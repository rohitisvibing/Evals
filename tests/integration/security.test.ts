// Integration tests against a local Supabase stack (`supabase start`).
// They exercise real Postgres RLS, RPC privileges, storage policies and quota logic.
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { releaseQuestion, reserveQuestion, checkRateLimit, currentMonthKey } from "@/lib/quota";
import { retrieve } from "@/lib/retrieval";
import { persistOutcomes } from "@/lib/pipeline";
import { toPgVector } from "@/lib/ingest/embed";
import type { ProviderOutcome } from "@/lib/decision/schema";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
if (!url?.includes("127.0.0.1") && !url?.includes("localhost")) {
  throw new Error("Integration tests must run against a LOCAL Supabase stack");
}

const admin = supabaseAdmin();
type TestUser = { id: string; client: SupabaseClient };

async function makeUser(tag: string): Promise<TestUser> {
  const email = `${tag}-${randomUUID().slice(0, 8)}@test.local`;
  const password = `pw-${randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signErr } = await client.auth.signInWithPassword({ email, password });
  if (signErr) throw signErr;
  return { id: data.user!.id, client };
}

// Deterministic fake 1024-d embedding (no network): one-hot-ish on a hashed bucket.
function fakeVec(seed: number): number[] {
  const v = Array(1024).fill(0);
  v[seed % 1024] = 1;
  v[(seed * 7) % 1024] = 0.5;
  return v;
}

let alice: TestUser;
let bob: TestUser;
let aliceDoc: string;
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

beforeAll(async () => {
  alice = await makeUser("alice");
  bob = await makeUser("bob");
  aliceDoc = randomUUID();
  const path = `${alice.id}/${aliceDoc}.pdf`;
  await admin.storage.from("documents").upload(path, new Uint8Array(Buffer.from("%PDF-1.4 test")), { contentType: "application/pdf" });
  const { error } = await admin.from("documents").insert({
    id: aliceDoc, owner_id: alice.id, title: "Alice private report", storage_path: path, status: "indexed", embedding_model: "test-embed",
  });
  if (error) throw error;
  const chunks = [
    "Revenue increased 20% to $1.2 billion in fiscal 2025.",
    "Operating expenses declined due to lower fuel prices.",
    "The board declared no dividend for the year.",
  ].map((content, i) => ({
    document_id: aliceDoc, chunk_key: `alice${aliceDoc.slice(0, 6)}:p${i + 1}:c0`, chunk_index: i, page_start: i + 1, page_end: i + 1,
    content, embedding: toPgVector(fakeVec(i + 1)), embedding_model: "test-embed",
  }));
  const { error: cErr } = await admin.from("document_chunks").insert(chunks);
  if (cErr) throw cErr;
});

describe("RLS and user isolation", () => {
  it("owner sees their document; another user and anon do not", async () => {
    expect((await alice.client.from("documents").select("id").eq("id", aliceDoc)).data).toHaveLength(1);
    expect((await bob.client.from("documents").select("id").eq("id", aliceDoc)).data).toHaveLength(0);
    expect((await bob.client.from("document_chunks").select("id").eq("document_id", aliceDoc)).data).toHaveLength(0);
    const anonRes = await anon.from("documents").select("id");
    expect(anonRes.data ?? []).toHaveLength(0);
  });

  it("benchmark documents are readable by any signed-in user", async () => {
    const { data } = await bob.client.from("documents").select("id").eq("visibility", "benchmark");
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("clients cannot write documents, usage or quota rows directly", async () => {
    const ins = await bob.client.from("documents").insert({ owner_id: bob.id, title: "x", storage_path: `${bob.id}/x.pdf` });
    expect(ins.error).not.toBeNull();
    const upd = await alice.client.from("documents").update({ status: "failed" }).eq("id", aliceDoc).select();
    expect(upd.data ?? []).toHaveLength(0);
    const quota = await alice.client.from("monthly_usage").upsert({ user_id: alice.id, month: currentMonthKey(), used: 0 });
    expect(quota.error).not.toBeNull();
    const deleteEvents = await alice.client.from("usage_events").delete().eq("user_id", alice.id).select();
    expect(deleteEvents.data ?? []).toHaveLength(0);
  });

  it("privileged RPCs are not executable with a user JWT", async () => {
    const r1 = await bob.client.rpc("reserve_question", {
      p_user_id: bob.id, p_idempotency_key: "x".repeat(20), p_is_admin: true, p_limit: 1000, p_document_id: aliceDoc, p_claim: "c", p_strategy: "lexical", p_params: {},
    });
    expect(r1.error?.message).toMatch(/permission denied/);
    const r2 = await bob.client.rpc("check_rate_limit", { p_bucket: "b", p_max: 1, p_window_seconds: 60 });
    expect(r2.error?.message).toMatch(/permission denied/);
    const r3 = await anon.rpc("release_question", { p_run_id: randomUUID(), p_reason: "x" });
    expect(r3.error).not.toBeNull();
  });
});

describe("retrieval RPCs respect RLS", () => {
  it("lexical retrieval returns page-referenced chunks to the owner only", async () => {
    const own = await retrieve(alice.client, { documentId: aliceDoc, claim: "Did revenue increase 20%?", strategy: "lexical", k: 2, embeddingModel: "test-embed" });
    expect(own.chunks[0].content).toMatch(/Revenue increased 20%/);
    expect(own.chunks[0].page_start).toBe(1);
    const other = await retrieve(bob.client, { documentId: aliceDoc, claim: "Did revenue increase 20%?", strategy: "lexical", k: 2, embeddingModel: "test-embed" });
    expect(other.chunks).toHaveLength(0);
  });

  it("vector and hybrid retrieval rank by similarity and filter by embedding model", async () => {
    const embed = async () => ({ vectors: [fakeVec(2)], model: "test-embed", tokens: 1, est_cost_usd: 0 });
    const v = await retrieve(alice.client, { documentId: aliceDoc, claim: "fuel", strategy: "vector", k: 3, embeddingModel: "test-embed" }, { embed });
    expect(v.chunks[0].page_start).toBe(2);
    const h = await retrieve(alice.client, { documentId: aliceDoc, claim: "operating expenses fuel", strategy: "hybrid", k: 3, embeddingModel: "test-embed" }, { embed });
    expect(h.chunks[0].page_start).toBe(2);
    expect(h.chunks[0].lexical_rank).toBe(1);
    const wrongModel = await retrieve(alice.client, { documentId: aliceDoc, claim: "fuel", strategy: "vector", k: 3, embeddingModel: "other-model" }, { embed });
    expect(wrongModel.chunks).toHaveLength(0);
    const bobView = await retrieve(bob.client, { documentId: aliceDoc, claim: "fuel", strategy: "vector", k: 3, embeddingModel: "test-embed" }, { embed });
    expect(bobView.chunks).toHaveLength(0);
  });

  it("rejects query vectors with the wrong dimension", async () => {
    const r = await alice.client.rpc("match_chunks_vector", { p_document_id: aliceDoc, p_query_embedding: toPgVector(Array(768).fill(0.1)), p_embedding_model: "test-embed", p_k: 3 });
    expect(r.error?.message).toMatch(/dimension/i);
  });
});

describe("private storage", () => {
  it("only the owner can read their PDF with a user JWT", async () => {
    const path = `${alice.id}/${aliceDoc}.pdf`;
    expect((await alice.client.storage.from("documents").download(path)).error).toBeNull();
    expect((await bob.client.storage.from("documents").download(path)).error).not.toBeNull();
    expect((await anon.storage.from("documents").download(path)).error).not.toBeNull();
  });

  it("users cannot upload directly (uploads go through server-issued signed URLs)", async () => {
    const r = await bob.client.storage.from("documents").upload(`${bob.id}/direct.pdf`, new Uint8Array([37, 80, 68, 70]), { contentType: "application/pdf" });
    expect(r.error).not.toBeNull();
  });

  it("bucket rejects non-PDF content types and oversized files", async () => {
    const { data } = await admin.storage.getBucket("documents");
    expect(data?.public).toBe(false);
    expect(data?.allowed_mime_types).toEqual(["application/pdf"]);
    expect(data?.file_size_limit).toBe(20 * 1024 * 1024);
    const r = await admin.storage.from("documents").upload(`${alice.id}/x.html`, new Uint8Array([60]), { contentType: "text/html" });
    expect(r.error).not.toBeNull();
  });
});

describe("monthly quota (atomic)", () => {
  const reserve = (u: TestUser, key = randomUUID(), isAdmin = false) =>
    reserveQuestion(admin, { userId: u.id, idempotencyKey: key, isAdmin, documentId: aliceDoc, claim: "Revenue increased 20%", strategy: "lexical", params: { k: 3 } });
  const complete = (runId: string) => admin.from("evaluation_runs").update({ status: "completed" }).eq("id", runId);

  it("concurrent submissions: only one run is accepted at a time", async () => {
    const u = await makeUser("conc");
    const results = await Promise.all(Array.from({ length: 20 }, () => reserve(u)));
    const accepted = results.filter((r) => r.ok && !r.duplicate);
    expect(accepted).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === "concurrent_run")).toHaveLength(19);
    const { data } = await admin.from("monthly_usage").select("used").eq("user_id", u.id).single();
    expect(data!.used).toBe(1);
  });

  it("enforces exactly 10 questions per UTC month and persists usage", async () => {
    const u = await makeUser("quota");
    for (let i = 0; i < 10; i++) {
      const r = await reserve(u);
      expect(r.ok).toBe(true);
      if (r.ok && !r.duplicate) await complete(r.run_id);
    }
    const eleventh = await reserve(u);
    expect(eleventh).toMatchObject({ ok: false, error: "quota_exceeded", used: 10, limit: 10 });
    const { data } = await admin.from("monthly_usage").select("used, month").eq("user_id", u.id).single();
    expect(data).toEqual({ used: 10, month: currentMonthKey() });
    const { count } = await admin.from("usage_events").select("id", { count: "exact", head: true }).eq("user_id", u.id).eq("kind", "question");
    expect(count).toBe(10);
  });

  it("parallel reservations across sessions never exceed the limit", async () => {
    const u = await makeUser("race");
    // Pre-fill to 8 used, then fire 10 parallel reservations, completing each as it lands.
    for (let i = 0; i < 8; i++) {
      const r = await reserve(u);
      if (r.ok && !r.duplicate) await complete(r.run_id);
    }
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, async () => {
        for (let attempt = 0; attempt < 30; attempt++) {
          const r = await reserve(u);
          if (r.ok && !r.duplicate) {
            await complete(r.run_id);
            return "accepted";
          }
          if (!r.ok && r.error === "quota_exceeded") return "exceeded";
          await new Promise((res) => setTimeout(res, 20));
        }
        return "gave_up";
      }),
    );
    expect(outcomes.filter((o) => o === "accepted")).toHaveLength(2);
    const { data } = await admin.from("monthly_usage").select("used").eq("user_id", u.id).single();
    expect(data!.used).toBe(10);
  });

  it("idempotent: the same key returns the same run without charging again", async () => {
    const u = await makeUser("idem");
    const key = randomUUID();
    const a = await reserve(u, key);
    const b = await reserve(u, key);
    expect(a.ok && b.ok && b.duplicate).toBe(true);
    expect((b as { run_id: string }).run_id).toBe((a as { run_id: string }).run_id);
    const { data } = await admin.from("monthly_usage").select("used").eq("user_id", u.id).single();
    expect(data!.used).toBe(1);
  });

  it("release refunds a run rejected before provider execution only", async () => {
    const u = await makeUser("release");
    const r = await reserve(u);
    if (!r.ok || r.duplicate) throw new Error("expected reservation");
    expect(await releaseQuestion(admin, r.run_id, "no_passages_retrieved")).toBe(true);
    expect((await admin.from("monthly_usage").select("used").eq("user_id", u.id).single()).data!.used).toBe(0);
    expect(await releaseQuestion(admin, r.run_id, "again")).toBe(false); // already released

    const r2 = await reserve(u);
    if (!r2.ok || r2.duplicate) throw new Error("expected reservation");
    await admin.from("evaluation_runs").update({ status: "evaluating" }).eq("id", r2.run_id);
    expect(await releaseQuestion(admin, r2.run_id, "late")).toBe(false); // providers already running
    expect((await admin.from("monthly_usage").select("used").eq("user_id", u.id).single()).data!.used).toBe(1);
  });

  it("admin exemption skips the monthly limit but still records usage", async () => {
    const u = await makeUser("admin");
    for (let i = 0; i < 12; i++) {
      const r = await reserve(u, randomUUID(), true);
      expect(r.ok).toBe(true);
      if (r.ok && !r.duplicate) await complete(r.run_id);
    }
    const usage = await admin.from("monthly_usage").select("used").eq("user_id", u.id).maybeSingle();
    expect(usage.data).toBeNull();
    const { count } = await admin.from("usage_events").select("id", { count: "exact", head: true }).eq("user_id", u.id).eq("kind", "question").eq("is_admin", true);
    expect(count).toBe(12);
  });
});

describe("rate limiting", () => {
  it("allows up to max hits per window", async () => {
    const bucket = `test:${randomUUID()}`;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await checkRateLimit(admin, bucket, 3, 60));
    expect(results).toEqual([true, true, true, false]);
  });
});

describe("trace persistence", () => {
  it("persists both providers' results and isolates them per user", async () => {
    const u = await makeUser("trace");
    const r = await reserveQuestion(admin, { userId: u.id, idempotencyKey: randomUUID(), isAdmin: false, documentId: aliceDoc, claim: "c", strategy: "lexical", params: {} });
    if (!r.ok || r.duplicate) throw new Error("expected reservation");
    const outcome = (provider: ProviderOutcome["provider"], status: ProviderOutcome["status"]): ProviderOutcome => ({
      provider, model: "m", status, raw: { x: 1 }, latency_ms: 12, input_tokens: 3, output_tokens: 4, est_cost_usd: 0.001, retries: 1, error: status === "ok" ? null : "boom",
      decision: status === "ok" ? { schema_version: "decision.v1", provider, model: "m", label: "supported", explanation: { summary: "s", kind: "generated" }, evidence_refs: [], confidence: null } : null,
    });
    const passages = [{ id: "E1", chunk_key: "k1", page_start: 1, page_end: 1, text: "t" }];
    await persistOutcomes(admin, { id: r.run_id, user_id: u.id, is_admin: false, kind: "live" }, passages, [outcome("jev", "timeout"), outcome("llm_judge", "ok")]);

    const mine = await u.client.from("evaluation_results").select("provider, status, label, evidence_sent, latency_ms").eq("run_id", r.run_id).order("provider");
    expect(mine.data).toEqual([
      { provider: "jev", status: "timeout", label: null, evidence_sent: ["k1"], latency_ms: 12 },
      { provider: "llm_judge", status: "ok", label: "supported", evidence_sent: ["k1"], latency_ms: 12 },
    ]);
    const theirs = await bob.client.from("evaluation_results").select("id").eq("run_id", r.run_id);
    expect(theirs.data).toHaveLength(0);
    const calls = await admin.from("usage_events").select("provider").eq("run_id", r.run_id).eq("kind", "provider_call");
    expect(calls.data).toHaveLength(2);
  });
});
