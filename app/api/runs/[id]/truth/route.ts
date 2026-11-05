import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid, jsonError, requireUser } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";
import { getScoreboard } from "@/lib/runs";

const body = z.object({ label: z.enum(["correct", "incorrect"]).nullable() });

/** The owner marks a live answer correct or wrong (or clears the mark). Never trusted from anyone else. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  const { id } = await params;
  if (!isUuid(id)) return jsonError(400, "bad_id", "Invalid run id");
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid_request", "label must be correct, incorrect or null");

  const admin = supabaseAdmin();
  const { data: run } = await admin.from("evaluation_runs").select("id, user_id, kind, mode, status").eq("id", id).maybeSingle();
  if (!run || run.user_id !== user.id || run.kind !== "live") return jsonError(404, "not_found", "Run not found");
  if (run.mode !== "qa" || !["completed", "partial", "failed"].includes(run.status)) {
    return jsonError(409, "not_gradable", "Only finished answers can be marked.");
  }
  const label = parsed.data.label;
  const { error } = await admin
    .from("evaluation_runs")
    .update({ truth_label: label, truth_source: label ? "user" : null, truth_at: label ? new Date().toISOString() : null })
    .eq("id", id);
  if (error) return jsonError(500, "db_error", "Could not save your mark");
  return NextResponse.json({ ok: true, label, scoreboard: await getScoreboard(await supabaseServer(), user.id) });
}
