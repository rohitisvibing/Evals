import type { SupabaseClient } from "@supabase/supabase-js";
import { asTask, type EvalTask, type EvidencePassage, type ProviderOutcome } from "./decision/schema";
import { evaluateWithJev } from "./providers/jev";
import { evaluateWithJudge } from "./providers/judge";

export type Evaluators = {
  jev: (task: EvalTask, passages: EvidencePassage[]) => Promise<ProviderOutcome>;
  judge: (task: EvalTask, passages: EvidencePassage[]) => Promise<ProviderOutcome>;
};

export const defaultEvaluators: Evaluators = {
  jev: (c, p) => evaluateWithJev(c, p),
  judge: (c, p) => evaluateWithJudge(c, p),
};

/**
 * Run both evaluators on the *same* task (claim, or question + answer) and the
 * *same* passages, in parallel. A failure in one never hides the other's result.
 */
export async function compareOnEvidence(
  input: string | EvalTask,
  passages: EvidencePassage[],
  evaluators: Evaluators = defaultEvaluators,
): Promise<{ jev: ProviderOutcome; judge: ProviderOutcome }> {
  const task = asTask(input);
  const [jev, judge] = await Promise.allSettled([evaluators.jev(task, passages), evaluators.judge(task, passages)]);
  return {
    jev: jev.status === "fulfilled" ? jev.value : crashed("jev", jev.reason),
    judge: judge.status === "fulfilled" ? judge.value : crashed("llm_judge", judge.reason),
  };
}

function crashed(provider: ProviderOutcome["provider"], reason: unknown): ProviderOutcome {
  return {
    provider,
    model: null,
    status: "error",
    decision: null,
    raw: null,
    latency_ms: 0,
    input_tokens: null,
    output_tokens: null,
    est_cost_usd: null,
    retries: 0,
    error: `Adapter crashed: ${(reason as Error)?.message ?? String(reason)}`,
  };
}

/** Persist both provider outcomes and per-call usage events. Refuses mocked outcomes for live runs. */
export async function persistOutcomes(
  admin: SupabaseClient,
  run: { id: string; user_id: string | null; is_admin: boolean; kind: "live" | "benchmark" },
  passages: EvidencePassage[],
  outcomes: ProviderOutcome[],
) {
  if (run.kind === "live" && outcomes.some((o) => o.mocked)) {
    throw new Error("Refusing to persist mocked provider output as a live result");
  }
  const rows = outcomes.map((o) => ({
    run_id: run.id,
    provider: o.provider,
    model: o.model,
    status: o.status,
    label: o.decision?.label ?? null,
    decision: o.decision,
    raw: o.raw ?? null,
    evidence_sent: passages.map((p) => p.chunk_key),
    latency_ms: o.latency_ms,
    input_tokens: o.input_tokens,
    output_tokens: o.output_tokens,
    est_cost_usd: o.est_cost_usd,
    retries: o.retries,
    error: o.error,
  }));
  const { data, error } = await admin.from("evaluation_results").upsert(rows, { onConflict: "run_id,provider" }).select("id, provider");
  if (error) throw new Error(`Persisting results failed: ${error.message}`);

  const calls = outcomes.filter((o) => o.status !== "not_configured");
  if (calls.length) {
    await admin.from("usage_events").insert(
      calls.map((o) => ({
        user_id: run.user_id,
        run_id: run.id,
        kind: "provider_call",
        provider: o.provider,
        is_admin: run.is_admin,
        est_cost_usd: o.est_cost_usd,
      })),
    );
  }
  return data as { id: string; provider: string }[];
}

export function runStatusFrom(outcomes: ProviderOutcome[]): "completed" | "partial" | "failed" {
  const ok = outcomes.filter((o) => o.status === "ok").length;
  return ok === outcomes.length ? "completed" : ok > 0 ? "partial" : "failed";
}
