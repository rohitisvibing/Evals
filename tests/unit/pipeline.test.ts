import { describe, expect, it } from "vitest";
import { compareOnEvidence, persistOutcomes, runStatusFrom } from "@/lib/pipeline";
import type { EvidencePassage, ProviderOutcome } from "@/lib/decision/schema";

const passages: EvidencePassage[] = [{ id: "E1", chunk_key: "k:p1:c0", page_start: 1, page_end: 1, text: "t" }];
const okOutcome = (provider: ProviderOutcome["provider"], mocked = true): ProviderOutcome => ({
  provider, model: "m", status: "ok", mocked, raw: null, latency_ms: 1, input_tokens: 1, output_tokens: 1, est_cost_usd: 0, retries: 0, error: null,
  decision: { schema_version: "decision.v1", provider, model: "m", label: "supported", explanation: { summary: "s", kind: "generated" }, evidence_refs: [], confidence: null },
});

describe("comparison pipeline [mock]", () => {
  it("passes identical claim and evidence to both evaluators", async () => {
    const seen: unknown[] = [];
    await compareOnEvidence("claim", passages, {
      jev: async (c, p) => (seen.push([c, p]), okOutcome("jev")),
      judge: async (c, p) => (seen.push([c, p]), okOutcome("llm_judge")),
    });
    expect(seen[0]).toEqual(seen[1]);
  });

  it("returns one provider's result even if the other crashes", async () => {
    const r = await compareOnEvidence("claim", passages, {
      jev: async () => { throw new Error("boom"); },
      judge: async () => okOutcome("llm_judge"),
    });
    expect(r.jev.status).toBe("error");
    expect(r.jev.error).toMatch(/boom/);
    expect(r.judge.status).toBe("ok");
    expect(runStatusFrom([r.jev, r.judge])).toBe("partial");
  });

  it("refuses to persist mocked outcomes as live results", async () => {
    await expect(persistOutcomes({} as never, { id: "r", user_id: "u", is_admin: false, kind: "live" }, passages, [okOutcome("jev")])).rejects.toThrow(/mocked/);
  });
});
