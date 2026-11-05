// Upload + index the golden-set source PDFs and load examples/labels into Supabase.
// Idempotent: existing documents (by benchmark_key) and label versions are left untouched.
// Usage: tsx scripts/seed-benchmark.ts [version=v1]
import "./_env";
import { readFileSync } from "node:fs";
import { supabaseAdmin } from "../lib/supabase/admin";
import { processDocument } from "../lib/ingest/process";
import { ensureGoldenPdf, loadExamples, GOLDEN_PROVENANCE, type GoldenDoc } from "../lib/eval/golden";
import { versions } from "../lib/constants";

const version = process.argv[2] ?? "v1";
const datasetVersion = `golden.${version}`;
const dir = `data/golden/${version}`;
const admin = supabaseAdmin();

const docs: GoldenDoc[] = JSON.parse(readFileSync(`${dir}/documents.json`, "utf8"));
for (const d of docs) {
  const { data: existing } = await admin.from("documents").select("id, status, embedding_model").eq("benchmark_key", d.document_key).maybeSingle();
  if (existing?.status === "indexed") {
    console.log(`${d.document_key}: already indexed (${existing.embedding_model ?? "lexical-only"})`);
    continue;
  }
  const path = `benchmark/${d.document_key}.pdf`;
  const bytes = await ensureGoldenPdf(d);
  const up = await admin.storage.from("documents").upload(path, bytes, { contentType: "application/pdf", upsert: true });
  if (up.error) throw new Error(`upload ${d.document_key}: ${up.error.message}`);
  let id = existing?.id;
  if (!id) {
    const { data, error } = await admin
      .from("documents")
      .insert({ visibility: "benchmark", title: d.title, storage_path: path, benchmark_key: d.document_key, source_url: d.source_url, status: "processing" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    id = data.id;
  }
  const res = await processDocument(admin, id!, { allowMissingEmbeddings: true });
  console.log(`${d.document_key}:`, res);
  if (!res.ok) process.exit(1);
}

const resolved = JSON.parse(readFileSync(`${dir}/resolved.json`, "utf8")).resolved as Record<string, { groups: string[][]; pages: number[] }>;
const examples = loadExamples(`${dir}/examples.jsonl`);
let inserted = 0;
for (const ex of examples) {
  await admin.from("benchmark_examples").upsert(
    { dataset_version: datasetVersion, example_id: ex.example_id, document_key: ex.document_key, claim: ex.claim, categories: ex.categories, is_synthetic: ex.is_synthetic ?? false },
    { onConflict: "dataset_version,example_id", ignoreDuplicates: true },
  );
  const { error } = await admin.from("benchmark_labels").insert({
    dataset_version: datasetVersion,
    example_id: ex.example_id,
    label_version: 1,
    gold_label: ex.gold_label,
    evidence_anchors: ex.evidence_groups,
    relevant_chunk_keys: resolved[ex.example_id].groups.flat(),
    relevant_pages: resolved[ex.example_id].pages,
    rationale: ex.rationale,
    calculation: ex.calculation ?? null,
    provenance: GOLDEN_PROVENANCE + ` Chunker ${versions.chunker}.`,
  });
  if (!error) inserted++;
  else if (!/duplicate key/.test(error.message)) throw new Error(`${ex.example_id}: ${error.message}`);
}
console.log(`examples: ${examples.length}, new labels inserted: ${inserted}`);
