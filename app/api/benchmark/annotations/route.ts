import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireUser } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { FAILURE_CODES } from "@/lib/eval/taxonomy";

const body = z.object({
  result_id: z.string().uuid(),
  code: z.enum(Object.keys(FAILURE_CODES) as [keyof typeof FAILURE_CODES, ...(keyof typeof FAILURE_CODES)[]]),
  note: z.string().max(1000).optional(),
});

/** Admin-only: confirm/override a failure category for a benchmark result (source='human'). */
export async function POST(request: Request) {
  const user = await requireUser();
  if (user instanceof NextResponse) return user;
  if (!user.isAdmin) return jsonError(403, "forbidden", "Admins only");
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid_request", "Invalid annotation");

  const admin = supabaseAdmin();
  const { data: res } = await admin.from("evaluation_results").select("id, evaluation_runs!inner(kind)").eq("id", parsed.data.result_id).maybeSingle();
  if (!res || (res.evaluation_runs as unknown as { kind: string }).kind !== "benchmark") return jsonError(404, "not_found", "Benchmark result not found");
  const { error } = await admin.from("failure_annotations").insert({ ...parsed.data, source: "human", annotator: user.email });
  if (error) return jsonError(500, "db_error", "Could not save annotation");
  return NextResponse.json({ ok: true });
}
