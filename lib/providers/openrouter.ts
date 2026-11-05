// Shared OpenRouter chat client for the LLM judge and the RAG answer generator.
// - Bounded retries on 429/5xx/timeouts with backoff.
// - Structured output (strict JSON Schema or JSON mode), zod validation, one repair attempt.
// - Usage/cost accounting (OpenRouter-reported cost when present).
// - Provider routing only among hosts of the SAME model; no model substitution.
import type { z } from "zod";
import { limits } from "../constants";
import type { ResultStatus } from "../decision/schema";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type ChatResponse = {
  id?: string;
  model?: string;
  provider?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { code?: number; message?: string };
};

export class HttpError extends Error {
  constructor(public status: number, message: string, public body: unknown) {
    super(message);
  }
}

/** Provider routing for hosts of the same model. JUDGE_QUANTIZATIONS-style lists pin precision. */
export function providerPreferences(quantizationsCsv: string | undefined, env: Record<string, string | undefined> = process.env, requireParameters = true) {
  const quantizations = (quantizationsCsv ?? "").split(",").map((q) => q.trim()).filter(Boolean);
  return {
    allow_fallbacks: true,
    // true: only hosts that support every parameter we send (e.g. strict response_format).
    require_parameters: requireParameters,
    data_collection: env.OPENROUTER_DATA_COLLECTION === "deny" ? "deny" : "allow",
    ...(quantizations.length ? { quantizations } : {}),
  };
}

export function responseFormat(mode: string | undefined, schema: { name: string; strict: boolean; schema: object }) {
  return mode === "json_schema" ? { type: "json_schema", json_schema: schema } : { type: "json_object" };
}

/** Extract a JSON object from model text (tolerates ```json fences / leading prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object found");
  return JSON.parse(body.slice(start, end + 1));
}

function safeExtract(text: string): unknown {
  try {
    return extractJson(text);
  } catch {
    return null;
  }
}

export type StructuredResult<T> = {
  status: ResultStatus;
  data: T | null;
  model: string;
  host: string | null;
  raw: unknown;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  /** OpenRouter-reported cost if present, else null (caller may estimate). */
  reported_cost_usd: number | null;
  retries: number;
  error: string | null;
};

export type StructuredCallOptions<T> = {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  output: z.ZodType<T>;
  responseFormat: object;
  provider: object;
  label: string; // used in error messages, e.g. "Judge"
  repairHint: string;
  maxTokens?: number;
  /** Sent as `reasoning` (default: hide reasoning tokens). null = omit, for hosts that don't accept it. */
  reasoning?: object | null;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export async function callStructured<T>(opts: StructuredCallOptions<T>): Promise<StructuredResult<T>> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let retries = 0;
  let inTok = 0;
  let outTok = 0;
  let reportedCost: number | null = null;
  let host: string | null = null;
  const rawResponses: unknown[] = [];
  const started = performance.now();

  async function call(msgs: ChatMessage[]): Promise<ChatResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await doFetch(OPENROUTER_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
            "X-Title": "Decision Model Observatory",
          },
          body: JSON.stringify({
            model: opts.model,
            messages: msgs,
            temperature: 0,
            seed: 7,
            max_tokens: opts.maxTokens ?? 2000,
            response_format: opts.responseFormat,
            // Routing among hosts of this same model only. No `models` list is sent,
            // so OpenRouter never substitutes a different model.
            provider: opts.provider,
            ...(opts.reasoning === null ? {} : { reasoning: opts.reasoning ?? { exclude: true } }),
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? limits.providerTimeoutMs),
        });
        const body = (await res.json().catch(() => null)) as ChatResponse | null;
        if (!res.ok || !body || body.error) {
          const status = res.ok ? (body?.error?.code ?? 502) : res.status;
          throw new HttpError(status, body?.error?.message ?? `HTTP ${status}`, body);
        }
        rawResponses.push(body);
        host = body.provider ?? host;
        inTok += body.usage?.prompt_tokens ?? 0;
        outTok += body.usage?.completion_tokens ?? 0;
        if (typeof body.usage?.cost === "number") reportedCost = (reportedCost ?? 0) + body.usage.cost;
        return body;
      } catch (e) {
        const retryable =
          (e instanceof HttpError && (e.status === 429 || e.status >= 500)) ||
          (e instanceof Error && (e.name === "TimeoutError" || e.name === "TypeError"));
        if (!retryable || attempt >= limits.providerMaxRetries) throw e;
        retries++;
        await sleep(Math.min(8000, 750 * 2 ** attempt));
      }
    }
  }

  const finish = (p: Partial<StructuredResult<T>> & Pick<StructuredResult<T>, "status">): StructuredResult<T> => ({
    data: null,
    model: opts.model,
    host,
    raw: rawResponses.length ? rawResponses : null,
    latency_ms: Math.round(performance.now() - started),
    input_tokens: inTok || null,
    output_tokens: outTok || null,
    reported_cost_usd: reportedCost,
    retries,
    error: null,
    ...p,
  });

  try {
    const first = await call(opts.messages);
    const actualModel = first.model ?? opts.model;
    const text = first.choices?.[0]?.message?.content ?? "";
    let parsed = opts.output.safeParse(safeExtract(text));
    if (!parsed.success) {
      retries++;
      const repaired = await call([
        ...opts.messages,
        { role: "assistant", content: text.slice(0, 6000) },
        { role: "user", content: opts.repairHint },
      ]);
      parsed = opts.output.safeParse(safeExtract(repaired.choices?.[0]?.message?.content ?? ""));
    }
    if (!parsed.success) {
      return finish({ status: "malformed", model: actualModel, error: `${opts.label} output failed schema validation after one repair attempt` });
    }
    return finish({ status: "ok", model: actualModel, data: parsed.data });
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 429) return finish({ status: "rate_limited", error: `${opts.label} rate-limited (429): ${e.message}`, raw: e.body });
      if (e.status === 404) return finish({ status: "error", error: `${opts.label} model "${opts.model}" unavailable (404). No fallback model is configured.`, raw: e.body });
      return finish({ status: "error", error: `${opts.label} HTTP ${e.status}: ${e.message}`, raw: e.body });
    }
    if (e instanceof Error && e.name === "TimeoutError") return finish({ status: "timeout", error: `${opts.label} request timed out` });
    return finish({ status: "error", error: `${opts.label} call failed: ${(e as Error).message}` });
  }
}

export function normalizeForQuote(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
