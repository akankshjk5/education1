import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { requireUserIdOrThrow } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import {
  CreateLessonVideoSchema,
  LessonVideoProjectSchema,
} from '@/lib/videos/lesson-contracts';
import { videoLanguage } from '@/lib/videos/languages';
import { synthesizeNarration } from '@/lib/videos/narration';
import {
  adjustNarrationToFit,
  narrationFromPlan,
  planLesson,
  scenesWithSharedVisualContext,
  translateLessonPlan,
} from '@/lib/videos/planner';

export const maxDuration = 300;

export async function POST(request: Request) {
  let projectId: string | null = null;
  try {
    await requireUserIdOrThrow();
    const input = CreateLessonVideoSchema.parse(await request.json());
    const language = videoLanguage(input.languageCode);
    let sourcePlan = await planLesson(input);
    let plan = await translateLessonPlan(sourcePlan, input.languageCode);
    let narrationText = narrationFromPlan(plan);
    let narration = await synthesizeNarration(narrationText, input.languageCode);
    const minimumNarrationSeconds = input.targetDurationSeconds * 0.6;
    const maximumNarrationSeconds = input.targetDurationSeconds - 2;
    for (let revision = 0; revision < 2; revision += 1) {
      if (
        narration.durationSeconds >= minimumNarrationSeconds
        && narration.durationSeconds <= maximumNarrationSeconds
      ) break;
      sourcePlan = await adjustNarrationToFit(sourcePlan, {
        languageCode: input.languageCode,
        measuredDurationSeconds: narration.durationSeconds,
        targetDurationSeconds: input.targetDurationSeconds,
      });
      plan = await translateLessonPlan(sourcePlan, input.languageCode);
      narrationText = narrationFromPlan(plan);
      narration = await synthesizeNarration(
        narrationText,
        input.languageCode,
        revision === 1 ? 'brisk' : 'natural',
      );
    }
    const supabase = await createClient();
    const { data: created, error: createError } = await supabase.rpc(
      'create_lesson_video_project',
      {
        p_class_level: input.classLevel,
        p_language_code: input.languageCode,
        p_language_name: language.label,
        p_learning_objective: plan.learningObjective,
        p_narration_text: narrationText,
        p_scenes: scenesWithSharedVisualContext(plan),
        p_subject: input.subject,
        p_target_duration_seconds: input.targetDurationSeconds,
        p_title: plan.title,
        p_topic: input.topic,
      },
    );
    if (createError) throw new Error(createError.message);
    const project = Array.isArray(created) ? created[0] : created;
    if (!project) throw new Error('Lesson video project was not created.');
    projectId = project.id;

    const audioPath = `${project.id}/narration.wav`;
    const { error: uploadError } = await supabase.storage
      .from('lesson-video-assets')
      .upload(audioPath, narration.wave, { contentType: 'audio/wav', upsert: false });
    if (uploadError) throw new Error(`Narration upload failed: ${uploadError.message}`);
    const narrationUrl = supabase.storage.from('lesson-video-assets').getPublicUrl(audioPath)
      .data.publicUrl;

    const { data: finalized, error: finalizeError } = await supabase.rpc(
      'set_lesson_video_narration',
      {
        p_narration_duration_seconds: narration.durationSeconds,
        p_narration_url: narrationUrl,
        p_project_id: project.id,
      },
    );
    if (finalizeError) throw new Error(finalizeError.message);
    const finalizedProject = Array.isArray(finalized) ? finalized[0] : finalized;
    return NextResponse.json(
      { project: LessonVideoProjectSchema.parse(finalizedProject ?? project) },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    if (projectId) {
      try {
        const supabase = await createClient();
        await supabase.rpc('fail_lesson_video_setup', {
          p_error_message: error instanceof Error ? error.message : 'Lesson setup failed.',
          p_project_id: projectId,
        });
      } catch {
        // Preserve the original error; stale setup is recoverable through the project record.
      }
    }
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: 'Check the class, subject, topic, language and duration.' },
        { status: 400 },
      );
    }
    console.error('[lesson-videos] create failed', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not start lesson generation.' },
      { status: 500 },
    );
  }
}
