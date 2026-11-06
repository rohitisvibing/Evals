import { NextResponse } from "next/server";
import { isUuid, jsonError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getRunDetail } from "@/lib/runs";

/**
 * Evidence and both evaluators' verdicts for ONE benchmark run (public benchmark data,
 * like /benchmark). Live user runs are never returned.
 */
export async function GET(request: Request) {
  const run = new URL(request.url).searchParams.get("run") ?? "";
  if (!isUuid(run)) return jsonError(400, "bad_id", "run must be a benchmark run id");
  const admin = supabaseAdmin();
  const { data } = await admin.from("evaluation_runs").select("kind").eq("id", run).maybeSingle();
  if (!data || data.kind !== "benchmark") return jsonError(404, "not_found", "Benchmark run not found");
  const detail = await getRunDetail(admin, run);
  if (!detail) return jsonError(404, "not_found", "Benchmark run not found");
  return NextResponse.json({
    evidence: detail.evidence.map(({ id, page_start, page_end, text }) => ({ id, page_start, page_end, text })),
    verdicts: detail.results.map((r) => ({
      provider: r.provider, label: r.label, status: r.status, model: r.model,
      explanation: r.decision?.explanation.summary ?? r.error ?? null,
      confidence: r.decision?.confidence?.value ?? null,
    })),
  });
}
