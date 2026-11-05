import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";
import { getScoreboard, listRuns } from "@/lib/runs";
import { getMonthlyUsage } from "@/lib/quota";
import { limits, providerModels } from "@/lib/constants";
import { listReports } from "@/lib/reports";
import { loadExamplesCached } from "@/lib/golden-server";
import { AppShell, type Doc } from "@/components/app/AppShell";
import { SignInButton } from "@/components/SignInButton";
import { DevLoginButton } from "@/components/DevLoginButton";
import { Metric } from "@/components/Metric";
import { qaHeadline, splitByEvidence, tradeoffSentence } from "@/lib/eval/qa-metrics";

export const dynamic = "force-dynamic";

const SAMPLE_QUESTIONS: Record<string, string[]> = {
  "brk-10q-q3-2025": [
    "By how much did net earnings attributable to Berkshire shareholders change in Q3 2025 versus Q3 2024?",
    "Did BNSF's coal volumes rise or fall in the third quarter of 2025?",
    "Which company was Berkshire's largest equity holding at September 30, 2025?",
  ],
  "brk-letter-2025": [
    "What share of its 2025 operating cash flow did BNSF pay to Berkshire as dividends?",
    "How large was Berkshire's insurance float at the end of 2025?",
  ],
};

export default async function Home({ searchParams }: { searchParams: Promise<{ tab?: string; run?: string }> }) {
  const user = await getSessionUser();
  if (!user) return <Landing />;

  const sp = await searchParams;
  const supabase = await supabaseServer();
  const embedding = providerModels().embedding;
  const [{ data: docs }, allRuns, used, scoreboard] = await Promise.all([
    supabase
      .from("documents")
      .select("id, title, visibility, status, error, page_count, embedding_model, benchmark_key, created_at")
      .order("created_at", { ascending: false }),
    listRuns(supabase, user.id),
    getMonthlyUsage(supabase, user.id),
    getScoreboard(supabase, user.id),
  ]);
  // The app shows the question flow; older claim-check runs stay in the database but out of the list.
  // Runs released before an answer existed (e.g. generation failed) were not counted and aren't shown.
  const runs = allRuns.filter((r) => r.mode === "qa" && r.status !== "released");
  const documents: Doc[] = (docs ?? []).map((d) => ({
    id: d.id, title: d.title, benchmark: d.visibility === "benchmark", status: d.status, error: d.error,
    page_count: d.page_count, embedded: d.embedding_model === embedding, created_at: d.created_at,
    examples: SAMPLE_QUESTIONS[d.benchmark_key ?? ""] ?? [],
  }));

  return (
    <AppShell
      documents={documents}
      runs={runs}
      initialTab={sp.tab === "evaluations" ? "evaluations" : "documents"}
      initialRun={sp.run ?? null}
      exhausted={!user.isAdmin && used >= limits.monthlyQuestions}
      scoreboard={scoreboard}
    />
  );
}

async function Landing() {
  const reports = await listReports().catch(() => []);
  const qaFull = reports.find((r) => r.summary.qa && r.summary.qa.overall.n >= 50)?.summary.qa ?? null;
  const qa = qaFull
    ? (() => {
        const l = splitByEvidence(qaFull.rows).labelled;
        return { overall: l, headline: qaHeadline(l), tradeoff: tradeoffSentence({ jev: qaFull.latency.jev.p50, judge: qaFull.latency.judge.p50 }, { jev: qaFull.cost.jev.mean, judge: qaFull.cost.judge.mean }) };
      })()
    : null;
  const questions = loadExamplesCached().items.length;
  const pctOf = (x: number | undefined) => (x == null || Number.isNaN(x) ? "—" : `${Math.round(x * 100)}%`);

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <section className="pt-20 sm:pt-28 pb-16 max-w-3xl">
        <h1 className="text-[40px] sm:text-[56px] leading-[1.02] font-semibold tracking-[-0.045em]">
          Which evaluator can you trust to grade RAG answers?
        </h1>
        <p className="mt-5 text-[17px] text-ink2 max-w-[52ch] leading-relaxed">
          Ask a question about a financial report. A RAG model answers it, then Jev and an LLM judge each decide whether that answer is correct.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <SignInButton next="/" />
          <DevLoginButton />
          <Link href="/benchmark" className="btn">View benchmark</Link>
        </div>
      </section>

      <Pipeline />

      <section className="py-14 border-t border-line space-y-8">
        {qa && <p className="text-[17px] max-w-[70ch] leading-snug">{qa.headline.sentence} {qa.tradeoff}</p>}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-y-8">
          <Figure value={String(questions)} label={<Metric k="labelled_questions" align="start">Benchmark questions</Metric>} />
          <Figure value={qa ? String(qa.overall.n) : "—"} label={<Metric k="accuracy" align="start">Answers graded</Metric>} />
          <Figure value={qa ? pctOf(qa.overall.jev.catch_rate) : "—"} label={<><Metric k="error_catch_rate" align="start">Wrong answers caught</Metric>, Jev</>} />
          <Figure value={qa ? pctOf(qa.overall.judge.catch_rate) : "—"} label={<><Metric k="error_catch_rate" align="start">Wrong answers caught</Metric>, judge</>} />
        </div>
      </section>
    </div>
  );
}

function Figure({ value, label }: { value: string; label: React.ReactNode }) {
  return (
    <div>
      <div className="text-[28px] font-semibold tracking-tight tabular">{value}</div>
      <div className="text-[13px] text-ink2 mt-1">{label}</div>
    </div>
  );
}

/** The product in one picture: a question, a RAG answer, two independent grades. */
function Pipeline() {
  const node = "border border-line rounded-lg bg-white px-4 py-3";
  return (
    <section aria-label="How a comparison works" className="pb-16">
      <div className="grid gap-3 md:gap-0 md:grid-cols-[1fr_28px_1fr_28px_1fr_28px_1.1fr] items-center">
        <div className={node}>
          <div className="text-[12px] text-muted">Question</div>
          <div className="text-[14px] mt-1 leading-snug">“How much did revenue grow year over year?”</div>
        </div>
        <Connector />
        <div className={node}>
          <div className="text-[12px] text-muted">Evidence</div>
          <div className="mt-2 space-y-1.5" aria-hidden>
            {[92, 78, 64].map((w) => <div key={w} className="h-1.5 rounded-full bg-neutral-bg" style={{ width: `${w}%` }} />)}
          </div>
          <div className="text-[12px] text-ink2 mt-2">Passages with page numbers</div>
        </div>
        <Connector />
        <div className={`${node} bg-s2`}>
          <div className="text-[12px] text-muted">RAG answer</div>
          <div className="text-[14px] mt-1 leading-snug">“Revenue rose 2.1%, from $93.0B to $95.0B.”</div>
        </div>
        <Connector />
        <div className="border border-line rounded-lg bg-white grid grid-cols-2 divide-x divide-line">
          {["Jev", "LLM judge"].map((m) => (
            <div key={m} className="px-4 py-3">
              <div className="text-[13px] font-medium">{m}</div>
              <div className="mt-2 flex flex-col gap-1 text-[12px]">
                <span className="text-good">Correct</span>
                <span className="text-bad">Incorrect</span>
                <span className="text-warn">Can&apos;t tell</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Connector() {
  return (
    <div className="hidden md:flex items-center justify-center" aria-hidden>
      <div className="h-px w-full bg-line-strong" />
    </div>
  );
}
