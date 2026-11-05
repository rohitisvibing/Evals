-- Immutable benchmark reports: one row per benchmark batch. The dashboard
-- reads these; re-running a benchmark creates a new row, never edits one.
create table public.benchmark_reports (
  id               uuid primary key default gen_random_uuid(),
  batch_id         uuid not null unique,
  dataset_version  text not null,
  label_snapshot   jsonb not null,   -- {example_id: {label_version, review_status}} at run time
  config           jsonb not null,   -- models, strategies, k, schema/rubric/chunker versions
  summary          jsonb not null,   -- computed metrics
  is_mock          boolean not null default false,
  notes            text,
  created_at       timestamptz not null default now()
);

alter table public.benchmark_reports enable row level security;
create policy bench_reports_select on public.benchmark_reports for select to authenticated using (true);
revoke all on public.benchmark_reports from anon;

create or replace function public.prevent_report_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'benchmark_reports are immutable';
end $$;

create trigger benchmark_reports_immutable before update on public.benchmark_reports
  for each row execute function public.prevent_report_update();
revoke execute on function public.prevent_report_update() from public, anon, authenticated;
