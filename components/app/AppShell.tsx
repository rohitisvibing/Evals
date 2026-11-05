"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { RunDetail, RunSummary } from "@/lib/runs";
import type { HeadToHead } from "@/lib/eval/qa-metrics";
import { Scoreboard } from "./Scoreboard";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { RunView } from "./RunView";
import { LABEL_COLOR, LABEL_TEXT, STATUS_TEXT, ago } from "./format";

export type Doc = {
  id: string; title: string; benchmark: boolean; status: string; error: string | null;
  page_count: number | null; embedded: boolean; created_at: string; examples: string[];
};

type Tab = "documents" | "evaluations";

export function AppShell(props: { documents: Doc[]; runs: RunSummary[]; initialTab: Tab; initialRun: string | null; exhausted: boolean; scoreboard: HeadToHead }) {
  const [tab, setTab] = useState<Tab>(props.initialTab);
  const [score, setScore] = useState<HeadToHead>(props.scoreboard);
  const [runId, setRunId] = useState<string | null>(props.initialRun);

  // Keep the URL shareable without navigating.
  useEffect(() => {
    const q = new URLSearchParams();
    if (tab !== "documents") q.set("tab", tab);
    if (tab === "evaluations" && runId) q.set("run", runId);
    const next = q.toString() ? `/?${q}` : "/";
    if (window.location.pathname + window.location.search !== next) window.history.replaceState(null, "", next);
  }, [tab, runId]);

  const openRun = useCallback((id: string) => {
    setRunId(id);
    setTab("evaluations");
  }, []);

  return (
    <div>
      <div className="border-b border-line">
        <div role="tablist" aria-label="Sections" className="mx-auto max-w-6xl px-4 sm:px-6 flex gap-6">
          <TabButton id="documents" tab={tab} onSelect={setTab} count={props.documents.length}>Documents</TabButton>
          <TabButton id="evaluations" tab={tab} onSelect={setTab} count={props.runs.length}>Evaluations</TabButton>
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8">
        <div role="tabpanel" hidden={tab !== "documents"} aria-labelledby="tab-documents">
          <DocumentsTab documents={props.documents} exhausted={props.exhausted} onOpenRun={openRun} onScoreboard={setScore} />
        </div>
        <div role="tabpanel" hidden={tab !== "evaluations"} aria-labelledby="tab-evaluations">
          <EvaluationsTab runs={props.runs} selected={runId} onSelect={setRunId} onAsk={() => setTab("documents")} score={score} onScoreboard={setScore} />
        </div>
      </div>
    </div>
  );
}

