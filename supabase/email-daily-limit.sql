-- Daily send counter for the Worker's /send-email route (Worker v9.2).
-- The Worker allows 25 emails a day on a trial and 200 on a paid plan.
-- Safe to run more than once. Until it runs, sending has no daily limit.
alter table public.subscriptions
  add column if not exists emails_sent_today int not null default 0,
  add column if not exists emails_day date;
