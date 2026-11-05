// Consistency checks for the QA golden set (no model calls):
//  1. every question id exists in golden v1 (so evidence anchors carry over)
//  2. the answer checker grades every reference answer CORRECT
//  3. the checker never grades a constructed mistake CORRECT (otherwise it is dropped)
// Usage: tsx scripts/check-qa-golden.ts
import { readFileSync } from "node:fs";
import { checkAnswer, type QaQuestion } from "../lib/eval/answer-check";
import { perturbations } from "../lib/eval/perturb";
import { loadExamples } from "../lib/eval/golden";

const qs: QaQuestion[] = readFileSync("data/golden/qa-v1/questions.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const v1 = new Map(loadExamples("data/golden/v1/examples.jsonl").map((e) => [e.example_id, e]));
let errors = 0;
const counts: Record<string, number> = {};
for (const q of qs) {
  if (!v1.has(q.id)) { console.error(`${q.id}: not in golden v1`); errors++; }
  const ref = checkAnswer(q, { text: q.reference, abstained: q.type === "unanswerable" });
  if (ref.verdict !== "correct") { console.error(`${q.id}: reference graded ${ref.verdict} (${ref.reason}) :: ${q.reference}`); errors++; }
  for (const p of perturbations(q)) {
    const r = checkAnswer(q, { text: p.text, abstained: p.type === "false_abstention" });
    if (r.verdict === "correct") { console.error(`${q.id}: ${p.type} graded CORRECT :: ${p.text}`); errors++; }
    counts[`${p.type}:${r.verdict}`] = (counts[`${p.type}:${r.verdict}`] ?? 0) + 1;
  }
}
console.log(JSON.stringify({ questions: qs.length, perturbation_checker_verdicts: counts, errors }));
process.exit(errors ? 1 : 0);
