// HTTP smoke test against a running app (default http://localhost:3000) + LOCAL Supabase.
// Signs in with a throwaway email/password user (test-only; production uses Google OAuth),
// then exercises upload → process → evaluate → trace → quota → isolation over real HTTP.
// Usage: tsx scripts/smoke-http.ts [baseUrl]
import "./_env";
import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "../lib/supabase/admin";
import { makePdf } from "../tests/fixtures/make-pdf";

const base = process.argv[2] ?? "http://localhost:3000";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
if (!/127\.0\.0\.1|localhost/.test(url)) throw new Error("smoke-http only runs against local Supabase");
const admin = supabaseAdmin();
let failures = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
  if (!cond) failures++;
};

async function session(tag: string) {
  const email = `${tag}-${randomUUID().slice(0, 8)}@smoke.local`;
  const password = `pw-${randomUUID()}`;
  const { data } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const jar = new Map<string, string>();
  const sb = createServerClient(url, anonKey, {
    cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (cs) => cs.forEach((c) => jar.set(c.name, c.value)) },
  });
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const call = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, redirect: "manual", headers: { cookie, ...(init.headers ?? {}) } });
  return { id: data.user!.id, call };
}

const alice = await session("alice");
const bob = await session("bob");

// Public pages
check("landing page renders", (await fetch(base + "/")).status === 200);
const bench = await fetch(base + "/benchmark");
check("benchmark dashboard is public", bench.status === 200 && (await bench.text()).includes("Retrieval"));

// Auth required
check("evaluate API rejects anonymous", (await fetch(base + "/api/evaluate", { method: "POST" })).status === 401);
check("documents API rejects anonymous", (await fetch(base + "/api/documents")).status === 401);

// Usage
const u0 = await (await alice.call("/api/usage")).json();
check("usage starts at 0 of 10", u0.used === 0 && u0.limit === 10, u0);

