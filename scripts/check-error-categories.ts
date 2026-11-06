// Consistency checks for error-category labels (no model calls):
//  - every annotation refers to an existing qa.v1.1 item that is a real (non-constructed) wrong answer
//  - every category is in the taxonomy
//  - every wrong item in qa.v1.1 ends up with exactly one category (or unclassified)
//  - every adversarial case carries a taxonomy category
// Usage: tsx scripts/check-error-categories.ts
import { readFileSync } from "node:fs";
import { categorize, isErrorCategory, type Annotation } from "../lib/eval/error-categories";
import { loadExamples } from "../lib/eval/golden";

const jsonl = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const items = new Map(jsonl("data/golden/qa-v1.1/items.jsonl").map((i) => [i.item_id, i]));
const ann = JSON.parse(readFileSync("data/golden/qa-v1.1/error-categories.json", "utf8")).annotations as Record<string, Annotation>;
const tags = new Map(loadExamples("data/golden/v1/examples.jsonl").map((e) => [e.example_id, e.categories]));
let errors = 0;
const fail = (m: string) => (console.error(m), errors++);

for (const [id, a] of Object.entries(ann)) {
  const it = items.get(id);
  if (!it) fail(`${id}: annotation for an unknown item`);
  else if (it.truth_label !== "incorrect" || !it.source.startsWith("rag")) fail(`${id}: annotation on a non-RAG or correct item`);
  if (!isErrorCategory(a.category)) fail(`${id}: unknown category ${a.category}`);
  if (!a.note?.trim()) fail(`${id}: missing note`);
}
const counts: Record<string, number> = {};
for (const it of items.values()) {
  if (it.truth_label !== "incorrect" || it.review_status === "excluded" || it.review_status === "needs_review") continue;
  const c = categorize({ item_id: it.item_id, truth: "incorrect", perturbation: it.perturbation, question_tags: tags.get(it.question_id) ?? [] }, ann);
  if (c.categories.length !== 1) fail(`${it.item_id}: ${c.categories.length} categories`);
  counts[c.categories[0]] = (counts[c.categories[0]] ?? 0) + 1;
}
for (const it of jsonl("data/golden/qa-adv-v1/items.jsonl")) if (!isErrorCategory(it.category)) fail(`${it.item_id}: bad category ${it.category}`);
console.log(JSON.stringify({ annotations: Object.keys(ann).length, disputed: Object.values(ann).filter((a) => a.disputed).length, wrong_by_category: counts, errors }, null, 1));
process.exit(errors ? 1 : 0);
