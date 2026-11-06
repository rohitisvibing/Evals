// Build the adversarial evaluator set (qa.adv-v1) from data/golden/qa-adv-v1/cases.jsonl.
//
// For each case:
//  - evidence = the qa.v1.1 reference evidence for its question, plus any extra anchors
//    (resolved to the chunk on that page that contains the quote)
//  - grounding check: the case's fact_quote must appear verbatim in that evidence
//  - checker check (where it applies): the deterministic answer checker must agree with
//    the expected verdict (a wrong case must never pass; a control must pass)
//  - citation cases: {CITE_RIGHT}/{CITE_WRONG} become passage ids that do / don't contain the fact
// Writes data/golden/qa-adv-v1/items.jsonl and upserts benchmark_qa_items (dataset 'qa.adv-v1').
// No model calls. Usage: tsx scripts/build-qa-adversarial.ts
import "./_env";
import { readFileSync, writeFileSync } from "node:fs";
import { supabaseAdmin } from "../lib/supabase/admin";
import { checkAnswer, type QaQuestion } from "../lib/eval/answer-check";
import { normalizeForQuote } from "../lib/providers/openrouter";
import { loadExamples } from "../lib/eval/golden";

const DATASET = "qa.adv-v1";
const DIR = "data/golden/qa-adv-v1";
type Case = {
  case_id: string; question_id: string; question: string; answer: string; expected: "correct" | "incorrect"; category: string;
  fact_quote: string; rationale: string; spec: Pick<QaQuestion, "facts" | "any" | "none"> | null; checker_applies: boolean;
  anchors: { page: number; quote: string }[]; grounded: boolean;
};

const admin = supabaseAdmin();
const cases: Case[] = readFileSync(`${DIR}/cases.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const v1 = new Map(loadExamples("data/golden/v1/examples.jsonl").map((e) => [e.example_id, e]));
const baseItems = new Map(
  readFileSync("data/golden/qa-v1.1/items.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((i) => i.source === "reference").map((i) => [i.question_id as string, i]),
);
const { data: docs } = await admin.from("documents").select("id, benchmark_key").eq("visibility", "benchmark");
const docId = new Map((docs ?? []).map((d) => [d.benchmark_key as string, d.id as string]));

let errors = 0;
const fail = (id: string, msg: string) => { console.error(`${id}: ${msg}`); errors++; };
const items: Record<string, unknown>[] = [];
const ids = new Set<string>();

for (const c of cases) {
  if (ids.has(c.case_id)) fail(c.case_id, "duplicate case_id");
  ids.add(c.case_id);
  const ex = v1.get(c.question_id);
  const base = baseItems.get(c.question_id);
  if (!ex || !base) { fail(c.case_id, `unknown question_id ${c.question_id}`); continue; }
  const keys: string[] = [...base.evidence_keys];

  for (const a of c.anchors) {
    const { data: chunks } = await admin.from("document_chunks").select("chunk_key, content").eq("document_id", docId.get(ex.document_key)).eq("page_start", a.page);
    const hit = (chunks ?? []).find((ch) => normalizeForQuote(ch.content).includes(normalizeForQuote(a.quote)));
    if (!hit) { fail(c.case_id, `anchor not found on p${a.page}: ${a.quote}`); continue; }
    if (!keys.includes(hit.chunk_key)) keys.push(hit.chunk_key);
  }

  const { data: ev } = await admin.from("document_chunks").select("chunk_key, content").in("chunk_key", keys);
  const text = new Map((ev ?? []).map((ch) => [ch.chunk_key, ch.content as string]));
  const has = (k: string) => normalizeForQuote(text.get(k) ?? "").includes(normalizeForQuote(c.fact_quote));
  if (!keys.some(has)) fail(c.case_id, `fact_quote not in the evidence: ${c.fact_quote}`);

  let answer = c.answer;
  if (answer.includes("{CITE_")) {
    const right = keys.findIndex(has);
    const wrong = keys.findIndex((k) => !has(k));
    if (right < 0 || wrong < 0) fail(c.case_id, "cannot place citation ids");
    answer = answer.replace("{CITE_RIGHT}", `E${right + 1}`).replace("{CITE_WRONG}", `E${wrong + 1}`);
  }

  if (c.checker_applies && c.spec) {
    const q: QaQuestion = { id: c.case_id, question: c.question, reference: "", type: "numeric", ...c.spec };
    const v = checkAnswer(q, { text: answer }).verdict;
    if (c.expected === "correct" && v !== "correct") fail(c.case_id, `control graded ${v} by the checker: ${answer}`);
    if (c.expected === "incorrect" && v === "correct") fail(c.case_id, `wrong case graded correct by the checker: ${answer}`);
  }

  items.push({
    item_id: `adv:${c.case_id}`,
    question_id: c.question_id,
    document_key: ex.document_key,
    question: c.question,
    answer_text: answer,
    abstained: false,
    source: c.expected === "incorrect" ? "perturbation" : "reference",
    perturbation: c.expected === "incorrect" ? `adv_${c.category}` : null,
    truth_label: c.expected,
    truth_source: "construction",
    review_status: "auto",
    evidence_keys: keys,
    is_synthetic: !c.grounded,
    generator_model: null,
    // Extra fields (not stored in the DB table): used by the analysis.
    category: c.category,
    fact_quote: c.fact_quote,
    rationale: c.rationale,
    checker_verified: c.checker_applies,
  });
}

if (errors) {
  console.error(`${errors} problem(s); nothing written.`);
  process.exit(1);
}
writeFileSync(`${DIR}/items.jsonl`, items.map((i) => JSON.stringify(i)).join("\n") + "\n");
const rows = items.map(({ category: _c, fact_quote: _f, rationale: _r, checker_verified: _v, ...i }) => ({ dataset_version: DATASET, ...i }));
const { error } = await admin.from("benchmark_qa_items").upsert(rows, { onConflict: "dataset_version,item_id" });
if (error) throw new Error(error.message);
const tally = (f: (i: Record<string, unknown>) => string) => items.reduce<Record<string, number>>((m, i) => ((m[f(i)] = (m[f(i)] ?? 0) + 1), m), {});
console.log(JSON.stringify({ items: items.length, by_expected: tally((i) => String(i.truth_label)), by_category: tally((i) => String(i.category)), checker_verified: items.filter((i) => i.checker_verified).length }, null, 1));