// Upload validation
const bad = await alice.call("/api/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: "x.exe", size: 10, contentType: "application/x-msdownload" }) });
check("upload rejects non-PDF content type", bad.status === 400);
const big = await alice.call("/api/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: "x.pdf", size: 50 * 1024 * 1024, contentType: "application/pdf" }) });
check("upload rejects >20MB", big.status === 400);

// Upload flow
const pdf = makePdf([
  ["Annual Report 2025. Consolidated results.", "Total revenue increased 20% to $1,200 million in 2025 from $1,000 million in 2024."],
  ["Operating expenses were $700 million in 2025.", "The company did not repurchase any shares during 2025."],
]);
const created = await alice.call("/api/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: "../../etc/passwd<script>.pdf", size: pdf.byteLength, contentType: "application/pdf" }) });
const c = await created.json();
check("signed upload issued", created.status === 200 && c.path?.startsWith(`${alice.id}/`) && !c.path.includes(".."), c);
const anonSb = createClient(url, anonKey);
const up = await anonSb.storage.from("documents").uploadToSignedUrl(c.path, c.token, new Blob([pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }), { contentType: "application/pdf" });
check("direct-to-storage upload", !up.error, up.error);
const proc = await alice.call(`/api/documents/${c.documentId}/process`, { method: "POST" });
const p = await proc.json();
check("processing extracts 2 pages", proc.status === 200 && p.pages === 2 && p.chunks >= 2, p);
const { data: doc } = await admin.from("documents").select("title, sha256, storage_path").eq("id", c.documentId).single();
check("filename sanitized, path server-generated", !doc!.title.includes("/") && !doc!.title.includes("<") && doc!.storage_path === `${alice.id}/${c.documentId}.pdf`, doc);

// Duplicate upload is rejected
const c2 = await (await alice.call("/api/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: "dup.pdf", size: pdf.byteLength, contentType: "application/pdf" }) })).json();
await anonSb.storage.from("documents").uploadToSignedUrl(c2.path, c2.token, new Blob([pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }), { contentType: "application/pdf" });
const dup = await alice.call(`/api/documents/${c2.documentId}/process`, { method: "POST" });
check("duplicate PDF detected", dup.status === 422 && (await dup.json()).error.duplicateOf === c.documentId);

// Isolation
check("bob cannot process alice's doc", (await bob.call(`/api/documents/${c.documentId}/process`, { method: "POST" })).status === 404);
check("bob cannot download alice's doc", (await bob.call(`/api/documents/${c.documentId}/download`)).status === 404);
check("bob cannot delete alice's doc", (await bob.call(`/api/documents/${c.documentId}`, { method: "DELETE" })).status === 404);
const dl = await alice.call(`/api/documents/${c.documentId}/download`);
check("owner gets a short-lived signed URL", dl.status === 303 && (dl.headers.get("location") ?? "").includes("token="));

// Evaluate
const evalBody = JSON.stringify({ documentId: c.documentId, claim: "Total revenue increased 20% in 2025.", strategy: "lexical", k: 4 });
const noKey = await alice.call("/api/evaluate", { method: "POST", headers: { "content-type": "application/json" }, body: evalBody });
check("evaluate requires an Idempotency-Key", noKey.status === 400);
const key = randomUUID().replaceAll("-", "");
const ev = await alice.call("/api/evaluate", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: evalBody });
const evJson = await ev.json();
const providersConfigured = !!(process.env.TYPESAFE_API_KEY || process.env.OPENROUTER_API_KEY);
if (!providersConfigured) {
  check("no providers configured → 503, nothing charged", ev.status === 503 && (await (await alice.call("/api/usage")).json()).used === 0, evJson);
} else {
  check("evaluation accepted", ev.status === 200 && !!evJson.runId, evJson);
  const again = await (await alice.call("/api/evaluate", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: evalBody })).json();
  check("same Idempotency-Key returns the same run", again.runId === evJson.runId && again.duplicate === true, again);
  const u1 = await (await alice.call("/api/usage")).json();
  check("one question counted", u1.used === 1, u1);
  const trace = await alice.call(`/api/runs/${evJson.runId}`);
  const detail = await trace.json();
  check("run trace has both providers + evidence text", trace.status === 200 && detail.results.length === 2 && detail.evidence.some((e: { text: string | null }) => e.text?.includes("Total revenue increased")), detail);
  check("bob cannot view alice's run", (await bob.call(`/api/runs/${evJson.runId}`)).status === 404);
  const list = await (await alice.call("/api/runs")).json();
  check("run appears in the evaluations list", list.runs.some((r: { id: string }) => r.id === evJson.runId));
  check("old /runs/:id links redirect into the app", (await alice.call(`/runs/${evJson.runId}`)).headers.get("location")?.includes(`/?tab=evaluations&run=${evJson.runId}`) === true);
  const app = await (await alice.call("/")).text();
  check("signed-in home renders the two tabs", app.includes(">Documents<") && app.includes(">Evaluations<"));
  check("home shows the question flow", app.includes("Ask a question about this document"));
  const { data: results } = await admin.from("evaluation_results").select("provider, status").eq("run_id", evJson.runId);
  console.log("      provider statuses:", JSON.stringify(results));
  // Ask a question: RAG answer graded by both evaluators, then the owner marks the truth.
  const askBody = JSON.stringify({ documentId: c.documentId, question: "By what percentage did total revenue increase in 2025?", strategy: "lexical", k: 4 });
  const ask = await alice.call("/api/ask", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomUUID().replaceAll("-", "") }, body: askBody });
  const askJson = await ask.json();
  if (ask.status === 200) {
    const qa = await (await alice.call(`/api/runs/${askJson.runId}`)).json();
    check("ask returns a generated answer and two grades", qa.run.mode === "qa" && !!qa.run.answer?.text && qa.results.length === 2, qa.run.answer);
    console.log("      answer:", JSON.stringify(qa.run.answer?.text), "| grades:", JSON.stringify(qa.results.map((r: { provider: string; status: string; label: string }) => [r.provider, r.status, r.label])));
    const mark = (who: typeof alice, label: unknown) => who.call(`/api/runs/${askJson.runId}/truth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }) });
    check("other users cannot mark the answer", (await mark(bob, "correct")).status === 404);
    check("invalid truth labels are rejected", (await mark(alice, "maybe")).status === 400);
    const marked = await (await mark(alice, "correct")).json();
    check("owner marks the answer; scoreboard counts it", marked.ok === true && marked.scoreboard.n === 1, marked);
    const cleared = await (await mark(alice, null)).json();
    check("owner can clear the mark", cleared.scoreboard.n === 0, cleared);
    const claimMark = await alice.call(`/api/runs/${evJson.runId}/truth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "correct" }) });
    check("claim-mode runs cannot be marked", claimMark.status === 409);
  } else {
    check("ask flow (needs OPENROUTER_API_KEY)", ask.status === 503 && askJson.error.code === "generator_not_configured", askJson);
  }

  // Quota exhaustion
  await admin.from("monthly_usage").update({ used: 10 }).eq("user_id", alice.id);
  const over = await alice.call("/api/evaluate", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomUUID().replaceAll("-", "") }, body: evalBody });
  const overJson = await over.json();
  check("11th question rejected with reset time", over.status === 429 && overJson.error.code === "quota_exceeded" && !!overJson.error.resetsAt, overJson);
}

// Forged admin flag in payload is ignored (admin is server-derived)
const forged = await bob.call("/api/benchmark/labels", { method: "POST", headers: { "content-type": "application/json", "x-admin": "true" }, body: JSON.stringify({ example_id: "q3-001", action: "reviewed", isAdmin: true }) });
check("non-admin cannot review labels even with forged flags", forged.status === 403);
check("non-admin gets 404 on /admin", (await bob.call("/admin")).status === 404);

// Deletion
const del = await alice.call(`/api/documents/${c.documentId}`, { method: "DELETE" });
const { data: chunksLeft } = await admin.from("document_chunks").select("id").eq("document_id", c.documentId);
const { data: obj } = await admin.storage.from("documents").list(alice.id);
check("delete removes chunks and stored file", del.status === 200 && chunksLeft!.length === 0 && !obj!.some((o) => o.name === `${c.documentId}.pdf`));

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall smoke checks passed");
process.exit(failures ? 1 : 0);
