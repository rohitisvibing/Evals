-- Row Level Security, storage policies, retrieval RPCs, quota + rate-limit RPCs.

-- ---------------------------------------------------------------------------
-- RLS: clients may only READ their own rows (plus shared benchmark rows).
-- No insert/update/delete policies exist, so the anon/authenticated roles
-- cannot write directly; the server performs writes with the service role
-- after verifying the session.
-- ---------------------------------------------------------------------------
alter table public.documents           enable row level security;
alter table public.document_chunks     enable row level security;
alter table public.evaluation_runs     enable row level security;
alter table public.evaluation_results  enable row level security;
alter table public.benchmark_examples  enable row level security;
alter table public.benchmark_labels    enable row level security;
alter table public.failure_annotations enable row level security;
alter table public.usage_events        enable row level security;
alter table public.monthly_usage       enable row level security;
alter table public.rate_limit_hits     enable row level security;

create policy documents_select on public.documents for select to authenticated
  using (deleted_at is null and (owner_id = (select auth.uid()) or visibility = 'benchmark'));

create policy chunks_select on public.document_chunks for select to authenticated
  using (exists (
    select 1 from public.documents d
    where d.id = document_id
      and d.deleted_at is null
      and (d.owner_id = (select auth.uid()) or d.visibility = 'benchmark')
  ));

create policy runs_select on public.evaluation_runs for select to authenticated
  using (user_id = (select auth.uid()) or kind = 'benchmark');

create policy results_select on public.evaluation_results for select to authenticated
  using (exists (
    select 1 from public.evaluation_runs r
    where r.id = run_id and (r.user_id = (select auth.uid()) or r.kind = 'benchmark')
  ));

create policy bench_examples_select on public.benchmark_examples for select to authenticated using (true);
create policy bench_labels_select   on public.benchmark_labels   for select to authenticated using (true);

create policy failures_select on public.failure_annotations for select to authenticated
  using (exists (
    select 1 from public.evaluation_results res
    join public.evaluation_runs r on r.id = res.run_id
    where res.id = result_id and (r.user_id = (select auth.uid()) or r.kind = 'benchmark')
  ));

create policy usage_events_select  on public.usage_events  for select to authenticated using (user_id = (select auth.uid()));
create policy monthly_usage_select on public.monthly_usage for select to authenticated using (user_id = (select auth.uid()));
-- rate_limit_hits: no policies (server only).

-- Belt and braces: anon gets nothing on these tables.
revoke all on all tables in schema public from anon;

