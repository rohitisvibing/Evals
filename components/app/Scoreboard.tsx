import type { HeadToHead } from "@/lib/eval/qa-metrics";
import { qaHeadline } from "@/lib/eval/qa-metrics";
import { Metric } from "@/components/Metric";

const pct = (x: number) => (Number.isNaN(x) ? "—" : `${Math.round(x * 100)}%`);

/** Running head-to-head over answers the user has marked. */
export function Scoreboard({ s, title = "Your scoreboard" }: { s: HeadToHead; title?: string }) {
  const h = qaHeadline(s);
  if (s.n === 0) {
    return (
      <section className="border border-line rounded-lg p-4">
        <h2 className="font-medium">{title}</h2>
        <p className="text-[13px] text-ink2 mt-0.5">Mark answers as correct or wrong to see which evaluator you can trust.</p>
      </section>
    );
  }
  const row = (name: string, x: HeadToHead["jev"], lead: boolean) => (
    <tr>
      <td className={lead ? "font-semibold" : ""}>{name}</td>
      <td className="num">{x.right}/{x.n}</td>
      <td className="num">{pct(x.accuracy)}</td>
      <td className="num">{x.caught}/{x.wrong_answers}</td>
      <td className="num">{x.false_alarms}/{x.correct_answers}</td>
      <td className="num">{x.cannot_tell + x.no_grade}</td>
    </tr>
  );
  return (
    <section className="border border-line rounded-lg">
      <div className="p-4 pb-3">
        <h2 className="font-medium">{title}</h2>
        <p className="text-[14px] mt-1 max-w-[75ch]">{h.sentence}</p>
      </div>
      <div className="overflow-x-auto border-t border-line">
        <table className="data">
          <thead>
            <tr>
              <th>Evaluator</th>
              <th className="num">Right</th>
              <th className="num"><Metric k="accuracy">Accuracy</Metric></th>
              <th className="num"><Metric k="error_catch_rate">Wrong answers caught</Metric></th>
              <th className="num"><Metric k="false_alarm_rate">False alarms</Metric></th>
              <th className="num"><Metric k="cannot_tell_rate" align="end">No verdict</Metric></th>
            </tr>
          </thead>
          <tbody>
            {row("Jev", s.jev, h.winner === "jev")}
            {row("LLM judge", s.judge, h.winner === "llm_judge")}
          </tbody>
        </table>
      </div>
    </section>
  );
}
