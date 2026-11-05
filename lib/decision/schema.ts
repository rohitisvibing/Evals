import { z } from "zod";

export const DECISION_LABELS = ["supported", "contradicted", "insufficient_evidence"] as const;
export type DecisionLabel = (typeof DECISION_LABELS)[number];
export const decisionLabel = z.enum(DECISION_LABELS);

/** answer-grade.v1 labels: is a generated answer correct? `cannot_tell` = the evaluator abstains. */
export const GRADE_LABELS = ["correct", "incorrect", "cannot_tell"] as const;
export type GradeLabel = (typeof GRADE_LABELS)[number];
export const gradeLabel = z.enum(GRADE_LABELS);

export type AnyLabel = DecisionLabel | GradeLabel;

/** What the evaluators are asked to judge. Both always receive the identical task and passages. */
export type EvalTask =
  | { kind: "claim"; claim: string }
  | { kind: "answer"; question: string; answer: string };

export function asTask(t: string | EvalTask): EvalTask {
  return typeof t === "string" ? { kind: "claim", claim: t } : t;
}

export const PROVIDERS = ["jev", "llm_judge"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const RESULT_STATUSES = ["ok", "error", "timeout", "malformed", "not_configured", "rate_limited"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const evidenceRef = z.object({
  chunk_key: z.string(),
  page_start: z.number().int(),
  page_end: z.number().int(),
  stance: z.enum(["supports", "contradicts", "neutral"]),
  quote: z.string().optional(),
  // Judge: quote string-matched against the passage. Jev: n/a (no quotes).
  quote_verified: z.boolean().optional(),
  // Jev only: probability of the chosen stance for this passage.
  probability: z.number().min(0).max(1).optional(),
});
export type EvidenceRef = z.infer<typeof evidenceRef>;

/**
 * decision.v1 — the common, provider-neutral decision record.
 *
 * `confidence` is present only when the provider emits a native confidence
 * (Jev's Choice confidence, derived from its probability distribution). It is
 * flagged `calibrated: false` until a calibration analysis exists. The LLM
 * judge never reports a confidence: verbalized confidence is not meaningful.
 */
export const decisionV1 = z.object({
  // decision.v1 = claim verdict; answer-grade.v1 = grade of a generated answer.
  schema_version: z.enum(["decision.v1", "answer-grade.v1"]),
  provider: z.enum(PROVIDERS),
  model: z.string().nullable(),
  label: z.enum([...DECISION_LABELS, ...GRADE_LABELS]),
  explanation: z.object({
    summary: z.string(),
    // generated = text written by the model; derived = assembled by us from structured output.
    kind: z.enum(["generated", "derived"]),
    calculation: z.string().optional(),
  }),
  evidence_refs: z.array(evidenceRef),
  confidence: z
    .object({
      value: z.number().min(0).max(1),
      source: z.string(),
      calibrated: z.boolean(),
    })
    .nullable(),
  probabilities: z.record(z.string(), z.number()).optional(),
});
export type DecisionV1 = z.infer<typeof decisionV1>;

/** Passage as handed to both evaluators — identical for Jev and the judge. */
export type EvidencePassage = {
  /** Short, prompt-local id (E1, E2, ...). Never derived from document text. */
  id: string;
  chunk_key: string;
  page_start: number;
  page_end: number;
  text: string;
};

export type ProviderOutcome = {
  provider: Provider;
  model: string | null;
  status: ResultStatus;
  decision: DecisionV1 | null;
  raw: unknown;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  est_cost_usd: number | null;
  retries: number;
  error: string | null;
  /** True when produced by a test double. Persisting such results is refused. */
  mocked?: boolean;
};

export function pageLabel(p: { page_start: number; page_end: number }): string {
  return p.page_start === p.page_end ? `p. ${p.page_start}` : `pp. ${p.page_start}–${p.page_end}`;
}
