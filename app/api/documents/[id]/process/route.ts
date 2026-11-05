import { NextResponse } from "next/server";
import { isUuid, jsonError, requireUser } from "@/lib/http";
import { processDocument } from "@/lib/ingest/process";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const maxDuration = 300;

/** Step 2 of upload: validate the stored bytes, extract, chunk, embed, index. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  if (!isUuid(id)) return jsonError(400, "bad_id", "Invalid document id");

  const admin = supabaseAdmin();
  const { data: doc } = await admin
    .from("documents")
    .select("id, owner_id, status, storage_path")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!doc || doc.owner_id !== user.id) return jsonError(404, "not_found", "Document not found");
  if (doc.status === "processing") return jsonError(409, "in_progress", "This document is already being processed");
  if (doc.status === "indexed") return NextResponse.json({ ok: true, status: "indexed" });

  // Without an embedding key the document is indexed lexical-only (vector/hybrid disabled for it).
  const result = await processDocument(admin, id, { allowMissingEmbeddings: true });
  if (!result.ok) {
    // Failed uploads keep no stored bytes around.
    await admin.storage.from("documents").remove([doc.storage_path]);
    return jsonError(422, "processing_failed", result.error, result.duplicateOf ? { duplicateOf: result.duplicateOf } : {});
  }
  return NextResponse.json({ ok: true, status: "indexed", pages: result.pages, chunks: result.chunks });
}
