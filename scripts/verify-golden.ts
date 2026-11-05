// Verify the golden dataset against the source PDFs and resolve anchors to chunk keys.
//  - every anchor quote must appear (whitespace/quote-normalized) on its stated page
//  - every `check.expr` (arithmetic only) must evaluate to `check.approx` within `tol`
//  - writes data/golden/<version>/resolved.json: example_id -> groups of chunk keys
// Usage: tsx scripts/verify-golden.ts [version=v1]
import { readFileSync, writeFileSync } from "node:fs";
import { extractPdfPages, sha256Hex } from "../lib/ingest/pdf";
import { chunkPages } from "../lib/ingest/chunk";
import { normalizeForQuote } from "../lib/providers/judge";
import { ensureGoldenPdf, loadExamples, type GoldenDoc } from "../lib/eval/golden";

const version = process.argv[2] ?? "v1";
const dir = `data/golden/${version}`;
const docs: GoldenDoc[] = JSON.parse(readFileSync(`${dir}/documents.json`, "utf8"));
const examples = loadExamples(`${dir}/examples.jsonl`);

const byDoc = new Map<string, { pages: string[]; chunks: ReturnType<typeof chunkPages> }>();
for (const d of docs) {
  const bytes = await ensureGoldenPdf(d);
  const sha = await sha256Hex(bytes);
  const { pages } = await extractPdfPages(bytes);
  byDoc.set(d.document_key, { pages, chunks: chunkPages(sha, pages) });
}

let errors = 0;
const resolved: Record<string, { groups: string[][]; pages: number[] }> = {};
const seen = new Set<string>();
for (const ex of examples) {
  if (seen.has(ex.example_id)) { console.error(`DUPLICATE id ${ex.example_id}`); errors++; }
  seen.add(ex.example_id);
  const doc = byDoc.get(ex.document_key);
  if (!doc) { console.error(`${ex.example_id}: unknown document ${ex.document_key}`); errors++; continue; }
  const groups: string[][] = [];
  const pages = new Set<number>();
  for (const group of ex.evidence_groups) {
    const keys = new Set<string>();
    for (const a of group) {
      const q = normalizeForQuote(a.quote);
      if (!normalizeForQuote(doc.pages[a.page - 1] ?? "").includes(q)) {
        console.error(`${ex.example_id}: quote not on page ${a.page}: "${a.quote}"`);
        errors++;
        continue;
      }
      pages.add(a.page);
      const hits = doc.chunks.filter((c) => c.page_start === a.page && normalizeForQuote(c.content).includes(q));
      if (!hits.length) { console.error(`${ex.example_id}: quote spans a chunk boundary: "${a.quote}"`); errors++; }
      hits.forEach((c) => keys.add(c.chunk_key));
    }
    groups.push([...keys]);
  }
  if (ex.check) {
    if (!/^[\d\s.+\-*/()]+$/.test(ex.check.expr)) { console.error(`${ex.example_id}: unsafe expr`); errors++; }
    else {
      const v = Function(`"use strict"; return (${ex.check.expr});`)() as number;
      if (Math.abs(v - ex.check.approx) > ex.check.tol) {
        console.error(`${ex.example_id}: check ${ex.check.expr} = ${v}, expected ${ex.check.approx}±${ex.check.tol}`);
        errors++;
      }
    }
  }
  resolved[ex.example_id] = { groups, pages: [...pages].sort((a, b) => a - b) };
}

const counts = examples.reduce<Record<string, number>>((m, e) => ((m[e.gold_label] = (m[e.gold_label] ?? 0) + 1), m), {});
console.log(JSON.stringify({ version, examples: examples.length, labels: counts, errors }));
if (errors) process.exit(1);
writeFileSync(`${dir}/resolved.json`, JSON.stringify({ chunker: "chunk.v1", resolved }, null, 1));
console.log(`wrote ${dir}/resolved.json`);
