# Decision Model Observatory

An evaluation harness and web app that compares **Jev**, TypeSafe's "System One" decision model, with an **LLM-as-a-judge** served through OpenRouter. Both judge claims about financial PDFs, and both see **exactly the same retrieved evidence**. Retrieval, decision and end-to-end quality are measured as **separate layers**, so a retrieval miss is never blamed on the decision model. The methodology follows Airbnb's [eval-driven development](https://airbnb.tech/ai-ml/eval-driven-development-lessons-from-evaluating-genai-at-scale/) write-up.

> Experimental evaluation tool. Model outputs are assertions, not verified facts. Not investment advice.

| | |
|---|---|
| Decision model under test | Jev `jev-1.14.0` (pinned): `POST https://api.typesafe.ai/v1/systemone`, official SDK `@typesafe-ai/sdk` |
| Baseline judge | OpenRouter `google/gemma-4-31b-it:free` (configurable, no silent fallback) |
| Embeddings | `baai/bge-m3` via OpenRouter (1024-d) |
| Database / vectors / auth / storage | Supabase: Postgres + pgvector (HNSW), Google OAuth, private Storage, RLS |
| App | Next.js 15 (App Router) on Vercel |

See [`docs/assessment.md`](docs/assessment.md) for the Phase-1 technical assessment, [`docs/deployment.md`](docs/deployment.md) for setup and deployment, and [`docs/blog-outline.md`](docs/blog-outline.md) for the write-up plan, which uses measured results only.

## Current status (2026-10-30)

| Area | Status |
|---|---|
| Schema, RLS, storage policies, quota/rate-limit RPCs | ✅ Versioned migrations. Verified by 18 integration tests on local Supabase |
| PDF ingest → chunks (page-preserving) → embeddings → pgvector | ✅ Verified locally. Embeddings mocked in tests until an OpenRouter key is provided |
| Lexical / vector / hybrid (RRF) retrieval | ✅ Implemented and tested. **Measured so far: lexical only** (vector/hybrid need the embedding key) |
| Jev adapter | ✅ Built against the documented API and tested with mocks. The live endpoint answered `401 authentication_error` to a placeholder key, which confirms the URL and auth scheme. **Blocked on a `TYPESAFE_API_KEY`** |
| OpenRouter judge adapter | ✅ Mock-tested (JSON mode, zod validation, one repair, bounded retries, no model fallback). **Blocked on an `OPENROUTER_API_KEY`** |
| Golden dataset v1 | ✅ 112 claims, 2 public documents, quotes and arithmetic machine-verified. ⚠️ Labels pending human review |
| Benchmark runner + immutable reports + dashboard | ✅ Retrieval layer measured. Decision/e2e layers run end to end with mocks; real numbers need provider keys |
| Google OAuth, quota (10/month UTC), admin exemption | ✅ Implemented. Quota and admin exemption verified in integration tests. Google sign-in needs OAuth client credentials |
| Public deployment | ⏳ Blocked on Supabase project, Vercel and Google OAuth credentials. Exact steps are in `docs/deployment.md` |

### Measured so far (real, not mocked)

Lexical retrieval (Postgres full-text, `ts_rank_cd`) on golden v1 covers 108 claims with labelled evidence. Report: `reports/2026-10-29-be7f92c5.json`.

| k | 1 | 3 | 5 | 8 | 10 |
|---|---|---|---|---|---|
| Group Recall@k | 53.7% | 69.0% | 71.8% | 75.5% | 81.0% |

MRR = 0.628. No Jev or judge accuracy is reported yet, because none has been measured.

## Quick start (local)

```bash
pnpm install
colima start            # or any Docker runtime
pnpm db:start           # local Supabase on :54321 (applies supabase/migrations)
cp .env.example .env.local   # then fill in local keys printed by `supabase status`
pnpm golden:verify      # downloads the two source PDFs, verifies quotes and arithmetic
pnpm bench:seed         # indexes benchmark docs (lexical-only without OPENROUTER_API_KEY)
pnpm bench --layers retrieval
pnpm build && pnpm start
```

Locally you can skip Google sign-in: with `DEV_LOGIN=1` in `.env.local`, a **Skip sign-in (local)** button signs you in as `dev@localhost.test` (set `DEV_LOGIN_EMAIL` to change it, and add it to `ADMIN_EMAILS` for the admin view). The bypass works only when Supabase is `localhost`/`127.0.0.1` and the app is not on Vercel; otherwise the route returns 404 and the button is hidden.

| Command | What it does |
|---|---|
| `pnpm test` | 45 unit tests (schema, adapters with mocked HTTP `[mock]`, chunking, PDF extraction, metrics, taxonomy, admin, UTC month) |
| `pnpm test:int` | 18 integration tests against **local** Supabase (RLS, storage, RPC privileges, quota races, idempotency, admin exemption, retrieval RPCs, traces) |
| `pnpm exec tsx scripts/smoke-http.ts` | 29-check HTTP smoke test against a running app + local Supabase |
| `pnpm bench --layers retrieval,decision,e2e --strategies hybrid` | Full benchmark. Writes `reports/*.json` and an immutable `benchmark_reports` row |

## How it works

```
Browser ──(Google OAuth via Supabase Auth)──► Next.js on Vercel
  │  signed upload URL (server-generated path {uid}/{uuid}.pdf)
  └──────────────► Supabase Storage (private bucket, 20 MB, application/pdf)
Next.js /api/documents/:id/process: re-validate bytes (%PDF, size, sha256 dedupe)
   → unpdf per-page text → chunk.v1 (page-bounded, key {sha12}:p{page}:c{n})
   → bge-m3 embeddings → document_chunks (tsvector + vector(1024) HNSW)
Next.js /api/evaluate:
   getUser() → zod → throttle (user + hashed IP) → reserve_question RPC (atomic)
   → retrieve (lexical | vector | hybrid RRF; SECURITY INVOKER ⇒ RLS-scoped)
   → same passages ─┬─► Jev: verdict Choice + one relation Choice per passage
                    └─► Judge: JSON verdict + quoted citations (quote string-matched)
   → normalize to decision.v1 → persist results + trace + usage events
```

**decision.v1** (`lib/decision/schema.ts`) contains:

- `label` ∈ {supported, contradicted, insufficient_evidence}
- `explanation` with `kind: generated | derived`. Jev writes no text, so its explanation is derived from its probabilities and labelled that way.
- `evidence_refs` with chunk keys and pages
- `confidence`: present only for Jev's native confidence, flagged `calibrated: false`. The judge gets none, because verbalized confidence is not meaningful.
- `probabilities` for Jev, and the raw provider output.

### Quota, retry and failure policy

- **10 questions per user per UTC calendar month.** One question is one claim submitted for comparison. The two provider calls count once against quota and are tracked separately for cost.
- **Atomic reservation** (`reserve_question`, executable only by the service role) takes a per-user advisory lock, then:
  - checks idempotency;
  - allows one in-flight run per user;
  - applies a conditional `INSERT … ON CONFLICT DO UPDATE … WHERE used < limit`.

  Tests run 20 concurrent submissions and confirm exactly one is accepted, and they confirm parallel races at 8/10 stop exactly at 10.
- **Released** (refunded) only when the run is rejected **before any provider call**: a retrieval error, zero passages, or no providers configured (refused before reservation).
- **Counted** once providers have been called, even if one or both fail. A failure in one provider never hides the other's result.
- **Idempotency:** the client sends an `Idempotency-Key`, and re-sending it returns the existing run without a second charge.
- **Provider calls** have a 30 s timeout, at most 2 retries on 429/5xx/timeouts, and one JSON-repair attempt for the judge. There is no automatic model fallback.
- **Throttles:** 5 evaluations per minute per user and 20 per minute per hashed IP; 10 uploads per hour per user; 10 stored documents per user.

### Admin exemption

Admin status is derived **only on the server**: the verified email from Supabase `getUser()` must be in `ADMIN_EMAILS`. Google emails count as verified; any other provider requires `email_confirmed_at`.

- Admins skip the monthly limit only. Throttles, auth and RLS still apply.
- Admin usage and costs are still recorded (`usage_events.is_admin = true`).
- Client-supplied flags are ignored; the smoke test sends forged `isAdmin` and `x-admin` values to confirm this.
- To verify: sign in with the allowlisted account. The Evaluate page shows "Admin: exempt…" and an **Admin** nav item appears.

### Security model

- **Database access:** RLS on every table. Clients have read-only policies; all writes go through server routes using the service role after `getUser()`. Retrieval RPCs are `SECURITY INVOKER`, so a user can only retrieve chunks from their own documents or the public benchmark documents.
- **Storage:** private bucket, per-user prefix policies, no client upload policy (uploads use server-issued signed URLs only), 60 s signed download URLs, and server-side re-validation of the stored bytes.
- **Prompt injection:** document text is wrapped as untrusted data, the system prompt tells the model to ignore embedded instructions, and no tools are attached to any call. The output can only choose a label and cite supplied passage ids; unknown ids are dropped. Golden example `q3-058` is an adversarial claim.
- **Secrets:** only `NEXT_PUBLIC_SUPABASE_URL` and the anon key reach the browser. `SUPABASE_SERVICE_ROLE_KEY` and the provider keys are server-only.
- **Deletion:** deleting a document soft-deletes the row and immediately removes the stored PDF and its chunks. Traces keep the claim and decisions but lose the passage text.
- **Privacy:** free OpenRouter endpoints may log prompts. The UI warns users not to upload confidential documents. Set `OPENROUTER_DATA_COLLECTION=deny` to restrict routing (this may make free models unavailable).

## Evaluation methodology (summary)

1. **Golden set v1** (`data/golden/v1`): 112 claims about a Berkshire Hathaway Q3-2025 10-Q and the 2025 shareholder letter. The set mixes direct lookups, YoY changes, computed ratios, multi-page claims, period, entity and scope confusions, outside-knowledge traps, ambiguous claims and one adversarial claim. See the datasheet in [`data/golden/v1/README.md`](data/golden/v1/README.md).
2. **Three layers:** retrieval (group Recall@k / MRR / nDCG, no model calls), decision (oracle gold passages plus fixed distractors), and end-to-end (each strategy, k=8).
3. **Metrics:**
   - accuracy with Wilson and bootstrap CIs, per-class P/R/F1 and confusion matrices
   - FPR with **positive = supported**
   - abstention rate, precision and recall
   - citation validity, latency p50/p95 and cost per evaluation
   - Jev–judge agreement, κ and exact McNemar test, presented as agreement, never as correctness
   - Jev reliability/ECE
4. **Failure taxonomy v1** (`lib/eval/taxonomy.ts`): heuristic auto-suggestions are stored with `source='auto'`, and admin confirmations append `source='human'` rows.
5. **Reproducibility:** each run records dataset, ground-truth label version, retrieval strategy and k, embedding model, Jev and judge model ids, `decision.v1`, `judge-rubric.v1`, `jev-questions.v1` and `chunk.v1`. Reports are immutable (a DB trigger blocks updates) and pin a snapshot of label versions. Label reviews append new versions, never edits.

## Evaluator Intelligence (`/evaluators`)

This page shows which errors Jev and the LLM judge each catch, where they disagree, and whether combining them pays off. Everything on it is computed in `lib/eval/evaluator-intel.ts` from grades already stored in the immutable reports. The only new model calls were the 45-case adversarial set (`data/golden/qa-adv-v1`, 90 calls, about $0.03).

- **Capability matrix:** detection rate per error category, plus unique catches, answers missed by both, and false alarms on correct answers that probe the same category. Categories with fewer than 10 wrong answers are flagged as too small to conclude.
- **Disagreement explorer:** a clickable 2×2 (wrong answers, or false alarms on correct ones), a paired McNemar test with a bootstrap interval, and each example with its evidence and both verdicts.
- **Hybrid policies:**

  | Policy | Rule |
  |---|---|
  | A | Jev only |
  | B | Judge only |
  | C | Reject if either says incorrect (OR) |
  | D | Jev first, escalate disagreements |

  All four are simulated from stored grades. Costs are measured; C and D latencies are estimated from measured per-answer values.
- **Findings:** templated, and shown only when their guards pass (n ≥ 10 and p < 0.05 for a category claim; at least 5 unique catches on each side for "complementary"). The page recommends the cheapest configuration that is not significantly worse than the best one.
- **Commands:** `pnpm qa:categories` checks the category labels; `pnpm qa:adv:build` rebuilds the adversarial set; `pnpm qa:bench --version qa.adv-v1` regrades it.

## Costs

| Item | Cost |
|---|---|
| Vercel Hobby | $0 (non-commercial; functions up to 300 s) |
| Supabase Free | $0. 500 MB DB, 1 GB storage, 5 GB egress; **pauses after 1 week of inactivity**. Pro is $25/mo with a spend cap on by default |
| Jev | $0.042 per million input tokens (output free). A typical 8-passage question is ~3–5k tokens ≈ **$0.0002** |
| Judge (`gemma-4-31b-it:free`) | $0, but 20 req/min and **50 req/day** (1,000/day after a one-time $10 credit purchase). The paid variant costs $0.20/$0.40 per Mtok, used only if set explicitly |
| Embeddings (bge-m3) | $0.01 per million tokens. A 60-page 10-Q is ~60k tokens ≈ **$0.0006** |
| Full benchmark (112 × oracle + 3 strategies) | ~450 judge calls (needs the 1,000/day tier) + ~450 Jev calls ≈ **< $0.15** |

Unexpected-charge risks and alerts:

- **Supabase:** egress from repeated PDF downloads, and Pro overages if the spend cap is turned off.
- **OpenRouter:** prepaid credits, so no surprise bills. Set a key credit limit in the dashboard.
- **TypeSafe:** pay per use. Set organization usage alerts in console.typesafe.ai.
- **Vercel:** Hobby has hard limits rather than overage billing.

## Limitations

- **Jev and judge results have not been measured yet** (no provider keys during the build). Every decision-layer number in this repo comes from mocks and is labelled MOCK, or does not exist.
- **Labels are LLM-drafted and pending human review.** They are machine-verified for quotes and arithmetic, and the dashboard says so. The set has two documents from one issuer, and its classes are imbalanced (63/31/18).
- **Lexical retrieval** is Postgres FTS with `ts_rank_cd`, not BM25.
- **PDF extraction:** tables flatten into text lines, and scanned PDFs are rejected (no OCR).
- **Throttling** is Postgres-backed and adequate for a demo, not a high-traffic edge rate limiter.
