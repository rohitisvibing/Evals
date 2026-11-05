import type { DecisionLabel } from "@/lib/decision/schema";

const LABEL: Record<DecisionLabel, [string, string]> = {
  supported: ["Supported", "var(--good)"],
  contradicted: ["Contradicted", "var(--bad)"],
  insufficient_evidence: ["Insufficient", "var(--warn)"],
};

export function LabelBadge({ label }: { label: DecisionLabel | null | undefined }) {
  if (!label) return <span className="text-muted">None</span>;
  const [text, color] = LABEL[label];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" style={{ color }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} aria-hidden />
      {text}
    </span>
  );
}

export function Stat({ label, value, hint }: { label: React.ReactNode; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="border border-line rounded-lg p-4">
      <div className="text-[13px] text-ink2">{label}</div>
      <div className="text-[28px] font-semibold tracking-tight tabular mt-1">{value}</div>
      {hint && <div className="text-[12px] text-muted mt-1">{hint}</div>}
    </div>
  );
}

export const pct = (x: number | null | undefined, d = 1) => (x == null || Number.isNaN(x) ? "—" : `${(x * 100).toFixed(d)}%`);
export const num = (x: number | null | undefined, d = 3) => (x == null || Number.isNaN(x) ? "—" : x.toFixed(d));
export const usd = (x: number | null | undefined) => (x == null ? "—" : x === 0 ? "$0" : x < 0.01 ? `$${x.toFixed(6)}` : `$${x.toFixed(4)}`);
export const ms = (x: number | null | undefined) => (x == null || Number.isNaN(x) ? "—" : x >= 1000 ? `${(x / 1000).toFixed(1)}s` : `${Math.round(x)}ms`);
