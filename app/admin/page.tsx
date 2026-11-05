import { notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { latencyStats } from "@/lib/eval/metrics";
import { Stat, ms, usd } from "@/components/ui";
import { Metric } from "@/components/Metric";
import { currentMonthKey } from "@/lib/quota";

export const dynamic = "force-dynamic";

/** Aggregate operational view. Deliberately shows no claims or document text. */
export default async function AdminPage() {
  const user = await getSessionUser();
  if (!user?.isAdmin) notFound();
  const admin = supabaseAdmin();
  const since = new Date(Date.now() - 30 * 864e5).toISOString();

  const [{ data: results }, { data: events }, { data: usage }, { count: docCount }, { data: runs }] = await Promise.all([
    admin.from("evaluation_results").select("provider, model, status, latency_ms, est_cost_usd, retries, evaluation_runs!inner(kind, created_at)").eq("evaluation_runs.kind", "live").gte("evaluation_runs.created_at", since).limit(10000),
    admin.from("usage_events").select("kind, provider, is_admin, est_cost_usd, user_id").gte("created_at", since).limit(20000),
    admin.from("monthly_usage").select("used").eq("month", currentMonthKey()),
    admin.from("documents").select("id", { count: "exact", head: true }).eq("visibility", "private").is("deleted_at", null),
    admin.from("evaluation_runs").select("status, retrieval_strategy, retrieval_ms").eq("kind", "live").gte("created_at", since).limit(10000),
  ]);

  const questions = (events ?? []).filter((e) => e.kind === "question");
  const released = (events ?? []).filter((e) => e.kind === "question_released").length;
  const users = new Set(questions.map((e) => e.user_id)).size;
  const cost = (events ?? []).reduce((s, e) => s + Number(e.est_cost_usd ?? 0), 0);
  const atLimit = (usage ?? []).filter((u) => u.used >= 10).length;
  const providers = ["jev", "llm_judge"] as const;
  const runStatuses = (runs ?? []).reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 space-y-6">
      <div>
        <h1 className="text-[32px] font-semibold tracking-[-0.03em]">Admin</h1>
        <p className="text-[13px] text-ink2 mt-1">Last 30 days of live evaluations. Totals only; no claims or document text.</p>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Questions accepted" value={questions.length} hint={`${released} released before provider calls · ${questions.filter((q) => q.is_admin).length} by admins`} />
        <Stat label="Active users" value={users} hint={`${atLimit} at this month's limit`} />
        <Stat label={<Metric k="cost" align="start">Estimated spend</Metric>} value={usd(cost)} hint="Models and embeddings" />
        <Stat label="Private documents" value={docCount ?? 0} />
      </div>
      <div className="border border-line rounded-lg overflow-x-auto">
        <table className="data">
          <thead><tr><th>Provider</th><th className="num">Calls</th><th className="num">OK</th><th className="num">Errors</th><th className="num">Timeouts</th><th className="num">Rate-limited</th><th className="num">Malformed</th><th className="num">Not configured</th><th className="num"><Metric k="latency">p50</Metric></th><th className="num"><Metric k="latency">p95</Metric></th><th className="num"><Metric k="retries" align="end">Retries</Metric></th><th className="num"><Metric k="cost" align="end">Cost</Metric></th></tr></thead>
          <tbody>
            {providers.map((p) => {
              const rs = (results ?? []).filter((r) => r.provider === p);
              const c = (s: string) => rs.filter((r) => r.status === s).length;
              const lat = latencyStats(rs.filter((r) => r.status === "ok").map((r) => r.latency_ms ?? NaN));
              return (
                <tr key={p}>
                  <td>{p}<div className="text-xs text-muted font-mono">{[...new Set(rs.map((r) => r.model))].join(", ")}</div></td>
                  <td className="num">{rs.length}</td><td className="num">{c("ok")}</td><td className="num">{c("error")}</td><td className="num">{c("timeout")}</td>
                  <td className="num">{c("rate_limited")}</td><td className="num">{c("malformed")}</td><td className="num">{c("not_configured")}</td>
                  <td className="num">{ms(lat.p50)}</td><td className="num">{ms(lat.p95)}</td>
                  <td className="num">{rs.reduce((s, r) => s + (r.retries ?? 0), 0)}</td>
                  <td className="num">{usd(rs.reduce((s, r) => s + Number(r.est_cost_usd ?? 0), 0))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border border-line rounded-lg p-4 text-[13px] space-y-1">
        <div>Run outcomes: {Object.entries(runStatuses).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}</div>
        <div>Retrieval latency p50/p95: {ms(latencyStats((runs ?? []).map((r) => r.retrieval_ms ?? NaN)).p50)} / {ms(latencyStats((runs ?? []).map((r) => r.retrieval_ms ?? NaN)).p95)}</div>
        <div className="text-xs text-muted">Admin status comes from the server-side ADMIN_EMAILS allowlist, matched against your verified Google email ({user.email}).</div>
      </div>
    </div>
  );
}
