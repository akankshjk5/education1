import 'server-only';

import { z } from 'zod';

import {
  narrationUsesSelectedLanguage,
  usesEnglishProductionScript,
  videoLanguage,
  type VideoLanguageCode,
} from '@/lib/videos/languages';
import { generateLocalStructured, translateLocalTexts } from '@/lib/videos/local-ai';

const LessonSceneSchema = z.object({
  index: z.number().int().min(1).max(12),
  fact: z.string().trim().min(10).max(400),
  narration: z.string().trim().min(5).max(500),
  visualDescription: z.string().trim().min(20).max(500),
  motionDescription: z.string().trim().min(15).max(800).refine(
    (value) => /\bStart\s*:/i.test(value)
      && /\bThen\s*:/i.test(value)
      && /\bEnd\s*:/i.test(value),
    'Motion must contain ordered Start, Then, and End action beats',
  ),
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
    if (!narrationUsesSelectedLanguage(
      plan.scenes.map((scene) => scene.narration).join(' '),
      'en-IN',
    )) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenes'],
        message: 'Source narration must remain in clear English',
      });
    }
    const productionText = [
      plan.learningObjective,
      plan.visualBible,
      ...plan.scenes.flatMap((scene) => [
        scene.fact,
        scene.visualDescription,
        scene.motionDescription,
      ]),
    ].join(' ');
    if (!usesEnglishProductionScript(productionText)) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenes'],
        message: 'Facts and production directions must remain in English',
      });
    }
  });

  const draft = await generateLocalStructured({
    stage: 'video-lesson-planner',
    timeoutMs: 120_000,
    schema: planSchema,
    systemPrompt: `You are a careful school curriculum editor, storyboard artist, and animation director.

Create one coherent ${input.targetDurationSeconds}-second animated lesson split into exactly ${sceneCount} scenes. Each scene receives about 7.5 seconds. The result must teach the requested concept through visible animated cause-and-effect, not through a slideshow, talking presenter, or decorative stock footage. Accuracy is more important than drama.

Rules:
- Interpret an underspecified topic using the supplied school subject and class level. For example, Python under Computer Science means the programming language.
- Use only stable, broadly accepted curriculum facts. Do not invent statistics, quotations, dates, experiments, people, or claims. If a detail is uncertain or unnecessary, omit it.
- Keep simplifications age-appropriate without making the mechanism false. Preserve important distinctions between inputs, intermediates, transformations, products, causes, and correlations. Before returning the plan, silently audit every fact and narration line against textbook consensus and rewrite anything uncertain, misleading, or internally inconsistent.
- Write the title, learning objective, fact fields, and source narration in clear English. A dedicated local translation model will convert only the approved title and narration after fact review.
- Build a clear educational story arc: scene 1 poses the exact concept visually; scenes 2-3 establish its components; scenes 4-7 (or 4-11) demonstrate the mechanism step by step; the final scene applies or summarizes it. A learner watching with sound off should still see the concept progressing. Do not use sensational claims or a generic call to action.
- Each scene must teach one concrete step that logically follows the previous scene. Every narration sentence and every visible object must support that scene's fact. Avoid repetition, tangents, generic motivational filler, and decorative objects unrelated to the lesson.
- Source narration must be natural, plain English with one concise sentence of 10-14 words per scene. This word budget survives Indian-language translation while fitting about 6-7 seconds of speech and leaving a short visual pause. The full narration should last roughly ${input.targetDurationSeconds === 60 ? '48-55' : '75-84'} seconds, never longer than the requested video.
- The fact field is a plain-English statement of the exact fact taught in that scene so it can be audited.
- Visual and motion descriptions must be in English for the local media models. They must show the actual mechanism, process, objects, or relationships—not a teacher presenting them. Each visualDescription is the opening keyframe of an animation: name the main subjects, their exact starting positions and states, environment, spatial relationships, framing, lighting, colors, and the precise curriculum idea.
- Use one consistent premium educational motion-graphics language across the entire storyboard: cinematic 16:9 composition, tactile paper or clean dimensional materials, restrained palette, crisp subject separation, and the same rendering style and recurring subject appearance in every scene. Repeat stable style and identity cues inside every visualDescription because scenes are generated independently.
- Write visualBible as one compact production-style specification shared by all scenes, no more than 500 characters. It must define the rendering medium, palette, lighting, camera language, environment treatment, and the immutable appearance of every recurring subject. Do not put scene-specific action in visualBible.
- Make adjacent scenes flow naturally. Preserve any recurring object, organism, machine, location, or character with identical defining traits, while changing only what the lesson progression requires. Do not depend on a previous scene to make the current description understandable.
- For abstract mathematics, visualize quantities as consistent colored tiles, weights, containers, paths, or geometric objects and animate the valid operation physically. For science, animate the real process and direction of change. For geography and social science, animate flows, spatial relationships, timelines, or cause-and-effect without pretending a metaphor is literal. For computing, animate data and control flow without showing source code or fake UI.
- Every motionDescription must contain three ordered animation beats written exactly as "Start: ... Then: ... End: ...". Each beat must manipulate or change the state of objects already present in the opening keyframe and visibly demonstrate the scene fact. Include one restrained camera instruction only after the subject action. Camera movement alone is invalid.
- Use physically and logically possible motion. State which objects stay fixed, which move, their direction, and the correct final relationship. Never ask the video model to invent factual content during motion.
- Never request a classroom, teacher, student audience, blackboard, projector, presentation slide, talking head, source code, written equation, caption, label, logo, UI, or any visible text. Accurate text is added later by deterministic software, never generated inside an image.
- Prefer one stable composition with clear subject animation. Animate only elements already specified in visualDescription. Do not request scene cuts, a new setting, uncontrolled morphing, or new objects appearing mid-clip.`,
    userPrompt: `Plan the lesson.

Class: ${input.classLevel}
Subject: ${input.subject}
Topic: ${input.topic}
Final narration language after local translation: ${language.label}
Target duration: ${input.targetDurationSeconds} seconds

The ${sceneCount} scene facts together must directly explain the topic at this class level.`,
  });

  return {
    ...draft,
    title: input.topic.slice(0, 200),
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
    if (!narrationUsesSelectedLanguage(narration, 'en-IN')) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenes'],
        message: 'Source narration must remain in clear English',
      });
    }
  });

  const revision = await generateLocalStructured({
    stage: 'video-narration-duration-editor',
    timeoutMs: 60_000,
    schema: revisionSchema,
    systemPrompt: `You are a precise educational narration editor.

${direction === 'shorten' ? 'Shorten' : 'Expand'} the narration so synthesized speech fits a ${input.targetDurationSeconds}-second lesson. Keep exactly one narration entry per scene and preserve the meaning of its supplied audited fact.

Rules:
- Write only in clear English. A dedicated local model translates the approved narration into ${language.promptName} afterward.
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

export async function translateLessonPlan(
  plan: LessonPlan,
  languageCode: VideoLanguageCode,
): Promise<LessonPlan> {
  if (languageCode === 'en-IN') return plan;
  const language = videoLanguage(languageCode);
  const translations = await translateLocalTexts({
    languageCode,
    texts: [plan.title, ...plan.scenes.map((scene) => scene.narration)],
  });
  const translated = {
    ...plan,
    title: translations[0],
    scenes: plan.scenes.map((scene, index) => ({
      ...scene,
      narration: translations[index + 1],
    })),
  };
  const spokenText = translated.scenes.map((scene) => scene.narration).join(' ');
  if (!narrationUsesSelectedLanguage(spokenText, languageCode)) {
    throw new Error(`Local translation did not return ${language.promptName} in its expected script.`);
  }
  return LessonPlanSchema.parse(translated);
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
