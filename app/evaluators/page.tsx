import { INTEL_VERSIONS, isIntelVersion, loadIntelData } from "@/lib/evaluator-intel-data";
import { Intel } from "@/components/evaluators/Intel";

export const dynamic = "force-dynamic";

export default async function EvaluatorsPage({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  const sp = await searchParams;
  const version = isIntelVersion(sp.v) ? sp.v : "qa.v1.1";
  const data = await loadIntelData(version);
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 space-y-8">
      <header className="space-y-2 max-w-3xl">
        <h1 className="text-[32px] font-semibold tracking-[-0.03em]">Evaluator Intelligence</h1>
        <p className="text-ink2 leading-relaxed">
          Which errors Jev and the LLM judge each catch, where they disagree, and whether using both is worth the extra cost and latency.
        </p>
      </header>
      {data.missing.length > 0 && (
        <p className="text-[13px] text-warn">No published report yet for {data.missing.join(", ")}.</p>
      )}
      {data.rows.length > 0 ? (
        <Intel
          rows={data.rows}
          items={data.items}
          version={version}
          versions={Object.entries(INTEL_VERSIONS).map(([id, v]) => ({ id, label: v.label }))}
          reports={data.reports}
        />
      ) : (
        <p className="text-ink2">Nothing to analyse for this benchmark version yet.</p>
      )}
    </div>
  );
}
