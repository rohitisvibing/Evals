// Mocked HTTP only. [mock]
import { describe, expect, it } from "vitest";
import { buildJevAnswerRequest, evaluateWithJev, normalizeJev } from "@/lib/providers/jev";
import { evaluateWithJudge, buildJudgeUserMessage, JUDGE_ANSWER_PROMPT } from "@/lib/providers/judge";
import { generateAnswer, NOT_STATED } from "@/lib/providers/generator";
import { compareOnEvidence } from "@/lib/pipeline";
import type { EvidencePassage, ProviderOutcome } from "@/lib/decision/schema";

const passages: EvidencePassage[] = [{ id: "E1", chunk_key: "k:p5:c0", page_start: 5, page_end: 5, text: "Total revenues 94,972 92,995 277,212 276,517" }];
const task = { kind: "answer" as const, question: "What were nine-month revenues?", answer: "$277,212 million." };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const noSleep = async () => {};

describe("RAG answer generator [mock]", () => {
  it("returns the answer with verified citations and cost", async () => {
    let body: { model?: string; reasoning?: unknown; provider?: { require_parameters?: boolean } } = {};
    const g = await generateAnswer(task.question, passages, {
      apiKey: "k", model: "openai/gpt-4.1-nano", sleep: noSleep,
      fetch: (async (_u: string, init: RequestInit) => ((body = JSON.parse(String(init.body))), json({
        model: "openai/gpt-4.1-nano", provider: "Azure",
        choices: [{ message: { content: JSON.stringify({ answer: "$277,212 million.", abstained: false, citations: [{ passage_id: "E1", quote: "277,212" }, { passage_id: "E9", quote: "x" }] }) } }],
        usage: { prompt_tokens: 1000, completion_tokens: 50 },
      }))) as never,
    });
    expect(g.status).toBe("ok");
    expect(g.text).toBe("$277,212 million.");
    expect(g.citations).toEqual([{ id: "E1", chunk_key: "k:p5:c0", page_start: 5, page_end: 5, quote: "277,212", quote_verified: true }]);
    expect(g.host).toBe("Azure");
    expect(g.est_cost_usd).toBeCloseTo((1000 * 0.1 + 50 * 0.4) / 1e6);
    expect(body.reasoning).toBeUndefined(); // hosts of this model reject it
    expect(body.provider?.require_parameters).toBe(false);
  });

  it("is not configured without a key, and reports unavailable models without fallback", async () => {
    expect((await generateAnswer("q", passages, { apiKey: "" })).status).toBe("not_configured");
    const g = await generateAnswer("q", passages, { apiKey: "k", sleep: noSleep, fetch: (async () => json({ error: { code: 404, message: "No endpoints" } }, 404)) as never });
    expect(g.status).toBe("error");
    expect(g.error).toMatch(/No fallback/);
  });

  it("uses a fixed decline phrase", () => {
    expect(NOT_STATED).toBe("The document does not say.");
  });
});

describe("answer grading [mock]", () => {
  it("Jev gets a grade question plus per-passage relations, and returns answer-grade.v1", async () => {
    const req = buildJevAnswerRequest(task.question, task.answer, passages, "jev-1.14.0");
    expect(Object.keys(req.questions)).toEqual(["grade", "rel_E1"]);
    expect(Object.keys(req.questions.grade.criteria)).toEqual(["correct", "incorrect", "cannot_tell"]);
    expect(req.state.note).toMatch(/untrusted/);
    const raw = {
      model: "jev-1.14.0",
      answers: {
        grade: { type: "choice", choice: "correct", confidence: 0.9, probabilities: { correct: 0.95, incorrect: 0.04, cannot_tell: 0.01 } },
        rel_E1: { type: "choice", choice: "supports", confidence: 0.9, probabilities: { supports: 0.9, contradicts: 0.05, says_nothing: 0.05 } },
      },
      usage: { input_tokens: 500, output_tokens: 0 },
    };
    const d = normalizeJev(raw as never, passages, "answer");
    expect(d.schema_version).toBe("answer-grade.v1");
    expect(d.label).toBe("correct");
    const out = await evaluateWithJev(task, passages, { apiKey: "k", fetch: (async () => json(raw)) as never });
    expect(out.decision?.label).toBe("correct");
  });

  it("the judge uses the answer rubric and wraps the answer as untrusted", async () => {
    expect(buildJudgeUserMessage(task, passages)).toContain("<untrusted_answer_to_grade>");
    let sys = "";
    const out = await evaluateWithJudge(task, passages, {
      apiKey: "k", model: "google/gemma-4-31b-it", responseFormat: "json_schema", sleep: noSleep,
      fetch: (async (_u: string, init: RequestInit) => {
        const b = JSON.parse(String(init.body));
        sys = b.messages[0].content;
        expect(b.response_format.json_schema.schema.properties.label.enum).toEqual(["correct", "incorrect", "cannot_tell"]);
        return json({ model: "google/gemma-4-31b-it", choices: [{ message: { content: JSON.stringify({ label: "incorrect", rationale: "r", calculation: null, evidence: [] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 } });
      }) as never,
    });
    expect(sys).toBe(JUDGE_ANSWER_PROMPT);
    expect(out.decision?.schema_version).toBe("answer-grade.v1");
    expect(out.decision?.label).toBe("incorrect");
    expect(out.est_cost_usd).toBe(0.0001); // OpenRouter-reported cost wins
  });

  it("both evaluators receive the identical answer task and passages", async () => {
    const seen: unknown[] = [];
    const ok = (p: ProviderOutcome["provider"]): ProviderOutcome => ({ provider: p, model: "m", status: "ok", raw: null, latency_ms: 0, input_tokens: null, output_tokens: null, est_cost_usd: 0, retries: 0, error: null, decision: null });
    await compareOnEvidence(task, passages, { jev: async (t, ps) => (seen.push([t, ps]), ok("jev")), judge: async (t, ps) => (seen.push([t, ps]), ok("llm_judge")) });
    expect(seen[0]).toEqual(seen[1]);
    expect((seen[0] as [typeof task])[0]).toEqual(task);
  });
});
