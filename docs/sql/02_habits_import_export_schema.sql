-- Life Project - 周期习惯、每日记录、导入作业与明细
-- 可在 Supabase SQL Editor 执行

create extension if not exists pgcrypto;

create table if not exists public.habit_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  parent_id uuid references public.habit_groups (id) on delete set null,
  name text not null check (char_length(trim(name)) > 0),
  description text,
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.habit_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  group_id uuid references public.habit_groups (id) on delete set null,
  source_key text not null,
  source_name text,
  source_type text not null default 'manual' check (source_type in ('manual', 'csv', 'zip', 'export')),
  title text not null check (char_length(trim(title)) > 0),
  description text,
  question text,
  frequency_kind text not null default 'daily' check (frequency_kind in ('daily', 'weekly', 'custom')),
  frequency_rule jsonb not null default '{}'::jsonb,
  -- frequency_rule.importance 保存 1 到 100 的重要值；每日/每周/月度规则也保存在该 JSON 中。
  unit text,
  target_type text,
  target_value numeric,
  color text,
  sort_order integer not null default 0,
  start_date date not null default current_date,
  end_date date,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.habit_templates
  add column if not exists group_id uuid references public.habit_groups (id) on delete set null;

alter table public.habit_templates
  add column if not exists start_date date;

update public.habit_templates
set start_date = coalesce(start_date, (created_at at time zone 'Asia/Shanghai')::date, current_date)
where start_date is null;

alter table public.habit_templates
  alter column start_date set default current_date,
  alter column start_date set not null;

alter table public.habit_templates
  add column if not exists end_date date;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'habit_templates_date_range'
  ) then
    alter table public.habit_templates
      add constraint habit_templates_date_range
      check (end_date is null or start_date <= end_date);
  end if;
end;
$$;

create index if not exists habit_groups_user_id_idx
  on public.habit_groups (user_id);

create index if not exists habit_groups_parent_id_idx
  on public.habit_groups (parent_id);

create unique index if not exists habit_templates_user_source_key_idx
  on public.habit_templates (user_id, source_key);

create index if not exists habit_templates_user_archived_sort_idx
  on public.habit_templates (user_id, archived_at, sort_order);

create index if not exists habit_templates_user_group_idx
  on public.habit_templates (user_id, group_id);

create index if not exists habit_templates_user_start_date_idx
  on public.habit_templates (user_id, start_date);

create index if not exists habit_templates_user_end_date_idx
  on public.habit_templates (user_id, end_date);

create table if not exists public.habit_daily_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  template_id uuid not null references public.habit_templates (id) on delete cascade,
  record_date date not null,
  value_text text,
  value_number numeric,
  normalized_value numeric,
  is_done boolean,
  completion_ratio numeric check (completion_ratio is null or (completion_ratio >= 0 and completion_ratio <= 1)),
  completion_state text not null default 'unknown' check (completion_state in ('done', 'missed', 'unknown', 'recorded')),
  notes text,
  source_type text not null default 'manual' check (source_type in ('manual', 'csv', 'zip', 'export')),
  source_key text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, template_id, record_date)
);

alter table public.habit_daily_records
  add column if not exists normalized_value numeric,
  add column if not exists is_done boolean,
  add column if not exists completion_ratio numeric;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'habit_daily_records_completion_ratio_range'
  ) then
    alter table public.habit_daily_records
      add constraint habit_daily_records_completion_ratio_range
      check (completion_ratio is null or (completion_ratio >= 0 and completion_ratio <= 1));
  end if;
end;
$$;

create index if not exists habit_daily_records_user_date_idx
  on public.habit_daily_records (user_id, record_date desc);

create index if not exists habit_daily_records_user_template_date_idx
  on public.habit_daily_records (user_id, template_id, record_date desc);

create table if not exists public.habit_daily_scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  template_id uuid not null references public.habit_templates (id) on delete cascade,
  record_date date not null,
  actual_value numeric not null default 0,
  normalized_value numeric not null default 0,
  is_done boolean not null default false,
  completion_ratio numeric not null default 0 check (completion_ratio >= 0 and completion_ratio <= 1),
  score integer not null default 0 check (score >= 0 and score <= 100),
  source_record_id uuid references public.habit_daily_records (id) on delete set null,
  calculated_at timestamptz not null default now(),
  unique (user_id, template_id, record_date)
);

create index if not exists habit_daily_scores_user_date_idx
  on public.habit_daily_scores (user_id, record_date desc);

create index if not exists habit_daily_scores_user_template_date_idx
  on public.habit_daily_scores (user_id, template_id, record_date desc);

create table if not exists public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_name text not null,
  source_type text not null default 'zip' check (source_type in ('csv', 'zip', 'export')),
  status text not null default 'draft' check (status in ('draft', 'preview', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled')),
  total_rows integer not null default 0,
  success_rows integer not null default 0,
  failed_rows integer not null default 0,
  warning_rows integer not null default 0,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists import_jobs_user_created_idx
  on public.import_jobs (user_id, created_at desc);

create table if not exists public.import_job_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.import_jobs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  source_name text not null,
  sheet_name text,
  source_key text,
  raw_payload jsonb not null default '{}'::jsonb,
  mapped_payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'ok', 'skipped', 'error')),
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists import_job_items_job_idx
  on public.import_job_items (job_id);

