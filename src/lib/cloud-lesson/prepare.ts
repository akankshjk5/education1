import 'server-only';

import { z } from 'zod';

import {
  CLOUD_LESSON_SCENE_COUNT, CLOUD_LESSON_SCENE_SECONDS, cloudLessonSceneCount,
  CloudLessonPreparedScenesSchema, CreateCloudLessonSchema,
  type CloudLessonPreparedScene, type CreateCloudLessonInput,
} from '@/lib/videos/cloud-lesson-contracts';
import {
  captionUsesSelectedLanguage, narrationUsesSelectedLanguage,
  usesEnglishProductionScript, videoLanguage,
} from '@/lib/videos/languages';
import { auditOverlay, auditTimelines, coerceOverlay, LessonOverlaySchema } from '@/lib/videos/overlays';
// Only exported deterministic helpers are reused; no local model calls run here.
import { cleanCaption, PRINTED_MATTER, scrubLettering, unsupportedNumbers } from '@/lib/videos/planner';
import { fetchTopicReference, referenceBlock, type TopicReference } from '@/lib/videos/reference';

import { generateStructured, type CallOptions } from './gemini';
import { assembleNarration, voiceLesson, type AssembledNarration, type SceneVoice } from './narration';
import { CostMeter } from './pricing';
import { loadCloudLessonSkill, type CloudLessonSkillName, type PromptValues } from './skills';

const IndexSchema = z.number().int().min(1).max(CLOUD_LESSON_SCENE_COUNT);
const SPOKEN_SYMBOLS = /[\p{N}=+*/^<>%×÷]/u;
const EnglishSchema = z.string().trim().refine(usesEnglishProductionScript, 'Keep source text in English');
const singleSentence = (text: string) => text.split(/[.!?।॥]+/u).filter((part) => part.trim()).length === 1;
const NarrationSchema = EnglishSchema.min(5).max(800)
  .refine(singleSentence, 'Narration must be one spoken sentence')
  .refine((text) => !SPOKEN_SYMBOLS.test(text), 'Speak numbers and operations as words, without digits or symbols')
  .refine((text) => {
    const count = text.split(/\s+/).length;
    return count >= 6 && count <= 24;
  }, 'Write one concise spoken sentence, ideally 10-14 words (6-24 allowed)');
const FactSchema = EnglishSchema.min(10).max(500);
const CaptionSchema = z.preprocess(cleanCaption, EnglishSchema.min(1).max(40));

function ordered<T extends { index: number }>(scenes: T[], ctx: z.RefinementCtx, expected: number[]) {
  if (scenes.length !== expected.length || scenes.some((scene, position) => scene.index !== expected[position])) {
    ctx.addIssue({ code: 'custom', path: ['scenes'], message: `Return scenes in order: ${expected.join(', ')}` });
  }
}
const WrittenSceneSchema = z.object({
  index: IndexSchema, fact: FactSchema, narration: NarrationSchema,
  caption: CaptionSchema, overlay: z.preprocess(coerceOverlay, LessonOverlaySchema),
});
const writtenPlanSchema = (count: number) => z.object({
  title: EnglishSchema.min(3).max(200), learningObjective: EnglishSchema.min(10).max(500),
  scenes: z.array(WrittenSceneSchema).length(count),
}).superRefine((plan, ctx) => ordered(plan.scenes, ctx, Array.from({ length: count }, (_, i) => i + 1)));
type WrittenScene = z.infer<typeof WrittenSceneSchema>;

const auditedSchema = (count: number) => z.object({
  scenes: z.array(z.object({
    index: IndexSchema, verdict: z.enum(['correct', 'corrected', 'softened']),
    fact: FactSchema, narration: NarrationSchema,
  })).length(count),
}).superRefine((plan, ctx) => ordered(plan.scenes, ctx, Array.from({ length: count }, (_, i) => i + 1)));

