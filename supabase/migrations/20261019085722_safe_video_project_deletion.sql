-- Allow owners to delete only terminal video projects, after all worker jobs
-- have left the queue. Asset deletion uses the same predicate so storage cannot
-- be removed underneath a worker that is still producing output.

grant delete on table public.lesson_video_projects to authenticated;
grant delete on table public.cloud_lesson_projects to authenticated;

create policy "lesson video projects: delete own terminal"
  on public.lesson_video_projects for delete to authenticated
  using (
    owner_id = (select public.clerk_user_id())
    and status in ('succeeded', 'failed', 'cancelled')
    and not exists (
      select 1
      from public.lesson_video_jobs j
      where j.project_id = lesson_video_projects.id
        and j.status in ('queued', 'processing')
    )
  );

create policy "cloud lesson projects: delete own terminal"
  on public.cloud_lesson_projects for delete to authenticated
  using (
    owner_id = (select public.clerk_user_id())
    and status in ('succeeded', 'failed', 'cancelled')
    and not exists (
      select 1
      from public.cloud_lesson_jobs j
      where j.project_id = cloud_lesson_projects.id
        and j.status in ('queued', 'processing')
    )
    and not exists (
      select 1
      from public.cloud_lesson_projects derived
      where derived.reused_from_project_id = cloud_lesson_projects.id
    )
  );

-- Storage list/remove are scoped to the user's project folder. Public URL
-- playback remains unchanged; this only adds authenticated owner operations.
grant delete on table storage.objects to authenticated;

create policy "lesson-video-assets: owner delete terminal"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'lesson-video-assets'
    and exists (
      select 1
      from public.lesson_video_projects p
      where p.id::text = split_part(storage.objects.name, '/', 1)
        and p.owner_id = (select public.clerk_user_id())
        and p.status in ('succeeded', 'failed', 'cancelled')
        and not exists (
          select 1
          from public.lesson_video_jobs j
          where j.project_id = p.id
            and j.status in ('queued', 'processing')
        )
    )
  );

create policy "cloud-lesson-assets: owner list"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'cloud-lesson-assets'
    and exists (
      select 1
      from public.cloud_lesson_projects p
      where p.id::text = split_part(storage.objects.name, '/', 1)
        and p.owner_id = (select public.clerk_user_id())
    )
  );

create policy "cloud-lesson-assets: owner delete terminal"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'cloud-lesson-assets'
    and exists (
      select 1
      from public.cloud_lesson_projects p
      where p.id::text = split_part(storage.objects.name, '/', 1)
        and p.owner_id = (select public.clerk_user_id())
        and p.status in ('succeeded', 'failed', 'cancelled')
        and not exists (
          select 1
          from public.cloud_lesson_jobs j
          where j.project_id = p.id
            and j.status in ('queued', 'processing')
        )
        and not exists (
          select 1
          from public.cloud_lesson_projects derived
          where derived.reused_from_project_id = p.id
        )
    )
  );