-- Decision Model Observatory — core schema.
-- Conventions:
--   * All client access is read-only through RLS. Every mutation goes through
--     server routes that verify the session and use the service role.
--   * Privileged RPCs (quota, rate limit) are executable by service_role only.

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------
create table public.documents (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid references auth.users (id) on delete cascade,
  visibility      text not null default 'private' check (visibility in ('private', 'benchmark')),
  title           text not null check (char_length(title) between 1 and 200),
  storage_path    text not null unique,
  sha256          text check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size       integer check (byte_size > 0),
  page_count      integer check (page_count >= 0),
  status          text not null default 'pending_upload'
                  check (status in ('pending_upload', 'processing', 'indexed', 'failed')),
  error           text,
  embedding_model text,
  embedding_dim   integer,
  chunker_version text,
  -- benchmark documents only: pinned public source + human-readable key
  benchmark_key   text unique,
  source_url      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint documents_owner_required check (visibility = 'benchmark' or owner_id is not null)
);

create index documents_owner_idx on public.documents (owner_id) where deleted_at is null;
-- Dedupe: one live copy of the same bytes per owner.
create unique index documents_owner_sha_uniq on public.documents (owner_id, sha256)
  where deleted_at is null and sha256 is not null;

-- ---------------------------------------------------------------------------
-- document_chunks
-- ---------------------------------------------------------------------------
create table public.document_chunks (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references public.documents (id) on delete cascade,
  chunk_key       text not null unique,          -- {sha12}:p{page_start}:c{index}
  chunk_index     integer not null,
  page_start      integer not null check (page_start >= 1),
  page_end        integer not null check (page_end >= page_start),
  content         text not null,
  tsv             tsvector generated always as (to_tsvector('english', content)) stored,
  embedding       extensions.vector(1024),
  embedding_model text,
  created_at      timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create index document_chunks_doc_idx on public.document_chunks (document_id);
create index document_chunks_tsv_idx on public.document_chunks using gin (tsv);
create index document_chunks_embedding_idx on public.document_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- evaluation runs / results
-- ---------------------------------------------------------------------------
create table public.evaluation_runs (
  id                      uuid primary key default gen_random_uuid(),
  kind                    text not null check (kind in ('live', 'benchmark')),
  user_id                 uuid references auth.users (id) on delete cascade,
  idempotency_key         text,
  document_id             uuid references public.documents (id) on delete set null,
  claim                   text not null check (char_length(claim) between 1 and 1000),
  status                  text not null default 'reserved'
                          check (status in ('reserved', 'retrieving', 'evaluating', 'completed', 'partial', 'failed', 'released')),
  quota_counted           boolean not null default false,
  is_admin                boolean not null default false,
  retrieval_strategy      text check (retrieval_strategy in ('lexical', 'vector', 'hybrid', 'oracle')),
  retrieval_params        jsonb not null default '{}'::jsonb,
  retrieved               jsonb,       -- [{chunk_key, page_start, page_end, rank, score, ...}]
  retrieval_ms            integer,
  embedding_model         text,
  decision_schema_version text,
  rubric_version          text,
  dataset_version         text,
  ground_truth_version    text,
  benchmark_example_id    text,
  benchmark_condition     text,
  benchmark_batch_id      uuid,
  config                  jsonb not null default '{}'::jsonb,
  error                   text,
  created_at              timestamptz not null default now(),
  completed_at            timestamptz,
  constraint runs_live_has_user check (kind = 'benchmark' or user_id is not null),
  unique (user_id, idempotency_key)
);

create index evaluation_runs_user_idx on public.evaluation_runs (user_id, created_at desc);
create index evaluation_runs_batch_idx on public.evaluation_runs (benchmark_batch_id) where benchmark_batch_id is not null;

create table public.evaluation_results (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references public.evaluation_runs (id) on delete cascade,
  provider       text not null check (provider in ('jev', 'llm_judge')),
  model          text,
  status         text not null check (status in ('ok', 'error', 'timeout', 'malformed', 'not_configured', 'rate_limited')),
  label          text check (label in ('supported', 'contradicted', 'insufficient_evidence')),
  decision       jsonb,        -- normalized decision.v1
  raw            jsonb,        -- provider-native response (debugging)
  evidence_sent  text[] not null default '{}',
  latency_ms     integer,
  input_tokens   integer,
  output_tokens  integer,
  est_cost_usd   numeric(12, 8),
  retries        integer not null default 0,
  error          text,
  created_at     timestamptz not null default now(),
  unique (run_id, provider)
);

create index evaluation_results_run_idx on public.evaluation_results (run_id);

-- ---------------------------------------------------------------------------
-- benchmark dataset (append-only, versioned)
-- ---------------------------------------------------------------------------
create table public.benchmark_examples (
  dataset_version text not null,
  example_id      text not null,
  document_key    text not null,     -- documents.benchmark_key
  claim           text not null,
  categories      text[] not null default '{}',
  is_synthetic    boolean not null default false,
  created_at      timestamptz not null default now(),
  primary key (dataset_version, example_id)
);

create table public.benchmark_labels (
  id                 uuid primary key default gen_random_uuid(),
  dataset_version    text not null,
  example_id         text not null,
  label_version      integer not null default 1,
  gold_label         text not null check (gold_label in ('supported', 'contradicted', 'insufficient_evidence')),
  evidence_anchors   jsonb not null default '[]'::jsonb,  -- [{page, quote}]
  relevant_chunk_keys text[] not null default '{}',       -- resolved from anchors at ingest
  relevant_pages     integer[] not null default '{}',
  rationale          text not null,
  calculation        text,
  provenance         text not null,
  review_status      text not null default 'pending_human_review'
                     check (review_status in ('pending_human_review', 'reviewed', 'disputed')),
  reviewer           text,
  reviewed_at        timestamptz,
  created_at         timestamptz not null default now(),
  foreign key (dataset_version, example_id) references public.benchmark_examples (dataset_version, example_id) on delete cascade,
  unique (dataset_version, example_id, label_version)
);

create table public.failure_annotations (
  id         uuid primary key default gen_random_uuid(),
  result_id  uuid not null references public.evaluation_results (id) on delete cascade,
  code       text not null,
  note       text,
  source     text not null check (source in ('auto', 'human')),
  annotator  text,
  created_at timestamptz not null default now()
);

create index failure_annotations_result_idx on public.failure_annotations (result_id);

-- ---------------------------------------------------------------------------
-- usage, quotas, throttling
-- ---------------------------------------------------------------------------
create table public.usage_events (
  id           bigint generated always as identity primary key,
  user_id      uuid references auth.users (id) on delete cascade,
  run_id       uuid references public.evaluation_runs (id) on delete set null,
  kind         text not null check (kind in ('question', 'question_released', 'provider_call', 'embedding')),
  provider     text,
  is_admin     boolean not null default false,
  est_cost_usd numeric(12, 8),
  created_at   timestamptz not null default now()
);

create index usage_events_user_idx on public.usage_events (user_id, created_at desc);

create table public.monthly_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  month   date not null,   -- first day of the UTC month
  used    integer not null default 0 check (used >= 0),
  primary key (user_id, month)
);

create table public.rate_limit_hits (
  id         bigint generated always as identity primary key,
  bucket     text not null,
  created_at timestamptz not null default now()
);

create index rate_limit_hits_bucket_idx on public.rate_limit_hits (bucket, created_at);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger documents_touch before update on public.documents
  for each row execute function public.touch_updated_at();
