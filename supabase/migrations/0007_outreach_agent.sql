-- Outreach Agent v0 — schema.
-- Plain async runs (not Vercel Workflow DevKit) drive transitions on
-- outreach_run.status. Crash-safety = idempotent transitions.

create table if not exists public.outreach_run (
  id                uuid primary key default gen_random_uuid(),
  funding_source_id uuid not null references public.funding_sources(id) on delete cascade,
  status            text not null default 'queued'
                    check (status in ('queued','drafting','awaiting_approval','sent','declined','expired','error')),
  missing_fields    text[] not null default '{}'::text[],
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  error             text
);

create index if not exists outreach_run_status_idx on public.outreach_run (status);
create index if not exists outreach_run_source_idx on public.outreach_run (funding_source_id);

create table if not exists public.outreach_draft (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references public.outreach_run(id) on delete cascade,
  to_email        text not null,
  subject         text not null,
  body_text       text not null,
  body_html       text not null,
  questions       text[] not null,
  model           text not null,
  prompt_version  text not null,
  created_at      timestamptz not null default now()
);

create index if not exists outreach_draft_run_idx on public.outreach_draft (run_id);

create table if not exists public.outreach_action_token (
  token            text primary key,
  run_id           uuid not null references public.outreach_run(id) on delete cascade,
  action           text not null check (action in ('approve','decline')),
  expires_at       timestamptz not null,
  used_at          timestamptz,
  used_from_ip     inet,
  created_at       timestamptz not null default now()
);

create index if not exists outreach_action_token_run_idx on public.outreach_action_token (run_id);

create table if not exists public.outreach_sent (
  id                 uuid primary key default gen_random_uuid(),
  run_id             uuid not null references public.outreach_run(id) on delete cascade,
  kind               text not null default 'lender'
                     check (kind in ('approval','lender')),
  to_email           text not null,
  subject            text not null,
  body_text          text not null,
  body_html          text,
  graph_message_id   text,
  dry_run            boolean not null default true,
  sent_at            timestamptz not null default now(),
  reply_received_at  timestamptz,
  reply_body_text    text,
  bounced            boolean not null default false
);

create index if not exists outreach_sent_run_idx on public.outreach_sent (run_id);
create index if not exists outreach_sent_kind_idx on public.outreach_sent (kind);

-- RLS — admin-only on all outreach_* tables. The service-role key used by
-- the cron + action routes bypasses RLS; these policies gate any authed
-- UI reads from the admin telemetry page (M3e fast-follow).
alter table public.outreach_run          enable row level security;
alter table public.outreach_draft        enable row level security;
alter table public.outreach_action_token enable row level security;
alter table public.outreach_sent         enable row level security;

drop policy if exists outreach_run_admin          on public.outreach_run;
drop policy if exists outreach_draft_admin        on public.outreach_draft;
drop policy if exists outreach_action_token_admin on public.outreach_action_token;
drop policy if exists outreach_sent_admin         on public.outreach_sent;

create policy outreach_run_admin
  on public.outreach_run          for all to authenticated
  using (public._is_admin()) with check (public._is_admin());

create policy outreach_draft_admin
  on public.outreach_draft        for all to authenticated
  using (public._is_admin()) with check (public._is_admin());

create policy outreach_action_token_admin
  on public.outreach_action_token for all to authenticated
  using (public._is_admin()) with check (public._is_admin());

create policy outreach_sent_admin
  on public.outreach_sent         for all to authenticated
  using (public._is_admin()) with check (public._is_admin());

-- updated_at trigger on outreach_run so transitions stamp automatically.
create or replace function public._outreach_run_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists outreach_run_touch on public.outreach_run;
create trigger outreach_run_touch
  before update on public.outreach_run
  for each row execute function public._outreach_run_touch();
