-- Business settings (run once in Supabase › SQL Editor, only after baz says "deploy").
--
-- Settings synced between phones (js/business-sync.js): company
-- details with the logo, payment details and agreement wording, the quote
-- price list and the invoice counter.
--
-- Who can do what:
--   read   the owner and the business's team members (the existing
--          "members can view their business" policy)
--   change the owner only. Technicians can't change the business's details.

alter table public.businesses
  add column if not exists settings jsonb not null default '{}'::jsonb;

drop policy if exists "owner can update business" on public.businesses;
create policy "owner can update business" on public.businesses
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
