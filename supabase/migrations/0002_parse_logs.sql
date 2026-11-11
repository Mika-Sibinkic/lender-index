-- Closed-loop learning: every AI parse + the user's corrections become
-- training/eval signal for future prompt + model iteration.

create table public.parse_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id),
  raw_input text not null,
  input_modality text not null default 'text'
    check (input_modality in ('text', 'image', 'pdf', 'mixed')),
  llm_provider text not null,
  llm_model text not null,
  parsed_output jsonb not null,
  funding_source_id uuid references public.funding_sources(id) on delete set null,
  corrections jsonb,
  parse_latency_ms int,
  parse_cost_usd_equivalent numeric default 0,
  raw_response_text text,
  fallback_used boolean default false,
  created_at timestamptz not null default now(),
  saved_at timestamptz
);
create index parse_logs_user_id_idx on public.parse_logs (user_id);
create index parse_logs_funding_source_id_idx on public.parse_logs (funding_source_id);
create index parse_logs_created_at_idx on public.parse_logs (created_at desc);

alter table public.parse_logs enable row level security;

create policy parse_logs_select_authenticated on public.parse_logs
  for select to authenticated using (true);
create policy parse_logs_insert_authenticated on public.parse_logs
  for insert to authenticated with check (true);
create policy parse_logs_update_authenticated on public.parse_logs
  for update to authenticated using (true);
