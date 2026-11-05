# Phase-1 technical assessment (2026-10-29)

Decisions were made and implementation continued without waiting for approval at each step. Everything below was checked against live documentation or APIs on the date shown.

## Jev integration

- **Identity.** The brief says "Typeface", but both references point to **TypeSafe** (docs.typesafe.ai). Jev is TypeSafe's hosted "System One" model.
  - `github.com/FathirAMM/system-one-decision-model` is a third-party, MIT-licensed "Decision Lab". It lists Jev as "TypeSafe's hosted commercial API".
  - The same repo also covers Kev-4B (an open reconstruction) and Laya. Laya is out of scope and not integrated.
- **API.** `POST https://api.typesafe.ai/v1/systemone`.
  - Auth: `Authorization: Bearer $TYPESAFE_API_KEY`, with keys issued at console.typesafe.ai/keys.
  - Body: `{state, model, questions:{id:{type, instructions, criteria}}}`.
  - A `choice` answer returns `{choice, probabilities, confidence}`, and the response includes `usage.input_tokens`.
  - Official SDKs: `@typesafe-ai/sdk` (JS) and `typesafe-sdk` (Python).
  - Limits: 32 MiB body; 64k tokens per request and 32k per question (long context is opt-in).
  - Errors: 413, 415, 422, 429, 529.
- **Live check.** A request with a placeholder key returned HTTP 401 `authentication_error`. This confirms the endpoint and auth scheme; only a valid key is missing.
- **Models.** `jev-1.14.0`, also aliased as `jev-latest` and `jev-preview`, and `jev-1.13.0`. The docs warn that aliases move, so **we pin `jev-1.14.0`**.
- **Pricing.** $0.042 per million input tokens, output free. No free tier is documented. Rate limits are set per organization and shown in the console.
- **Fit.** The `Choice` primitive maps 1:1 onto `supported / contradicted / insufficient_evidence`. TypeSafe's own `citation_check` cookbook uses the same pattern (`supports / contradicts / says_nothing` over `{claim, section}`).
  - We ask one `verdict` question over all passages, plus one `rel_E<n>` relation question per passage in the same request. The relation answers give Jev evidence references.
- **Semantics.** Jev returns probabilities and a confidence derived from their spread, and no text. In decision.v1:
  - its explanation is **derived** from those structured answers and labelled as such;
  - its confidence is kept but flagged **uncalibrated** until the benchmark's reliability/ECE table says otherwise.
- **Blocker.** `TYPESAFE_API_KEY`. The adapter is complete and mock-tested, and when the key is unset the UI shows "not configured", never a fake result.

## OpenRouter judge

- **Free catalogue options (checked via `/api/v1/models`):**
  - `google/gemma-4-31b-it:free` and `google/gemma-4-26b-a4b-it:free`, both with 262k context and `response_format` support;
  - several NVIDIA Nemotron `:free` models.
- **Choice:** **`google/gemma-4-31b-it:free`**. It is the strongest dense Gemma, has a long context, and supports JSON mode. Its only endpoint is Google AI Studio, which does *not* advertise `structured_outputs` (json_schema).
  - We therefore use JSON mode, validate with zod, and allow one repair attempt. If repair fails, the result is recorded as `malformed`, which is itself a measured reliability metric.
- **Limits.** `:free` models allow 20 requests/min, and 50 requests/day until $10 of credits has been purchased (1,000/day after). The benchmark runner paces judge calls at 3.5 s and has a `--max-judge-calls` budget.
- **Reproducibility.** Requests use temperature 0 and seed 7, the response `model` is recorded, and the model is pinned via `JUDGE_MODEL`.
- **No silent fallback.** No `models` list is sent, so OpenRouter cannot substitute a different model. A 404 or 429 is surfaced as an error. The paid `google/gemma-4-31b-it` ($0.20/$0.40 per Mtok) is used only if it is configured explicitly.
- **Privacy.** Free endpoints may log prompts. This is disclosed in the UI, and the `OPENROUTER_DATA_COLLECTION=deny` option restricts routing.

## Embeddings

- **Choice:** `baai/bge-m3` via OpenRouter `/embeddings`: 1024 dimensions, 8k context, $0.01 per million tokens, MIT-licensed open weights. It reuses the OpenRouter key.
- **Free embedding endpoints rejected:** `nvidia/*-embed:free` was avoided, because if it disappeared, every stored vector would be orphaned.
- **Model pinning:** the model id is stored on every chunk, and queries filter on it. The vector column is `vector(1024)`, so Postgres rejects any wrong-dimension vector (covered by a test).
- **Without a key:** documents index lexical-only, and vector/hybrid retrieval is disabled for them, with a clear message.

## Supabase

One project provides Auth (Google), private Storage, Postgres with pgvector 0.8 (an HNSW cosine index with `iterative_scan` for filtered queries), quotas and traces. A separate vector database isn't needed at this scale.

- **Free tier:** 500 MB database, 1 GB storage, 5 GB egress, 50k MAU, and projects pause after 1 week of inactivity.
- **Footprint:** about 300 chunks × 1024 floats ≈ 1.3 MB of vectors per benchmark set. Free-tier limits are not a constraint for a demo.

## Retrieval

| Strategy | Implementation |
|---|---|
| Lexical | Postgres FTS (english `tsvector`, OR-of-lexemes query, `ts_rank_cd`). Not BM25 |
| Vector | pgvector cosine search |
| Hybrid | Reciprocal-rank fusion (k=60) of the two candidate lists of 30 |

- No reranker is used unless measured results justify one.
- All retrieval RPCs are `SECURITY INVOKER`, so RLS scopes evidence to the caller.

## Authentication and authorization

- **Sign-in:** Supabase Auth with Google OAuth, using the `@supabase/ssr` cookie session.
- **Session checks:** every protected route calls `getUser()`, which verifies the session with Supabase Auth. Admin status comes only from `ADMIN_EMAILS` matched against the verified email.

## Deployment

- **Hosting:** Vercel Hobby, with fluid compute and a 300 s function cap.
- **Uploads:** they bypass the function request-body limit by going straight to Storage with server-issued signed upload URLs; the server then re-validates the stored bytes.
- **No servers:** there is no GPU and no always-on model server; every model call is pay-as-you-go.

## Cost risks

See the README "Costs" section. The main exposures:

- the judge's free daily cap during benchmarks;
- Supabase project pausing;
- egress from repeated PDF downloads.

Billing on OpenRouter is prepaid, and Vercel Hobby and Supabase Free cannot run up overage charges.
