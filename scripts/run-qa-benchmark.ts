// QA benchmark: grade frozen candidate answers (data/golden/qa-v1/items.jsonl) with
// Jev and the LLM judge, then score each evaluator against known truth.
//
// Usage: tsx scripts/run-qa-benchmark.ts [--limit N] [--concurrency 3] [--notes "..."] [--mock]
import "./_env";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "../lib/supabase/admin";
import { compareOnEvidence, persistOutcomes, runStatusFrom, type Evaluators } from "../lib/pipeline";
import { toPassages } from "../lib/retrieval";
import { headToHead, headToHeadBy, qaHeadline, splitByEvidence, type Grade, type PairRow, type Truth } from "../lib/eval/qa-metrics";
import { latencyStats, mean } from "../lib/eval/metrics";
import { providerModels, versions } from "../lib/constants";
import type { ProviderOutcome } from "../lib/decision/schema";

const { values: args } = parseArgs({
  options: { limit: { type: "string" }, concurrency: { type: "string", default: "3" }, notes: { type: "string" }, mock: { type: "boolean", default: false }, version: { type: "string", default: versions.qaDataset } },
});
const DATASET = args.version!;
const ITEMS_FILE = DATASET === "qa.v1" ? "data/golden/qa-v1/items.jsonl" : `data/golden/${DATASET.replace(/^qa\./, "qa-")}/items.jsonl`;

type Item = {
  item_id: string; question_id: string; document_key: string; question: string; answer_text: string; abstained: boolean;
  source: string; perturbation: string | null; truth_label: Truth; truth_source: string; review_status: string;
  evidence_keys: string[]; generator_model: string | null;
};

const admin = supabaseAdmin();
const models = providerModels();
const batchId = randomUUID();
const questions = new Map(readFileSync("data/golden/qa-v1/questions.jsonl", "utf8").split("\n").filter(Boolean).map((l) => { const q = JSON.parse(l); return [q.id, q]; }));
let items: Item[] = readFileSync(ITEMS_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
items = items.filter((i) => i.review_status === "auto" || i.review_status === "reviewed");
if (args.limit) {
  // Spread a limited run across sources so a smoke run still exercises every candidate type.
  const n = Number(args.limit);
  items = items.filter((_, idx) => idx % Math.max(1, Math.floor(items.length / n)) === 0).slice(0, n);
}

const { data: docs } = await admin.from("documents").select("id, benchmark_key").eq("visibility", "benchmark");
const docId = new Map((docs ?? []).map((d) => [d.benchmark_key as string, d.id as string]));
const { data: chunkRows } = await admin.from("document_chunks").select("chunk_key, page_start, page_end, content").in("chunk_key", [...new Set(items.flatMap((i) => i.evidence_keys))]);
const chunks = new Map((chunkRows ?? []).map((c) => [c.chunk_key, c]));

const mockOutcome = (provider: ProviderOutcome["provider"]): ProviderOutcome => ({
  provider, model: "MOCK", status: "ok", mocked: true, raw: { mock: true }, latency_ms: 0, input_tokens: null, output_tokens: null, est_cost_usd: 0, retries: 0, error: null,
  decision: { schema_version: "answer-grade.v1", provider, model: "MOCK", label: "correct", explanation: { summary: "MOCK", kind: "derived" }, evidence_refs: [], confidence: null },
});
const evaluators: Evaluators | undefined = args.mock ? { jev: async () => mockOutcome("jev"), judge: async () => mockOutcome("llm_judge") } : undefined;

type Row = PairRow & {
  item_id: string; question_id: string; source: string; perturbation: string | null; type: string; run_id: string;
  jev_status: string; judge_status: string; jev_conf: number | null; jev_ms: number; judge_ms: number; jev_cost: number | null; judge_cost: number | null;
};
const rows: Row[] = [];

async function gradeItem(it: Item) {
  const passages = toPassages(it.evidence_keys.map((k) => chunks.get(k)!).filter(Boolean));
  const { data: run, error } = await admin
    .from("evaluation_runs")
    .insert({
      kind: "benchmark", mode: "qa", document_id: docId.get(it.document_key), claim: it.question, status: "evaluating",
      answer: { status: "ok", text: it.answer_text, abstained: it.abstained, citations: [], model: it.generator_model ?? `(${it.source})`, host: null, latency_ms: 0, input_tokens: null, output_tokens: null, est_cost_usd: null, retries: 0, error: null },
      truth_label: it.truth_label, truth_source: it.truth_source === "review" ? "reference" : it.truth_source, truth_at: new Date().toISOString(),
      retrieval_strategy: it.source === "rag_hybrid" ? "hybrid" : "oracle", retrieval_params: { k: passages.length },
      retrieved: passages.map((p, i) => ({ chunk_key: p.chunk_key, page_start: p.page_start, page_end: p.page_end, rank: i + 1 })),
      embedding_model: it.source === "rag_hybrid" ? models.embedding : null,
      decision_schema_version: versions.gradeSchema, rubric_version: versions.answerRubric, dataset_version: DATASET,
      benchmark_example_id: it.question_id, benchmark_item_id: it.item_id, benchmark_condition: it.source, benchmark_batch_id: batchId,
      config: { jev_model: models.jev, judge_model: models.judge, jev_prompt: versions.jevAnswerPrompt, mock: args.mock },
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const out = await compareOnEvidence({ kind: "answer", question: it.question, answer: it.answer_text }, passages, evaluators);
  await persistOutcomes(admin, { id: run.id, user_id: null, is_admin: false, kind: "benchmark" }, passages, [out.jev, out.judge]);
  await admin.from("evaluation_runs").update({ status: runStatusFrom([out.jev, out.judge]), completed_at: new Date().toISOString() }).eq("id", run.id);
  const g = (o: ProviderOutcome): Grade => (o.status === "ok" ? (o.decision?.label as Grade) : null);
  rows.push({
    item_id: it.item_id, question_id: it.question_id, source: it.source, perturbation: it.perturbation, type: questions.get(it.question_id)?.type ?? "?", run_id: run.id,
    truth: it.truth_label, jev: g(out.jev), judge: g(out.judge), jev_status: out.jev.status, judge_status: out.judge.status,
    jev_conf: out.jev.decision?.confidence?.value ?? null, jev_ms: out.jev.latency_ms, judge_ms: out.judge.latency_ms, jev_cost: out.jev.est_cost_usd, judge_cost: out.judge.est_cost_usd,
  });
  process.stdout.write(rows.length % 50 === 0 ? `${rows.length}` : ".");
}

// Bounded concurrency.
const queue = [...items];
await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
  while (queue.length) await gradeItem(queue.shift()!);
}));
console.log();

