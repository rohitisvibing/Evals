// Build the QA golden set's candidate answers (qa.v1) and freeze them.
//
// For each question:
//   evidence: oracle passages (gold + fixed distractors) and hybrid top-8
//   candidates:
//     reference      — the reference answer (correct by construction)
//     rag_oracle     — the RAG generator's answer on oracle passages  (truth from the answer checker)
//     rag_hybrid     — the RAG generator's answer on hybrid retrieval (truth from the answer checker)
//     perturbation×≤2 — controlled mistakes (incorrect by construction)
// RAG answers the checker can't decide are stored as needs_review and excluded
// from scoring until reviewed. No Jev or judge output is used for truth.
//
// Writes data/golden/qa-v1/items.jsonl (committed) and upserts benchmark_qa_items.
// Usage: tsx scripts/build-qa-golden.ts [--limit N] [--regenerate]
import "./_env";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { supabaseAdmin } from "../lib/supabase/admin";
import { checkAnswer, type QaQuestion } from "../lib/eval/answer-check";
import { perturbations, type Perturbation } from "../lib/eval/perturb";
import { oracleKeys } from "../lib/eval/oracle";
import { loadExamples } from "../lib/eval/golden";
import { generateAnswer } from "../lib/providers/generator";
import { retrieve, toPassages } from "../lib/retrieval";
import { providerModels, versions } from "../lib/constants";

const { values: args } = parseArgs({
  options: {
    limit: { type: "string" },
    regenerate: { type: "boolean", default: false },
    version: { type: "string", default: versions.qaDataset },
    // Reuse RAG answers from an earlier build when the evidence is identical.
    cache: { type: "string", default: "data/golden/qa-v1/items.jsonl" },
  },
});
const DATASET = args.version!;
const OUT = DATASET === "qa.v1" ? "data/golden/qa-v1/items.jsonl" : `data/golden/${DATASET.replace(/^qa\./, "qa-")}/items.jsonl`;
// qa.v1.1: (1) extend evidence across chunk boundaries, (2) exclude questions flagged ambiguous in golden v1.
const EXTEND_BOUNDARY = DATASET !== "qa.v1";
const admin = supabaseAdmin();
const models = providerModels();

