import 'server-only';

import { z } from 'zod';

import { serverEnv } from '@/lib/env';
import {
  narrationUsesSelectedLanguage,
  videoLanguage,
  type VideoLanguageCode,
} from '@/lib/videos/languages';

const LessonSceneSchema = z.object({
  index: z.number().int().min(1).max(12),
  fact: z.string().trim().min(10).max(400),
  narration: z.string().trim().min(5).max(500),
  visualDescription: z.string().trim().min(20).max(500),
  motionDescription: z.string().trim().min(15).max(800),
});

export const LessonPlanSchema = z.object({
  title: z.string().trim().min(3).max(200),
  learningObjective: z.string().trim().min(10).max(500),
  visualBible: z.string().trim().min(40).max(600),
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

const NarrationRevisionSchema = z.object({
  scenes: z.array(z.object({
    index: z.number().int().min(1).max(12),
    narration: z.string().trim().min(5).max(500),
  })).min(8).max(12),
});

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
  const plannerModel = serverEnv.modelForSkill('video-planner') ?? serverEnv.openRouterModel;
  const planSchema = LessonPlanSchema.superRefine((plan, ctx) => {
    if (plan.scenes.length !== sceneCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenes'],
        message: `Expected exactly ${sceneCount} scenes`,
      });
    }
    if (!narrationUsesSelectedLanguage(
      plan.scenes.map((scene) => scene.narration).join(' '),
      input.languageCode,
    )) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenes'],
        message: `Narration must use ${language.promptName} and its expected script`,
      });
    }
  });

  const draft = await generateStructured({
    stage: 'video-lesson-planner',
    model: plannerModel,
    effort: 'medium',
    requestTimeoutMs: 60_000,
    maxTransientRetries: 0,
    maxSchemaAttempts: 1,
    schema: planSchema,
    systemPrompt: `You are a careful school curriculum editor and visual lesson planner.

Create one coherent ${input.targetDurationSeconds}-second lesson split into exactly ${sceneCount} scenes. Each scene receives about 7.5 seconds. Accuracy is more important than drama.

Rules:
- Interpret an underspecified topic using the supplied school subject and class level. For example, Python under Computer Science means the programming language.
- Use only stable, broadly accepted curriculum facts. Do not invent statistics, quotations, dates, experiments, people, or claims. If a detail is uncertain or unnecessary, omit it.
- Keep simplifications age-appropriate without making the mechanism false. Preserve important distinctions between inputs, intermediates, transformations, products, causes, and correlations. Before returning the plan, silently audit every fact and narration line against textbook consensus and rewrite anything uncertain, misleading, or internally inconsistent.
- Write the title in ${language.promptName}. For Indian English, use clear English rather than a transliterated title. Keep the fact fields in English for auditing even when narration uses another language.
- Build a clear educational story arc: scene 1 is a topic-specific visual hook or central question; the middle scenes establish the needed ideas and explain the mechanism step by step; the final scene gives a concise topic-specific synthesis or practical application. Do not use sensational claims or a generic call to action.
- Each scene must teach one concrete step that logically follows the previous scene. Every narration sentence and every visible object must support that scene's fact. Avoid repetition, tangents, generic motivational filler, and decorative objects unrelated to the lesson.
- Narration must be in ${language.promptName}, using its natural native script where applicable. Keep every scene concise enough for about 6-7 seconds of natural speech, leaving a short visual pause. The full narration should last roughly ${input.targetDurationSeconds === 60 ? '48-55' : '75-84'} seconds, never longer than the requested video.
- The fact field is a plain-English statement of the exact fact taught in that scene so it can be audited.
- Visual and motion descriptions must be in English for the local media models. They must show the actual mechanism, process, objects, or relationships—not a teacher presenting them. Each visualDescription must be a detailed standalone generation prompt naming the main subject, environment, spatial relationships, camera framing, lighting, colors, and the precise curriculum idea being visualized.
- Use one consistent premium educational-documentary visual language across the entire storyboard: cinematic 16:9 composition, realistic materials, restrained color palette, clean subject separation, and the same rendering style and recurring subject appearance in every scene. Repeat those stable style and identity cues inside every visualDescription because scenes are generated independently.
- Write visualBible as one compact production-style specification shared by all scenes, no more than 500 characters. It must define the rendering medium, palette, lighting, camera language, environment treatment, and the immutable appearance of every recurring subject. Do not put scene-specific action in visualBible.
- Make adjacent scenes flow naturally. Preserve any recurring object, organism, machine, location, or character with identical defining traits, while changing only what the lesson progression requires. Do not depend on a previous scene to make the current description understandable.
- Never request a classroom, teacher, student audience, blackboard, projector, presentation slide, talking head, source code, written equation, caption, label, logo, UI, or any visible text. Accurate text is added later by deterministic software, never generated inside an image.
- Prefer one stable composition and restrained motion. Each motionDescription must animate only elements already specified in its visualDescription and must state the subject motion plus one gentle camera move. Do not request scene cuts, transitions to another setting, morphing, or new objects appearing mid-clip.`,
    userPrompt: `Plan the lesson.

Class: ${input.classLevel}
Subject: ${input.subject}
Topic: ${input.topic}
Narration language: ${language.label}
Target duration: ${input.targetDurationSeconds} seconds

The ${sceneCount} scene facts together must directly explain the topic at this class level.`,
  });

  const verifyPlan = (withSearch: boolean) => generateStructured({
    stage: 'video-lesson-verifier',
    model: plannerModel,
    effort: 'low',
    schema: planSchema,
    systemPrompt: `You are a skeptical school curriculum fact-checker and storyboard continuity editor.

Return a complete corrected lesson plan in the required schema. Preserve exactly ${sceneCount} scenes and the requested ${input.targetDurationSeconds}-second structure.

Audit rules:
- Check every fact and narration line for textbook consensus, precise cause-and-effect, correct inputs/intermediates/products, internal consistency, and suitability for Class ${input.classLevel} ${input.subject}.
- Remove or rewrite invented details, misleading simplifications, unsupported superlatives, grand claims, generic hooks, tangents, and statements that do not directly explain "${input.topic}".
- Narration must remain in ${language.promptName}; the title must be in that language (clear English for Indian English); fact fields remain English.
- Each visual must directly depict its audited fact. Preserve one compact visualBible and identical recurring-subject traits across scenes. Keep visualBible within 500 characters and each scene visualDescription within 500 characters.
- Preserve the ban on classrooms, presenters, visible writing, captions, labels, logos, UI, source code, written equations, and watermarks.
- Motion may animate only existing scene elements, with one restrained camera move and no cuts, morphing, transitions, or newly appearing objects.
- Output only the corrected structured plan.`,
    userPrompt: `Verify and, where necessary, correct this draft lesson plan:

${JSON.stringify(draft)}

Original request:
Class: ${input.classLevel}
Subject: ${input.subject}
Topic: ${input.topic}
Narration language: ${language.label}
Target duration: ${input.targetDurationSeconds} seconds`,
    requestTimeoutMs: withSearch ? 25_000 : 20_000,
    maxTransientRetries: 0,
    maxSchemaAttempts: 1,
    ...(withSearch ? {
      search: {
        engine: 'exa' as const,
        maxResults: 3,
        searchPrompt: `Verify stable, age-appropriate curriculum facts for Class ${input.classLevel} ${input.subject}: ${input.topic}`,
      },
    } : {}),
  });

  let plan: LessonPlan;
  try {
    plan = await verifyPlan(true);
  } catch (error) {
    console.warn(
      '[video-lesson-verifier] grounded review unavailable; using bounded model-only review',
      error instanceof Error ? error.message : String(error),
    );
    try {
      plan = await verifyPlan(false);
    } catch (fallbackError) {
      console.warn(
        '[video-lesson-verifier] bounded fallback unavailable; using validated self-audited draft',
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      );
      plan = draft;
    }
  }

  return {
    ...plan,
    title: input.languageCode === 'en-IN' ? input.topic.slice(0, 200) : plan.title,
  };
}