const overall = headToHead(rows);
const split = splitByEvidence(rows);
const costs = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x != null); return { mean: v.length ? mean(v) : null, total: v.reduce((a, b) => a + b, 0) }; };
const ragItems = readFileSync(ITEMS_FILE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Item)
  .filter((i) => i.source.startsWith("rag") && i.review_status !== "excluded" && i.review_status !== "needs_review");
const ragAcc = (src: string) => { const r = ragItems.filter((i) => i.source === src); return { n: r.length, correct: r.filter((i) => i.truth_label === "correct").length }; };

const summary = {
  qa: {
    overall,
    // Headline = evaluators compared where both saw the labelled evidence (layer separation).
    labelled_evidence: split.labelled,
    end_to_end: split.endToEnd,
    headline: qaHeadline(split.labelled),
    by_source: headToHeadBy(rows, (r) => r.source),
    by_mistake: headToHeadBy(rows.filter((r) => r.truth === "incorrect"), (r) => r.perturbation ?? (r.source.startsWith("rag") ? "natural RAG error" : r.source)),
    by_question_type: headToHeadBy(rows, (r) => r.type),
    rag_accuracy: { oracle: ragAcc("rag_oracle"), hybrid: ragAcc("rag_hybrid") },
    latency: { jev: latencyStats(rows.map((r) => r.jev_ms)), judge: latencyStats(rows.map((r) => r.judge_ms)) },
    cost: { jev: costs(rows.map((r) => r.jev_cost)), judge: costs(rows.map((r) => r.judge_cost)) },
    statuses: { jev: count(rows.map((r) => r.jev_status)), judge: count(rows.map((r) => r.judge_status)) },
    rows,
  },
  retrieval: null, decisions: null, jev_reliability: null, review_status_counts: {}, rows: [],
};
const config = {
  layers: ["qa"], strategies: ["oracle", "hybrid"], k: 8, retrieval_ks: [],
  models: { jev: models.jev, judge: models.judge, embedding: models.embedding, answer: models.answer },
  versions: { ...versions, qaDataset: DATASET }, examples: rows.length, judge_calls: rows.length, providers: ["jev", "judge"],
};
const { error: repErr } = await admin.from("benchmark_reports").insert({
  batch_id: batchId, dataset_version: DATASET, label_snapshot: { items: rows.length, items_file: ITEMS_FILE, review_file: ITEMS_FILE.replace(/items\.jsonl$/, "review.json") },
  config, summary, is_mock: args.mock, notes: args.notes ?? null,
});
if (repErr) throw new Error(repErr.message);
mkdirSync("reports", { recursive: true });
const file = `reports/${new Date().toISOString().slice(0, 10)}-qa-${batchId.slice(0, 8)}${args.mock ? "-MOCK" : ""}.json`;
writeFileSync(file, JSON.stringify({ batch_id: batchId, config, summary }, null, 1));

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
console.log(`report: ${file}`);
console.log(summary.qa.headline.sentence);
console.log(summary.qa.headline.detail);
for (const [name, s] of [["Jev", overall.jev], ["Judge", overall.judge]] as const) {
  console.log(`${name.padEnd(6)} acc ${pct(s.accuracy)} | caught ${s.caught}/${s.wrong_answers} (${pct(s.catch_rate)}) | approved-wrong ${s.approved_wrong} | false alarms ${s.false_alarms}/${s.correct_answers} | can't tell ${s.cannot_tell} | no grade ${s.no_grade} | κ ${s.kappa_vs_truth.toFixed(2)}`);
}
console.log("cost: jev $" + summary.qa.cost.jev.total.toFixed(4) + ", judge $" + summary.qa.cost.judge.total.toFixed(4));

function count(xs: string[]) {
  return xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
}
