-- Delete my account (run once in Supabase › SQL Editor, only after baz says "deploy").
--
-- Lets a signed-in user permanently delete their own account and everything
-- stored against it: their reports, their team membership and their login.
-- If they own a business, the business goes too (with its subscription row,
-- scheduled jobs and pending invites). The app deletes the user's photos
-- from the report-photos bucket first, through the storage policies, because
-- storage files can't be removed from SQL.
--
-- It refuses, changing nothing, when:
--   ACTIVE_SUBSCRIPTION  the business still has a Stripe subscription that
--                        could bill (cancel it in Billing › Manage first)
--   HAS_TEAM             other people are still on the business's team
--                        (remove them first, so their access isn't cut off
--                        without warning)
--
-- Called as rpc/delete_my_account with { "dry_run": true } to run only those
-- checks, then with { "dry_run": false } to delete.

create or replace function public.delete_my_account(dry_run boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  biz_id uuid;
  sub_status text;
  sub_stripe_id text;
begin
  if uid is null then
    raise exception 'NOT_SIGNED_IN';
  end if;

  select b.id, s.status, s.stripe_subscription_id
    into biz_id, sub_status, sub_stripe_id
    from public.businesses b
    left join public.subscriptions s on s.business_id = b.id
   where b.owner_id = uid;

  if biz_id is not null then
    if sub_stripe_id is not null and sub_status in ('trialing', 'active', 'past_due') then
      raise exception 'ACTIVE_SUBSCRIPTION';
    end if;
    if exists (select 1 from public.team_members where business_id = biz_id and user_id <> uid) then
      raise exception 'HAS_TEAM';
    end if;
  end if;

  if dry_run then
    return;
  end if;

  -- The user's own reports go first: they point at the business, so the
  -- business can't be deleted while they're still there.
  delete from public.reports where user_id = uid;

  if biz_id is not null then
    -- Reports left behind by people already removed from the team stay
    -- theirs, just no longer linked to this business.
    update public.reports set business_id = null where business_id = biz_id and user_id <> uid;
    delete from public.invites where business_id = biz_id;
    delete from public.team_members where business_id = biz_id;
    delete from public.businesses where id = biz_id;  -- jobs and subscriptions cascade
  end if;

  delete from public.team_members where user_id = uid;
  update public.invites set invited_by = null where invited_by = uid;
  update public.jobs set created_by = null where created_by = uid;
  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_my_account(boolean) from public, anon;
grant execute on function public.delete_my_account(boolean) to authenticated;
