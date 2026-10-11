import assert from 'node:assert/strict';
import { cloudLessonKeys, cloudLessonProgress } from '../src/lib/cloud-lesson/progress.ts';
import { cloudLessonApiError } from '../src/lib/cloud-lesson/api-errors.ts';
import { CreateCloudLessonSchema, type CloudLessonProject, type CloudLessonJobProgress } from '../src/lib/videos/cloud-lesson-contracts.ts';
const base = { target_duration_seconds: 60, status: 'preparing', reused_from_project_id: null } as CloudLessonProject;
const job = (kind: CloudLessonJobProgress['kind'], status = 'succeeded', progress = 100) => ({ kind, status, progress } as CloudLessonJobProgress);
const input = { classLevel: 6, subject: ' SCIENCE ', topic: 'Water   cycle', languageCode: 'en-IN' };
assert.deepEqual(cloudLessonKeys(input), { contentKey: '6|science|water cycle|60', cacheKey: '6|science|water cycle|60|en-IN' });
assert.notEqual(cloudLessonKeys(input).cacheKey, cloudLessonKeys({ ...input, languageCode: 'hi-IN' }).cacheKey);
assert.notEqual(cloudLessonKeys(input).cacheKey, cloudLessonKeys({ ...input, durationSeconds: 30 }).cacheKey);
assert.equal(CreateCloudLessonSchema.parse(input).visualStyle, 'illustrated');
assert.equal(CreateCloudLessonSchema.safeParse({ ...input, durationSeconds: 45 }).success, false);
assert.equal(CreateCloudLessonSchema.safeParse({ ...input, visualStyle: 'unknown' }).success, false);
const short = cloudLessonProgress({ ...base, target_duration_seconds: 30, status: 'generating_videos' },
  [job('prepare'), ...Array.from({ length: 4 }, () => job('image'))]);
assert.equal(short.progress, 50);
assert.equal(short.stages[1].total, 4);
assert.equal(cloudLessonProgress(base, []).progress, 0);
assert.equal(cloudLessonProgress(base, []).waitingForWorker, true);
assert.equal(cloudLessonProgress(base, [job('prepare', 'processing', 50)]).progress, 10);
assert.equal(cloudLessonProgress(base, [job('prepare', 'processing', 50)]).waitingForWorker, false);
const finished = [job('prepare'), ...Array.from({ length: 8 }, () => job('image')),
  ...Array.from({ length: 8 }, () => job('video')), job('assemble')];
assert.equal(cloudLessonProgress({ ...base, status: 'assembling' }, finished).progress, 99);
assert.equal(cloudLessonProgress({ ...base, status: 'succeeded' }, finished).progress, 100);
assert.equal(cloudLessonProgress({ ...base, status: 'cancelled' }, []).waitingForWorker, false);
const reused = cloudLessonProgress({ ...base, status: 'generating_videos', reused_from_project_id: 'source' }, [job('prepare')]);
assert.equal(reused.progress, 50); assert.equal(reused.stages[1].count, 8);
assert.equal(reused.stages[1].completed, true);
for (const [hint, status] of [['cloud_lesson_auth', 401], ['cloud_lesson_invalid', 400],
  ['cloud_lesson_active_limit', 429], ['cloud_lesson_daily_limit', 429]] as const) {
  const response = cloudLessonApiError({ hint, message: 'private provider details' });
  assert.equal(response.status, status); assert.ok(!(await response.text()).includes('private'));
}
assert.equal(cloudLessonApiError(new SyntaxError()).status, 400);
assert.equal(cloudLessonApiError(new Response('Unauthorized', { status: 401 })).status, 401);
assert.equal(CreateCloudLessonSchema.safeParse({ ...input, classLevel: 13 }).success, false);
assert.equal(CreateCloudLessonSchema.safeParse({ ...input, languageCode: 'fr-FR' }).success, false);
console.log('Cloud UI contracts: cache keys, all progress states, reuse progress, request validation and safe refusal messages passed.');
