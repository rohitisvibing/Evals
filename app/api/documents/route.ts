import { NextResponse } from "next/server";
import { z } from "zod";
import { limits } from "@/lib/constants";
import { jsonError, requireUser, throttle } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";

/** List documents the caller can read (own + benchmark), via RLS. */
export async function GET() {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, visibility, status, error, page_count, byte_size, created_at, benchmark_key")
    .order("created_at", { ascending: false });
  if (error) return jsonError(500, "db_error", "Could not list documents");
  return NextResponse.json({ documents: data });
}

const createBody = z.object({
  filename: z.string().min(1).max(255),
  size: z.number().int().positive().max(limits.maxPdfBytes),
  contentType: z.literal("application/pdf"),
});

/**
 * Step 1 of upload: create a document row and a signed upload URL for a
 * server-generated storage path. The browser uploads directly to Storage
 * (avoids the host's request-body limit); step 2 (/process) re-validates bytes.
 */
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;

  const parsed = createBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(400, "invalid_upload", `Only PDF files up to ${limits.maxPdfBytes / 1024 / 1024} MB are accepted.`);
  }
  const limited = await throttle(user, "upload", limits.uploadsPerUserPerHour, 30, 3600);
  if (limited) return limited;

  const admin = supabaseAdmin();
  const { count } = await admin
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", user.id)
    .is("deleted_at", null);
  if ((count ?? 0) >= limits.maxDocumentsPerUser && !user.isAdmin) {
    return jsonError(409, "document_limit", `You can keep up to ${limits.maxDocumentsPerUser} documents. Delete one to upload another.`);
  }

  const id = crypto.randomUUID();
  const storagePath = `${user.id}/${id}.pdf`; // never derived from the client filename
  const title = sanitizeTitle(parsed.data.filename);

  const { error: insErr } = await admin.from("documents").insert({
    id,
    owner_id: user.id,
    visibility: "private",
    title,
    storage_path: storagePath,
    status: "pending_upload",
  });
  if (insErr) return jsonError(500, "db_error", "Could not create document");

  const { data: signed, error: signErr } = await admin.storage.from("documents").createSignedUploadUrl(storagePath);
  if (signErr || !signed) {
    await admin.from("documents").delete().eq("id", id);
    return jsonError(500, "storage_error", "Could not create upload URL");
  }
  return NextResponse.json({ documentId: id, path: signed.path, token: signed.token });
}

function sanitizeTitle(name: string): string {
  const base = name.replace(/\.pdf$/i, "").replace(/[^\p{L}\p{N} ._()&,-]+/gu, " ").replace(/\s+/g, " ").trim();
  return (base || "Untitled document").slice(0, 200);
}
