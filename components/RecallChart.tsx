"use client";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

// Categorical slots 1–3; colour follows the method, never its rank.
const COLOR: Record<string, string> = { lexical: "var(--series-1)", vector: "var(--series-2)", hybrid: "var(--series-3)" };
const NAME: Record<string, string> = { lexical: "Keyword", vector: "Semantic", hybrid: "Hybrid" };

export function RecallChart({ data, strategies }: { data: Record<string, number | null>[]; strategies: string[] }) {
  return (
    <div className="h-60" role="img" aria-label="Recall at k by search method. The same values are in the table below.">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="k" tickFormatter={(k) => `k=${k}`} stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={{ stroke: "var(--border)" }} padding={{ left: 12, right: 12 }} />
          <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={false} width={44} />
          <Tooltip
            cursor={{ stroke: "var(--border-strong)" }}
            formatter={(v, name) => [`${(Number(v) * 100).toFixed(1)}%`, NAME[String(name)] ?? name]}
            labelFormatter={(k) => `Recall@${k}`}
            contentStyle={{ background: "#000", border: "none", borderRadius: 6, color: "#fff", fontSize: 12 }}
            itemStyle={{ color: "#fff" }}
            labelStyle={{ color: "#fff" }}
          />
          {strategies.length > 1 && <Legend formatter={(v) => NAME[v] ?? v} wrapperStyle={{ fontSize: 12 }} />}
          {strategies.map((s) => (
            <Line
              key={s} type="linear" dataKey={s} name={s} isAnimationActive={false}
              stroke={COLOR[s] ?? "var(--text-muted)"} strokeWidth={2}
              dot={{ r: 4, strokeWidth: 2, stroke: "#fff", fill: COLOR[s] }} activeDot={{ r: 6, stroke: "#fff", strokeWidth: 2, fill: COLOR[s] }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
