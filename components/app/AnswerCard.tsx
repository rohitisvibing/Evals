import type { RunAnswer } from "@/lib/runs";
import { Metric } from "@/components/Metric";
import { STATUS_TEXT, ms, pages, usd } from "./format";

/** The RAG answer under evaluation. */
export function AnswerCard({ answer }: { answer: RunAnswer }) {
  const failed = answer.status !== "ok" || !answer.text;
  return (
    <section className="verdict-in border border-line rounded-lg p-5 space-y-3 bg-s2">
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="font-semibold">Answer</h3>
        <span className="text-[12px] text-muted">
          RAG answer from <span className="font-mono">{answer.model}</span>
        </span>
      </header>
      {failed ? (
        <p className="text-ink2">{STATUS_TEXT[answer.status] ?? answer.status}{answer.error ? `: ${answer.error}` : ""}</p>
      ) : (
        <p className={`text-[16px] leading-relaxed max-w-[70ch] ${answer.abstained ? "text-ink2 italic" : ""}`}>{answer.text}</p>
      )}
      {answer.abstained && !failed && <p className="text-[12px] text-muted">The answer model declined: it found no answer in the passages.</p>}
      {answer.citations.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {answer.citations.map((c, i) => (
            <li
              key={i}
              title={`“${c.quote}”${c.quote_verified ? "" : " (quote not found in passage)"}`}
              className={`text-[12px] px-2 py-0.5 rounded-md border bg-white tabular ${c.quote_verified ? "border-line text-ink2" : "border-bad text-bad"}`}
            >
              {c.id}, {pages(c)}
            </li>
          ))}
        </ul>
      )}
      <footer className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-ink2 tabular">
        <span><Metric k="latency" align="start">Latency</Metric> {ms(answer.latency_ms)}</span>
        <span><Metric k="tokens">Tokens</Metric> {answer.input_tokens ?? "—"}/{answer.output_tokens ?? "—"}</span>
        <span><Metric k="cost">Cost</Metric> {usd(answer.est_cost_usd)}</span>
      </footer>
    </section>
  );
}
