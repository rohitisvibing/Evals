// Benchmark runner — three separately-measured layers:
//   retrieval : Recall@k / MRR / nDCG per strategy (no model calls)
//   decision  : Jev vs judge on ORACLE evidence (gold passages + fixed distractors)
//   e2e       : Jev vs judge on evidence retrieved by each strategy (k = --k)
//
// Usage:
//   tsx scripts/run-benchmark.ts --layers retrieval
//   tsx scripts/run-benchmark.ts --layers retrieval,decision,e2e --strategies hybrid --providers jev,judge
//   tsx scripts/run-benchmark.ts --mock ...   (pipeline test; report is flagged is_mock and never shown as real)
// Flags: --version v1 --k 8 --limit N --max-judge-calls 45 --notes "..."
import "./_env";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "../lib/supabase/admin";
import { loadExamples, isNumeric, type GoldenExample } from "../lib/eval/golden";
import { retrieve, retrievalTrace, toPassages, STRATEGIES, type Strategy } from "../lib/retrieval";
import { embedTexts } from "../lib/ingest/embed";
import { compareOnEvidence, persistOutcomes, runStatusFrom, type Evaluators } from "../lib/pipeline";
import { evaluateWithJev } from "../lib/providers/jev";
import { evaluateWithJudge } from "../lib/providers/judge";
import { checkCitations } from "../lib/eval/metrics";
import { oracleKeys } from "../lib/eval/oracle";
import { suggestFailure } from "../lib/eval/taxonomy";
import { summarizeDecisions, summarizeRetrieval, reliability, groupRecallAtK, type DecisionRow, type RetrievalRow } from "../lib/eval/benchmark";
import { providerModels, versions } from "../lib/constants";
import type { DecisionLabel, EvidencePassage, ProviderOutcome } from "../lib/decision/schema";

const { values: args } = parseArgs({
  options: {
    version: { type: "string", default: "v1" },
    layers: { type: "string", default: "retrieval" },
    strategies: { type: "string", default: STRATEGIES.join(",") },
    providers: { type: "string", default: "jev,judge" },
    k: { type: "string", default: "8" },
    limit: { type: "string" },
    "max-judge-calls": { type: "string", default: "45" },
    mock: { type: "boolean", default: false },
    notes: { type: "string" },
  },
});

const admin = supabaseAdmin();
const datasetVersion = `golden.${args.version}`;
const dir = `data/golden/${args.version}`;
const layers = new Set(args.layers!.split(","));
const providers = new Set(args.providers!.split(","));
const K = Number(args.k);
const RETRIEVAL_KS = [1, 3, 5, 8, 10];
const models = providerModels();
const batchId = randomUUID();

let examples = loadExamples(`${dir}/examples.jsonl`);
if (args.limit) examples = examples.slice(0, Number(args.limit));
const resolved = JSON.parse(readFileSync(`${dir}/resolved.json`, "utf8")).resolved as Record<string, { groups: string[][]; pages: number[] }>;

// Label snapshot: latest label_version per example (reports pin exactly what they were scored against).
const { data: labelRows, error: lblErr } = await admin
  .from("benchmark_labels")
  .select("example_id, label_version, gold_label, review_status, relevant_chunk_keys")
  .eq("dataset_version", datasetVersion);
if (lblErr) throw new Error(lblErr.message);
const labels = new Map<string, { label_version: number; gold_label: GoldenExample["gold_label"]; review_status: string }>();
for (const l of labelRows ?? []) {
  const cur = labels.get(l.example_id);
  if (!cur || l.label_version > cur.label_version) labels.set(l.example_id, l);
}
examples = examples.filter((e) => labels.has(e.example_id));
const gold = (e: GoldenExample) => labels.get(e.example_id)!.gold_label;

const { data: docs } = await admin.from("documents").select("id, benchmark_key, embedding_model").eq("visibility", "benchmark").is("deleted_at", null);
const docByKey = new Map((docs ?? []).map((d) => [d.benchmark_key as string, d]));