const DirectionSchema = z.object({
  index: IndexSchema,
  subject: EnglishSchema.min(3).max(160),
  visualDescription: z.preprocess(
    (value) => typeof value === 'string' ? scrubLettering(value) : value,
    EnglishSchema.min(20).max(1200).refine((text) => !PRINTED_MATTER.test(text), 'Use physical objects only; no writing or printed matter'),
  ),
  motionDescription: EnglishSchema.min(15).max(800).refine(
    (text) => /Start\s*:[\s\S]+Then\s*:[\s\S]+End\s*:[\s\S]+/i.test(text),
    'Provide ordered Start: / Then: / End: motion beats',
  ).refine((text) => !PRINTED_MATTER.test(text), 'Do not introduce writing in the animation'),
  motionMode: z.enum(['animate', 'still']),
});

const STOP_WORDS = new Set('a an the is are of to in for with by and or as this that it its can from into on at one two three four five six seven eight nine ten we you our their these those'.split(' '));
function subjectWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z]{3,}/g) ?? [])
    .filter((word) => !STOP_WORDS.has(word)).map((word) => word.replace(/(?:ing|es|s)$/, '')));
}

function directorSchema(scenes: WrittenScene[], input: CreateCloudLessonInput) {
  return z.object({
    visualBible: EnglishSchema.min(20).max(500),
    scenes: z.array(DirectionSchema).length(scenes.length),
  }).superRefine((plan, ctx) => {
    ordered(plan.scenes, ctx, scenes.map(s => s.index));
    const seen = new Set<string>();
    plan.scenes.forEach((scene, position) => {
      const fingerprint = scene.visualDescription.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seen.has(fingerprint)) ctx.addIssue({ code: 'custom', path: ['scenes', position, 'visualDescription'], message: 'Each scene needs a distinct arrangement' });
      seen.add(fingerprint);
      const original = scenes[position];
      if (!original) return;
      // Math/programming may use physical analogies. Other subjects must share
      // a concrete subject with the narration or its audited fact.
      const analogy = /math|computer|programming/i.test(input.subject)
        || original.overlay.kind === 'equation' || original.overlay.kind === 'groups';
      if (!analogy) {
        const words = subjectWords(`${original.narration} ${original.fact}`);
        if (![...subjectWords(scene.subject)].some((word) => words.has(word))) {
          ctx.addIssue({ code: 'custom', path: ['scenes', position, 'subject'], message: 'Subject must overlap the audited narration/fact' });
        }
      }
      const shown = subjectWords(scene.visualDescription);
      if (![...subjectWords(scene.subject)].some((word) => shown.has(word))) {
        ctx.addIssue({ code: 'custom', path: ['scenes', position, 'visualDescription'], message: 'The picture must show its stated subject' });
      }
    });
  });
}

export const CloudLessonSourcePlanSchema = z.object({
  title: EnglishSchema.min(3).max(200), learningObjective: EnglishSchema.min(10).max(500),
  scenes: CloudLessonPreparedScenesSchema, visualBible: EnglishSchema.min(20).max(500),
}).superRefine((plan, ctx) => {
  plan.scenes.forEach((scene, index) => {
    const result = WrittenSceneSchema.safeParse(scene);
    if (!result.success) ctx.addIssue({ code: 'custom', path: ['scenes', index], message: 'Invalid English source scene' });
  });
});
export type CloudLessonSourcePlan = z.infer<typeof CloudLessonSourcePlanSchema>;

export interface PrepareCloudLessonOptions extends Omit<CallOptions, 'stage'> {
  input: CreateCloudLessonInput;
  sourcePlan?: CloudLessonSourcePlan;
  /** Injectable so offline tests never fetch Wikipedia. */
  referenceLookup?: (topic: string, subject: string) => Promise<TopicReference | null>;
  /** Called before stages and provider calls; worker throws on cancel/lost. */
  checkpoint?: (stage: string, progress: number) => Promise<void>;
}

export interface PreparedCloudLesson {
  title: string;
  learningObjective: string;
  narrationText: string;
  scenes: CloudLessonPreparedScene[];
  narration: AssembledNarration;
  costUsd: number;
  metadata: {
    cost: ReturnType<CostMeter['summary']>;
    sourcePlan?: CloudLessonSourcePlan;
    reference: { title: string } | null;
    visualBible: string;
    warnings: string[];
    narration: { durationSeconds: number; scenes: AssembledNarration['scenes'] };
  };
}

