import "server-only";
import { supabaseAdmin } from "./supabase/admin";
import type { summarizeDecisions, summarizeRetrieval, reliability, DecisionRow } from "./eval/benchmark";
import type { HeadToHead, PairRow, qaHeadline } from "./eval/qa-metrics";
import type { latencyStats } from "./eval/metrics";

export type QaRow = PairRow & {
  item_id: string; question_id: string; source: string; perturbation: string | null; type: string; run_id: string;
  jev_status: string; judge_status: string; jev_conf: number | null; jev_ms: number; judge_ms: number; jev_cost: number | null; judge_cost: number | null;
};
export type QaSummary = {
  overall: HeadToHead;
  headline: ReturnType<typeof qaHeadline>;
  by_source: (HeadToHead & { group: string })[];
  by_mistake: (HeadToHead & { group: string })[];
  by_question_type: (HeadToHead & { group: string })[];
  rag_accuracy: { oracle: { n: number; correct: number }; hybrid: { n: number; correct: number } };
  latency: { jev: ReturnType<typeof latencyStats>; judge: ReturnType<typeof latencyStats> };
  cost: { jev: { mean: number | null; total: number }; judge: { mean: number | null; total: number } };
  statuses: { jev: Record<string, number>; judge: Record<string, number> };
  rows: QaRow[];
};

export type Report = {
  id: string;
  batch_id: string;
  dataset_version: string;
  created_at: string;
  is_mock: boolean;
  notes: string | null;
  config: { layers: string[]; strategies: string[]; k: number; retrieval_ks: number[]; models: Record<string, string>; versions: Record<string, string>; examples: number; judge_calls: number; providers: string[] };
  label_snapshot: Record<string, { label_version: number; review_status: string }>;
  summary: {
    retrieval: ReturnType<typeof summarizeRetrieval> | null;
    decisions: ReturnType<typeof summarizeDecisions> | null;
    jev_reliability: ReturnType<typeof reliability> | null;
    review_status_counts: Record<string, number>;
    rows: DecisionRow[];
    qa?: QaSummary;
  };
};

/** Benchmark reports contain only public benchmark data (no user documents), so they are publicly readable. */
export async function listReports(includeMock = false): Promise<Report[]> {
  let q = supabaseAdmin().from("benchmark_reports").select("*").order("created_at", { ascending: false }).limit(50);
  if (!includeMock) q = q.eq("is_mock", false);
  const { data } = await q;
  return (data ?? []) as Report[];
}