// Strategy availability: vector/hybrid require embeddings for the doc AND an embedding key.
const requested = args.strategies!.split(",") as Strategy[];
const strategies = requested.filter((s) => {
  if (s === "lexical") return true;
  const ok = !!process.env.OPENROUTER_API_KEY && [...docByKey.values()].every((d) => d.embedding_model === models.embedding);
  if (!ok) console.warn(`skipping strategy "${s}": documents not embedded with ${models.embedding} or OPENROUTER_API_KEY missing`);
  return ok;
});

// Cache claim embeddings across vector/hybrid.
const embedCache = new Map<string, Awaited<ReturnType<typeof embedTexts>>>();
const cachedEmbed: typeof embedTexts = async (texts, o) => {
  const key = texts.join("\u0000");
  if (!embedCache.has(key)) embedCache.set(key, await embedTexts(texts, o));
  return embedCache.get(key)!;
};

async function retrieveFor(e: GoldenExample, strategy: Strategy, k: number) {
  const doc = docByKey.get(e.document_key);
  if (!doc) throw new Error(`benchmark document ${e.document_key} not seeded`);
  return retrieve(admin, { documentId: doc.id, claim: e.claim, strategy, k, embeddingModel: models.embedding }, { embed: cachedEmbed });
}

// ------------------------------------------------------------ retrieval layer
const retrievalRows: RetrievalRow[] = [];
const retrievedCache = new Map<string, Awaited<ReturnType<typeof retrieveFor>>>();
if (layers.has("retrieval") || layers.has("e2e") || layers.has("decision")) {
  for (const e of examples) {
    for (const s of strategies) {
      const r = await retrieveFor(e, s, Math.max(10, K));
      retrievedCache.set(`${e.example_id}|${s}`, r);
      retrievalRows.push({
        example_id: e.example_id,
        strategy: s,
        retrieved: r.chunks.map((c) => c.chunk_key),
        groups: resolved[e.example_id].groups,
        multi_page: e.categories.includes("multi_page"),
      });
    }
  }
}
const retrievalSummary = layers.has("retrieval") ? summarizeRetrieval(retrievalRows, RETRIEVAL_KS) : null;

// ------------------------------------------------------------ model layers
const evaluators: Evaluators = args.mock
  ? {
      jev: async () => mockOutcome("jev"),
      judge: async () => mockOutcome("llm_judge"),
    }
  : {
      jev: providers.has("jev") ? (c, p) => evaluateWithJev(c, p) : async () => skipped("jev"),
      judge: providers.has("judge") ? paced((c, p) => evaluateWithJudge(c, p), models.judge.endsWith(":free") ? 3500 : 500) : async () => skipped("llm_judge"),
    };

let judgeCalls = 0;
const maxJudgeCalls = Number(args["max-judge-calls"]);
const decisionRows: DecisionRow[] = [];

async function chunkTexts(keys: string[]) {
  const { data } = await admin.from("document_chunks").select("chunk_key, page_start, page_end, content").in("chunk_key", keys);
  const m = new Map((data ?? []).map((c) => [c.chunk_key, c]));
  return keys.map((k) => m.get(k)!).filter(Boolean);
}