/** Eight scenes and voice-over only. Images/videos are queued by the completion RPC. */
export async function prepareCloudLesson(options: PrepareCloudLessonOptions): Promise<PreparedCloudLesson> {
  const input = CreateCloudLessonSchema.parse(options.input);
  const sceneCount = cloudLessonSceneCount(input.durationSeconds);
  const animationCap = input.visualStyle === "illustrated" ? (sceneCount === 4 ? 2 : 3) : Math.min(6, sceneCount);
  const meter = options.meter ?? new CostMeter();
  const warnings: string[] = [];
  const languageName = videoLanguage(input.languageCode).promptName;
  const values: PromptValues = {
    classLevel: input.classLevel, subject: input.subject, topic: input.topic,
    languageName, sceneCount, sceneSeconds: 7.5, durationSeconds: input.durationSeconds,
    visualStyle: input.visualStyle, animationCap,
  };
  const checkpoint = async (stage: string, progress: number) => { await options.checkpoint?.(stage, progress); };
  const request = async <T>(name: CloudLessonSkillName, schema: z.ZodType<T>, userPrompt: string, extra: PromptValues = {}) => {
    const skill = await loadCloudLessonSkill(name);
    return (await generateStructured({ ...options, meter, skill, values: { ...values, ...extra }, schema, userPrompt, maxAttempts: 3 })).data;
  };

  let reference: TopicReference | null = null;
  let written: { title: string; learningObjective: string };
  let scenes: WrittenScene[];
  let prepared: CloudLessonPreparedScene[];
  let visualBible: string;
  if (options.sourcePlan) {
    const source = CloudLessonSourcePlanSchema.parse(options.sourcePlan);
    if (source.scenes.length !== sceneCount) throw new Error("Source plan duration does not match the lesson.");
    await checkpoint('reuse-audited-plan', 48);
    written = source;
    scenes = source.scenes.map(scene => WrittenSceneSchema.parse(scene));
    prepared = structuredClone(source.scenes);
    visualBible = source.visualBible;
  } else {
    await checkpoint('reference', 5);
    reference = await (options.referenceLookup ?? fetchTopicReference)(input.topic, input.subject);
    const referenceText = referenceBlock(reference);
    if (!reference) warnings.push('No encyclopedia reference was available; facts were reviewed against model knowledge.');

    await checkpoint('writer', 12);
    const initialPlan = await request('cloud-lesson-writer', writtenPlanSchema(sceneCount), `Topic: ${input.topic}${referenceText}`);
    written = initialPlan;
    scenes = initialPlan.scenes;
    await checkpoint('fact-auditor', 25);
    // Numeric reference flags are useful for dates/statistics, not for invented
    // arithmetic examples, whose correctness is checked by auditOverlay.
    const flagsFor = (current: WrittenScene[]) => reference && !/math/i.test(input.subject)
      ? current.map((scene) => ({ index: scene.index, numbers: unsupportedNumbers(scene.fact, reference!.text) })).filter((flag) => flag.numbers.length)
      : [];
    for (let round = 0; round < 2; round += 1) {
      const flags = flagsFor(scenes);
      const audited = await request('cloud-lesson-fact-auditor', auditedSchema(sceneCount),
        `Topic: ${input.topic}\nScenes: ${JSON.stringify(scenes)}\nUnsupported reference numbers (correct or remove): ${JSON.stringify(flags)}${referenceText}`);
      scenes = scenes.map((scene, index) => ({ ...scene, fact: audited.scenes[index].fact, narration: audited.scenes[index].narration }));
      if (!flagsFor(scenes).length) break;
    }
    if (flagsFor(scenes).length) throw new Error('The lesson still contains numbers not supported by its reference. Try a more specific topic.');

    await checkpoint('math-repair', 38);
    const problems = scenes.flatMap((scene) => {
      const issue = auditOverlay(scene.overlay, scene.fact).issue;
      return issue ? [{ index: scene.index, fact: scene.fact, overlay: scene.overlay, issue }] : [];
    });
    if (problems.length) {
      const repairSchema = z.object({ scenes: z.array(z.object({ index: IndexSchema, fact: FactSchema, overlay: z.preprocess(coerceOverlay, LessonOverlaySchema) })) })
        .superRefine((plan, ctx) => ordered(plan.scenes, ctx, problems.map((scene) => scene.index)));
      try {
        const fixes = await request('cloud-lesson-math-repair', repairSchema,
          `Audited lesson: ${JSON.stringify(scenes)}\nRepair only these scenes: ${JSON.stringify(problems)}\nKeep audited facts unchanged; drop the overlay if it requires changing a fact.`);
        scenes = scenes.map((scene) => {
          const fixed = fixes.scenes.find((fix) => fix.index === scene.index);
          if (!fixed) return scene;
          if (fixed.fact !== scene.fact) {
            warnings.push(`Scene ${scene.index}: overlay dropped because repair changed the audited fact.`);
            return { ...scene, overlay: { kind: 'none' } };
          }
          return { ...scene, overlay: fixed.overlay };
        });
      } catch {
        // Exact graphics are optional. Mandatory facts, direction and narration
        // still fail closed; an unavailable repair only drops bad graphics.
        warnings.push('Overlay repair was unavailable; invalid overlays were dropped.');
      }
    }
    scenes = auditTimelines(scenes.map((scene) => {
      const audited = auditOverlay(scene.overlay, scene.fact);
      if (audited.issue) warnings.push(`Scene ${scene.index}: ${audited.issue}`);
      const direction = /\b(up|down|left|right|towards?|rises?|falls?|flows?|moves?|direction|transfer|increas|decreas|push|pull|enter|leave)/i;
      return { ...scene, overlay: audited.overlay.kind === 'arrow' && !direction.test(`${scene.fact} ${scene.narration}`)
        ? { kind: 'none' } as const : audited.overlay };
    }));

    await checkpoint('scene-director', 48);
    const directed = await request('cloud-lesson-scene-director', directorSchema(scenes, input),
      `Topic: ${input.topic}\nAudited scenes: ${JSON.stringify(scenes)}`);
    let animateCount = 0;
    visualBible = directed.visualBible;
    prepared = scenes.map((scene, index) => {
      const direction = directed.scenes[index];
      const motionMode = direction.motionMode === 'animate' && ++animateCount <= animationCap ? 'animate' : 'still';
      return { ...scene, visualDescription: direction.visualDescription, motionDescription: direction.motionDescription, motionMode };
    });
    if (animateCount > animationCap) warnings.push(`Animation count capped at ${animationCap}; remaining scenes use local motion.`);

  }
  const sourcePlan = CloudLessonSourcePlanSchema.parse({ title: written.title,
    learningObjective: written.learningObjective, scenes: structuredClone(prepared), visualBible });

  type TranslationItem = { id: string; kind: 'title' | 'narration' | 'caption'; text: string };
  const translate = async (items: TranslationItem[]) => {
    if (input.languageCode === 'en-IN') return items.map((item) => item.text);
    const schema = z.object({ translations: z.array(z.object({ id: z.string(), text: z.string().trim().min(1).max(800) })).length(items.length) })
      .superRefine((response, ctx) => response.translations.forEach((translated, position) => {
        const item = items[position];
        if (translated.id !== item.id) ctx.addIssue({ code: 'custom', path: ['translations', position, 'id'], message: `Expected ${item.id}` });
        const matches = item.kind === 'narration' ? narrationUsesSelectedLanguage(translated.text, input.languageCode)
          : captionUsesSelectedLanguage(translated.text, input.languageCode);
        if (!matches || SPOKEN_SYMBOLS.test(translated.text)) ctx.addIssue({ code: 'custom', path: ['translations', position, 'text'], message: `Use ${languageName} script and spell numbers/operations as words` });
        if (item.kind === 'narration' && !singleSentence(translated.text)) ctx.addIssue({ code: 'custom', path: ['translations', position, 'text'], message: 'Keep narration to one spoken sentence' });
        if (item.kind === 'title' && (translated.text.length < 3 || translated.text.length > 200)) ctx.addIssue({ code: 'custom', path: ['translations', position, 'text'], message: 'Title must be 3-200 characters' });
        if (item.kind === 'caption' && (translated.text.split(/\s+/).length > 5 || translated.text.length > 120)) ctx.addIssue({ code: 'custom', path: ['translations', position, 'text'], message: 'Caption must be at most 5 words and 120 characters' });
      }));
    const result = await request('cloud-lesson-translator', schema, JSON.stringify(items));
    return result.translations.map((item) => item.text);
  };

  await checkpoint('translator', 58);
  const items: TranslationItem[] = [{ id: 'title', kind: 'title', text: written.title },
    ...scenes.map((scene) => ({ id: `narration-${scene.index}`, kind: 'narration' as const, text: scene.narration })),
    ...scenes.map((scene) => ({ id: `caption-${scene.index}`, kind: 'caption' as const, text: scene.caption }))];
  const translated = await translate(items);
  const title = translated[0];
  prepared.forEach((scene, index) => { scene.narration = translated[index + 1]; scene.caption = translated[index + 1 + sceneCount]; });

  await checkpoint('narration', 68);
  let voices = await voiceLesson({ ...options, meter, sentences: prepared.map((scene) => scene.narration), languageCode: input.languageCode, slotSeconds: CLOUD_LESSON_SCENE_SECONDS });
  for (let round = 0; round < 2 && voices.some((voice) => voice.overran); round += 1) {
    await checkpoint('narration-editor', 76 + round * 6);
    const overran = voices.filter((voice) => voice.overran);
    const indexes = overran.map((voice) => voice.index);
    const schema = z.object({ scenes: z.array(z.object({ index: IndexSchema, narration: NarrationSchema })) })
      .superRefine((plan, ctx) => ordered(plan.scenes, ctx, indexes));
    const revised = await request('cloud-lesson-narration-editor', schema,
      `Shorten only these scenes, preserving their audited facts:\n${JSON.stringify(overran.map((voice) => ({ ...scenes[voice.index - 1], measuredSeconds: voice.naturalSeconds })))}`,
      { direction: 'too long', targetWords: round === 0 ? 8 : 6 });
    revised.scenes.forEach((revision) => { scenes[revision.index - 1].narration = revision.narration; });
    const revisions = await translate(revised.scenes.map((scene) => ({ id: `narration-${scene.index}`, kind: 'narration', text: scene.narration })));
    revised.scenes.forEach((scene, index) => { prepared[scene.index - 1].narration = revisions[index]; });
    const reuse = new Map<number, SceneVoice>(voices.filter((voice) => !voice.overran).map((voice) => [voice.index, voice]));
    voices = await voiceLesson({ ...options, meter, reuse, sentences: prepared.map((scene) => scene.narration), languageCode: input.languageCode, slotSeconds: CLOUD_LESSON_SCENE_SECONDS });
  }
  await checkpoint('narration-ready', 92);
  const narration = assembleNarration(voices, CLOUD_LESSON_SCENE_SECONDS);
  if (Math.abs(narration.durationSeconds - input.durationSeconds) > 0.001) throw new Error('Narration did not match the selected timeline.');
  const validatedScenes = CloudLessonPreparedScenesSchema.parse(prepared);
  if (validatedScenes.length !== sceneCount) throw new Error("Scene count does not match the selected duration.");
  return {
    title, learningObjective: written.learningObjective, scenes: validatedScenes,
    narrationText: validatedScenes.map((scene) => scene.narration).join(' '), narration, costUsd: meter.totalUsd,
    metadata: { cost: meter.summary(), reference: reference ? { title: reference.title } : null,
      visualBible, sourcePlan, warnings, narration: { durationSeconds: narration.durationSeconds, scenes: narration.scenes } },
  };
}
