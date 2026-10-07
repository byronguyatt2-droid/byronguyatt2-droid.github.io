-- Test mode notes (run once in Supabase › SQL Editor, only after baz says "deploy").
--
-- With Menu › Data & backups › Test mode switched on, every voice note the
-- owner sends to the AI is saved here with what the AI pulled out of it (or
-- why it failed), so Claude can score a batch on tests/extraction later.
-- Each person sees, adds and deletes only their own rows. Rows go when the
-- account is deleted (the cascade on user_id).

create table if not exists public.test_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  transcript text not null check (length(transcript) <= 100000),
  extraction jsonb,
  problem text,
  seconds numeric
);

alter table public.test_notes enable row level security;

create policy "test notes: add own"
  on public.test_notes for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy "test notes: view own"
  on public.test_notes for select to authenticated
  using (user_id = (select auth.uid()));

create policy "test notes: delete own"
  on public.test_notes for delete to authenticated
  using (user_id = (select auth.uid()));
