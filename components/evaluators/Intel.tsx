"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Metric } from "@/components/Metric";
import { capabilityMatrix, disagreement, allPolicies, findings, type IntelRow, type CapabilityRow, type PolicyStats } from "@/lib/eval/evaluator-intel";
import { headToHead } from "@/lib/eval/qa-metrics";
import { ERROR_CATEGORIES, type ErrorCategory } from "@/lib/eval/error-categories";

type Row = IntelRow & { dataset: string };
type Item = { item_id: string; dataset: string; question: string; answer: string; reference: string; source: string; perturbation: string | null; truth: "correct" | "incorrect"; category_note: string | null; run_id: string };
type Evidence = "labelled" | "e2e" | "all";

const JEV = "var(--series-1)";
const JUDGE = "var(--series-2)";
const pct = (x: number, d = 0) => (Number.isNaN(x) ? "—" : `${(x * 100).toFixed(d)}%`);
const frac = (k: number, n: number) => (n ? `${k}/${n}` : "—");
const usd = (x: number | null) => (x == null ? "—" : `$${x.toFixed(3)}`);
const ms = (x: number) => (Number.isNaN(x) ? "—" : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const p3 = (p: number) => (p < 0.001 ? "< 0.001" : p.toFixed(3));
const gradeText = (g: string | null) => (g === "correct" ? "Correct" : g === "incorrect" ? "Incorrect" : g === "cannot_tell" ? "Can't tell" : "No grade");

export function Intel({ rows, items, versions, version, reports }: {
  rows: Row[]; items: Record<string, Item>; versions: { id: string; label: string }[]; version: string;
  reports: { dataset: string; batch_id: string; created_at: string; notes: string | null }[];
}) {
  const hasHybrid = rows.some((r) => r.source === "rag_hybrid");
  const [evidence, setEvidence] = useState<Evidence>(hasHybrid ? "labelled" : "all");
  const [category, setCategory] = useState<ErrorCategory | "all">("all");

  const scoped = useMemo(
    () => rows.filter((r) => (evidence === "all" ? true : evidence === "labelled" ? r.source !== "rag_hybrid" : r.source === "rag_hybrid")),
    [rows, evidence],
  );
  const cap = useMemo(() => capabilityMatrix(scoped), [scoped]);
  const fin = useMemo(() => findings(scoped), [scoped]);
  const pol = useMemo(() => allPolicies(scoped), [scoped]);
  const h2h = useMemo(() => headToHead(scoped.filter((r) => !r.disputed)), [scoped]);
  const inCategory = useMemo(() => (category === "all" ? scoped : scoped.filter((r) => r.categories.includes(category))), [scoped, category]);
  const disputed = rows.filter((r) => r.disputed).length;

  return (
    <div className="space-y-12">
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <Segmented
          label="Benchmark"
          value={version}
          options={versions.map((v) => ({ id: v.id, label: v.label, href: `/evaluators?v=${encodeURIComponent(v.id)}` }))}
        />
        {hasHybrid && (
          <Segmented
            label="Evidence"
            value={evidence}
            onChange={(v) => setEvidence(v as Evidence)}
            options={[{ id: "labelled", label: "Labelled evidence" }, { id: "e2e", label: "End to end (hybrid search)" }, { id: "all", label: "All" }]}
          />
        )}
      </div>
      <p className="text-[12px] text-muted -mt-8">
        {scoped.length} graded answers · reports {reports.map((r) => `${r.dataset} (${r.created_at.slice(0, 10)})`).join(", ")}
        {disputed ? ` · ${disputed} answer with a disputed label excluded` : ""}. Every number below is computed from stored grades; no extra model calls.
      </p>

      <Section title="Key findings" note="Generated from the data. A claim appears only when the sample and the paired test support it.">
        <ul className="space-y-2 max-w-[80ch]">
          {fin.findings.map((f, i) => (
            <li key={i} className="flex gap-3 text-[14px] leading-relaxed">
              <span className={`mt-1.5 w-2 h-2 shrink-0 rounded-full ${f.kind === "supported" ? "bg-ink" : f.kind === "signal" ? "bg-warn" : "bg-line-strong"}`} aria-hidden />
              <span className={f.kind === "insufficient" ? "text-ink2" : ""}>{f.text}</span>
            </li>
          ))}
        </ul>
        <div className="border border-line rounded-lg p-4 bg-s2 max-w-[80ch]">
          <div className="text-[13px] text-ink2">Cheapest configuration that holds up</div>
          <p className="text-[15px] mt-1 leading-relaxed">{fin.recommendation}</p>
        </div>
      </Section>

      <Section title="Evaluator comparison" note={`${h2h.n} answers, both evaluators graded every one.`}>
        <div className="border border-line rounded-lg overflow-x-auto">
          <table className="data">
            <thead><tr><th></th><th className="num">Jev</th><th className="num">LLM judge</th></tr></thead>
            <tbody>
              {([
                ["Graded correctly", "accuracy", (x: typeof h2h.jev) => `${pct(x.accuracy, 1)} (${pct(x.accuracy_ci.lo, 1)}–${pct(x.accuracy_ci.hi, 1)})`],
                ["Wrong answers caught", "error_catch_rate", (x: typeof h2h.jev) => `${frac(x.caught, x.wrong_answers)} (${pct(x.catch_rate, 1)})`],
                ["Wrong answers approved", "approved_wrong", (x: typeof h2h.jev) => String(x.approved_wrong)],
                ["False alarms on correct answers", "false_alarm_rate", (x: typeof h2h.jev) => frac(x.false_alarms, x.correct_answers)],
                ["Agreement with truth (κ)", "kappa_vs_truth", (x: typeof h2h.jev) => x.kappa_vs_truth.toFixed(2)],
              ] as const).map(([label, k, f]) => (
                <tr key={label}><td><Metric k={k} align="start">{label}</Metric></td><td className="num">{f(h2h.jev)}</td><td className="num">{f(h2h.judge)}</td></tr>
              ))}
              <tr><td><Metric k="latency" align="start">Median latency</Metric></td><td className="num">{ms(pol[0].latency.p50)}</td><td className="num">{ms(pol[1].latency.p50)}</td></tr>
              <tr><td><Metric k="cost_per_1000" align="start">Cost per 1,000 answers</Metric></td><td className="num">{usd(pol[0].cost_per_1000)}</td><td className="num">{usd(pol[1].cost_per_1000)}</td></tr>
              <tr><td><Metric k="mcnemar" align="start">Head to head (McNemar)</Metric></td><td className="num" colSpan={2}>p = {p3(h2h.mcnemar.p_value)}: only Jev right on {h2h.mcnemar.a_only}, only the judge on {h2h.mcnemar.b_only}</td></tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Capability by error category" note="Detection rate on wrong answers in each category; false alarms on correct answers to questions that test it. Click a row to explore it below.">
        <DetectionChart rows={cap.filter((c) => c.wrong > 0)} />
        <div className="border border-line rounded-lg overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">Wrong</th>
                <th className="num"><Metric k="detection_rate">Jev caught</Metric></th>
                <th className="num"><Metric k="detection_rate">Judge caught</Metric></th>
                <th className="num"><Metric k="unique_catches">Only Jev</Metric></th>
                <th className="num"><Metric k="unique_catches">Only judge</Metric></th>
                <th className="num"><Metric k="missed_by_both">Neither</Metric></th>
                <th className="num"><Metric k="probe_fpr">False alarms J / G</Metric></th>
                <th className="num"><Metric k="mcnemar" align="end">p</Metric></th>
              </tr>
            </thead>
            <tbody>
              {cap.map((c) => (
                <tr key={c.category} onClick={() => setCategory(c.category)} className={`cursor-pointer hover:bg-s2 ${c.insufficient ? "text-ink2" : ""} ${category === c.category ? "bg-neutral-bg" : ""}`}>
                  <td>
                    {c.name}
                    {c.insufficient && c.wrong > 0 && <span className="block text-[11px] text-warn">Too few wrong answers to conclude</span>}
                    {c.wrong === 0 && <span className="block text-[11px] text-muted">No wrong answers; false alarms only</span>}
                  </td>
                  <td className="num">{c.wrong}</td>
                  <td className="num">{c.wrong ? `${frac(c.jev.tp, c.wrong)} (${pct(c.jev.detection)})` : "—"}</td>
                  <td className="num">{c.wrong ? `${frac(c.judge.tp, c.wrong)} (${pct(c.judge.detection)})` : "—"}</td>
                  <td className="num">{c.wrong ? c.only_jev : "—"}</td>
                  <td className="num">{c.wrong ? c.only_judge : "—"}</td>
                  <td className={`num ${c.neither ? "font-semibold" : ""}`}>{c.wrong ? c.neither : "—"}</td>
                  <td className="num">{c.correct ? `${c.jev.fp} / ${c.judge.fp} of ${c.correct}` : "—"}</td>
                  <td className="num">{c.wrong && (c.only_jev || c.only_judge) ? p3(c.mcnemar.p_value) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Explorer rows={inCategory} items={items} category={category} setCategory={setCategory} categories={cap.map((c) => c.category)} />

      <Section title="Hybrid evaluators" note="Simulated from stored grades. Cost and latency come from measured per-answer values; C and D latencies are composed from them (estimated).">
        <PolicyTable pol={pol} />
        <CostChart pol={pol} />
      </Section>

      <p className="text-[12px] text-muted max-w-[80ch]">
        Error categories: constructed mistakes are labelled by construction; real RAG mistakes were annotated against the source text by Claude (claude-opus-5-5), pending human review; adversarial cases state their category. Correct answers are counted under the categories their question tests. See <Link className="underline" href="/benchmark">Benchmark</Link> for the underlying runs.
      </p>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-[20px] font-semibold tracking-tight">{title}</h2>
        {note && <p className="text-[13px] text-ink2 mt-0.5 max-w-[80ch]">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Segmented({ label, value, options, onChange }: { label: string; value: string; options: { id: string; label: string; href?: string }[]; onChange?: (v: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-ink2">{label}</span>
      <span className="inline-flex flex-wrap p-0.5 rounded-md bg-neutral-bg">
        {options.map((o) => {
          const cls = `h-7 px-3 inline-flex items-center rounded ${value === o.id ? "bg-white shadow-[0_0_0_1px_var(--border)] text-ink" : "text-ink2 hover:text-ink"}`;
          return o.href ? <Link key={o.id} href={o.href} className={cls}>{o.label}</Link> : <button key={o.id} className={cls} onClick={() => onChange?.(o.id)} aria-pressed={value === o.id}>{o.label}</button>;
        })}
      </span>
    </div>
  );
}

/** Dot plot: detection rate per category, Jev vs judge, with Wilson whiskers. Small categories drawn faint. */
function DetectionChart({ rows }: { rows: CapabilityRow[] }) {
  const sorted = [...rows].sort((a, b) => Math.min(a.jev.detection, a.judge.detection) - Math.min(b.jev.detection, b.judge.detection));
  const left = 250, right = 700, y0 = 70, step = 30;
  const X = (v: number) => left + v * (right - left);
  const H = y0 + sorted.length * step + 30;
  return (
    <div className="border border-line rounded-lg p-4 overflow-x-auto">
      <svg viewBox={`0 0 760 ${H}`} role="img" aria-label="Detection rate by error category for Jev and the LLM judge" className="w-full min-w-[560px]" fontSize="12">
        <text x="0" y="18" fontSize="14" fontWeight="600" fill="var(--text-primary)">Where each evaluator catches wrong answers</text>
        <g>
          <circle cx={left} cy="40" r="5" fill={JEV} /><text x={left + 10} y="44" fill="var(--text-primary)">Jev</text>
          <circle cx={left + 60} cy="40" r="5" fill={JUDGE} /><text x={left + 70} y="44" fill="var(--text-primary)">LLM judge</text>
          <text x={left + 150} y="44" fill="var(--text-secondary)">lines = 95% interval; faint = fewer than 10 wrong answers</text>
        </g>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={X(t)} x2={X(t)} y1={y0 - 12} y2={H - 26} stroke="var(--border)" />
            <text x={X(t)} y={H - 10} textAnchor="middle" fill="var(--text-secondary)">{`${t * 100}%`}</text>
          </g>
        ))}
        {sorted.map((c, i) => {
          const y = y0 + i * step;
          const o = c.insufficient ? 0.35 : 1;
          return (
            <g key={c.category} opacity={o}>
              <text x={left - 12} y={y + 4} textAnchor="end" fill="var(--text-primary)">{`${c.name} (${c.wrong})`}</text>
              {[{ s: c.jev, col: JEV, dy: -5, n: "Jev" }, { s: c.judge, col: JUDGE, dy: 5, n: "LLM judge" }].map(({ s, col, dy, n }) => (
                <g key={n}>
                  <line x1={X(s.detection_ci.lo)} x2={X(s.detection_ci.hi)} y1={y + dy} y2={y + dy} stroke={col} strokeWidth="1.5" />
                  <circle cx={X(s.detection)} cy={y + dy} r="5" fill={col} stroke="#fff" strokeWidth="1.5">
                    <title>{`${n}, ${c.name}: caught ${s.tp} of ${c.wrong} (${pct(s.detection)}; 95% interval ${pct(s.detection_ci.lo)}–${pct(s.detection_ci.hi)})`}</title>
                  </circle>
                </g>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Explorer({ rows, items, category, setCategory, categories }: {
  rows: Row[]; items: Record<string, Item>; category: ErrorCategory | "all"; setCategory: (c: ErrorCategory | "all") => void; categories: ErrorCategory[];
}) {
  const [on, setOn] = useState<"wrong" | "correct">("wrong");
  const [cell, setCell] = useState<"both" | "only_jev" | "only_judge" | "neither">("neither");
  const d = useMemo(() => disagreement(rows, on), [rows, on]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.item_id, r])), [rows]);
  const listed = d.cells[cell];
  const label = on === "wrong" ? { y: "catches the error", n: "misses it" } : { y: "raises a false alarm", n: "accepts it" };
  const box = (k: typeof cell, title: string) => (
    <button
      onClick={() => setCell(k)}
      aria-pressed={cell === k}
      className={`text-left p-4 border border-line ${cell === k ? "bg-neutral-bg" : "hover:bg-s2"} ${k === "neither" && on === "wrong" ? "ring-inset" : ""}`}
    >
      <div className="text-[28px] font-semibold tracking-tight tabular">{d.cells[k].length}</div>
      <div className="text-[13px] text-ink2">{title}</div>
    </button>
  );
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-[20px] font-semibold tracking-tight">Disagreement explorer</h2>
        <p className="text-[13px] text-ink2 mt-0.5">Who catches what, on the same answers. Click a cell to read its examples; open one to see the evidence and both verdicts.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <Segmented label="Answers" value={on} onChange={(v) => { setOn(v as "wrong" | "correct"); setCell(v === "wrong" ? "neither" : "only_jev"); }} options={[{ id: "wrong", label: "Wrong answers" }, { id: "correct", label: "Correct answers (false alarms)" }]} />
        <label className="flex items-center gap-2">
          <span className="text-ink2">Category</span>
          <select className="field w-auto py-1.5 pr-8" value={category} onChange={(e) => setCategory(e.target.value as ErrorCategory | "all")}>
            <option value="all">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{ERROR_CATEGORIES[c]}</option>)}
          </select>
        </label>
      </div>
      <div className="grid sm:grid-cols-[auto_1fr] gap-4 items-start">
        <div className="grid grid-cols-[auto_1fr_1fr] text-[12px] w-full sm:w-[420px]">
          <div />
          <div className="px-2 pb-1 text-ink2">LLM judge {label.y}</div>
          <div className="px-2 pb-1 text-ink2">LLM judge {label.n}</div>
          <div className="pr-2 text-ink2 self-center [writing-mode:vertical-rl] rotate-180">Jev {label.y}</div>
          {box("both", "Both")}
          {box("only_jev", "Only Jev")}
          <div className="pr-2 text-ink2 self-center [writing-mode:vertical-rl] rotate-180">Jev {label.n}</div>
          {box("only_judge", "Only the LLM judge")}
          {box("neither", on === "wrong" ? "Neither: got past both" : "Neither")}
        </div>
        <div className="text-[13px] text-ink2 space-y-1">
          <p>{d.n} {on === "wrong" ? "wrong" : "correct"} answers{category !== "all" ? ` in ${ERROR_CATEGORIES[category].toLowerCase()}` : ""}.</p>
          <p>Jev {on === "wrong" ? "catches" : "flags"} {pct(d.jev_rate, 1)}, the LLM judge {pct(d.judge_rate, 1)}.</p>
          <p>
            <Metric k="paired_difference" align="start">Paired difference</Metric> {(d.difference * 100).toFixed(1)} points (95% interval {(d.difference_ci.lo * 100).toFixed(1)} to {(d.difference_ci.hi * 100).toFixed(1)});{" "}
            <Metric k="mcnemar" align="start">McNemar</Metric> p = {p3(d.mcnemar.p_value)}.{" "}
            {d.mcnemar.p_value >= 0.05 || d.n < 10 ? "Not a significant difference." : "Significant at 0.05."}
          </p>
        </div>
      </div>
      <div className="border border-line rounded-lg divide-y divide-line">
        {listed.length === 0 && <p className="p-4 text-[13px] text-muted">No answers in this cell.</p>}
        {listed.slice(0, 60).map((id) => <ItemRow key={id} row={byId.get(id)!} item={items[id]} />)}
        {listed.length > 60 && <p className="p-4 text-[13px] text-muted">Showing 60 of {listed.length}. Narrow by category to see the rest.</p>}
      </div>
    </section>
  );
}

function ItemRow({ row, item }: { row: Row; item: Item | undefined }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<{ evidence: { id: string; page_start: number; page_end: number; text: string | null }[]; verdicts: { provider: string; label: string | null; status: string; explanation: string | null; confidence: number | null }[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!item) return null;
  const cls = (g: string | null) => (g === row.truth ? "text-good" : "text-bad");
  async function toggle() {
    setOpen(!open);
    if (!detail && row.run_id) {
      const r = await fetch(`/api/evaluators/item?run=${row.run_id}`);
      if (r.ok) setDetail(await r.json());
      else setErr("Could not load the evidence for this answer.");
    }
  }
  return (
    <div className="p-4 space-y-2">
      <button onClick={toggle} aria-expanded={open} className="w-full text-left">
        <div className="text-[14px]">{item.question}</div>
        <div className="text-[13px] text-ink2 mt-0.5">“{item.answer}”</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-[12px] tabular">
          <span className={row.truth === "correct" ? "text-good" : "text-bad"}>Actually {row.truth === "correct" ? "correct" : "wrong"}</span>
          <span className={cls(row.jev)}>Jev: {gradeText(row.jev)}</span>
          <span className={cls(row.judge)}>Judge: {gradeText(row.judge)}</span>
          <span className="text-muted">{row.categories.map((c) => ERROR_CATEGORIES[c]).join(", ") || "No category"}</span>
          <span className="text-muted">{item.dataset}</span>
          <span className="ml-auto text-muted">{open ? "Hide" : "Evidence and verdicts"}</span>
        </div>
      </button>
      {open && (
        <div className="space-y-3 pt-2">
          <dl className="grid sm:grid-cols-[9rem_1fr] gap-x-4 gap-y-1 text-[13px]">
            <dt className="text-muted">Ground truth</dt><dd>{item.reference || "—"}</dd>
            {item.category_note && (<><dt className="text-muted">Why it&apos;s in this category</dt><dd>{item.category_note}</dd></>)}
          </dl>
          {err && <p className="text-[13px] text-bad">{err}</p>}
          {detail && (
            <>
              <div className="grid md:grid-cols-2 gap-3">
                {detail.verdicts.map((v) => (
                  <div key={v.provider} className="border border-line rounded-md p-3 text-[13px]">
                    <div className="font-medium">{v.provider === "jev" ? "Jev" : "LLM judge"}: <span className={cls(v.label)}>{gradeText(v.label)}</span>{v.confidence != null && <span className="text-muted font-normal"> · confidence {v.confidence.toFixed(2)}</span>}</div>
                    <p className="text-ink2 mt-1 leading-relaxed">{v.explanation}</p>
                  </div>
                ))}
              </div>
              <details className="text-[13px]">
                <summary className="cursor-pointer text-ink2">Evidence both received ({detail.evidence.length} passages)</summary>
                <ol className="mt-2 space-y-2">
                  {detail.evidence.map((e) => (
                    <li key={e.id} className="border border-line rounded-md p-3">
                      <div className="text-[12px] text-muted">{e.id}, p. {e.page_start}</div>
                      <p className="whitespace-pre-wrap leading-relaxed max-h-48 overflow-auto">{e.text}</p>
                    </li>
                  ))}
                </ol>
              </details>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PolicyTable({ pol }: { pol: PolicyStats[] }) {
  const best = Math.max(...pol.map((p) => p.accuracy));
  return (
    <div className="border border-line rounded-lg overflow-x-auto">
      <table className="data">
        <thead>
          <tr>
            <th>Configuration</th>
            <th className="num"><Metric k="accuracy">Accuracy</Metric></th>
            <th className="num"><Metric k="error_catch_rate">Wrong caught</Metric></th>
            <th className="num"><Metric k="approved_wrong">Wrong approved</Metric></th>
            <th className="num"><Metric k="false_alarm_rate">Correct rejected</Metric></th>
            <th className="num"><Metric k="precision">Precision</Metric></th>
            <th className="num"><Metric k="f1">F1</Metric></th>
            <th className="num"><Metric k="cost_per_1000">$ / 1,000</Metric></th>
            <th className="num"><Metric k="estimated_latency" align="end">Median latency</Metric></th>
          </tr>
        </thead>
        <tbody>
          {pol.map((p) => (
            <tr key={p.policy}>
              <td>
                <Metric k={p.policy === "or" ? "or_policy" : p.policy === "escalate" ? "escalation" : "accuracy"} align="start">{p.name}</Metric>
                {p.policy === "escalate" && (
                  <span className="block text-[11px] text-ink2">
                    <Metric k="escalation_rate" align="start">{pct(p.escalation_rate, 1)} escalated</Metric> ({p.escalated}); {p.escalated_wrong} of them wrong; {pct(p.accuracy_if_review_correct, 1)} if review is always right
                  </span>
                )}
              </td>
              <td className={`num ${p.accuracy === best ? "font-semibold" : ""}`}>{pct(p.accuracy, 1)}</td>
              <td className="num">{p.wrong_total ? `${p.tp}/${p.wrong_total} (${pct(p.recall, 1)})` : "—"}</td>
              <td className="num">{p.wrong_approved}</td>
              <td className="num">{p.correct_rejected}</td>
              <td className="num">{pct(p.precision, 1)}</td>
              <td className="num">{Number.isNaN(p.f1) ? "—" : p.f1.toFixed(3)}</td>
              <td className="num">{usd(p.cost_per_1000)}</td>
              <td className="num">{ms(p.latency.p50)}{p.latency_kind === "estimated" ? "*" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-[12px] text-muted border-t border-line">* Estimated from measured per-answer latencies. Escalated answers count as not decided automatically; review cost is not priced.</p>
    </div>
  );
}

/** Cost per 1,000 vs share of wrong answers caught; one labelled point per configuration. */
function CostChart({ pol }: { pol: PolicyStats[] }) {
  const maxC = Math.max(...pol.map((p) => p.cost_per_1000 ?? 0)) * 1.15 || 1;
  const recalls = pol.map((p) => p.recall).filter((r) => !Number.isNaN(r));
  const lo = Math.max(0, Math.floor((Math.min(...recalls) - 0.03) * 20) / 20), hi = Math.min(1, Math.ceil((Math.max(...recalls) + 0.02) * 20) / 20);
  const L = 70, R = 720, T = 50, B = 280;
  const X = (c: number) => L + (c / maxC) * (R - L);
  const Y = (r: number) => B - ((r - lo) / (hi - lo || 1)) * (B - T);
  const ticks = Array.from({ length: Math.round((hi - lo) / 0.05) + 1 }, (_, i) => lo + i * 0.05);
  const colour: Record<string, string> = { jev: JEV, judge: JUDGE, or: "var(--text-primary)", escalate: "var(--text-secondary)" };
  return (
    <div className="border border-line rounded-lg p-4 overflow-x-auto">
      <svg viewBox="0 0 760 320" role="img" aria-label="Cost per 1,000 answers against the share of wrong answers caught, per configuration" className="w-full min-w-[520px]" fontSize="12">
        <text x="0" y="18" fontSize="14" fontWeight="600" fill="var(--text-primary)">What extra cost buys in error detection</text>
        <text x="0" y="36" fill="var(--text-secondary)">Share of wrong answers caught automatically vs cost per 1,000 graded answers (median latency in labels)</text>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={R} y1={Y(t)} y2={Y(t)} stroke="var(--border)" />
            <text x={L - 8} y={Y(t) + 4} textAnchor="end" fill="var(--text-secondary)">{`${Math.round(t * 100)}%`}</text>
          </g>
        ))}
        <line x1={L} x2={R} y1={B} y2={B} stroke="var(--border-strong)" />
        {[0, maxC / 2, maxC].map((c) => <text key={c} x={X(c)} y={B + 18} textAnchor="middle" fill="var(--text-secondary)">{`$${c.toFixed(2)}`}</text>)}
        {placeLabels(pol.filter((p) => p.cost_per_1000 != null && !Number.isNaN(p.recall)).map((p) => ({ p, x: X(p.cost_per_1000!), y: Y(p.recall) })), R).map(({ p, x, y, lx, ly, anchor }) => (
          <g key={p.policy}>
            {(Math.abs(lx - x) > 12 || Math.abs(ly - y) > 14) && <line x1={x} y1={y} x2={anchor === "end" ? lx + 4 : lx - 4} y2={ly - 4} stroke="var(--border-strong)" />}
            <circle cx={x} cy={y} r="6" fill={colour[p.policy]} stroke="#fff" strokeWidth="2">
              <title>{`${p.name}: ${pct(p.recall, 1)} of wrong answers caught, ${p.fp} correct answers rejected, $${p.cost_per_1000!.toFixed(3)} per 1,000, median ${ms(p.latency.p50)}${p.latency_kind === "estimated" ? " (estimated)" : ""}`}</title>
            </circle>
            <text x={lx} y={ly - 6} textAnchor={anchor} fill="var(--text-primary)">{p.name.slice(3)}</text>
            <text x={lx} y={ly + 9} textAnchor={anchor} fontSize="11" fill="var(--text-secondary)">{`${pct(p.recall, 1)} · ${ms(p.latency.p50)}${p.latency_kind === "estimated" ? "*" : ""}`}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/** Greedy, deterministic label placement: try beside, above and below each point; skip spots that overlap a placed label. */
function placeLabels<T extends { x: number; y: number; p: PolicyStats }>(pts: T[], right: number, y0 = 56, y1 = 274) {
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const out: (T & { lx: number; ly: number; anchor: "start" | "end" })[] = [];
  for (const pt of [...pts].sort((a, b) => a.x - b.x)) {
    const w = Math.max(pt.p.name.length - 3, 16) * 6.8;
    const anchor: "start" | "end" = pt.x > right - w - 20 ? "end" : "start";
    const dx = anchor === "end" ? -10 : 10;
    const tries = [0, -30, 30, -56, 56].map((dy) => ({ lx: pt.x + dx, ly: pt.y + dy }));
    const fits = (t: { lx: number; ly: number }) => {
      const box = { x0: anchor === "end" ? t.lx - w : t.lx, x1: anchor === "end" ? t.lx : t.lx + w, y0: t.ly - 18, y1: t.ly + 12 };
      if (box.y0 < y0 || box.y1 > y1) return null; // stay inside the plot area
      return placed.every((b) => box.x1 < b.x0 || box.x0 > b.x1 || box.y1 < b.y0 || box.y0 > b.y1) ? box : null;
    };
    let chosen = tries[0], box = fits(tries[0]);
    for (const t of tries.slice(1)) { if (box) break; const b = fits(t); if (b) { chosen = t; box = b; } }
    if (!box) chosen = { lx: pt.x + dx, ly: Math.min(Math.max(pt.y, y0 + 18), y1 - 12) };
    placed.push(box ?? { x0: chosen.lx, x1: chosen.lx + w, y0: chosen.ly - 18, y1: chosen.ly + 12 });
    out.push({ ...pt, ...chosen, anchor });
  }
  return out;
}
