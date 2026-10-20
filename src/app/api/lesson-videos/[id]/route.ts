import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUserIdOrThrow } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { canWorkerProcessLesson } from '@/lib/videos/local-ai';
import { removeProjectAssets } from '@/lib/videos/project-assets';
import {
  LessonVideoProjectSchema,
  LessonVideoSceneSchema,
} from '@/lib/videos/lesson-contracts';
import { lessonProgressSnapshot } from '@/lib/videos/progress';

const idSchema = z.string().uuid();

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserIdOrThrow();
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: 'Invalid video id.' }, { status: 400 });
    const supabase = await createClient();
    const [projectResult, scenesResult, jobsResult] = await Promise.all([
      supabase
        .from('lesson_video_projects')
        .select('*')
        .eq('id', id.data)
        .eq('owner_id', userId)
        .maybeSingle(),
      supabase
        .from('lesson_video_scenes')
        .select('*')
        .eq('project_id', id.data)
        .order('scene_index'),
      supabase
        .from('lesson_video_jobs')
        .select('kind, scene_id, status, started_at, output_metadata')
        .eq('project_id', id.data)
        .order('created_at', { ascending: true }),
    ]);
    if (projectResult.error || scenesResult.error || jobsResult.error) {
      throw new Error('Could not read the video progress from the database.');
    }
    const project = projectResult.data;
    if (!project) return NextResponse.json({ error: 'Video not found.' }, { status: 404 });

    const parsedProject = LessonVideoProjectSchema.parse(project);
    const parsedScenes = LessonVideoSceneSchema.array().parse(scenesResult.data ?? []);
    const snapshot = lessonProgressSnapshot(parsedProject, parsedScenes, jobsResult.data ?? []);
    const rendering = ['generating_images', 'generating_videos', 'assembling']
      .includes(parsedProject.status);
    const workerAvailable = rendering
      ? await canWorkerProcessLesson(userId, parsedProject.id)
      : true;
    const hasProcessingJob = (jobsResult.data ?? []).some((job) => job.status === 'processing');
    const waitingForWorker = rendering && !hasProcessingJob && !workerAvailable;
    return NextResponse.json({
      project: parsedProject,
      scenes: parsedScenes,
      ...snapshot,
      etaSeconds: waitingForWorker ? null : snapshot.etaSeconds,
      waitingForWorker,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('[lesson-videos] load failed', error);
    return NextResponse.json({ error: 'Could not load this lesson video.' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserIdOrThrow();
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: 'Invalid video id.' }, { status: 400 });
    const supabase = await createClient();
    const { data: project, error: projectError } = await supabase
      .from('lesson_video_projects')
      .select('id, status')
      .eq('id', id.data)
      .eq('owner_id', userId)
      .maybeSingle();
    if (projectError) throw new Error(`Could not check video ownership: ${projectError.message}`);
    if (!project) return NextResponse.json({ error: 'Video not found.' }, { status: 404 });

    if (['generating_images', 'generating_videos', 'assembling'].includes(project.status)) {
      const { data, error } = await supabase.rpc('cancel_lesson_video_project', {
        p_project_id: id.data,
      });
      if (error) throw new Error(error.message);
      if (!data?.length) {
        return NextResponse.json({ error: 'This video is no longer generating.' }, { status: 409 });
      }
      return NextResponse.json({ cancelled: true });
    }

    const { data: activeJobs, error: jobsError } = await supabase
      .from('lesson_video_jobs')
      .select('id')
      .eq('project_id', id.data)
      .in('status', ['queued', 'processing'])
      .limit(1);
    if (jobsError) throw new Error(`Could not check video workers: ${jobsError.message}`);
    if (activeJobs?.length) {
      return NextResponse.json(
        { error: 'A worker is still finishing this video. Wait a moment, then try deleting it again.' },
        { status: 409 },
      );
    }

    await removeProjectAssets(supabase.storage.from('lesson-video-assets'), id.data);
    const { data: deleted, error: deleteError } = await supabase
      .from('lesson_video_projects')
      .delete()
      .eq('id', id.data)
      .eq('owner_id', userId)
      .select('id')
      .maybeSingle();
    if (deleteError) throw new Error(`Could not delete video: ${deleteError.message}`);
    if (!deleted) {
      return NextResponse.json(
        { error: 'The video could not be deleted safely. Refresh and try again.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('[lesson-videos] cancel or delete failed', error);
    return NextResponse.json({ error: 'Could not update this video.' }, { status: 500 });
  }
}
