import Link from "next/link";
import { listReports, type Report } from "@/lib/reports";
import { loadExamplesCached, loadQaItemsCached } from "@/lib/golden-server";
import type { QaSummary } from "@/lib/reports";
import { MistakeChart } from "@/components/MistakeChart";
import { headToHeadBy, qaHeadline, splitByEvidence, tradeoffSentence } from "@/lib/eval/qa-metrics";
import { getSessionUser } from "@/lib/auth";
import { RecallChart } from "@/components/RecallChart";
import { Metric } from "@/components/Metric";
import { pct, num, ms, usd } from "@/components/ui";
import type { MetricKey } from "@/lib/metric-definitions";
import { ReviewControls } from "./client";

export const dynamic = "force-dynamic";

export default async function BenchmarkPage({ searchParams }: { searchParams: Promise<{ batch?: string; mock?: string; provider?: string }> }) {
  const sp = await searchParams;
  const showMock = sp.mock === "1";
  const reports = await listReports(showMock);
  const user = await getSessionUser().catch(() => null);
  const examples = loadExamplesCached();
  const pick = (has: (r: Report) => boolean) => (sp.batch ? reports.find((r) => r.batch_id === sp.batch && has(r)) : reports.find(has));
  const retrievalReport = pick((r) => !!r.summary.retrieval);
  const qaReport = pick((r) => !!r.summary.qa && r.summary.qa.overall.n >= 50) ?? pick((r) => !!r.summary.qa);

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 space-y-12">
      <header className="space-y-3 max-w-3xl">
        <h1 className="text-[32px] font-semibold tracking-[-0.03em]">Benchmark</h1>
        <p className="text-ink2 leading-relaxed">
          A RAG model answers {examples.items.length} <Metric k="labelled_questions">questions</Metric> about two public Berkshire Hathaway reports.
          Jev and an LLM judge then grade each answer, and we know which answers are actually right.
        </p>
        <p className="text-[13px] text-warn">
          Reference answers were drafted by Claude and checked by script against the source PDFs; they are awaiting human review. Treat results as preliminary.
        </p>
        {showMock && <p className="text-[13px] text-bad">Showing mock pipeline tests. These are not model results.</p>}
      </header>

      {qaReport?.summary.qa ? <QaSection report={qaReport} qa={qaReport.summary.qa} provider={sp.provider} /> : (
        <section><SectionTitle title="Who grades answers better?" note="No graded-answer benchmark has been published yet." /></section>
      )}
      <RetrievalSection report={retrievalReport} />
      <ReportList reports={reports} showMock={showMock} />

      {user?.isAdmin && (
        <section className="space-y-3">
          <h2 className="text-[18px] font-semibold tracking-tight">Label review</h2>
          <p className="text-[13px] text-ink2">Reviews add a new label version. Published reports keep the versions they were scored against.</p>
          <ReviewControls examples={examples.items.map((e) => ({ id: e.example_id, claim: e.claim, gold: e.gold_label }))} />
        </section>
      )}
    </div>
  );
}

const SOURCE_NAME: Record<string, string> = {
  reference: "Reference answers (correct)",
  rag_oracle: "RAG answers, labelled evidence",
  rag_hybrid: "RAG answers, hybrid search",
  perturbation: "Constructed mistakes (wrong)",
};
const MISTAKE_NAME: Record<string, string> = {
  number_shift: "Wrong number",
  unit_swap: "Wrong unit",
  direction_flip: "Wrong direction",
  false_abstention: "Wrongly says not stated",
  fabricated_answer: "Made-up answer",
  "natural RAG error": "Real RAG mistakes",
};

