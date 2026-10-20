/** Cloud lesson preparation worker; no RunPod services or GPU required. */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { serverEnv } from '../src/lib/env.ts';
import { loadAllCloudLessonSkills } from '../src/lib/cloud-lesson/skills.ts';
import { createCloudPreparationStore, runCloudPreparationJob } from '../src/lib/cloud-lesson/worker.ts';
import { createCloudImageStore, runCloudImageJob } from '../src/lib/cloud-lesson/image-worker.ts';
import { runCloudWorkerPool } from '../src/lib/cloud-lesson/worker-pool.ts';

const args = process.argv.slice(2);
const kind = args[args.indexOf('--kinds') + 1] === 'image' ? 'image' : 'prepare';
const concurrencyIndex = args.indexOf('--concurrency');
const concurrencyValue = concurrencyIndex >= 0 ? args[concurrencyIndex + 1] : undefined;
if (args.includes('--help')) {
  console.log('Usage: npm run worker:cloud-prepare -- [--kinds prepare|image] [--concurrency 1-4] [--once]\nImage jobs default to four concurrent workers; preparation defaults to one. --once processes at most one job.');
} else {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--once') continue;
    if (args[index] === '--kinds' && ['prepare', 'image'].includes(args[index + 1])) { index += 1; continue; }
    if (args[index] === '--concurrency' && /^\d+$/.test(args[index + 1] ?? '')) { index += 1; continue; }
    throw new Error(`Unsupported argument: ${args[index]}. Use --kinds prepare|image and --concurrency 1-4.`);
  }
  const defaultConcurrency = kind === 'image' ? 4 : 1;
  const concurrency = concurrencyValue === undefined ? defaultConcurrency : Number(concurrencyValue);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error('Cloud worker concurrency must be between 1 and 4.');
  }
  await loadAllCloudLessonSkills();
  // Fail before claiming a job when configuration is incomplete.
  void serverEnv.cloudLessonGeminiApiKey;
  void serverEnv.supabaseServiceRoleKey;
  const store = kind === 'image' ? createCloudImageStore() : createCloudPreparationStore();
  const workerId = `cloud-${kind}:${hostname()}:${randomUUID()}`;
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const once = args.includes('--once');
  console.log(`Cloud lesson worker ready (${workerId}); kind: ${kind}; concurrency: ${once ? 1 : concurrency}; Gemini backend: ${serverEnv.cloudLessonGeminiBackend}`);
  try {
    await runCloudWorkerPool({
      workerId, concurrency, once, signal: controller.signal,
      claim: id => store.claim(id),
      process: async (job, _id, signal) => {
        const onStage = (stage: string, progress: number) => console.log(`[${job.id}] ${progress}% ${stage}`);
        const result = job.kind === 'image'
          ? await runCloudImageJob({ job, store: store as ReturnType<typeof createCloudImageStore>, signal, onStage })
          : await runCloudPreparationJob({ job, store: store as ReturnType<typeof createCloudPreparationStore>, signal, onStage });
        console.log(`[${job.id}] ${result.status}; known Gemini cost $${result.costUsd.toFixed(4)}`);
      },
    });
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}