export async function adjustNarrationToFit(
  plan: LessonPlan,
  input: {
    languageCode: VideoLanguageCode;
    targetDurationSeconds: 60 | 90;
    measuredDurationSeconds: number;
  },
): Promise<LessonPlan> {
  const { generateStructured } = await import('../../../Agents/Agent');
  const language = videoLanguage(input.languageCode);
  const currentText = narrationFromPlan(plan);
  const desiredDuration = input.targetDurationSeconds - 4;
  const ratio = desiredDuration / Math.max(1, input.measuredDurationSeconds);
  const targetCharacters = Math.max(
    plan.scenes.length * 12,
    Math.floor(currentText.length * ratio * (ratio < 1 ? 0.9 : 0.98)),
  );
  const direction = ratio < 1 ? 'shorten' : 'expand';
  const revisionSchema = NarrationRevisionSchema.superRefine((revision, ctx) => {
    if (revision.scenes.length !== plan.scenes.length) {
      ctx.addIssue({ code: 'custom', path: ['scenes'], message: 'Scene count changed' });
    }
    revision.scenes.forEach((scene, position) => {
      if (scene.index !== position + 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['scenes', position, 'index'],
          message: `Expected scene index ${position + 1}`,
        });
      }
    });
    const narration = revision.scenes.map((scene) => scene.narration).join(' ');
    if (direction === 'shorten' && narration.length > targetCharacters) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenes'],
        message: `Combined narration must be at most ${targetCharacters} characters`,
      });
    }
    if (!narrationUsesSelectedLanguage(narration, input.languageCode)) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenes'],
        message: `Narration must use ${language.promptName} and its expected script`,
      });
    }
  });

  const revision = await generateStructured({
    stage: 'video-narration-duration-editor',
    model: serverEnv.modelForSkill('video-planner') ?? serverEnv.openRouterModel,
    effort: 'low',
    requestTimeoutMs: 25_000,
    maxTransientRetries: 0,
    maxSchemaAttempts: 1,
    schema: revisionSchema,
    systemPrompt: `You are a precise educational narration editor.

${direction === 'shorten' ? 'Shorten' : 'Expand'} the narration so synthesized speech fits a ${input.targetDurationSeconds}-second lesson. Keep exactly one narration entry per scene and preserve the meaning of its supplied audited fact.

Rules:
- Write only in ${language.promptName}, using its natural script. Do not translate into another language.
- Keep the narration conversational, factual, and age-appropriate. Never add a fact, number, name, example, claim, or conclusion that is absent from the audited facts.
- Each scene should be one concise sentence that can be spoken clearly in its 7.5-second slot.
- Avoid introductions, greetings, repetition, filler, calls to action, and grand claims.
- The combined narration must be ${direction === 'shorten' ? `no more than ${targetCharacters}` : `about ${targetCharacters}`} characters.
- Return only scene indexes and revised narration in the required schema.`,
    userPrompt: `Measured speech duration: ${input.measuredDurationSeconds.toFixed(1)} seconds
Target video duration: ${input.targetDurationSeconds} seconds

Audited scenes:
${JSON.stringify(plan.scenes.map((scene) => ({
    index: scene.index,
    fact: scene.fact,
    narration: scene.narration,
  })))}`,
  });

  return {
    ...plan,
    scenes: plan.scenes.map((scene, index) => ({
      ...scene,
      narration: revision.scenes[index].narration,
    })),
  };
}

export function scenesWithSharedVisualContext(plan: LessonPlan): LessonPlan['scenes'] {
  const sharedVisualContext = `Storyboard visual bible (apply exactly): ${plan.visualBible}.`;
  return plan.scenes.map((scene) => ({
    ...scene,
    visualDescription: `${sharedVisualContext} Scene composition: ${scene.visualDescription}`,
  }));
}

export function narrationFromPlan(plan: LessonPlan): string {
  return plan.scenes.map((scene) => scene.narration.trim()).join(' ');
}
