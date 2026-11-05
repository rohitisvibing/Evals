import { NextResponse } from "next/server";
import { isUuid, jsonError, requireUser } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Short-lived (60 s) signed URL for the owner of a private document, or for a benchmark document. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  if (!isUuid(id)) return jsonError(400, "bad_id", "Invalid document id");

  const admin = supabaseAdmin();
  const { data: doc } = await admin
    .from("documents")
    .select("owner_id, visibility, storage_path, status")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!doc || (doc.visibility === "private" && doc.owner_id !== user.id)) return jsonError(404, "not_found", "Document not found");

  const { data, error } = await admin.storage.from("documents").createSignedUrl(doc.storage_path, 60);
  if (error || !data) return jsonError(404, "not_found", "File not available");
  return NextResponse.redirect(data.signedUrl, { status: 303 });
}
