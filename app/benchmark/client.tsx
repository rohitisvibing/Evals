"use client";
import { useState } from "react";

export function ReviewControls({ examples }: { examples: { id: string; claim: string; gold: string }[] }) {
  const [id, setId] = useState(examples[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const ex = examples.find((e) => e.id === id);

  async function send(action: "reviewed" | "disputed") {
    const res = await fetch("/api/benchmark/labels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ example_id: id, action, note }) });
    const body = await res.json();
    setMsg(res.ok ? `Saved label v${body.label_version} (${action}).` : body.error?.message ?? "Failed");
  }

  return (
    <div className="space-y-2 text-sm">
      <select className="field" value={id} onChange={(e) => { setId(e.target.value); setMsg(null); }}>
        {examples.map((e) => <option key={e.id} value={e.id}>{e.id}: {e.claim.slice(0, 80)}</option>)}
      </select>
      {ex && <p className="text-ink2">{ex.claim} Labelled <strong>{ex.gold.replace("_", " ")}</strong>.</p>}
      <input className="field" placeholder="Reviewer note (required for disputes)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
      <div className="flex gap-2">
        <button className="btn btn-sm" onClick={() => send("reviewed")}>Confirm label</button>
        <button className="btn btn-sm text-bad" disabled={!note.trim()} onClick={() => send("disputed")}>Dispute</button>
      </div>
      {msg && <p className="text-xs">{msg}</p>}
    </div>
  );
}
