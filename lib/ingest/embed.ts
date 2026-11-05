// Embeddings via OpenRouter's /embeddings endpoint (default: baai/bge-m3, 1024-d).
import { EMBEDDING_DIM, providerModels } from "../constants";
import { embeddingCost } from "../providers/pricing";

const URL = "https://openrouter.ai/api/v1/embeddings";
const BATCH = 32;

export class EmbeddingError extends Error {}

export type EmbedResult = { vectors: number[][]; model: string; tokens: number | null; est_cost_usd: number | null };

export async function embedTexts(
  texts: string[],
  opts: { apiKey?: string; model?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<EmbedResult> {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  const model = opts.model ?? providerModels().embedding;
  if (!apiKey) throw new EmbeddingError("OPENROUTER_API_KEY is not set; cannot compute embeddings.");
  const doFetch = opts.fetch ?? fetch;

  const vectors: number[][] = [];
  let tokens: number | null = 0;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    let body: { data?: { embedding: number[]; index: number }[]; usage?: { prompt_tokens?: number }; error?: { message?: string } } | null = null;
    for (let attempt = 0; attempt <= 2; attempt++) {
      const res = await doFetch(URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: batch }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      body = await res.json().catch(() => null);
      if (res.ok && body?.data) break;
      if (!(res.status === 429 || res.status >= 500) || attempt === 2) {
        throw new EmbeddingError(`Embedding request failed (HTTP ${res.status}): ${body?.error?.message ?? "unknown error"}`);
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    const data = [...(body!.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== batch.length) throw new EmbeddingError("Embedding count mismatch");
    for (const d of data) {
      assertDim(d.embedding);
      vectors.push(d.embedding);
    }
    const t = body!.usage?.prompt_tokens;
    tokens = typeof t === "number" && tokens !== null ? tokens + t : null;
  }
  return { vectors, model, tokens, est_cost_usd: embeddingCost(tokens) };
}

export function assertDim(v: number[]) {
  if (v.length !== EMBEDDING_DIM) {
    throw new EmbeddingError(`Embedding has ${v.length} dimensions; the index expects ${EMBEDDING_DIM}. Check EMBEDDING_MODEL.`);
  }
}

/** pgvector text literal. */
export function toPgVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
