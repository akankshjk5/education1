import assert from 'node:assert/strict';

import { runCloudWorkerPool } from '../src/lib/cloud-lesson/worker-pool.ts';
import { CreateCloudLessonSchema } from '../src/lib/videos/cloud-lesson-contracts.ts';
import { LessonPlanSchema } from '../src/lib/videos/planner.ts';
import { CreateLessonVideoSchema } from '../src/lib/videos/lesson-contracts.ts';

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  console.log(`PASS ${name}`);
  passed += 1;
}

await test('both video workflows default to 30 seconds and the narrated planner accepts four scenes', async () => {
  const request = CreateLessonVideoSchema.parse({
    classLevel: 6,
    subject: 'Science',
    topic: 'The water cycle',
  });
  assert.equal(request.targetDurationSeconds, 30);
  assert.equal(CreateLessonVideoSchema.safeParse({ ...request, targetDurationSeconds: 45 }).success, false);
  assert.equal(CreateCloudLessonSchema.parse({
    classLevel: 6,
    subject: 'Science',
    topic: 'The water cycle',
  }).durationSeconds, 30);

  const plan = LessonPlanSchema.parse({
    title: 'The water cycle',
    learningObjective: 'Explain how water moves through the environment.',
    visualBible: 'Warm natural colors, soft daylight and simple physical objects.',
    scenes: Array.from({ length: 4 }, (_, index) => ({
      index: index + 1,
      fact: 'Water changes form as it moves through the environment.',
      narration: 'Water moves through this part of the cycle.',
      caption: 'Water keeps moving',
      visualDescription: 'A clear glass sphere beside a small pool in warm daylight.',
      motionDescription: 'Start: The sphere is still. Then: Water gently rises. End: The sphere settles.',
      overlay: { kind: 'none' },
    })),
  });
  assert.equal(plan.scenes.length, 4);
});

await test('worker pool processes claimed jobs concurrently on distinct lanes', async () => {
  let nextJob = 0;
  let active = 0;
  let maxActive = 0;
  let processed = 0;
  const workerIds = new Set<string>();
  const controller = new AbortController();

  await runCloudWorkerPool({
    workerId: 'pool-test',
    concurrency: 3,
    signal: controller.signal,
    claim: async (workerId) => {
      workerIds.add(workerId);
      return nextJob < 3 ? nextJob++ : null;
    },
    process: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      processed += 1;
      if (processed === 3) controller.abort();
    },
  });

  assert.equal(maxActive, 3);
  assert.equal(workerIds.size, 3);
});

await test('--once handles one job even when concurrency is greater than one', async () => {
  let claims = 0;
  let processed = 0;

  await runCloudWorkerPool({
    workerId: 'pool-once',
    concurrency: 4,
    once: true,
    signal: new AbortController().signal,
    claim: async () => {
      claims += 1;
      return { id: claims };
    },
    process: async () => { processed += 1; },
  });

  assert.equal(claims, 1);
  assert.equal(processed, 1);
});

await test('worker failure aborts sibling lanes and surfaces the error', async () => {
  let nextJob = 0;
  const laneSignals: AbortSignal[] = [];

  await assert.rejects(runCloudWorkerPool({
    workerId: 'pool-failure',
    concurrency: 3,
    signal: new AbortController().signal,
    claim: async () => nextJob < 3 ? nextJob++ : null,
    process: async (job, _workerId, signal) => {
      laneSignals.push(signal);
      if (job === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('job processing failed');
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  }), /job processing failed/);

  assert.equal(laneSignals.length, 3);
  assert.ok(laneSignals.every((signal) => signal.aborted));
});

await test('worker pool rejects concurrency above the bounded limit', async () => {
  await assert.rejects(runCloudWorkerPool({
    workerId: 'pool-invalid',
    concurrency: 5,
    signal: new AbortController().signal,
    claim: async () => null,
    process: async () => {},
  }), /between 1 and 4/);
});

console.log(`${passed} video fast-path tests passed; no provider calls.`);
