import { useId } from "react";
import { METRICS, type MetricKey } from "@/lib/metric-definitions";

/** A metric name with a hover/focus definition. Keyboard and screen-reader accessible. */
export function Metric({ k, children, align = "center" }: { k: MetricKey; children: React.ReactNode; align?: "center" | "start" | "end" }) {
  const id = useId();
  return (
    <span className="tip" data-align={align}>
      <span className="tip-term" tabIndex={0} aria-describedby={id}>{children}</span>
      <span role="tooltip" id={id} className="tip-body">{METRICS[k]}</span>
    </span>
  );
}
