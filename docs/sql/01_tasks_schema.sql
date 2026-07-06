create extension if not exists pgcrypto;

create table if not exists public.task_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  parent_id uuid references public.task_groups (id) on delete set null,
  name text not null check (char_length(trim(name)) > 0),
  description text,
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(trim(title)) > 0),
  description text,
  task_date date not null,
  task_type text not null default 'single' check (task_type in ('single', 'range')),
  range_start_date date,
  range_end_date date,
  progress_value numeric,
  target_value numeric,
  start_time time without time zone,
  end_time time without time zone,
  status text not null default 'todo' check (status in ('todo', 'done', 'cancelled')),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  importance integer not null default 50 check (importance >= 1 and importance <= 100),
  category text,
  group_id uuid references public.task_groups (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.tasks
  add column if not exists importance integer not null default 50;

alter table public.tasks
  add column if not exists group_id uuid references public.task_groups (id) on delete set null;

alter table public.tasks
  add column if not exists task_type text not null default 'single';

alter table public.tasks
  add column if not exists range_start_date date;

alter table public.tasks
  add column if not exists range_end_date date;

alter table public.tasks
  add column if not exists progress_value numeric;

alter table public.tasks
  add column if not exists target_value numeric;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tasks_importance_range'
  ) then
    alter table public.tasks
      add constraint tasks_importance_range
      check (importance >= 1 and importance <= 100);
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tasks_task_type_check'
  ) then
    alter table public.tasks
      add constraint tasks_task_type_check
      check (task_type in ('single', 'range'));
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tasks_range_dates_check'
  ) then
    alter table public.tasks
      add constraint tasks_range_dates_check
      check (
        task_type = 'single'
        or (
          range_start_date is not null
          and range_end_date is not null
          and range_start_date <= range_end_date
        )
      );
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tasks_progress_nonnegative_check'
  ) then
    alter table public.tasks
      add constraint tasks_progress_nonnegative_check
      check (
        progress_value is null
        or progress_value >= 0
      );
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tasks_target_positive_check'
  ) then
    alter table public.tasks
      add constraint tasks_target_positive_check
      check (
        target_value is null
        or target_value > 0
      );
  end if;
end;
$$;

create index if not exists task_groups_user_id_idx
  on public.task_groups (user_id);

create index if not exists task_groups_parent_id_idx
  on public.task_groups (parent_id);

create index if not exists tasks_user_id_idx
  on public.tasks (user_id);

create index if not exists tasks_user_id_date_idx
  on public.tasks (user_id, task_date);

create index if not exists tasks_user_id_range_idx
  on public.tasks (user_id, range_start_date, range_end_date);

create index if not exists tasks_user_id_date_start_time_idx
  on public.tasks (user_id, task_date, start_time);

create index if not exists tasks_user_id_group_idx
  on public.tasks (user_id, group_id);

alter table public.task_groups enable row level security;
alter table public.tasks enable row level security;

drop policy if exists task_groups_select_policy on public.task_groups;
create policy task_groups_select_policy on public.task_groups
for select
using (auth.uid() = user_id);

drop policy if exists task_groups_insert_policy on public.task_groups;
create policy task_groups_insert_policy on public.task_groups
for insert
with check (auth.uid() = user_id);

drop policy if exists task_groups_update_policy on public.task_groups;
create policy task_groups_update_policy on public.task_groups
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists task_groups_delete_policy on public.task_groups;
create policy task_groups_delete_policy on public.task_groups
for delete
using (auth.uid() = user_id);

drop policy if exists tasks_select_policy on public.tasks;
create policy tasks_select_policy on public.tasks
for select
using (auth.uid() = user_id and deleted_at is null);

drop policy if exists tasks_insert_policy on public.tasks;
create policy tasks_insert_policy on public.tasks
for insert
with check (auth.uid() = user_id);

drop policy if exists tasks_update_policy on public.tasks;
create policy tasks_update_policy on public.tasks
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists tasks_delete_policy on public.tasks;
create policy tasks_delete_policy on public.tasks
for delete
using (auth.uid() = user_id);

create or replace function public.tasks_set_updated_at()
returns trigger
as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tasks_set_updated_at_trigger on public.tasks;
create trigger tasks_set_updated_at_trigger
before update on public.tasks
for each row
execute procedure public.tasks_set_updated_at();

create or replace function public.task_groups_set_updated_at()
returns trigger
as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists task_groups_set_updated_at_trigger on public.task_groups;
create trigger task_groups_set_updated_at_trigger
before update on public.task_groups
for each row
execute procedure public.task_groups_set_updated_at();
