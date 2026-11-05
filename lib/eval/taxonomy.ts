import type { DecisionLabel, ResultStatus } from "../decision/schema";

/** Failure taxonomy v1 — extensible: add codes, never repurpose existing ones. */
export const FAILURE_CODES = {
  retrieval_miss: "Relevant evidence not retrieved",
  numerical_reasoning: "Incorrect numerical reasoning",
  unsupported_inference: "Unsupported inference",
  missed_contradiction: "Contradictory evidence missed",
  invalid_citation: "Correct answer with invalid citation",
  incorrect_abstention: "Incorrect abstention",
  failed_to_abstain: "Failure to abstain when evidence is insufficient",
  malformed_output: "Malformed provider output",
  timeout: "Retrieval or provider timeout",
  provider_error: "Provider error / unavailable",
  label_dispute: "Gold label disputed on review",
  other: "Other",
} as const;
export type FailureCode = keyof typeof FAILURE_CODES;
export const TAXONOMY_VERSION = "taxonomy.v1";

/**
 * Heuristic first-pass attribution. These are *suggestions* stored with
 * source='auto'; a reviewer confirms or overrides them (source='human').
 */
export function suggestFailure(args: {
  gold: DecisionLabel;
  pred: DecisionLabel | null;
  status: ResultStatus;
  retrievalRecall: number | null; // fraction of gold passages in the evidence the model saw
  citationValid: boolean | null;
  numeric: boolean;
}): FailureCode | null {
  const { gold, pred, status, retrievalRecall, citationValid, numeric } = args;
  if (status === "timeout") return "timeout";
  if (status === "malformed") return "malformed_output";
  if (status !== "ok") return "provider_error";
  if (pred === gold) return citationValid === false ? "invalid_citation" : null;

  if (gold !== "insufficient_evidence" && retrievalRecall !== null && retrievalRecall === 0) return "retrieval_miss";
  if (pred === "insufficient_evidence") return retrievalRecall !== null && retrievalRecall < 1 ? "retrieval_miss" : "incorrect_abstention";
  if (gold === "insufficient_evidence") return "failed_to_abstain";
  if (numeric) return "numerical_reasoning";
  if (gold === "contradicted" && pred === "supported") return "missed_contradiction";
  return "unsupported_inference";
}
