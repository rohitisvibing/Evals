import { NextResponse } from "next/server";
import { isUuid, jsonError, requireUser } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Delete a private document: soft-delete the row, remove the stored PDF and
 * its chunks immediately. Run traces keep claim/labels but lose the document
 * link (FK on delete set null when the row is purged).
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  if (!isUuid(id)) return jsonError(400, "bad_id", "Invalid document id");

  const admin = supabaseAdmin();
  const { data: doc } = await admin
    .from("documents")
    .select("id, owner_id, storage_path, visibility")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!doc || doc.owner_id !== user.id || doc.visibility !== "private") return jsonError(404, "not_found", "Document not found");

  await admin.from("documents").update({ deleted_at: new Date().toISOString() }).eq("id", id);
  await admin.storage.from("documents").remove([doc.storage_path]);
  await admin.from("document_chunks").delete().eq("document_id", id);
  return NextResponse.json({ deleted: true });
}
