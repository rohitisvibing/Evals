"use client";
import { Bar, BarChart, CartesianGrid, LabelList, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

// Two series: categorical slots 1 (Jev) and 2 (LLM judge); colour follows the evaluator.
export function MistakeChart({ data }: { data: { group: string; jev: number; judge: number; n: number }[] }) {
  return (
    <div className="h-72" role="img" aria-label="Share of wrong answers caught, by kind of mistake, for Jev and the LLM judge. The same values are in the table below.">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 20, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="28%">
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="group" stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={{ stroke: "var(--border)" }} interval={0} />
          <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={false} width={44} />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            formatter={(v, name) => [`${Math.round(Number(v) * 100)}% caught`, name === "jev" ? "Jev" : "LLM judge"]}
            labelFormatter={(g, p) => `${g} (${p?.[0]?.payload?.n ?? 0} wrong answers)`}
            contentStyle={{ background: "#000", border: "none", borderRadius: 6, color: "#fff", fontSize: 12 }}
            itemStyle={{ color: "#fff" }}
            labelStyle={{ color: "#fff" }}
          />
          <Legend formatter={(v) => (v === "jev" ? "Jev" : "LLM judge")} wrapperStyle={{ fontSize: 12 }} />
          {(["jev", "judge"] as const).map((k, i) => (
            <Bar key={k} dataKey={k} fill={i === 0 ? "var(--series-1)" : "var(--series-2)"} radius={[4, 4, 0, 0]} isAnimationActive={false} stroke="#fff" strokeWidth={2}>
              <LabelList dataKey={k} position="top" formatter={(v) => `${Math.round(Number(v) * 100)}%`} style={{ fontSize: 11, fill: "var(--text-secondary)" }} />
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
