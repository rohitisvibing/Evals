// Evidence completeness: for every answerable question, each key fact must be
// present in the oracle evidence the evaluators receive (and in the chunk text).
// Reports questions whose evidence is incomplete. Usage: tsx scripts/check-qa-evidence.ts
import "./_env";
import { readFileSync } from "node:fs";
import { supabaseAdmin } from "../lib/supabase/admin";
import { extractNumbers, factSatisfied, type QaQuestion } from "../lib/eval/answer-check";

const admin = supabaseAdmin();
const qs: QaQuestion[] = readFileSync("data/golden/qa-v1/questions.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const items = readFileSync("data/golden/qa-v1/items.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const refKeys = new Map(items.filter((i) => i.source === "reference").map((i) => [i.question_id, i.evidence_keys as string[]]));
const { data } = await admin.from("document_chunks").select("chunk_key, content").in("chunk_key", [...new Set([...refKeys.values()].flat())]);
const text = new Map((data ?? []).map((c) => [c.chunk_key, c.content as string]));
const bad: { id: string; missing: string[] }[] = [];
for (const q of qs) {
  if (q.type === "unanswerable" || !q.facts.length) continue;
  const ev = (refKeys.get(q.id) ?? []).map((k) => text.get(k) ?? "").join("\n");
  const nums = extractNumbers(ev);
  const missing = q.facts.filter((f) => !factSatisfied(f, nums)).map((f) => `${f.k}:${f.v}`);
  if (missing.length) bad.push({ id: q.id, missing });
}
console.log(JSON.stringify({ checked: qs.filter((q) => q.type !== "unanswerable" && q.facts.length).length, incomplete: bad.length, bad }, null, 1));
