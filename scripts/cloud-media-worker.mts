import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { serverEnv } from '../src/lib/env.ts';
import { createHiggsfieldProvider } from '../src/lib/cloud-lesson/higgsfield.ts';
import { createCloudMediaStore, createCloudMediaRenderer, pickLessonMusic, runCloudMediaJob } from '../src/lib/cloud-lesson/media-worker.ts';
import { runCloudWorkerPool } from '../src/lib/cloud-lesson/worker-pool.ts';

const args = process.argv.slice(2);
const concurrencyIndex = args.indexOf('--concurrency');
const concurrencyValue = concurrencyIndex >= 0 ? args[concurrencyIndex + 1] : undefined;
if (args.includes('--help')) {
  console.log('Usage: npm run worker:cloud-media -- [--concurrency 1-4] [--once] [--assemble-only] [--preflight]\nDefaults to two concurrent media jobs; --once processes at most one job. Video jobs may incur Higgsfield charges.');
} else {
  for (let index = 0; index < args.length; index += 1) {
    if (['--once', '--assemble-only', '--preflight'].includes(args[index])) continue;
    if (args[index] === '--concurrency' && /^\d+$/.test(args[index + 1] ?? '')) { index += 1; continue; }
    throw new Error(`Unsupported argument: ${args[index]}`);
  }
  const concurrency = concurrencyValue === undefined ? 2 : Number(concurrencyValue);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error('Cloud worker concurrency must be between 1 and 4.');
  }
  const renderer = createCloudMediaRenderer();
  await renderer.preflight(); // Dependencies and all language fonts checked before claiming work.
  if (serverEnv.cloudLessonMusicDir) {
    // Throws now, before any claim, when the folder is wrong; storybook lessons only.
    const track = await pickLessonMusic(serverEnv.cloudLessonMusicDir, 'preflight');
    console.log(track ? 'Storybook music folder is ready.' : 'CLOUD_LESSON_MUSIC_DIR has no .wav or .m4a tracks; storybook lessons will have no music.');
  }
  if (args.includes('--preflight')) {
    console.log('Cloud compositor dependencies and fonts are ready. No API calls made.');
  } else {
    void serverEnv.supabaseServiceRoleKey;
    const provider = args.includes('--assemble-only') ? undefined : createHiggsfieldProvider(serverEnv.cloudLessonHiggsfieldCredentials);
    const store = createCloudMediaStore();
    const workerId = `cloud-media:${hostname()}:${randomUUID()}`;
    const controller = new AbortController();
    const shutdown = () => controller.abort();
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    const once = args.includes('--once');
    console.log(`Cloud media worker ready (${workerId}), 1080p CPU composition, concurrency ${once ? 1 : concurrency}.`);
    try {
      await runCloudWorkerPool({
        workerId, concurrency, once, signal: controller.signal,
        claim: id => store.claim(id, args.includes('--assemble-only') ? ['assemble'] : ['video', 'assemble']),
        process: async (job, _id, signal) => {
          const result = await runCloudMediaJob({ job, store, provider, renderer, signal,
            onStage: (stage, percent) => console.log(`[${job.id}] ${percent}% ${stage}`) });
          console.log(`[${job.id}] ${result.status}; additional estimated provider cost $${result.costUsd.toFixed(4)}`);
        },
      });
    } finally { process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown); }
  }
}
