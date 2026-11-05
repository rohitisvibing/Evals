// QA-mode database behaviour on a LOCAL Supabase stack.
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { releaseQuestion, reserveQuestion } from "@/lib/quota";
import { getScoreboard } from "@/lib/runs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
if (!/127\.0\.0\.1|localhost/.test(url)) throw new Error("Integration tests must run against a LOCAL Supabase stack");
const admin = supabaseAdmin();

async function makeUser(tag: string): Promise<{ id: string; client: SupabaseClient }> {
  const email = `${tag}-${randomUUID().slice(0, 8)}@test.local`;
  const password = `pw-${randomUUID()}`;
  const { data } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  await client.auth.signInWithPassword({ email, password });
  return { id: data.user!.id, client };
}

let docId: string;
beforeAll(async () => {
  const { data } = await admin.from("documents").select("id").eq("visibility", "benchmark").limit(1).single();
  docId = data!.id;
});

const reserve = (userId: string) =>
  reserveQuestion(admin, { userId, idempotencyKey: randomUUID(), isAdmin: false, documentId: docId, claim: "What were revenues?", strategy: "lexical", params: {} });

describe("QA quota policy", () => {
  it("releases a question whose answer could not be generated", async () => {
    const u = await makeUser("gen");
    const r = await reserve(u.id);
    if (!r.ok || r.duplicate) throw new Error("expected reservation");
    await admin.from("evaluation_runs").update({ mode: "qa", status: "generating" }).eq("id", r.run_id);
    expect(await releaseQuestion(admin, r.run_id, "generation_failed")).toBe(true);
    expect((await admin.from("monthly_usage").select("used").eq("user_id", u.id).single()).data!.used).toBe(0);
  });

  it("counts the question once evaluators have run", async () => {
    const u = await makeUser("eval");
    const r = await reserve(u.id);
    if (!r.ok || r.duplicate) throw new Error("expected reservation");
    await admin.from("evaluation_runs").update({ mode: "qa", status: "evaluating" }).eq("id", r.run_id);
    expect(await releaseQuestion(admin, r.run_id, "late")).toBe(false);
    expect((await admin.from("monthly_usage").select("used").eq("user_id", u.id).single()).data!.used).toBe(1);
  });

  it("treats a generating run as in flight", async () => {
    const u = await makeUser("flight");
    const r = await reserve(u.id);
    if (!r.ok || r.duplicate) throw new Error("expected reservation");
    await admin.from("evaluation_runs").update({ status: "generating" }).eq("id", r.run_id);
    expect(await reserve(u.id)).toEqual({ ok: false, error: "concurrent_run" });
  });
});

describe("QA schema", () => {
  it("rejects invalid modes, truth labels and grade labels", async () => {
    const u = await makeUser("schema");
    const r = await reserve(u.id);
    if (!r.ok || r.duplicate) throw new Error("expected reservation");
    expect((await admin.from("evaluation_runs").update({ mode: "chat" }).eq("id", r.run_id)).error).not.toBeNull();
    expect((await admin.from("evaluation_runs").update({ truth_label: "maybe" }).eq("id", r.run_id)).error).not.toBeNull();
    expect((await admin.from("evaluation_results").insert({ run_id: r.run_id, provider: "jev", status: "ok", label: "probably" })).error).not.toBeNull();
    expect((await admin.from("evaluation_results").insert({ run_id: r.run_id, provider: "jev", status: "ok", label: "cannot_tell" })).error).toBeNull();
  });

  it("benchmark_qa_items: readable when signed in, hidden from anon, not writable by users", async () => {
    const u = await makeUser("items");
    const anon = createClient(url, anonKey, { auth: { persistSession: false } });
    expect(((await u.client.from("benchmark_qa_items").select("item_id").limit(1)).data ?? []).length).toBe(1);
    expect((await anon.from("benchmark_qa_items").select("item_id").limit(1)).data ?? []).toHaveLength(0);
    const ins = await u.client.from("benchmark_qa_items").insert({ dataset_version: "x", item_id: "x", question_id: "x", document_key: "x", question: "q", answer_text: "a", source: "reference", truth_label: "correct", truth_source: "construction" });
    expect(ins.error).not.toBeNull();
  });
});

describe("scoreboard", () => {
  it("counts only the caller's marked answers and scores each evaluator", async () => {
    const a = await makeUser("score-a");
    const b = await makeUser("score-b");
    const mk = async (userId: string, truth: "correct" | "incorrect" | null, jev: string, judge: string) => {
      const r = await reserve(userId);
      if (!r.ok || r.duplicate) throw new Error("expected reservation");
      await admin.from("evaluation_runs").update({ mode: "qa", status: "completed", truth_label: truth, truth_source: truth ? "user" : null }).eq("id", r.run_id);
      await admin.from("evaluation_results").insert([
        { run_id: r.run_id, provider: "jev", status: "ok", label: jev },
        { run_id: r.run_id, provider: "llm_judge", status: "ok", label: judge },
      ]);
    };
    await mk(a.id, "incorrect", "incorrect", "correct"); // Jev caught it, judge approved a wrong answer
    await mk(a.id, "correct", "correct", "correct");
    await mk(a.id, null, "correct", "incorrect"); // unmarked: excluded
    await mk(b.id, "correct", "incorrect", "incorrect"); // another user's: excluded
    const s = await getScoreboard(a.client, a.id);
    expect(s.n).toBe(2);
    expect(s.jev.right).toBe(2);
    expect(s.judge.right).toBe(1);
    expect(s.jev.caught).toBe(1);
    expect(s.judge.approved_wrong).toBe(1);
    expect((await getScoreboard(a.client, b.id)).n).toBe(0); // RLS: cannot read b's runs
  });
});
