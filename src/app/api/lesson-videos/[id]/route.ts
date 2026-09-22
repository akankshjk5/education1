import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireUserIdOrThrow } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import {
  LessonVideoProjectSchema,
  LessonVideoSceneSchema,
} from '@/lib/videos/lesson-contracts';

const idSchema = z.string().uuid();

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserIdOrThrow();
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: 'Invalid video id.' }, { status: 400 });
    const supabase = await createClient();
    const [{ data: project, error }, { data: scenes }, { data: jobs }] = await Promise.all([
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
        .select('status, progress')
        .eq('project_id', id.data),
    ]);
    if (error || !project) return NextResponse.json({ error: 'Video not found.' }, { status: 404 });

    const total = Math.max(1, (scenes?.length ?? 0) * 2 + 1);
    const points = (jobs ?? []).reduce((sum, job) => {
      if (job.status === 'succeeded') return sum + 100;
      if (job.status === 'processing') return sum + job.progress;
      return sum;
    }, 0);
    const progress = project.status === 'succeeded' ? 100 : Math.min(99, Math.round(points / total));
    return NextResponse.json({
      project: LessonVideoProjectSchema.parse(project),
      scenes: LessonVideoSceneSchema.array().parse(scenes ?? []),
      progress,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('[lesson-videos] load failed', error);
    return NextResponse.json({ error: 'Could not load this lesson video.' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireUserIdOrThrow();
    const id = idSchema.safeParse((await context.params).id);
    if (!id.success) return NextResponse.json({ error: 'Invalid video id.' }, { status: 400 });
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('cancel_lesson_video_project', {
      p_project_id: id.data,
    });
    if (error) throw new Error(error.message);
    if (!data?.length) {
      return NextResponse.json({ error: 'This video is not generating.' }, { status: 409 });
    }
    return NextResponse.json({ cancelled: true });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('[lesson-videos] cancel failed', error);
    return NextResponse.json({ error: 'Could not cancel this video.' }, { status: 500 });
  }
}