function QaSection({ report, qa, provider }: { report: Report; qa: QaSummary; provider?: string }) {
  // Compare evaluators where both saw the labelled evidence; hybrid-search items are end-to-end.
  const split = splitByEvidence(qa.rows);
  const o = split.labelled;
  const e2e = split.endToEnd;
  const headline = qaHeadline(o);
  const ev = [["jev", "Jev", o.jev], ["llm_judge", "LLM judge", o.judge]] as const;
  const rows: [string, MetricKey, (x: typeof o.jev) => string][] = [
    ["Graded correctly", "accuracy", (x) => `${pct(x.accuracy)} (${x.right}/${x.n})`],
    ["Wrong answers caught", "error_catch_rate", (x) => `${pct(x.catch_rate)} (${x.caught}/${x.wrong_answers})`],
    ["Wrong answers approved", "approved_wrong", (x) => String(x.approved_wrong)],
    ["False alarms on correct answers", "false_alarm_rate", (x) => `${pct(x.false_alarm_rate)} (${x.false_alarms}/${x.correct_answers})`],
    ["No verdict (can't tell or failed)", "cannot_tell_rate", (x) => String(x.cannot_tell + x.no_grade)],
    ["Agreement with truth (κ)", "kappa_vs_truth", (x) => num(x.kappa_vs_truth, 2)],
  ];
  const mistakes = headToHeadBy(
    qa.rows.filter((r) => r.source !== "rag_hybrid" && r.truth === "incorrect"),
    (r) => r.perturbation ?? "natural RAG error",
  )
    .map((m) => ({ group: MISTAKE_NAME[m.group] ?? m.group, jev: m.jev.catch_rate, judge: m.judge.catch_rate, n: m.n }))
    .sort((a, b) => b.n - a.n);
  const items = loadQaItemsCached();
  const misses = qa.rows.filter((r) => (provider === "jev" ? r.jev !== r.truth : provider === "llm_judge" ? r.judge !== r.truth : r.jev !== r.truth || r.judge !== r.truth));
  const verdict = (g: string | null) => (g === "correct" ? "Correct" : g === "incorrect" ? "Incorrect" : g === "cannot_tell" ? "Can't tell" : "No grade");

  return (
    <section className="space-y-8">
      <div className="space-y-2 max-w-3xl">
        <h2 className="text-[20px] font-semibold tracking-tight">Who grades answers better?</h2>
        <p className="text-[17px] leading-snug">{headline.sentence}</p>
        {tradeoffSentence({ jev: qa.latency.jev.p50, judge: qa.latency.judge.p50 }, { jev: qa.cost.jev.mean, judge: qa.cost.judge.mean }) && (
          <p className="text-[17px] leading-snug">{tradeoffSentence({ jev: qa.latency.jev.p50, judge: qa.latency.judge.p50 }, { jev: qa.cost.jev.mean, judge: qa.cost.judge.mean })}</p>
        )}
        <p className="text-[13px] text-ink2">{headline.detail}</p>
        <p className="text-[12px] text-muted">
          Compared on {o.n} answers where both evaluators saw the labelled evidence. With hybrid search instead ({e2e.n} RAG answers, end to end), Jev graded {pct(e2e.jev.accuracy)} correctly and the LLM judge {pct(e2e.judge.accuracy)}; some of those errors come from search missing the evidence.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 border border-line rounded-lg divide-y sm:divide-y-0 sm:divide-x divide-line">
        {ev.map(([k, n, x]) => (
          <Figure key={k} label={<><Metric k="accuracy" align="start">Graded correctly</Metric>, {n}</>} value={pct(x.accuracy)}
            hint={<><Metric k="ci" align="start">95% interval</Metric> {pct(x.accuracy_ci.lo)}–{pct(x.accuracy_ci.hi)}</>} />
        ))}
        {ev.map(([k, n, x]) => (
          <Figure key={`c-${k}`} label={<><Metric k="error_catch_rate" align="start">Wrong answers caught</Metric>, {n}</>} value={pct(x.catch_rate)}
            hint={`${x.false_alarms} false alarms on ${x.correct_answers} correct answers`} />
        ))}
      </div>

      <div className="border border-line rounded-lg overflow-x-auto">
        <table className="data">
          <thead><tr><th>{o.n} answers, labelled evidence</th><th className="num">Jev</th><th className="num">LLM judge</th></tr></thead>
          <tbody>
            {rows.map(([label, key, f]) => (
              <tr key={label}><td><Metric k={key} align="start">{label}</Metric></td><td className="num">{f(o.jev)}</td><td className="num">{f(o.judge)}</td></tr>
            ))}
            <tr><td><Metric k="latency" align="start">Latency p50 / p95</Metric></td><td className="num">{ms(qa.latency.jev.p50)} / {ms(qa.latency.jev.p95)}</td><td className="num">{ms(qa.latency.judge.p50)} / {ms(qa.latency.judge.p95)}</td></tr>
            <tr><td><Metric k="cost" align="start">Cost per answer</Metric></td><td className="num">{usd(qa.cost.jev.mean)}</td><td className="num">{usd(qa.cost.judge.mean)}</td></tr>
            <tr><td><Metric k="mcnemar" align="start">McNemar p (head to head)</Metric></td><td className="num" colSpan={2}>{num(o.mcnemar.p_value, 4)}: only Jev right on {o.mcnemar.a_only}, only the judge right on {o.mcnemar.b_only}</td></tr>
          </tbody>
        </table>
      </div>

      <div className="space-y-3">
        <h3 className="font-medium">Which mistakes does each evaluator catch?</h3>
        <div className="border border-line rounded-lg p-4"><MistakeChart data={mistakes} /></div>
        <div className="border border-line rounded-lg overflow-x-auto">
          <table className="data">
            <thead><tr><th>Kind of wrong answer</th><th className="num">Answers</th><th className="num">Caught by Jev</th><th className="num">Caught by LLM judge</th></tr></thead>
            <tbody>{mistakes.map((m) => <tr key={m.group}><td>{m.group}</td><td className="num">{m.n}</td><td className="num">{pct(m.jev)}</td><td className="num">{pct(m.judge)}</td></tr>)}</tbody>
          </table>
        </div>
      </div>

      <div className="border border-line rounded-lg overflow-x-auto">
        <table className="data">
          <thead><tr><th>Where the answer came from</th><th className="num">Answers</th><th className="num">Jev right</th><th className="num">LLM judge right</th></tr></thead>
          <tbody>
            {qa.by_source.map((g) => (
              <tr key={g.group}><td>{SOURCE_NAME[g.group] ?? g.group}</td><td className="num">{g.n}</td><td className="num">{pct(g.jev.accuracy)}</td><td className="num">{pct(g.judge.accuracy)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[13px] text-ink2">
        <Metric k="answer_accuracy" align="start">The RAG model</Metric> (<span className="font-mono">{report.config.models.answer ?? "—"}</span>) answered correctly{" "}
        {pct(qa.rag_accuracy.oracle.correct / qa.rag_accuracy.oracle.n)} of the time with labelled evidence and {pct(qa.rag_accuracy.hybrid.correct / qa.rag_accuracy.hybrid.n)} with hybrid search.
      </p>

      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h3 className="font-medium">Where an evaluator got it wrong</h3>
          <span className="ml-auto inline-flex p-0.5 rounded-md bg-neutral-bg text-[13px]">
            {[["", "Either"], ["jev", "Jev"], ["llm_judge", "Judge"]].map(([p, n]) => (
              <Link key={p} href={`/benchmark?batch=${report.batch_id}${p ? `&provider=${p}` : ""}`} className={`h-7 px-3 inline-flex items-center rounded ${(provider ?? "") === p ? "bg-white shadow-[0_0_0_1px_var(--border)]" : "text-ink2"}`}>{n}</Link>
            ))}
          </span>
        </div>
        <div className="border border-line rounded-lg overflow-x-auto">
          <table className="data">
            <thead><tr><th>Question and answer</th><th>Actually</th><th>Jev said</th><th>LLM judge said</th><th></th></tr></thead>
            <tbody>
              {misses.slice(0, 10).map((r) => {
                const it = items.get(r.item_id);
                const cls = (g: string | null) => (g === r.truth ? "text-good" : "text-bad");
                return (
                  <tr key={r.item_id}>
                    <td className="max-w-[56ch]">
                      <div>{it?.question}</div>
                      <div className="text-ink2 mt-0.5">“{it?.answer_text}”</div>
                      <div className="text-[12px] text-muted mt-0.5">{SOURCE_NAME[r.source]}{r.perturbation ? `: ${MISTAKE_NAME[r.perturbation]}` : ""}</div>
                    </td>
                    <td className={r.truth === "correct" ? "text-good" : "text-bad"}>{r.truth === "correct" ? "Correct" : "Wrong"}</td>
                    <td className={cls(r.jev)}>{verdict(r.jev)}</td>
                    <td className={cls(r.judge)}>{verdict(r.judge)}</td>
                    <td><Link className="text-accent hover:underline" href={`/runs/${r.run_id}`}>Trace</Link></td>
                  </tr>
                );
              })}
              {!misses.length && <tr><td colSpan={5} className="text-muted">None.</td></tr>}
            </tbody>
          </table>
        </div>
        {misses.length > 10 && (
          <details className="border border-line rounded-lg">
            <summary className="cursor-pointer px-4 h-11 flex items-center text-[13px] text-ink2 hover:text-ink">Show all {misses.length}</summary>
            <div className="overflow-x-auto border-t border-line">
              <table className="data">
                <tbody>
                  {misses.slice(10).map((r) => {
                    const it = items.get(r.item_id);
                    const cls = (g: string | null) => (g === r.truth ? "text-good" : "text-bad");
                    return (
                      <tr key={r.item_id}>
                        <td className="max-w-[56ch]"><div>{it?.question}</div><div className="text-ink2 mt-0.5">“{it?.answer_text}”</div></td>
                        <td className={r.truth === "correct" ? "text-good" : "text-bad"}>{r.truth === "correct" ? "Correct" : "Wrong"}</td>
                        <td className={cls(r.jev)}>{verdict(r.jev)}</td>
                        <td className={cls(r.judge)}>{verdict(r.judge)}</td>
                        <td><Link className="text-accent hover:underline" href={`/runs/${r.run_id}`}>Trace</Link></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
    </section>
  );
}

function RetrievalSection({ report }: { report: Report | undefined }) {
  const r = report?.summary.retrieval;
  if (!report || !r) return null;
  const ks = report.config.retrieval_ks;
  const data = ks.map((k) => ({ k, ...Object.fromEntries(r.map((s) => [s.strategy, s.at_k[k]?.recall ?? null])) }));
  const name: Record<string, string> = { lexical: "Keyword", vector: "Semantic", hybrid: "Hybrid" };
  return (
    <section className="space-y-4">
      <SectionTitle title="Retrieval" note="Did search find the passages a verdict depends on?" />
      <div className="border border-line rounded-lg p-4"><RecallChart data={data} strategies={r.map((s) => s.strategy)} /></div>
      <div className="border border-line rounded-lg overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>Method</th>
              <th className="num">Claims</th>
              <th className="num"><Metric k="mrr">MRR</Metric></th>
              {ks.map((k) => <th key={k} className="num"><Metric k="recall_at_k">R@{k}</Metric></th>)}
              <th className="num"><Metric k="full_recall" align="end">All evidence @8</Metric></th>
              <th className="num"><Metric k="ndcg" align="end">nDCG@8</Metric></th>
            </tr>
          </thead>
          <tbody>
            {r.map((s) => (
              <tr key={s.strategy}>
                <td>{name[s.strategy] ?? s.strategy}</td>
                <td className="num">{s.n}</td>
                <td className="num">{num(s.mrr)}</td>
                {ks.map((k) => <td key={k} className="num" title={`95% interval ${pct(s.at_k[k]?.recall_ci.lo)}–${pct(s.at_k[k]?.recall_ci.hi)}`}>{pct(s.at_k[k]?.recall)}</td>)}
                <td className="num">{pct(s.at_k[8]?.full_recall)}</td>
                <td className="num">{num(s.at_k[8]?.ndcg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-muted">
        Embeddings: <span className="font-mono">{report.config.models.embedding}</span>. Keyword search is Postgres full-text ranking.
      </p>
    </section>
  );
}

function ReportList({ reports, showMock }: { reports: Report[]; showMock: boolean }) {
  if (!reports.length) return null;
  return (
    <section className="space-y-3">
      <SectionTitle title="Runs" note="Each run is frozen with the label versions it used." />
      <div className="border border-line rounded-lg overflow-x-auto">
        <table className="data">
          <thead><tr><th>Date (UTC)</th><th>Scope</th><th>Notes</th><th>Export</th></tr></thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.id}>
                <td className="tabular whitespace-nowrap"><Link className="hover:underline" href={`/benchmark?batch=${r.batch_id}${showMock ? "&mock=1" : ""}`}>{r.created_at.slice(0, 16).replace("T", " ")}</Link>{r.is_mock && <span className="text-bad"> mock</span>}</td>
                <td>{r.config.layers.join(", ")}; {r.config.strategies.join(", ")}</td>
                <td className="text-ink2">{r.notes}</td>
                <td className="whitespace-nowrap space-x-3">
                  <a className="text-accent hover:underline" href={`/api/benchmark/export?batch=${r.batch_id}&format=csv`}>CSV</a>
                  <a className="text-accent hover:underline" href={`/api/benchmark/export?batch=${r.batch_id}&format=json`}>JSON</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Link className="text-[13px] text-ink2 hover:text-ink" href={showMock ? "/benchmark" : "/benchmark?mock=1"}>{showMock ? "Hide" : "Show"} mock pipeline tests</Link>
    </section>
  );
}

function SectionTitle({ title, note }: { title: string; note: string }) {
  return (
    <div>
      <h2 className="text-[20px] font-semibold tracking-tight">{title}</h2>
      <p className="text-[13px] text-ink2 mt-0.5">{note}</p>
    </div>
  );
}

function Figure({ label, value, hint }: { label: React.ReactNode; value: string; hint?: React.ReactNode }) {
  return (
    <div className="p-4">
      <div className="text-[13px] text-ink2">{label}</div>
      <div className="text-[28px] font-semibold tracking-tight tabular mt-1">{value}</div>
      {hint && <div className="text-[12px] text-muted mt-1 tabular">{hint}</div>}
    </div>
  );
}
