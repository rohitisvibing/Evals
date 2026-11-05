import { NextResponse } from "next/server";
import { listReports } from "@/lib/reports";
import { loadExamplesCached } from "@/lib/golden-server";
import { isUuid, jsonError } from "@/lib/http";

/** Public export of one benchmark report (benchmark data only — no user documents or secrets). */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const batch = url.searchParams.get("batch") ?? "";
  const format = url.searchParams.get("format") === "json" ? "json" : "csv";
  if (!isUuid(batch)) return jsonError(400, "bad_batch", "batch must be a report batch id");
  const report = (await listReports(true)).find((r) => r.batch_id === batch);
  if (!report) return jsonError(404, "not_found", "Report not found");
  const claims = loadExamplesCached().byId;

  if (format === "json") {
    return new NextResponse(JSON.stringify(report, null, 1), {
      headers: { "content-type": "application/json", "content-disposition": `attachment; filename="benchmark-${batch}.json"` },
    });
  }
  const cols = ["example_id", "claim", "condition", "provider", "gold", "pred", "status", "correct", "failure", "citation_valid", "evidence_recall", "latency_ms", "est_cost_usd", "confidence", "ambiguous", "categories", "label_version", "review_status", "is_mock"];
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of report.summary.rows) {
    const snap = report.label_snapshot[r.example_id];
    lines.push([
      r.example_id, claims.get(r.example_id)?.claim, r.condition, r.provider, r.gold, r.pred, r.status, r.pred === r.gold, r.failure, r.citation_valid,
      r.evidence_recall, r.latency_ms, r.est_cost_usd, r.confidence, r.ambiguous, r.categories.join("|"), snap?.label_version, snap?.review_status, report.is_mock,
    ].map(esc).join(","));
  }
  return new NextResponse(lines.join("\n"), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="benchmark-${batch}.csv"` },
  });
}