create index if not exists import_job_items_user_status_idx
  on public.import_job_items (user_id, status);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists habit_templates_set_updated_at_trigger on public.habit_templates;
create trigger habit_templates_set_updated_at_trigger
before update on public.habit_templates
for each row
execute procedure public.set_updated_at();

drop trigger if exists habit_groups_set_updated_at_trigger on public.habit_groups;
create trigger habit_groups_set_updated_at_trigger
before update on public.habit_groups
for each row
execute procedure public.set_updated_at();

drop trigger if exists habit_daily_records_set_updated_at_trigger on public.habit_daily_records;
create trigger habit_daily_records_set_updated_at_trigger
before update on public.habit_daily_records
for each row
execute procedure public.set_updated_at();

drop trigger if exists import_jobs_set_updated_at_trigger on public.import_jobs;
create trigger import_jobs_set_updated_at_trigger
before update on public.import_jobs
for each row
execute procedure public.set_updated_at();

alter table public.habit_groups enable row level security;
alter table public.habit_templates enable row level security;
alter table public.habit_daily_records enable row level security;
alter table public.habit_daily_scores enable row level security;
alter table public.import_jobs enable row level security;
alter table public.import_job_items enable row level security;

drop policy if exists habit_groups_select_policy on public.habit_groups;
create policy habit_groups_select_policy on public.habit_groups
for select
using (auth.uid() = user_id);

drop policy if exists habit_groups_insert_policy on public.habit_groups;
create policy habit_groups_insert_policy on public.habit_groups
for insert
with check (auth.uid() = user_id);

drop policy if exists habit_groups_update_policy on public.habit_groups;
create policy habit_groups_update_policy on public.habit_groups
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists habit_groups_delete_policy on public.habit_groups;
create policy habit_groups_delete_policy on public.habit_groups
for delete
using (auth.uid() = user_id);

drop policy if exists habit_templates_select_policy on public.habit_templates;
create policy habit_templates_select_policy on public.habit_templates
for select
using (auth.uid() = user_id);

drop policy if exists habit_templates_insert_policy on public.habit_templates;
create policy habit_templates_insert_policy on public.habit_templates
for insert
with check (auth.uid() = user_id);

drop policy if exists habit_templates_update_policy on public.habit_templates;
create policy habit_templates_update_policy on public.habit_templates
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists habit_templates_delete_policy on public.habit_templates;
create policy habit_templates_delete_policy on public.habit_templates
for delete
using (auth.uid() = user_id);

drop policy if exists habit_daily_records_select_policy on public.habit_daily_records;
create policy habit_daily_records_select_policy on public.habit_daily_records
for select
using (auth.uid() = user_id);

drop policy if exists habit_daily_records_insert_policy on public.habit_daily_records;
create policy habit_daily_records_insert_policy on public.habit_daily_records
for insert
with check (auth.uid() = user_id);

drop policy if exists habit_daily_records_update_policy on public.habit_daily_records;
create policy habit_daily_records_update_policy on public.habit_daily_records
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists habit_daily_records_delete_policy on public.habit_daily_records;
create policy habit_daily_records_delete_policy on public.habit_daily_records
for delete
using (auth.uid() = user_id);

drop policy if exists habit_daily_scores_select_policy on public.habit_daily_scores;
create policy habit_daily_scores_select_policy on public.habit_daily_scores
for select
using (auth.uid() = user_id);

drop policy if exists habit_daily_scores_insert_policy on public.habit_daily_scores;
create policy habit_daily_scores_insert_policy on public.habit_daily_scores
for insert
with check (auth.uid() = user_id);

drop policy if exists habit_daily_scores_update_policy on public.habit_daily_scores;
create policy habit_daily_scores_update_policy on public.habit_daily_scores
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists habit_daily_scores_delete_policy on public.habit_daily_scores;
create policy habit_daily_scores_delete_policy on public.habit_daily_scores
for delete
using (auth.uid() = user_id);

drop policy if exists import_jobs_select_policy on public.import_jobs;
create policy import_jobs_select_policy on public.import_jobs
for select
using (auth.uid() = user_id);

drop policy if exists import_jobs_insert_policy on public.import_jobs;
create policy import_jobs_insert_policy on public.import_jobs
for insert
with check (auth.uid() = user_id);

drop policy if exists import_jobs_update_policy on public.import_jobs;
create policy import_jobs_update_policy on public.import_jobs
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists import_jobs_delete_policy on public.import_jobs;
create policy import_jobs_delete_policy on public.import_jobs
for delete
using (auth.uid() = user_id);

drop policy if exists import_job_items_select_policy on public.import_job_items;
create policy import_job_items_select_policy on public.import_job_items
for select
using (auth.uid() = user_id);

drop policy if exists import_job_items_insert_policy on public.import_job_items;
create policy import_job_items_insert_policy on public.import_job_items
for insert
with check (auth.uid() = user_id);

drop policy if exists import_job_items_update_policy on public.import_job_items;
create policy import_job_items_update_policy on public.import_job_items
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists import_job_items_delete_policy on public.import_job_items;
create policy import_job_items_delete_policy on public.import_job_items
for delete
using (auth.uid() = user_id);
