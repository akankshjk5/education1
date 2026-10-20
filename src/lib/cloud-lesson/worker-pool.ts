import { setTimeout as delay } from 'node:timers/promises';

export interface CloudWorkerPoolOptions<T> {
  workerId: string;
  concurrency: number;
  once?: boolean;
  pollMs?: number;
  signal: AbortSignal;
  claim(workerId: string): Promise<T | null>;
  process(job: T, workerId: string, signal: AbortSignal): Promise<void>;
}

export async function runCloudWorkerPool<T>(options: CloudWorkerPoolOptions<T>): Promise<void> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4) {
    throw new Error('Cloud worker concurrency must be between 1 and 4.');
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal.aborted) abort();
  else options.signal.addEventListener('abort', abort, { once: true });

  const runLane = async (lane: number) => {
    const workerId = `${options.workerId}:${lane + 1}`;
    while (!controller.signal.aborted) {
      const job = await options.claim(workerId);
      if (controller.signal.aborted) return;
      if (job === null) {
        if (options.once) return;
        try {
          await delay(options.pollMs ?? 3_000, undefined, { signal: controller.signal });
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        }
        continue;
      }
      await options.process(job, workerId, controller.signal);
      if (options.once) return;
    }
  };

  try {
    const lanes = Array.from({ length: options.once ? 1 : options.concurrency }, (_, i) =>
      runLane(i).catch((error: unknown) => {
        controller.abort();
        throw error;
      }));
    const results = await Promise.allSettled(lanes);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  } finally {
    options.signal.removeEventListener('abort', abort);
    controller.abort();
  }
}