let questions: QaQuestion[] = readFileSync("data/golden/qa-v1/questions.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
if (args.limit) questions = questions.slice(0, Number(args.limit));
const v1 = new Map(loadExamples("data/golden/v1/examples.jsonl").map((e) => [e.example_id, e]));
const resolved = JSON.parse(readFileSync("data/golden/v1/resolved.json", "utf8")).resolved as Record<string, { groups: string[][] }>;
const { data: docs } = await admin.from("documents").select("id, benchmark_key, embedding_model").eq("visibility", "benchmark");
const docByKey = new Map((docs ?? []).map((d) => [d.benchmark_key as string, d]));
for (const d of docByKey.values()) {
  if (d.embedding_model !== models.embedding) throw new Error("Benchmark documents need embeddings (run scripts/embed-missing.ts).");
}

export type QaItem = {
  item_id: string; question_id: string; document_key: string; question: string; answer_text: string; abstained: boolean;
  source: "reference" | "rag_oracle" | "rag_hybrid" | "perturbation"; perturbation: Perturbation["type"] | null;
  truth_label: "correct" | "incorrect"; truth_source: "reference" | "construction" | "review"; review_status: "auto" | "needs_review" | "reviewed" | "excluded";
  check_reason: string | null; evidence_keys: string[]; is_synthetic: boolean; generator_model: string | null;
  generator_host?: string | null; generator_cost_usd?: number | null;
};

const existing = new Map<string, QaItem>();
for (const file of [args.cache!, OUT]) {
  if (!existsSync(file) || args.regenerate) continue;
  for (const l of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const it = JSON.parse(l) as QaItem;
    existing.set(it.item_id, it);
  }
}

/**
 * When a labelled quote ends near the end of its chunk, the sentence it starts
 * usually continues in the next chunk (e.g. q3-035: "Fuel expenses declined $27 million
 * (3.4%) in" | "...the third quarter and $235 million (9.5%) in the first nine months").
 * Add that following chunk (same document, same page) so the evaluators see the fact.
 */
async function withBoundaryContinuations(questionId: string, keys: string[]): Promise<string[]> {
  if (!EXTEND_BOUNDARY) return keys;
  const ex = v1.get(questionId)!;
  const { data } = await admin.from("document_chunks").select("chunk_key, chunk_index, page_start, document_id, content").in("chunk_key", keys);
  const extra: string[] = [];
  for (const c of data ?? []) {
    const norm = (t: string) => t.replace(/\s+/g, " ").toLowerCase();
    const content = norm(c.content);
    for (const a of ex.evidence_groups.flat()) {
      const at = content.indexOf(norm(a.quote));
      if (at === -1 || content.length - (at + norm(a.quote).length) > 120) continue;
      const { data: next } = await admin.from("document_chunks").select("chunk_key, page_start").eq("document_id", c.document_id).eq("chunk_index", c.chunk_index + 1).maybeSingle();
      if (next && next.page_start === c.page_start && !keys.includes(next.chunk_key)) extra.push(next.chunk_key);
    }
  }
  if (!extra.length) return keys;
  // Insert each continuation right after its chunk so the text reads in order.
  const out = [...keys];
  for (const k of [...new Set(extra)]) {
    const prevIndex = (data ?? []).find((c) => c.chunk_key.split(":c")[0] === k.split(":c")[0] && Number(k.split(":c")[1]) === Number(c.chunk_key.split(":c")[1]) + 1);
    const pos = prevIndex ? out.indexOf(prevIndex.chunk_key) + 1 : out.length;
    out.splice(pos, 0, k);
  }
  return out;
}
const AMBIGUOUS = new Set([...v1.values()].filter((e) => e.ambiguous).map((e) => e.example_id));

async function passagesFor(keys: string[]) {
  const { data } = await admin.from("document_chunks").select("chunk_key, page_start, page_end, content").in("chunk_key", keys);
  const m = new Map((data ?? []).map((c) => [c.chunk_key, c]));
  return toPassages(keys.map((k) => m.get(k)!).filter(Boolean));
}

const PREFERRED: Perturbation["type"][] = ["number_shift", "unit_swap", "direction_flip", "fabricated_answer", "false_abstention"];
const items: QaItem[] = [];
const regenerated = new Set<string>();
let genCost = 0;
for (const q of questions) {
  const ex = v1.get(q.id)!;
  const doc = docByKey.get(ex.document_key)!;
  const hybrid = await retrieve(admin, { documentId: doc.id, claim: q.question, strategy: "hybrid", k: 10, embeddingModel: models.embedding });
  const hybridKeys = hybrid.chunks.map((c) => c.chunk_key);
  const { keys: baseOracle } = oracleKeys(resolved[q.id].groups, hybridKeys, q.id);
  const oracle = await withBoundaryContinuations(q.id, baseOracle);
  const base = { question_id: q.id, document_key: ex.document_key, question: q.question, is_synthetic: false, generator_model: null };

  items.push({ ...base, item_id: `${q.id}:reference`, answer_text: q.reference, abstained: q.type === "unanswerable", source: "reference", perturbation: null, truth_label: "correct", truth_source: "construction", review_status: "auto", check_reason: null, evidence_keys: oracle });

  for (const [source, keys] of [["rag_oracle", oracle], ["rag_hybrid", hybridKeys.slice(0, 8)]] as const) {
    const id = `${q.id}:${source}`;
    const cached = existing.get(id);
    // Reuse a cached answer only if it was generated from exactly the same evidence.
    if (cached && cached.evidence_keys.join("|") === [...keys].join("|")) { items.push({ ...cached, truth_source: cached.truth_source === "review" ? "reference" : cached.truth_source }); continue; }
    regenerated.add(id);
    const gen = await generateAnswer(q.question, await passagesFor(keys));
    if (gen.status !== "ok" || !gen.text) { console.warn(`${id}: generation ${gen.status} ${gen.error ?? ""}`); continue; }
    genCost += gen.est_cost_usd ?? 0;
    const check = checkAnswer(q, { text: gen.text, abstained: gen.abstained });
    items.push({
      ...base, item_id: id, answer_text: gen.text, abstained: gen.abstained, source, perturbation: null,
      truth_label: check.verdict === "correct" ? "correct" : "incorrect", truth_source: "reference",
      review_status: check.verdict === "needs_review" ? "needs_review" : "auto", check_reason: check.reason,
      evidence_keys: [...keys], generator_model: gen.model, generator_host: gen.host, generator_cost_usd: gen.est_cost_usd,
    });
  }

  const ps = perturbations(q).sort((a, b) => PREFERRED.indexOf(a.type) - PREFERRED.indexOf(b.type)).slice(0, q.type === "unanswerable" ? 1 : 2);
  for (const p of ps) {
    items.push({ ...base, item_id: `${q.id}:${p.type}`, answer_text: p.text, abstained: p.type === "false_abstention", source: "perturbation", perturbation: p.type, truth_label: "incorrect", truth_source: "construction", review_status: "auto", check_reason: null, evidence_keys: oracle, is_synthetic: true });
  }
  process.stdout.write(".");
}
console.log();

// Human/annotator review overrides win over the automatic checker, but only for the exact
// answers that were reviewed: a regenerated answer is new and goes through the checker again.
const reviewFile = OUT.replace(/items\.jsonl$/, "review.json");
const review = existsSync(reviewFile)
  ? (JSON.parse(readFileSync(reviewFile, "utf8")).overrides as Record<string, { truth_label: "correct" | "incorrect"; review_status: "reviewed" | "excluded"; note: string; reviewer: string }>)
  : {};
for (const it of items) {
  const r = review[it.item_id];
  if (!r || regenerated.has(it.item_id)) continue;
  Object.assign(it, { truth_label: r.truth_label, review_status: r.review_status, truth_source: "review", check_reason: `${it.check_reason ?? ""} | review: ${r.note} (${r.reviewer})` });
}
// Questions flagged ambiguous in golden v1 are not scored in later versions.
if (EXTEND_BOUNDARY) {
  for (const it of items) if (AMBIGUOUS.has(it.question_id)) Object.assign(it, { review_status: "excluded", check_reason: `${it.check_reason ?? ""} | excluded: question flagged ambiguous in golden v1` });
}
const unresolved = items.filter((i) => i.review_status === "needs_review").map((i) => i.item_id);
if (unresolved.length) console.warn(`needs_review (excluded until reviewed): ${unresolved.join(", ")}`);
const fresh = items.filter((i) => regenerated.has(i.item_id));
if (fresh.length) {
  console.log("\nRegenerated answers (check these labels):");
  for (const i of fresh) console.log(`  ${i.item_id} [${i.review_status === "needs_review" ? "REVIEW" : i.truth_label}] ${i.answer_text.slice(0, 200)} || ${i.check_reason}`);
}

writeFileSync(OUT, items.map((i) => JSON.stringify(i)).join("\n") + "\n");
const rows = items.map(({ check_reason: _c, generator_host: _h, generator_cost_usd: _g, ...i }) => ({ dataset_version: DATASET, ...i }));
for (let i = 0; i < rows.length; i += 200) {
  const { error } = await admin.from("benchmark_qa_items").upsert(rows.slice(i, i + 200), { onConflict: "dataset_version,item_id" });
  if (error) throw new Error(error.message);
}
const tally = (f: (i: QaItem) => string) => items.reduce<Record<string, number>>((m, i) => ((m[f(i)] = (m[f(i)] ?? 0) + 1), m), {});
console.log(JSON.stringify({
  items: items.length,
  by_source: tally((i) => i.source),
  truth: tally((i) => (["needs_review", "excluded"].includes(i.review_status) ? i.review_status : i.truth_label)),
  rag_truth: tally((i) => (i.source.startsWith("rag") ? `${i.source}:${i.review_status === "needs_review" ? "review" : i.truth_label}` : "-")),
  new_generation_cost_usd: Number(genCost.toFixed(5)),
}, null, 1));
