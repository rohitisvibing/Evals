// Back-fill embeddings for indexed documents whose chunks have none (e.g. indexed
// before an OpenRouter key existed). Chunk text and keys are untouched, so
// benchmark labels stay valid. Usage: tsx scripts/embed-missing.ts
import "./_env";
import { supabaseAdmin } from "../lib/supabase/admin";
import { embedTexts, toPgVector } from "../lib/ingest/embed";
import { EMBEDDING_DIM, providerModels } from "../lib/constants";

const admin = supabaseAdmin();
const model = providerModels().embedding;
const { data: docs, error } = await admin
  .from("documents")
  .select("id, title, embedding_model")
  .eq("status", "indexed")
  .is("deleted_at", null);
if (error) throw new Error(error.message);

let total = 0;
for (const d of docs ?? []) {
  if (d.embedding_model === model) continue;
  const { data: chunks } = await admin.from("document_chunks").select("id, content").eq("document_id", d.id).order("chunk_index");
  if (!chunks?.length) continue;
  const res = await embedTexts(chunks.map((c) => c.content), { model });
  for (let i = 0; i < chunks.length; i++) {
    const { error: e } = await admin.from("document_chunks").update({ embedding: toPgVector(res.vectors[i]), embedding_model: model }).eq("id", chunks[i].id);
    if (e) throw new Error(e.message);
  }
  await admin.from("documents").update({ embedding_model: model, embedding_dim: EMBEDDING_DIM }).eq("id", d.id);
  total += res.est_cost_usd ?? 0;
  console.log(`${d.title}: ${chunks.length} chunks embedded (${res.tokens} tokens)`);
}
console.log(`done. estimated embedding cost $${total.toFixed(5)}`);