async function evaluateCondition(e: GoldenExample, condition: string, passages: EvidencePassage[], strategy: Strategy | "oracle", retrievedTrace: unknown) {
  if (providers.has("judge") && !args.mock) {
    if (judgeCalls >= maxJudgeCalls) return false;
    judgeCalls++;
  }
  const doc = docByKey.get(e.document_key)!;
  const { data: run, error } = await admin
    .from("evaluation_runs")
    .insert({
      kind: "benchmark",
      document_id: doc.id,
      claim: e.claim,
      status: "evaluating",
      retrieval_strategy: strategy,
      retrieval_params: { k: passages.length },
      retrieved: retrievedTrace,
      embedding_model: strategy === "lexical" || strategy === "oracle" ? null : models.embedding,
      decision_schema_version: versions.decisionSchema,
      rubric_version: versions.rubric,
      dataset_version: datasetVersion,
      ground_truth_version: String(labels.get(e.example_id)!.label_version),
      benchmark_example_id: e.example_id,
      benchmark_condition: condition,
      benchmark_batch_id: batchId,
      config: { jev_model: models.jev, judge_model: models.judge, jev_prompt: versions.jevPrompt, chunker: versions.chunker, mock: args.mock },
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  const out = await compareOnEvidence(e.claim, passages, evaluators);
  const outcomes = [out.jev, out.judge].filter((o) => args.mock || providers.has(o.provider === "jev" ? "jev" : "judge"));
  const saved = await persistOutcomes(admin, { id: run.id, user_id: null, is_admin: false, kind: "benchmark" }, passages, outcomes);
  await admin.from("evaluation_runs").update({ status: runStatusFrom(outcomes), completed_at: new Date().toISOString() }).eq("id", run.id);

  const groups = resolved[e.example_id].groups;
  const sent = passages.map((p) => p.chunk_key);
  const evidenceRecall = groups.some((g) => g.length) ? groupRecallAtK(sent, groups, sent.length) : null;
  for (const o of outcomes) {
    const g = gold(e);
    // Claim benchmark: evaluators return claim labels (decision.v1) only.
    const pred = (o.decision?.label ?? null) as DecisionLabel | null;
    const cit = o.decision ? checkCitations(o.decision.evidence_refs, sent, groups.flat(), g) : null;
    const failure = suggestFailure({ gold: g, pred, status: o.status, retrievalRecall: evidenceRecall, citationValid: cit?.valid ?? null, numeric: isNumeric(e) });
    decisionRows.push({
      example_id: e.example_id,
      run_id: run.id,
      condition,
      provider: o.provider,
      gold: g,
      pred,
      status: o.status,
      latency_ms: o.latency_ms,
      est_cost_usd: o.est_cost_usd,
      citation_valid: cit?.valid ?? null,
      evidence_recall: evidenceRecall,
      failure,
      categories: e.categories,
      ambiguous: !!e.ambiguous,
      confidence: o.decision?.confidence?.value ?? null,
    });
    const resultId = saved.find((s) => s.provider === o.provider)?.id;
    if (failure && resultId) {
      await admin.from("failure_annotations").insert({ result_id: resultId, code: failure, source: "auto", annotator: "taxonomy.v1-heuristic" });
    }
  }
  process.stdout.write(".");
  return true;
}

if (layers.has("decision")) {
  for (const e of examples) {
    // Fixed distractors: best-ranked non-gold chunks from the first available strategy.
    const base = retrievedCache.get(`${e.example_id}|${strategies.includes("hybrid") ? "hybrid" : "lexical"}`);
    const { keys: ordered, gold: goldKeys } = oracleKeys(resolved[e.example_id].groups, (base?.chunks ?? []).map((c) => c.chunk_key), e.example_id);
    const chunks = await chunkTexts(ordered);
    const passages = toPassages(chunks);
    const ok = await evaluateCondition(e, "oracle", passages, "oracle", chunks.map((c, i) => ({ chunk_key: c.chunk_key, page_start: c.page_start, page_end: c.page_end, rank: i + 1, gold: goldKeys.includes(c.chunk_key) })));
    if (!ok) break;
  }
}

if (layers.has("e2e")) {
  outer: for (const s of strategies) {
    for (const e of examples) {
      const r = retrievedCache.get(`${e.example_id}|${s}`)!;
      const top = r.chunks.slice(0, K);
      if (!top.length) continue;
      const ok = await evaluateCondition(e, `e2e:${s}`, toPassages(top), s, retrievalTrace(top));
      if (!ok) break outer;
    }
  }
}
console.log();

// ------------------------------------------------------------ report
const decisionSummary = decisionRows.length ? summarizeDecisions(decisionRows) : null;
const report = {
  batch_id: batchId,
  dataset_version: datasetVersion,
  created_at: new Date().toISOString(),
  is_mock: args.mock,
  config: {
    layers: [...layers],
    strategies,
    k: K,
    retrieval_ks: RETRIEVAL_KS,
    models: { jev: models.jev, judge: models.judge, embedding: models.embedding },
    versions,
    examples: examples.length,
    judge_calls: judgeCalls,
    max_judge_calls: maxJudgeCalls,
    providers: [...providers],
  },
  label_snapshot: Object.fromEntries([...labels].map(([id, l]) => [id, { label_version: l.label_version, review_status: l.review_status }])),
  summary: {
    retrieval: retrievalSummary,
    decisions: decisionSummary,
    jev_reliability: decisionRows.some((r) => r.provider === "jev") ? reliability(decisionRows.filter((r) => r.provider === "jev")) : null,
    review_status_counts: [...labels.values()].reduce<Record<string, number>>((m, l) => ((m[l.review_status] = (m[l.review_status] ?? 0) + 1), m), {}),
    rows: decisionRows,
  },
};
const { error: repErr } = await admin.from("benchmark_reports").insert({
  batch_id: batchId,
  dataset_version: datasetVersion,
  label_snapshot: report.label_snapshot,
  config: report.config,
  summary: report.summary,
  is_mock: args.mock,
  notes: args.notes ?? null,
});
if (repErr) throw new Error(repErr.message);
mkdirSync("reports", { recursive: true });
const file = `reports/${report.created_at.slice(0, 10)}-${batchId.slice(0, 8)}${args.mock ? "-MOCK" : ""}.json`;
writeFileSync(file, JSON.stringify(report, null, 1));
console.log(`report: ${file}`);
if (retrievalSummary) {
  for (const s of retrievalSummary) {
    console.log(`${s.strategy.padEnd(8)} n=${s.n} MRR=${s.mrr.toFixed(3)} ` + RETRIEVAL_KS.map((k) => `R@${k}=${s.at_k[k].recall.toFixed(3)}`).join(" "));
  }
}
if (decisionSummary) {
  for (const d of decisionSummary) {
    for (const p of ["jev", "llm_judge"] as const) {
      const x = d[p];
      if (x) console.log(`${d.condition.padEnd(12)} ${p.padEnd(9)} n=${x.n} acc=${x.accuracy.toFixed(3)} macroF1=${x.macro_f1.toFixed(3)} FPR(sup)=${x.false_positive_rate_supported.toFixed(3)} valid=${x.valid_output_rate.toFixed(2)}`);
    }
    if (d.jev_vs_judge) console.log(`${d.condition.padEnd(12)} agreement=${d.jev_vs_judge.agreement.toFixed(3)} kappa=${d.jev_vs_judge.kappa.toFixed(3)} (agreement ≠ correctness)`);
  }
}

// ------------------------------------------------------------ helpers
function paced<A extends unknown[], R>(fn: (...a: A) => Promise<R>, minIntervalMs: number) {
  let last = 0;
  return async (...a: A) => {
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn(...a);
  };
}

function skipped(provider: ProviderOutcome["provider"]): ProviderOutcome {
  return { provider, model: null, status: "not_configured", decision: null, raw: null, latency_ms: 0, input_tokens: null, output_tokens: null, est_cost_usd: null, retries: 0, error: "provider excluded by --providers" };
}

function mockOutcome(provider: ProviderOutcome["provider"]): ProviderOutcome {
  return {
    provider,
    model: "MOCK",
    status: "ok",
    mocked: true,
    decision: {
      schema_version: "decision.v1",
      provider,
      model: "MOCK",
      label: "insufficient_evidence",
      explanation: { summary: "MOCK output for pipeline testing — not a model result.", kind: "derived" },
      evidence_refs: [],
      confidence: null,
    },
    raw: { mock: true },
    latency_ms: 0,
    input_tokens: null,
    output_tokens: null,
    est_cost_usd: 0,
    retries: 0,
    error: null,
  };
}
