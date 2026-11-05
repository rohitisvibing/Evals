import type { SupabaseClient } from "@supabase/supabase-js";
import { limits, providerModels, versions, EMBEDDING_DIM } from "../constants";
import { chunkPages } from "./chunk";
import { embedTexts, toPgVector } from "./embed";
import { PdfRejectedError, extractPdfPages, sha256Hex } from "./pdf";

export type ProcessResult =
  | { ok: true; documentId: string; pages: number; chunks: number; embedding_cost_usd: number | null }
  | { ok: false; documentId: string; error: string; duplicateOf?: string };

type Deps = {
  embed?: typeof embedTexts;
  /** Index lexical-only when no embedding key is configured (vector/hybrid then unavailable for this document). */
  allowMissingEmbeddings?: boolean;
};

/**
 * Download → validate → extract per-page text → chunk → embed → store.
 * Runs with the service-role client; callers must have verified ownership.
 * Status and errors are persisted on the document row.
 */
export async function processDocument(admin: SupabaseClient, documentId: string, deps: Deps = {}): Promise<ProcessResult> {
  const embed = deps.embed ?? embedTexts;
  const fail = async (error: string, extra: Partial<{ duplicateOf: string; byte_size: number }> = {}) => {
    await admin
      .from("documents")
      .update({ status: "failed", error, ...(extra.byte_size ? { byte_size: extra.byte_size } : {}) })
      .eq("id", documentId);
    return { ok: false as const, documentId, error, duplicateOf: extra.duplicateOf };
  };

  const { data: doc, error: docErr } = await admin.from("documents").select("*").eq("id", documentId).single();
  if (docErr || !doc) return { ok: false, documentId, error: "Document not found" };
  if (doc.status === "indexed") return { ok: true, documentId, pages: doc.page_count, chunks: -1, embedding_cost_usd: 0 };

  await admin.from("documents").update({ status: "processing", error: null }).eq("id", documentId);

  const { data: blob, error: dlErr } = await admin.storage.from("documents").download(doc.storage_path);
  if (dlErr || !blob) return fail("Uploaded file not found in storage");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength === 0) return fail("Uploaded file is empty");
  if (bytes.byteLength > limits.maxPdfBytes) return fail("PDF exceeds the 20 MB limit", { byte_size: bytes.byteLength });

  const sha = await sha256Hex(bytes);
  // Dedupe: identical bytes already indexed for this owner.
  const dupQuery = admin.from("documents").select("id").eq("sha256", sha).is("deleted_at", null).neq("id", documentId);
  const { data: dup } = await (doc.owner_id ? dupQuery.eq("owner_id", doc.owner_id) : dupQuery.is("owner_id", null)).maybeSingle();
  if (dup) return fail("This PDF has already been uploaded", { duplicateOf: dup.id, byte_size: bytes.byteLength });

  let pages: string[];
  let pageCount: number;
  try {
    const extracted = await extractPdfPages(bytes);
    pages = extracted.pages;
    pageCount = extracted.pageCount;
  } catch (e) {
    return fail(e instanceof PdfRejectedError ? e.message : "PDF text extraction failed", { byte_size: bytes.byteLength });
  }

  const chunks = chunkPages(sha, pages);
  if (chunks.length === 0) return fail("No text chunks could be produced from this PDF");

  const model = providerModels().embedding;
  let embedded: { vectors: (number[] | null)[]; model: string | null; est_cost_usd: number | null };
  if (!process.env.OPENROUTER_API_KEY && deps.allowMissingEmbeddings) {
    embedded = { vectors: chunks.map(() => null), model: null, est_cost_usd: null };
  } else {
    try {
      embedded = await embed(chunks.map((c) => c.content), { model });
    } catch (e) {
      return fail(`Embedding failed: ${(e as Error).message}`);
    }
  }

  // Replace any partial chunks from a previous failed attempt.
  await admin.from("document_chunks").delete().eq("document_id", documentId);
  const rows = chunks.map((c, i) => ({
    document_id: documentId,
    chunk_key: c.chunk_key,
    chunk_index: c.chunk_index,
    page_start: c.page_start,
    page_end: c.page_end,
    content: c.content,
    embedding: embedded.vectors[i] ? toPgVector(embedded.vectors[i]!) : null,
    embedding_model: embedded.model,
  }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await admin.from("document_chunks").insert(rows.slice(i, i + 200));
    if (error) return fail(`Storing chunks failed: ${error.message}`);
  }

  const { error: upErr } = await admin
    .from("documents")
    .update({
      status: "indexed",
      error: null,
      sha256: sha,
      byte_size: bytes.byteLength,
      page_count: pageCount,
      embedding_model: embedded.model,
      embedding_dim: embedded.model ? EMBEDDING_DIM : null,
      chunker_version: versions.chunker,
    })
    .eq("id", documentId);
  if (upErr) return fail(`Updating document failed: ${upErr.message}`);

  if (doc.owner_id && embedded.model) {
    await admin.from("usage_events").insert({ user_id: doc.owner_id, kind: "embedding", provider: "openrouter", est_cost_usd: embedded.est_cost_usd });
  }
  return { ok: true, documentId, pages: pageCount, chunks: chunks.length, embedding_cost_usd: embedded.est_cost_usd };
}
