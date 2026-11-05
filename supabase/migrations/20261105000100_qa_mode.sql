-- Question-answering mode: a RAG pipeline answers a question, then Jev and the
-- LLM judge grade that answer. Truth comes from reference answers (benchmark)
-- or from the user marking the answer (live).

-- ---------------------------------------------------------------------------
-- evaluation_runs: mode, generated answer, truth
-- ---------------------------------------------------------------------------
alter table public.evaluation_runs
  add column mode         text not null default 'claim' check (mode in ('claim', 'qa')),
  add column answer       jsonb,   -- {text, abstained, citations[], model, host, status, latency_ms, tokens, cost, error}
  add column truth_label  text check (truth_label in ('correct', 'incorrect')),
  add column truth_source text check (truth_source in ('user', 'reference', 'construction')),
  add column truth_at     timestamptz,
  add column benchmark_item_id text;   -- benchmark_qa_items.item_id for QA benchmark runs

comment on column public.evaluation_runs.claim is 'Input text: the claim (mode=claim) or the question (mode=qa).';

alter table public.evaluation_runs drop constraint evaluation_runs_status_check;
alter table public.evaluation_runs add constraint evaluation_runs_status_check
  check (status in ('reserved', 'retrieving', 'generating', 'evaluating', 'completed', 'partial', 'failed', 'released'));

create index evaluation_runs_truth_idx on public.evaluation_runs (user_id) where mode = 'qa' and truth_label is not null;

-- ---------------------------------------------------------------------------
-- evaluation_results: answer grades use their own labels
-- ---------------------------------------------------------------------------
alter table public.evaluation_results drop constraint evaluation_results_label_check;
alter table public.evaluation_results add constraint evaluation_results_label_check
  check (label in ('supported', 'contradicted', 'insufficient_evidence', 'correct', 'incorrect', 'cannot_tell'));

-- ---------------------------------------------------------------------------
-- QA golden set: candidate answers with known truth (append-only, versioned)
-- ---------------------------------------------------------------------------
create table public.benchmark_qa_items (
  dataset_version text not null,
  item_id         text not null,
  question_id     text not null,
  document_key    text not null,
  question        text not null,
  answer_text     text not null,
  abstained       boolean not null default false,
  source          text not null check (source in ('reference', 'rag_oracle', 'rag_hybrid', 'perturbation')),
  perturbation    text,             -- number_shift | direction_flip | unit_swap | false_abstention | fabricated_answer
  truth_label     text not null check (truth_label in ('correct', 'incorrect')),
  truth_source    text not null check (truth_source in ('reference', 'construction', 'review')),
  review_status   text not null default 'auto' check (review_status in ('auto', 'needs_review', 'reviewed', 'excluded')),
  evidence_keys   text[] not null default '{}',   -- passages the evaluators see for this item
  is_synthetic    boolean not null default false,
  generator_model text,
  created_at      timestamptz not null default now(),
  primary key (dataset_version, item_id)
);

alter table public.benchmark_qa_items enable row level security;
create policy bench_qa_items_select on public.benchmark_qa_items for select to authenticated using (true);
revoke all on public.benchmark_qa_items from anon;

-- ---------------------------------------------------------------------------
-- Quota RPCs: treat 'generating' as in flight / releasable. Same signatures,
-- so existing grants (service_role only) are preserved.
-- ---------------------------------------------------------------------------
create or replace function public.reserve_question(
  p_user_id         uuid,
  p_idempotency_key text,
  p_is_admin        boolean,
  p_limit           integer,
  p_document_id     uuid,
  p_claim           text,
  p_strategy        text,
  p_params          jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_month    date := date_trunc('month', now() at time zone 'utc')::date;
  v_existing public.evaluation_runs%rowtype;
  v_used     integer;
  v_run_id   uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('quota:' || p_user_id::text, 0));

  select * into v_existing from public.evaluation_runs
   where user_id = p_user_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'run_id', v_existing.id, 'status', v_existing.status);
  end if;

  if exists (select 1 from public.evaluation_runs
              where user_id = p_user_id
                and status in ('reserved', 'retrieving', 'generating', 'evaluating')
                and created_at > now() - interval '3 minutes') then
    return jsonb_build_object('ok', false, 'error', 'concurrent_run');
  end if;

  if not p_is_admin then
    insert into public.monthly_usage as mu (user_id, month, used)
    values (p_user_id, v_month, 1)
    on conflict (user_id, month) do update set used = mu.used + 1 where mu.used < p_limit
    returning used into v_used;

    if v_used is null then
      select used into v_used from public.monthly_usage where user_id = p_user_id and month = v_month;
      return jsonb_build_object('ok', false, 'error', 'quota_exceeded', 'used', v_used, 'limit', p_limit);
    end if;
  else
    select coalesce((select used from public.monthly_usage where user_id = p_user_id and month = v_month), 0)
      into v_used;
  end if;

  insert into public.evaluation_runs
    (kind, user_id, idempotency_key, document_id, claim, status, quota_counted, is_admin, retrieval_strategy, retrieval_params)
  values
    ('live', p_user_id, p_idempotency_key, p_document_id, p_claim, 'reserved', not p_is_admin, p_is_admin, p_strategy, coalesce(p_params, '{}'::jsonb))
  returning id into v_run_id;

  insert into public.usage_events (user_id, run_id, kind, is_admin) values (p_user_id, v_run_id, 'question', p_is_admin);

  return jsonb_build_object('ok', true, 'duplicate', false, 'run_id', v_run_id, 'used', v_used, 'limit', p_limit, 'is_admin', p_is_admin);
end $$;

create or replace function public.release_question(p_run_id uuid, p_reason text)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_run public.evaluation_runs%rowtype;
begin
  select * into v_run from public.evaluation_runs where id = p_run_id for update;
  -- Releasable only before any *evaluator* ran (generation failures included).
  if not found or v_run.status not in ('reserved', 'retrieving', 'generating') then
    return false;
  end if;

  if v_run.quota_counted then
    update public.monthly_usage
       set used = greatest(used - 1, 0)
     where user_id = v_run.user_id
       and month = date_trunc('month', v_run.created_at at time zone 'utc')::date;
  end if;

  update public.evaluation_runs
     set status = 'released', quota_counted = false, error = p_reason, completed_at = now()
   where id = p_run_id;

  insert into public.usage_events (user_id, run_id, kind, is_admin)
  values (v_run.user_id, p_run_id, 'question_released', v_run.is_admin);
  return true;
end $$;
