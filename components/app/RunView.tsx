"use client";
import { useState } from "react";
import type { RunDetail, RunResult } from "@/lib/runs";
import type { HeadToHead, Truth } from "@/lib/eval/qa-metrics";
import { Metric } from "@/components/Metric";
import { AnswerCard } from "./AnswerCard";
import { TruthBar } from "./TruthBar";
import { LABEL_COLOR, LABEL_TEXT, STATUS_TEXT, ms, pages, usd } from "./format";

/**
 * One run. QA mode: question → generated answer → Jev and the LLM judge grade it → who was right.
 * Claim mode (older runs): side-by-side claim verdicts.
 */
export function RunView({ detail, showHeader = true, onScoreboard }: { detail: RunDetail; showHeader?: boolean; onScoreboard?: (s: HeadToHead) => void }) {
  const { run, results, evidence, gold } = detail;
  const [truth, setTruth] = useState<Truth | null>(run.truth);
  const jev = results.find((r) => r.provider === "jev");
  const judge = results.find((r) => r.provider === "llm_judge");
  const ids = new Map(evidence.map((e) => [e.chunk_key, e.id]));
  const qa = run.mode === "qa";
  const reference = qa ? truth : (gold?.label ?? null);
  const bothOk = jev?.status === "ok" && judge?.status === "ok";
  const agree = bothOk && jev!.label === judge!.label;

  return (
    <div className="space-y-5">
      {showHeader && (
        <div className="space-y-1.5">
          <p className="text-[17px] leading-snug font-medium max-w-[70ch]">{run.claim}</p>
          <p className="text-[13px] text-muted">
            {run.document_title ?? "Deleted document"}, {run.retrieval_strategy} search, {evidence.length} passages,{" "}
            {new Date(run.created_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
          </p>
        </div>
      )}

      {qa && run.answer && <AnswerCard answer={run.answer} />}

      {qa && <h3 className="text-[13px] text-ink2 -mb-2">Is this answer correct? Each evaluator graded it independently from the same passages.</h3>}
      <div className="grid md:grid-cols-2 border border-line rounded-lg">
        <Verdict title="Jev" subtitle="TypeSafe decision model" r={jev} ids={ids} reference={reference} />
        <Verdict title="LLM judge" subtitle="via OpenRouter" r={judge} ids={ids} reference={reference} divider />
      </div>

      {qa && run.kind === "live" ? (
        <TruthBar runId={run.id} truth={truth} jev={jev} judge={judge} onChange={(t, s) => { setTruth(t); if (s) onScoreboard?.(s); }} />
      ) : qa && truth ? (
        <p className="text-[13px] text-ink2">
          Benchmark answer, known to be <span className={`font-medium ${truth === "correct" ? "text-good" : "text-bad"}`}>{truth === "correct" ? "correct" : "wrong"}</span>
          {run.truth_source === "construction" ? " by construction" : " from the reference answer"}.
        </p>
      ) : gold ? (
        <p className="text-[13px] text-ink2">
          Labelled answer: <span className={`font-medium ${LABEL_COLOR[gold.label]}`}>{LABEL_TEXT[gold.label]}</span>. {gold.rationale}
          {gold.missed > 0 && <span className="text-warn"> Retrieval missed {gold.missed} labelled passage{gold.missed > 1 ? "s" : ""}.</span>}
        </p>
      ) : bothOk && !qa ? (
        <p className="text-[13px] text-ink2">
          {agree ? "Both models gave the same verdict." : "The models disagree."} This claim has no labelled answer, so neither verdict is verified.
        </p>
      ) : null}

      <Evidence evidence={evidence} retrievalMs={run.retrieval_ms} embedding={run.embedding_model} />
    </div>
  );
}

function Verdict({ title, subtitle, r, ids, reference, divider = false }: { title: string; subtitle: string; r: RunResult | undefined; ids: Map<string, string>; reference: RunResult["label"]; divider?: boolean }) {
  const [raw, setRaw] = useState(false);
  const d = r?.decision;
  return (
    <section className={`verdict-in p-5 flex flex-col gap-4 ${divider ? "border-t md:border-t-0 md:border-l border-line" : ""}`}>
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="font-semibold">{title}</h3>
          <p className="text-[12px] text-muted">{r?.model ? <span className="font-mono">{r.model}</span> : subtitle}</p>
        </div>
        {reference && r && (
          <span className={`text-[12px] font-medium ${r.status === "ok" && r.label === reference ? "text-good" : "text-bad"}`}>
            {r.status === "ok" && r.label === reference ? "✓ Right call" : "✕ Wrong call"}
          </span>
        )}
      </header>

      {!r ? (
        <p className="text-ink2">No result.</p>
      ) : r.status !== "ok" || !d ? (
        <div>
          <p className="text-[22px] font-semibold tracking-tight text-muted">{STATUS_TEXT[r.status] ?? r.status}</p>
          {r.error && <p className="text-[13px] text-ink2 mt-1">{r.error}</p>}
        </div>
      ) : (
        <>
          <div>
            <p className={`text-[26px] leading-none font-semibold tracking-tight ${LABEL_COLOR[d.label]}`}>{LABEL_TEXT[d.label]}</p>
            {d.confidence && (
              <p className="text-[12px] text-muted mt-2 tabular">
                <Metric k="confidence" align="start">Confidence</Metric> {d.confidence.value.toFixed(2)}
              </p>
            )}
          </div>
          <p className="text-[14px] leading-relaxed text-ink2 max-w-[60ch]">{d.explanation.summary}</p>
          {d.explanation.calculation && <pre className="text-[12px] bg-s2 border border-line rounded-md p-2.5 whitespace-pre-wrap font-mono">{d.explanation.calculation}</pre>}
          {d.evidence_refs.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {d.evidence_refs.map((e, i) => (
                <li
                  key={i}
                  title={e.quote ? `“${e.quote}”${e.quote_verified === false ? " (quote not found in passage)" : ""}` : undefined}
                  className={`text-[12px] px-2 py-0.5 rounded-md border tabular ${e.quote_verified === false ? "border-bad text-bad" : "border-line text-ink2"}`}
                >
                  {ids.get(e.chunk_key) ?? "?"} {e.stance === "supports" ? "supports" : e.stance === "contradicts" ? "contradicts" : "neutral"}, {pages(e)}
                  {e.probability != null && <span className="text-muted"> {e.probability.toFixed(2)}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {r && (
        <footer className="mt-auto pt-3 border-t border-line flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink2 tabular">
          <span><Metric k="latency" align="start">Latency</Metric> {ms(r.latency_ms)}</span>
          <span><Metric k="tokens">Tokens</Metric> {r.input_tokens ?? "—"}/{r.output_tokens ?? "—"}</span>
          <span><Metric k="cost">Cost</Metric> {usd(r.est_cost_usd)}</span>
          {r.retries > 0 && <span><Metric k="retries">Retries</Metric> {r.retries}</span>}
          <button className="ml-auto text-muted hover:text-ink" onClick={() => setRaw(!raw)} aria-expanded={raw}>{raw ? "Hide raw" : "Raw output"}</button>
          {raw && <pre className="basis-full max-h-72 overflow-auto bg-s2 border border-line rounded-md p-2.5 text-[11px] font-mono whitespace-pre-wrap break-all">{JSON.stringify(r.raw, null, 2)}</pre>}
        </footer>
      )}
    </section>
  );
}

function Evidence({ evidence, retrievalMs, embedding }: { evidence: RunDetail["evidence"]; retrievalMs: number | null; embedding: string | null }) {
  const [open, setOpen] = useState(false);
  if (!evidence.length) return null;
  return (
    <div className="border border-line rounded-lg">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="w-full flex flex-wrap items-center gap-x-4 gap-y-0.5 text-left px-4 py-3 text-[13px] hover:bg-s2 rounded-lg">
        <span className="font-medium">Evidence both models received</span>
        <span className="text-muted tabular sm:ml-auto">{evidence.length} passages, retrieved in {ms(retrievalMs)}</span>
        <span className="ml-auto sm:ml-0 text-muted" aria-hidden>{open ? "−" : "+"}</span>
      </button>
      {open && (
        <ol className="border-t border-line divide-y divide-line">
          {evidence.map((e) => (
            <li key={e.chunk_key} className="px-4 py-3 grid grid-cols-[2.5rem_1fr] gap-x-3">
              <span className="font-medium tabular">{e.id}</span>
              <div className="min-w-0">
                <p className="text-[12px] text-muted tabular flex flex-wrap gap-x-3">
                  <span>{pages(e)}</span>
                  {e.score != null && <span><Metric k="retrieval_score">Score</Metric> {Number(e.score).toFixed(3)}</span>}
                  {e.lexical_rank !== undefined && <span>Keyword #{e.lexical_rank ?? "—"}, semantic #{e.vector_rank ?? "—"}</span>}
                  {e.gold && <span className="text-good">Labelled evidence</span>}
                </p>
                <p className="text-[13px] leading-relaxed mt-1 whitespace-pre-wrap max-h-56 overflow-auto pr-2">{e.text ?? <em className="text-muted">Passage removed with its document.</em>}</p>
              </div>
            </li>
          ))}
          {embedding && <li className="px-4 py-2 text-[12px] text-muted">Embeddings: <span className="font-mono">{embedding}</span></li>}
        </ol>
      )}
    </div>
  );
}