function TabButton({ id, tab, onSelect, count, children }: { id: Tab; tab: Tab; onSelect: (t: Tab) => void; count: number; children: React.ReactNode }) {
  return (
    <button role="tab" id={`tab-${id}`} aria-selected={tab === id} className="tab" onClick={() => onSelect(id)}>
      {children}
      <span className="text-[12px] text-muted tabular">{count}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ Documents */

function DocumentsTab({ documents, exhausted, onOpenRun, onScoreboard }: { documents: Doc[]; exhausted: boolean; onOpenRun: (id: string) => void; onScoreboard: (s: HeadToHead) => void }) {
  // Start on the user's newest ready document, else the sample with the most example claims.
  const initial =
    documents.find((d) => !d.benchmark && d.status === "indexed") ??
    [...documents].filter((d) => d.status === "indexed").sort((a, b) => b.examples.length - a.examples.length)[0] ??
    documents[0];
  const [selected, setSelected] = useState<string | null>(initial?.id ?? null);
  const doc = documents.find((d) => d.id === selected) ?? null;
  const samples = documents.filter((d) => d.benchmark);
  const mine = documents.filter((d) => !d.benchmark);

  return (
    <div className="grid lg:grid-cols-[280px_1fr] gap-8">
      <aside className="space-y-6">
        <Uploader onUploaded={setSelected} />
        <DocList title="Your documents" docs={mine} selected={selected} onSelect={setSelected} empty="Upload a PDF annual report or filing to ask about it." />
        <DocList title="Sample reports" docs={samples} selected={selected} onSelect={setSelected} />
      </aside>
      <div className="min-w-0">
        {doc ? <DocumentPanel key={doc.id} doc={doc} exhausted={exhausted} onOpenRun={onOpenRun} onScoreboard={onScoreboard} /> : <p className="text-ink2">Select a document.</p>}
      </div>
    </div>
  );
}

function DocList({ title, docs, selected, onSelect, empty }: { title: string; docs: Doc[]; selected: string | null; onSelect: (id: string) => void; empty?: string }) {
  return (
    <div>
      <h2 className="text-[13px] text-ink2 mb-2">{title}</h2>
      {docs.length === 0 && empty && <p className="text-[13px] text-muted">{empty}</p>}
      <ul className="space-y-0.5">
        {docs.map((d) => (
          <li key={d.id}>
            <button
              onClick={() => onSelect(d.id)}
              aria-current={selected === d.id}
              className={`w-full text-left px-3 py-2 rounded-md text-[13px] leading-snug ${selected === d.id ? "bg-neutral-bg text-ink" : "text-ink2 hover:bg-s2 hover:text-ink"}`}
            >
              <span className="line-clamp-2">{d.title}</span>
              <span className="block text-[12px] text-muted mt-0.5 tabular">
                {d.status === "indexed" ? `${d.page_count} pages` : STATUS_TEXT[d.status] ?? d.status}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Uploader({ onUploaded }: { onUploaded: (id: string) => void }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "uploading" | "indexing" | "error">("idle");
  const [msg, setMsg] = useState<string | null>(null);

  async function onFile(file: File) {
    setMsg(null);
    if (file.type !== "application/pdf" || file.size > 20 * 1024 * 1024) {
      setPhase("error");
      return setMsg("Choose a PDF of 20 MB or less.");
    }
    setPhase("uploading");
    const create = await fetch("/api/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: file.name, size: file.size, contentType: file.type }) });
    const c = await create.json();
    if (!create.ok) return (setPhase("error"), setMsg(c.error?.message ?? "Upload failed."));
    const up = await supabaseBrowser().storage.from("documents").uploadToSignedUrl(c.path, c.token, file, { contentType: "application/pdf" });
    if (up.error) return (setPhase("error"), setMsg("Upload failed. Try again."));
    setPhase("indexing");
    router.refresh();
    const proc = await fetch(`/api/documents/${c.documentId}/process`, { method: "POST" });
    const p = await proc.json();
    if (!proc.ok) {
      setPhase("error");
      setMsg(p.error?.message ?? "Indexing failed.");
    } else {
      setPhase("idle");
      onUploaded(c.documentId);
    }
    router.refresh();
  }

  const busy = phase === "uploading" || phase === "indexing";
  return (
    <div>
      <label className={`btn w-full cursor-pointer ${busy ? "opacity-50 pointer-events-none" : ""}`}>
        {phase === "uploading" ? "Uploading…" : phase === "indexing" ? "Indexing…" : "Upload PDF"}
        <input type="file" accept="application/pdf" className="sr-only" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onFile(f); }} />
      </label>
      <p className={`text-[12px] mt-2 ${phase === "error" ? "text-bad" : "text-muted"}`} role="status">
        {msg ?? (phase === "indexing" ? "Reading pages and building the search index." : "Text-based PDFs up to 20 MB. Only you can see them.")}
      </p>
    </div>
  );
}

const newKey = () => crypto.randomUUID().replaceAll("-", "");

function DocumentPanel({ doc, exhausted, onOpenRun, onScoreboard }: { doc: Doc; exhausted: boolean; onOpenRun: (id: string) => void; onScoreboard: (s: HeadToHead) => void }) {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [strategy, setStrategy] = useState<"lexical" | "vector" | "hybrid">(doc.embedded ? "hybrid" : "lexical");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunDetail | null>(null);
  const [idemKey, setIdemKey] = useState(newKey);

  async function compare(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idemKey },
        body: JSON.stringify({ documentId: doc.id, question, strategy, k: 8 }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error?.message ?? "Could not answer this question.");
        if (body.error?.code !== "concurrent_run") setIdemKey(newKey());
        return;
      }
      const detail = await fetch(`/api/runs/${body.runId}`).then((r) => r.json());
      setResult(detail);
      setIdemKey(newKey());
      router.refresh();
    } catch {
      setError("Network error. Submitting again won't count twice.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete “${doc.title}”? The file and its index are removed. Past evaluations stay.`)) return;
    await fetch(`/api/documents/${doc.id}`, { method: "DELETE" });
    router.refresh();
  }

  const ready = doc.status === "indexed";
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold tracking-tight leading-snug">{doc.title}</h1>
          <p className="text-[13px] text-muted mt-1 tabular">
            {doc.benchmark ? "Sample report" : "Private"}
            {doc.page_count ? `, ${doc.page_count} pages` : ""}
            {ready && !doc.embedded ? ", keyword search only" : ""}
          </p>
          {doc.error && <p className="text-[13px] text-bad mt-1">{doc.error}</p>}
        </div>
        <div className="flex gap-2">
          <a className="btn btn-sm" href={`/api/documents/${doc.id}/download`}>Open PDF</a>
          {!doc.benchmark && <button className="btn btn-sm text-bad" onClick={remove}>Delete</button>}
        </div>
      </div>

      {ready && (
        <form onSubmit={compare} className="space-y-3">
          <label htmlFor="question" className="sr-only">Question</label>
          <textarea
            id="question" required minLength={5} maxLength={500} rows={2} value={question}
            onChange={(e) => { setQuestion(e.target.value); setIdemKey(newKey()); }}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit(); }}
            className="field text-[15px] leading-relaxed resize-y"
            placeholder="Ask a question about this document, e.g. How much did revenue grow year over year?"
          />
          {doc.examples.length > 0 && !question && (
            <div className="flex flex-wrap gap-1.5">
              {doc.examples.map((ex) => (
                <button type="button" key={ex} onClick={() => { setQuestion(ex); setIdemKey(newKey()); }} className="text-[12px] px-2.5 py-1 rounded-full border border-line text-ink2 hover:border-line-strong hover:text-ink text-left">
                  {ex.length > 64 ? ex.slice(0, 64) + "…" : ex}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <div role="radiogroup" aria-label="Search method" className="inline-flex p-0.5 rounded-md bg-neutral-bg">
              {([["lexical", "Keyword"], ["vector", "Semantic"], ["hybrid", "Hybrid"]] as const).map(([s, label]) => (
                <button
                  type="button" role="radio" key={s} aria-checked={strategy === s}
                  disabled={s !== "lexical" && !doc.embedded}
                  title={s !== "lexical" && !doc.embedded ? "Needs an embedded document" : undefined}
                  onClick={() => { setStrategy(s); setIdemKey(newKey()); }}
                  className={`h-7 px-3 rounded text-[13px] disabled:opacity-40 ${strategy === s ? "bg-white shadow-[0_0_0_1px_var(--border)] text-ink" : "text-ink2 hover:text-ink"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button className="btn btn-primary ml-auto" disabled={busy || exhausted || question.trim().length < 5}>
              {busy ? "Answering and grading…" : exhausted ? "Monthly limit reached" : "Get answer"}
            </button>
          </div>
          {error && <p className="text-[13px] text-bad" role="alert">{error}</p>}
        </form>
      )}

      {busy && <ComparingSkeleton />}
      {result && (
        <div className="space-y-3">
          <RunView detail={result} showHeader={false} onScoreboard={onScoreboard} />
          <button className="text-[13px] text-ink2 hover:text-ink" onClick={() => onOpenRun(result.run.id)}>View in evaluations</button>
        </div>
      )}
    </div>
  );
}

function ComparingSkeleton() {
  return (
    <div className="grid md:grid-cols-2 border border-line rounded-lg overflow-hidden" aria-hidden>
      {[0, 1].map((i) => (
        <div key={i} className={`p-5 space-y-3 ${i ? "border-t md:border-t-0 md:border-l border-line" : ""}`}>
          <div className="h-4 w-16 rounded bg-neutral-bg animate-pulse" />
          <div className="h-7 w-40 rounded bg-neutral-bg animate-pulse" />
          <div className="h-3 w-full rounded bg-neutral-bg animate-pulse" />
          <div className="h-3 w-4/5 rounded bg-neutral-bg animate-pulse" />
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- Evaluations */

function EvaluationsTab({ runs, selected, onSelect, onAsk, score, onScoreboard }: { runs: RunSummary[]; selected: string | null; onSelect: (id: string | null) => void; onAsk: () => void; score: HeadToHead; onScoreboard: (s: HeadToHead) => void }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  // On narrow screens the detail sits below the list; bring it into view when one is opened.
  useEffect(() => {
    if (detail && window.innerWidth < 1024) detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [detail]);

  useEffect(() => {
    if (!selected) return setDetail(null);
    let live = true;
    setLoading(true);
    setError(null);
    fetch(`/api/runs/${selected}`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject((await r.json()).error?.message)))
      .then((d) => live && setDetail(d))
      .catch((m) => live && (setDetail(null), setError(typeof m === "string" ? m : "Could not load this evaluation.")))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [selected]);

  if (!runs.length && !selected) {
    return (
      <div className="py-16 max-w-md">
        <h2 className="text-[17px] font-medium">No evaluations yet</h2>
        <p className="text-ink2 mt-1">Pick a document and ask a question. The answer is graded by both evaluators.</p>
        <button className="btn btn-primary mt-4" onClick={onAsk}>Go to documents</button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
    <Scoreboard s={score} />
    <div className="grid lg:grid-cols-[minmax(0,360px)_1fr] gap-8">
      <ul className="border border-line rounded-lg divide-y divide-line self-start overflow-hidden lg:sticky lg:top-20 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
        {runs.map((r) => (
          <li key={r.id}>
            <button onClick={() => onSelect(r.id)} aria-current={selected === r.id} className={`w-full text-left px-4 py-3 ${selected === r.id ? "bg-neutral-bg" : "hover:bg-s2"}`}>
              <span className="block text-[13px] leading-snug line-clamp-2">{r.claim}</span>
              {r.answer_text && <span className="block text-[12px] text-ink2 leading-snug line-clamp-1 mt-1">{r.answer_text}</span>}
              <span className="flex flex-wrap items-center gap-x-3 mt-1.5 text-[12px] text-muted tabular">
                <Mini label="Jev" r={r.jev} truth={r.truth} />
                <Mini label="Judge" r={r.judge} truth={r.truth} />
                {r.mode === "qa" && <span>{r.truth ? (r.truth === "correct" ? "marked correct" : "marked wrong") : "not marked"}</span>}
                <span className="ml-auto">{ago(r.created_at)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 scroll-mt-20" ref={detailRef}>
        {loading && <p className="text-ink2">Loading…</p>}
        {error && <p className="text-bad">{error}</p>}
        {!loading && detail && <RunView key={detail.run.id} detail={detail} onScoreboard={onScoreboard} />}
        {!loading && !detail && !error && <p className="text-ink2">Select an evaluation to see both verdicts and the evidence.</p>}
      </div>
    </div>
    </div>
  );
}

function Mini({ label, r, truth }: { label: string; r: RunSummary["jev"]; truth: RunSummary["truth"] }) {
  if (!r) return <span>{label} —</span>;
  const mark = truth ? (r.status === "ok" && r.label === truth ? <span className="text-good"> ✓</span> : <span className="text-bad"> ✕</span>) : null;
  if (r.status !== "ok" || !r.label) return <span>{label} {STATUS_TEXT[r.status]?.toLowerCase() ?? r.status}{mark}</span>;
  return <span>{label} <span className={LABEL_COLOR[r.label]}>{LABEL_TEXT[r.label].toLowerCase()}</span>{mark}</span>;
}
