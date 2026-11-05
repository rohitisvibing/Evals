import type { AnyLabel } from "@/lib/decision/schema";

export const LABEL_TEXT: Record<AnyLabel, string> = {
  supported: "Supported",
  contradicted: "Contradicted",
  insufficient_evidence: "Insufficient evidence",
  correct: "Correct",
  incorrect: "Incorrect",
  cannot_tell: "Can't tell",
};

export const LABEL_COLOR: Record<AnyLabel, string> = {
  supported: "text-good",
  contradicted: "text-bad",
  insufficient_evidence: "text-warn",
  correct: "text-good",
  incorrect: "text-bad",
  cannot_tell: "text-warn",
};

export const STATUS_TEXT: Record<string, string> = {
  ok: "Done",
  error: "Failed",
  timeout: "Timed out",
  malformed: "Invalid output",
  not_configured: "Not configured",
  rate_limited: "Rate limited",
  completed: "Completed",
  generating: "Answering",
  partial: "Partial",
  failed: "Failed",
  released: "Not counted",
  reserved: "Queued",
  retrieving: "Retrieving",
  evaluating: "Evaluating",
  indexed: "Ready",
  processing: "Indexing",
  pending_upload: "Uploading",
};

export const pages = (p: { page_start: number; page_end: number }) =>
  p.page_start === p.page_end ? `p. ${p.page_start}` : `pp. ${p.page_start}–${p.page_end}`;

export const ms = (x: number | null | undefined) =>
  x == null || Number.isNaN(x) ? "—" : x >= 1000 ? `${(x / 1000).toFixed(1)}s` : `${Math.round(x)}ms`;

export const usd = (x: number | null | undefined) =>
  x == null ? "—" : x === 0 ? "$0" : x < 0.001 ? `$${x.toFixed(6)}` : `$${x.toFixed(4)}`;

export function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
