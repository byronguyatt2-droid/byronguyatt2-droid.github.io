-- Report photos storage (run once in Supabase › SQL Editor, only after baz says "deploy").
--
-- Photos are stored as files at report-photos/<uploader user id>/<photo id>.jpg.
-- A user can add, replace and delete their own photos. A business owner can
-- also view the photos of everyone on their team, matching the
-- "Owners can read their business's reports" policy on public.reports.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-photos', 'report-photos', false, 5242880, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;

create policy "report photos: upload own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'report-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "report photos: view own or team's as owner"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'report-photos'
    and (
      (storage.foldername(name))[1] = (select auth.uid())::text
      or (storage.foldername(name))[1] in (
        select tm.user_id::text
        from public.team_members tm
        join public.businesses b on b.id = tm.business_id
        where b.owner_id = (select auth.uid())
      )
    )
  );

create policy "report photos: replace own"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'report-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "report photos: delete own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'report-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
