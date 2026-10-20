import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUserIdOrThrow } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { loadCloudLesson } from '@/lib/data/cloud-lessons';
import { cloudLessonApiError } from '@/lib/cloud-lesson/api-errors';
import { removeProjectAssets } from '@/lib/videos/project-assets';
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try { const owner = await requireUserIdOrThrow(); const id = z.string().uuid().parse((await context.params).id);
    const detail = await loadCloudLesson(owner, id);
    return detail ? NextResponse.json(detail, { headers: { 'Cache-Control': 'no-store' } }) : NextResponse.json({ error: 'Lesson not found.' }, { status: 404 });
  } catch (error) { return cloudLessonApiError(error); }
}
export async function DELETE(_request: Request, context: Context) {
  try {
    const ownerId = await requireUserIdOrThrow();
    const id = z.string().uuid().parse((await context.params).id);
    const client = await createClient();
    const { data: project, error: projectError } = await client
      .from('cloud_lesson_projects')
      .select('id, status')
      .eq('id', id)
      .eq('owner_id', ownerId)
      .maybeSingle();
    if (projectError) throw new Error(`Could not check lesson ownership: ${projectError.message}`);
    if (!project) return NextResponse.json({ error: 'Lesson not found.' }, { status: 404 });

    if (['preparing', 'generating_images', 'generating_videos', 'assembling'].includes(project.status)) {
      const { data, error } = await client.rpc('cancel_cloud_lesson', { p_project_id: id });
      if (error) throw error;
      return data?.length
        ? NextResponse.json({ cancelled: true })
        : NextResponse.json({ error: 'This lesson is no longer generating.' }, { status: 409 });
    }

    const { data: activeJobs, error: jobsError } = await client
      .from('cloud_lesson_jobs')
      .select('id')
      .eq('project_id', id)
      .eq('owner_id', ownerId)
      .in('status', ['queued', 'processing'])
      .limit(1);
    if (jobsError) throw new Error(`Could not check lesson workers: ${jobsError.message}`);
    if (activeJobs?.length) {
      return NextResponse.json(
        { error: 'A worker is still finishing this lesson. Wait a moment, then try deleting it again.' },
        { status: 409 },
      );
    }

    const { data: reusedBy, error: reuseError } = await client
      .from('cloud_lesson_projects')
      .select('id')
      .eq('reused_from_project_id', id)
      .limit(1);
    if (reuseError) throw new Error(`Could not check lesson reuse: ${reuseError.message}`);
    if (reusedBy?.length) {
      return NextResponse.json(
        { error: 'This lesson’s visuals are used by another lesson. Delete that lesson first.' },
        { status: 409 },
      );
    }

    await removeProjectAssets(client.storage.from('cloud-lesson-assets'), id);
    const { data: deleted, error: deleteError } = await client
      .from('cloud_lesson_projects')
      .delete()
      .eq('id', id)
      .eq('owner_id', ownerId)
      .select('id')
      .maybeSingle();
    if (deleteError) throw deleteError;
    if (!deleted) {
      return NextResponse.json(
        { error: 'The lesson could not be deleted safely. Refresh and try again.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return cloudLessonApiError(error);
  }
}
