import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireUser } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { versions } from "@/lib/constants";

const body = z.object({ example_id: z.string().max(40), action: z.enum(["reviewed", "disputed"]), note: z.string().max(1000).default("") });

/** Admin-only: append a reviewed/disputed label version. Never edits prior versions. */
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  if (!user.isAdmin) return jsonError(403, "forbidden", "Admins only");
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid_request", "Invalid review");
  if (parsed.data.action === "disputed" && !parsed.data.note.trim()) return jsonError(400, "note_required", "A note is required to dispute a label");

  const admin = supabaseAdmin();
  const { data: latest } = await admin
    .from("benchmark_labels")
    .select("*")
    .eq("dataset_version", versions.dataset)
    .eq("example_id", parsed.data.example_id)
    .order("label_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latest) return jsonError(404, "not_found", "Unknown example");

  const { id: _id, created_at: _c, ...rest } = latest;
  const next = {
    ...rest,
    label_version: latest.label_version + 1,
    review_status: parsed.data.action,
    reviewer: user.email,
    reviewed_at: new Date().toISOString(),
    rationale: parsed.data.note ? `${latest.rationale}\n[review ${new Date().toISOString().slice(0, 10)}] ${parsed.data.note}` : latest.rationale,
  };
  const { error } = await admin.from("benchmark_labels").insert(next);
  if (error) return jsonError(500, "db_error", "Could not save review");
  return NextResponse.json({ label_version: next.label_version });
}
