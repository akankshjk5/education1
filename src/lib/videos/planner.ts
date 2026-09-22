import 'server-only';

import { z } from 'zod';

import { serverEnv } from '@/lib/env';
import { videoLanguage, type VideoLanguageCode } from '@/lib/videos/languages';

const LessonSceneSchema = z.object({
  index: z.number().int().min(1).max(12),
  fact: z.string().trim().min(10).max(400),
  narration: z.string().trim().min(5).max(500),
  visualDescription: z.string().trim().min(20).max(1200),
  motionDescription: z.string().trim().min(15).max(800),
});

export const LessonPlanSchema = z.object({
  title: z.string().trim().min(3).max(200),
  learningObjective: z.string().trim().min(10).max(500),
  scenes: z.array(LessonSceneSchema).min(8).max(12),
}).superRefine((plan, ctx) => {
  plan.scenes.forEach((scene, position) => {
    if (scene.index !== position + 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenes', position, 'index'],
        message: `Expected scene index ${position + 1}`,
      });
    }
  });
});

export type LessonPlan = z.infer<typeof LessonPlanSchema>;

export async function planLesson(input: {
  classLevel: number;
  subject: string;
  topic: string;
  languageCode: VideoLanguageCode;
  targetDurationSeconds: 60 | 90;
}): Promise<LessonPlan> {
  // Agent.ts intentionally validates its provider key during module loading.
  // Load it only for an authenticated generation request, never during build.
  const { generateStructured } = await import('../../../Agents/Agent');
  const language = videoLanguage(input.languageCode);
  const sceneCount = input.targetDurationSeconds === 60 ? 8 : 12;
  const planSchema = LessonPlanSchema.superRefine((plan, ctx) => {
    if (plan.scenes.length !== sceneCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenes'],
        message: `Expected exactly ${sceneCount} scenes`,
      });
    }
  });

  return generateStructured({
    stage: 'video-lesson-planner',
    model: serverEnv.modelForSkill('video-planner') ?? serverEnv.openRouterModel,
    effort: 'medium',
    schema: planSchema,
    systemPrompt: `You are a careful school curriculum editor and visual lesson planner.

Create one coherent ${input.targetDurationSeconds}-second lesson split into exactly ${sceneCount} scenes. Each scene receives about 7.5 seconds. Accuracy is more important than drama.

Rules:
- Interpret an underspecified topic using the supplied school subject and class level. For example, Python under Computer Science means the programming language.
- Use only stable, broadly accepted curriculum facts. Do not invent statistics, quotations, dates, experiments, people, or claims. If a detail is uncertain or unnecessary, omit it.
- Each scene must teach one concrete step that logically follows the previous scene. Avoid repetition and generic motivational filler.
- Narration must be in ${language.promptName}, using its natural native script where applicable. Keep every scene concise enough for about 6-7 seconds of natural speech, leaving a short visual pause. The full narration should last roughly ${input.targetDurationSeconds === 60 ? '48-55' : '75-84'} seconds, never longer than the requested video.
- The fact field is a plain-English statement of the exact fact taught in that scene so it can be audited.
- Visual and motion descriptions must be in English for the local media models. They must show the actual mechanism, process, objects, or relationships—not a teacher presenting them.
- Never request a classroom, teacher, student audience, blackboard, projector, presentation slide, talking head, source code, written equation, caption, label, logo, UI, or any visible text. Accurate text is added later by deterministic software, never generated inside an image.
- Prefer one stable composition and restrained motion. Do not request scene cuts, morphing, or new objects appearing mid-clip.`,
    userPrompt: `Plan the lesson.

Class: ${input.classLevel}
Subject: ${input.subject}
Topic: ${input.topic}
Narration language: ${language.label}
Target duration: ${input.targetDurationSeconds} seconds

The ${sceneCount} scene facts together must directly explain the topic at this class level.`,
  });
}

export function narrationFromPlan(plan: LessonPlan): string {
  return plan.scenes.map((scene) => scene.narration.trim()).join(' ');
}
