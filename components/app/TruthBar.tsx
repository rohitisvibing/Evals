"use client";
import { useState } from "react";
import type { RunResult } from "@/lib/runs";
import type { HeadToHead, Truth } from "@/lib/eval/qa-metrics";

/** The user says whether the answer was actually correct; then each evaluator is shown right or wrong. */
export function TruthBar({ runId, truth, jev, judge, onChange }: {
  runId: string; truth: Truth | null; jev?: RunResult; judge?: RunResult;
  onChange: (t: Truth | null, scoreboard: HeadToHead | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mark(label: Truth | null) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/runs/${runId}/truth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }) });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(body.error?.message ?? "Could not save your mark.");
    onChange(label, body.scoreboard ?? null);
  }

  const verdict = (r: RunResult | undefined) => (r?.status === "ok" && r.label === truth ? "right" : "wrong");
  const opt = (label: Truth, text: string) => (
    <button
      disabled={busy}
      aria-pressed={truth === label}
      onClick={() => mark(truth === label ? null : label)}
      className={`btn btn-sm ${truth === label ? (label === "correct" ? "!bg-good !text-white !border-good" : "!bg-bad !text-white !border-bad") : ""}`}
    >
      {text}
    </button>
  );

  return (
    <section className="border border-line rounded-lg p-4 flex flex-wrap items-center gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1">
        <h3 className="font-medium">Who was right?</h3>
        {truth ? (
          <p className="text-[13px] text-ink2 mt-0.5">
            You marked the answer <strong className={truth === "correct" ? "text-good" : "text-bad"}>{truth === "correct" ? "correct" : "wrong"}</strong>. Jev was{" "}
            <strong className={verdict(jev) === "right" ? "text-good" : "text-bad"}>{verdict(jev)}</strong>; the LLM judge was{" "}
            <strong className={verdict(judge) === "right" ? "text-good" : "text-bad"}>{verdict(judge)}</strong>.
          </p>
        ) : (
          <p className="text-[13px] text-ink2 mt-0.5">
            Is the answer right according to the <em>document</em>? Check it in the PDF, not only in the retrieved passages: search can miss the evidence. Your marks build the scoreboard.
          </p>
        )}
        {error && <p className="text-[13px] text-bad mt-1" role="alert">{error}</p>}
      </div>
      <div className="flex gap-2">
        {opt("correct", "Answer is correct")}
        {opt("incorrect", "Answer is wrong")}
      </div>
    </section>
  );
}