-- ---------------------------------------------------------------------------
-- Storage: private bucket, per-user prefix `{uid}/...`.
-- Uploads are issued by the server as signed upload URLs to server-generated
-- paths; these policies stop any direct cross-user access with a user JWT.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 20971520, array['application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy documents_bucket_select on storage.objects for select to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy documents_bucket_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------------------------------------------------------------------------
-- Retrieval RPCs — SECURITY INVOKER so the caller's RLS applies: a user can
-- only ever retrieve chunks of their own documents or benchmark documents.
-- ---------------------------------------------------------------------------
create function public.match_chunks_vector(
  p_document_id     uuid,
  p_query_embedding extensions.vector(1024),
  p_embedding_model text,
  p_k               integer default 8
)
returns table (chunk_key text, page_start integer, page_end integer, content text, score double precision)
language sql stable security invoker
set search_path = public, extensions
set hnsw.iterative_scan = 'relaxed_order'
as $$
  select * from (
    select c.chunk_key, c.page_start, c.page_end, c.content,
           1 - (c.embedding <=> p_query_embedding) as score
    from public.document_chunks c
    where c.document_id = p_document_id
      and c.embedding_model = p_embedding_model
      and c.embedding is not null
    order by c.embedding <=> p_query_embedding
    limit least(greatest(p_k, 1), 50)
  ) s
  order by s.score desc;
$$;

-- Lexical baseline: Postgres full-text search, OR-ing the claim's lexemes and
-- ranking with ts_rank_cd (cover density). This is not BM25; documented as such.
create function public.claim_tsquery(p_query text) returns tsquery
language sql immutable
set search_path = public
as $$
  select coalesce(
    nullif(
      to_tsquery('simple',
        coalesce(
          (select string_agg(quote_literal(lex), ' | ')
           from unnest(tsvector_to_array(to_tsvector('english', p_query))) as lex),
          '')),
      ''::tsquery),
    ''::tsquery);
$$;

create function public.match_chunks_lexical(
  p_document_id uuid,
  p_query       text,
  p_k           integer default 8
)
returns table (chunk_key text, page_start integer, page_end integer, content text, score double precision)
language sql stable security invoker
set search_path = public
as $$
  with q as (select public.claim_tsquery(p_query) as tsq)
  select c.chunk_key, c.page_start, c.page_end, c.content,
         ts_rank_cd(c.tsv, q.tsq, 1)::double precision as score
  from public.document_chunks c, q
  where c.document_id = p_document_id
    and c.tsv @@ q.tsq
  order by score desc, c.chunk_index
  limit least(greatest(p_k, 1), 50);
$$;

-- Hybrid: reciprocal-rank fusion of the lexical and vector candidate lists.
create function public.match_chunks_hybrid(
  p_document_id     uuid,
  p_query           text,
  p_query_embedding extensions.vector(1024),
  p_embedding_model text,
  p_k               integer default 8,
  p_candidates      integer default 30,
  p_rrf_k           integer default 60
)
returns table (chunk_key text, page_start integer, page_end integer, content text, score double precision,
               lexical_rank integer, vector_rank integer)
language sql stable security invoker
set search_path = public, extensions
as $$
  with lex as (
    select l.chunk_key, row_number() over (order by l.score desc)::integer as rnk
    from public.match_chunks_lexical(p_document_id, p_query, p_candidates) l
  ),
  vec as (
    select v.chunk_key, row_number() over (order by v.score desc)::integer as rnk
    from public.match_chunks_vector(p_document_id, p_query_embedding, p_embedding_model, p_candidates) v
  ),
  fused as (
    select coalesce(lex.chunk_key, vec.chunk_key) as chunk_key,
           coalesce(1.0 / (p_rrf_k + lex.rnk), 0) + coalesce(1.0 / (p_rrf_k + vec.rnk), 0) as score,
           lex.rnk as lexical_rank, vec.rnk as vector_rank
    from lex full outer join vec on lex.chunk_key = vec.chunk_key
  )
  select c.chunk_key, c.page_start, c.page_end, c.content, f.score::double precision, f.lexical_rank, f.vector_rank
  from fused f
  join public.document_chunks c on c.chunk_key = f.chunk_key
  order by f.score desc, c.chunk_index
  limit least(greatest(p_k, 1), 50);
$$;

grant execute on function public.match_chunks_vector(uuid, extensions.vector, text, integer) to authenticated, service_role;
grant execute on function public.match_chunks_lexical(uuid, text, integer) to authenticated, service_role;
grant execute on function public.match_chunks_hybrid(uuid, text, extensions.vector, text, integer, integer, integer) to authenticated, service_role;
revoke execute on function public.match_chunks_vector(uuid, extensions.vector, text, integer) from public, anon;
revoke execute on function public.match_chunks_lexical(uuid, text, integer) from public, anon;
revoke execute on function public.match_chunks_hybrid(uuid, text, extensions.vector, text, integer, integer, integer) from public, anon;

-- ---------------------------------------------------------------------------
-- Quota reservation (atomic). Called only by the server with the service role,
-- passing the user id and admin flag it derived from the verified session.
-- ---------------------------------------------------------------------------
create function public.reserve_question(
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
  -- Serialize all reservations for this user.
  perform pg_advisory_xact_lock(hashtextextended('quota:' || p_user_id::text, 0));

  select * into v_existing from public.evaluation_runs
   where user_id = p_user_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'run_id', v_existing.id, 'status', v_existing.status);
  end if;

  if exists (select 1 from public.evaluation_runs
              where user_id = p_user_id
                and status in ('reserved', 'retrieving', 'evaluating')
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

-- Release a reservation that was rejected before any provider call.
create function public.release_question(p_run_id uuid, p_reason text)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_run public.evaluation_runs%rowtype;
begin
  select * into v_run from public.evaluation_runs where id = p_run_id for update;
  if not found or v_run.status not in ('reserved', 'retrieving') then
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

-- Sliding-window rate limiter. Returns true when the request is allowed.
create function public.check_rate_limit(p_bucket text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('rl:' || p_bucket, 0));
  delete from public.rate_limit_hits
   where bucket = p_bucket and created_at < now() - make_interval(secs => greatest(p_window_seconds, 3600));
  select count(*) into v_count from public.rate_limit_hits
   where bucket = p_bucket and created_at > now() - make_interval(secs => p_window_seconds);
  if v_count >= p_max then
    return false;
  end if;
  insert into public.rate_limit_hits (bucket) values (p_bucket);
  return true;
end $$;

revoke execute on function public.reserve_question(uuid, text, boolean, integer, uuid, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.release_question(uuid, text) from public, anon, authenticated;
revoke execute on function public.check_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.reserve_question(uuid, text, boolean, integer, uuid, text, text, jsonb) to service_role;
grant execute on function public.release_question(uuid, text) to service_role;
grant execute on function public.check_rate_limit(text, integer, integer) to service_role;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
