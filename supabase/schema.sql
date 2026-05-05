-- Create extension for optional text search performance.
create extension if not exists pg_trgm;

create sequence if not exists feedback_id_seq;

create table if not exists public.feedbacks (
  id text primary key default ('WP-' || lpad(nextval('feedback_id_seq')::text, 6, '0')),
  name text not null,
  units text[] not null,
  content text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint feedback_units_not_empty check (cardinality(units) > 0)
);

create table if not exists public.feedback_content_history (
  id bigserial primary key,
  feedback_id text not null references public.feedbacks(id) on delete cascade,
  before_content text not null,
  after_content text not null,
  changed_at timestamptz not null default timezone('utc', now())
);

create or replace function public.set_feedback_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create or replace function public.log_feedback_content_history()
returns trigger
language plpgsql
as $$
begin
  if old.content is distinct from new.content then
    insert into public.feedback_content_history (
      feedback_id,
      before_content,
      after_content,
      changed_at
    )
    values (
      old.id,
      old.content,
      new.content,
      timezone('utc', now())
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_feedback_updated_at on public.feedbacks;

create trigger trg_feedback_updated_at
before update on public.feedbacks
for each row
execute function public.set_feedback_updated_at();

drop trigger if exists trg_feedback_content_history on public.feedbacks;

create trigger trg_feedback_content_history
after update on public.feedbacks
for each row
execute function public.log_feedback_content_history();

create index if not exists idx_feedbacks_updated_at on public.feedbacks (updated_at desc);
create index if not exists idx_feedbacks_content_trgm on public.feedbacks using gin (content gin_trgm_ops);
create index if not exists idx_feedbacks_units on public.feedbacks using gin (units);
create index if not exists idx_feedback_content_history_feedback_id_changed_at
  on public.feedback_content_history (feedback_id, changed_at desc);
