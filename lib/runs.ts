import type { SupabaseClient } from "@supabase/supabase-js";
import type { DecisionV1 } from "./decision/schema";
import type { AnswerCitation } from "./providers/generator";
import { headToHead, type Grade, type HeadToHead, type Truth } from "./eval/qa-metrics";

export type RunAnswer = {
  status: string; text: string | null; abstained: boolean; citations: AnswerCitation[]; model: string; host: string | null;
  latency_ms: number; input_tokens: number | null; output_tokens: number | null; est_cost_usd: number | null; retries: number; error: string | null; raw?: unknown;
};

export type RunSummary = {
  id: string;
  mode: "claim" | "qa";
  /** The claim (claim mode) or the question (qa mode). */
  claim: string;
  answer_text: string | null;
  truth: Truth | null;
  status: string;
  retrieval_strategy: string | null;
  created_at: string;
  document_title: string | null;
  jev: { label: DecisionV1["label"] | null; status: string } | null;
  judge: { label: DecisionV1["label"] | null; status: string } | null;
};

export type RunResult = {
  id: string;
  provider: "jev" | "llm_judge";
  model: string | null;
  status: string;
  label: DecisionV1["label"] | null;
  decision: DecisionV1 | null;
  raw: unknown;
  evidence_sent: string[];
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  est_cost_usd: number | null;
  retries: number;
  error: string | null;
};

export type RunDetail = {
  run: {
    id: string; kind: string; mode: "claim" | "qa"; claim: string; status: string; created_at: string; retrieval_strategy: string | null;
    answer: RunAnswer | null; truth: Truth | null; truth_source: string | null;
    retrieval_params: { k?: number } | null; retrieval_ms: number | null; embedding_model: string | null;
    decision_schema_version: string | null; rubric_version: string | null; dataset_version: string | null;
    ground_truth_version: string | null; benchmark_condition: string | null; document_title: string | null;
  };
  results: RunResult[];
  evidence: { id: string; chunk_key: string; page_start: number; page_end: number; score: number | null; rank: number; lexical_rank?: number | null; vector_rank?: number | null; text: string | null; gold: boolean }[];
  gold: { label: DecisionV1["label"]; rationale: string; review_status: string; missed: number } | null;
};

/** Live runs owned by the caller (RLS-scoped client). */
export async function listRuns(client: SupabaseClient, userId: string, limit = 100): Promise<RunSummary[]> {
  const { data } = await client
    .from("evaluation_runs")
    .select("id, mode, claim, answer, truth_label, status, retrieval_strategy, created_at, documents(title), evaluation_results(provider, label, status)")
    .eq("kind", "live")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((r) => {
    const res = (p: string) => (r.evaluation_results as { provider: string; label: DecisionV1["label"] | null; status: string }[]).find((x) => x.provider === p);
    const j = res("jev");
    const g = res("llm_judge");
    return {
      id: r.id, mode: r.mode, claim: r.claim, status: r.status, retrieval_strategy: r.retrieval_strategy, created_at: r.created_at,
      answer_text: (r.answer as { text?: string | null } | null)?.text ?? null,
      truth: r.truth_label,
      document_title: (r.documents as unknown as { title: string } | null)?.title ?? null,
      jev: j ? { label: j.label, status: j.status } : null,
      judge: g ? { label: g.label, status: g.status } : null,
    };
  });
}

/** Full trace for one run, or null if the caller cannot see it (RLS). */
export async function getRunDetail(client: SupabaseClient, id: string): Promise<RunDetail | null> {
  const { data: run } = await client.from("evaluation_runs").select("*, documents(title)").eq("id", id).maybeSingle();
  if (!run) return null;
  const { data: results } = await client.from("evaluation_results").select("*").eq("run_id", id);
  const retrieved = (run.retrieved ?? []) as { chunk_key: string; page_start: number; page_end: number; score?: number; rank: number; lexical_rank?: number | null; vector_rank?: number | null }[];
  const { data: chunks } = retrieved.length
    ? await client.from("document_chunks").select("chunk_key, content").in("chunk_key", retrieved.map((r) => r.chunk_key))
    : { data: [] as { chunk_key: string; content: string }[] };
  const text = new Map((chunks ?? []).map((c) => [c.chunk_key, c.content as string]));

  let gold: RunDetail["gold"] = null;
  let goldKeys = new Set<string>();
  if (run.kind === "benchmark" && run.benchmark_example_id) {
    const { data } = await client
      .from("benchmark_labels")
      .select("gold_label, relevant_chunk_keys, rationale, review_status, label_version")
      .eq("dataset_version", run.dataset_version)
      .eq("example_id", run.benchmark_example_id)
      .order("label_version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      goldKeys = new Set(data.relevant_chunk_keys as string[]);
      gold = {
        label: data.gold_label, rationale: data.rationale, review_status: data.review_status,
        missed: [...goldKeys].filter((k) => !retrieved.some((r) => r.chunk_key === k)).length,
      };
    }
  }

  return {
    run: {
      id: run.id, kind: run.kind, mode: run.mode, claim: run.claim, status: run.status, created_at: run.created_at, retrieval_strategy: run.retrieval_strategy,
      answer: run.answer ? (({ raw: _raw, ...a }) => a)(run.answer) : null, truth: run.truth_label, truth_source: run.truth_source,
      retrieval_params: run.retrieval_params, retrieval_ms: run.retrieval_ms, embedding_model: run.embedding_model,
      decision_schema_version: run.decision_schema_version, rubric_version: run.rubric_version, dataset_version: run.dataset_version,
      ground_truth_version: run.ground_truth_version, benchmark_condition: run.benchmark_condition,
      document_title: (run.documents as { title?: string } | null)?.title ?? null,
    },
    results: (results ?? []) as RunResult[],
    evidence: retrieved.map((r, i) => ({
      id: `E${i + 1}`, chunk_key: r.chunk_key, page_start: r.page_start, page_end: r.page_end, score: r.score ?? null, rank: r.rank,
      lexical_rank: r.lexical_rank, vector_rank: r.vector_rank, text: text.get(r.chunk_key) ?? null, gold: goldKeys.has(r.chunk_key),
    })),
    gold,
  };
}

/** Live QA runs the user has marked, scored head-to-head. Never mixed with benchmark numbers. */
export async function getScoreboard(client: SupabaseClient, userId: string): Promise<HeadToHead> {
  const { data } = await client
    .from("evaluation_runs")
    .select("truth_label, evaluation_results(provider, label, status)")
    .eq("kind", "live")
    .eq("mode", "qa")
    .eq("user_id", userId)
    .not("truth_label", "is", null)
    .limit(1000);
  const grade = (rs: { provider: string; label: string | null; status: string }[], p: string): Grade => {
    const r = rs.find((x) => x.provider === p);
    return r && r.status === "ok" ? (r.label as Grade) : null;
  };
  return headToHead(
    (data ?? []).map((r) => {
      const rs = r.evaluation_results as { provider: string; label: string | null; status: string }[];
      return { truth: r.truth_label as Truth, jev: grade(rs, "jev"), judge: grade(rs, "llm_judge") };
    }),
  );
}
