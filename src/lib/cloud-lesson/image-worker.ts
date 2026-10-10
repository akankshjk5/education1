import 'server-only';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { publicEnv, serverEnv } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/lib/supabase/database.types';
import { type CallOptions, generateImage, geminiTransport, type GeminiTransport } from './gemini';
import { CostMeter } from './pricing';
import { checkKeyframe } from './vision';
import { PreparationStopped, preparationFailure, type HeartbeatState } from './worker';

export const ImageJobSchema = z.object({
  id: z.string().uuid(), project_id: z.string().uuid(), owner_id: z.string().min(1), scene_id: z.string().uuid(),
  kind: z.literal('image'), status: z.literal('processing'), worker_id: z.string().min(1),
  attempts: z.number().int().positive(), max_attempts: z.number().int().positive(),
  prompt: z.string().min(20).max(4000), negative_prompt: z.string().nullable(),
  parameters: z.object({ sceneIndex: z.number().int().min(1).max(8), styleReferenceUrl: z.string().url().optional(), awaitsStyleReference: z.boolean().optional() }),
});
export type ImageJob = z.infer<typeof ImageJobSchema>;
export class KeyframeRejected extends Error {}

/** Decode and strip metadata. Never upscale an undersized provider response. */
export async function normalizeKeyframe(bytes: Buffer): Promise<{ mimeType: string; data: Buffer }> {
  if (bytes.length > 20 * 1024 * 1024) throw new Error('Image exceeds size limit.');
  const image = sharp(bytes, { limitInputPixels: 20_000_000, animated: false });
  const meta = await image.metadata();
  if (!meta.width || !meta.height || meta.width < 2560 || meta.height < 1440
      || Math.abs(meta.width / meta.height - 16 / 9) > 0.05
      || (meta.pages ?? 1) > 1) throw new Error('Image does not meet 2K widescreen quality requirements.');
  return { mimeType: 'image/png', data: await image.resize(2560, 1440, { fit: 'cover' }).png().toBuffer() };
}
export function validateStyleReference(url: string, projectId: string, supabaseUrl: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.origin !== new URL(supabaseUrl).origin || parsed.username || parsed.password || parsed.search || parsed.hash
    || !parsed.pathname.startsWith(`/storage/v1/object/public/cloud-lesson-assets/${projectId}/media/`)
    || /%|\\/.test(parsed.pathname) || !parsed.pathname.endsWith('.png')) throw new Error('Invalid style reference URL.');
  return parsed;
}
export async function downloadStyleReference(url: URL, fetcher: typeof fetch = fetch) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !/^image\/(png|jpeg|webp)(;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw new Error('Could not load style reference.');
  if (Number(response.headers.get('content-length') ?? 0) > 20 * 1024 * 1024) throw new Error('Style reference exceeds size limit.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break;
    size += value.length; if (size > 20 * 1024 * 1024) throw new Error('Style reference exceeds size limit.'); chunks.push(value);
  } } finally { await reader.cancel(); }
  return normalizeKeyframe(Buffer.concat(chunks));
}
export interface CloudImageStore {
  claim(workerId: string): Promise<ImageJob | null>;
  scene(job: ImageJob): Promise<{ index: number; description: string }>;
  reference(job: ImageJob, url: string): Promise<{ mimeType: string; data: Buffer }>;
  heartbeat(job: ImageJob, progress: number): Promise<HeartbeatState>;
  upload(job: ImageJob, png: Buffer): Promise<string>;
  complete(job: ImageJob, url: string, metadata: Record<string, unknown>, cost: number): Promise<boolean>;
  fail(job: ImageJob, code: string, message: string, cost: number): Promise<boolean>;
}
export function createCloudImageStore(): CloudImageStore {
  const client = createAdminClient();
  return {
    async claim(workerId) {
      const { data, error } = await client.rpc('claim_cloud_lesson_job', { p_worker_id: workerId, p_kinds: ['image'] });
      if (error) throw new Error('Could not claim image job.'); return data?.[0] ? ImageJobSchema.parse(data[0]) : null;
    },
    async scene(job) {
      const { data: project, error: projectError } = await client.from('cloud_lesson_projects').select('status').eq('id', job.project_id).eq('owner_id', job.owner_id).single();
      if (projectError || !project) throw new Error('Could not load lesson.');
      if (project.status === 'cancelled') throw new PreparationStopped('cancel');
      if (!['generating_images', 'generating_videos'].includes(project.status)) throw new Error('Lesson is inactive.');
      const { data, error } = await client.from('cloud_lesson_scenes').select('scene_index,visual_description,status').eq('id', job.scene_id).eq('project_id', job.project_id).single();
      if (error || !data || data.status !== 'generating_image' || data.scene_index !== job.parameters.sceneIndex) throw new Error('Invalid scene claim.');
      return { index: data.scene_index, description: data.visual_description };
    },
    async reference(job, url) { return downloadStyleReference(validateStyleReference(url, job.project_id, publicEnv.supabaseUrl)); },
    async heartbeat(job, progress) {
      const { data, error } = await client.rpc('heartbeat_cloud_lesson_job', { p_job_id: job.id, p_worker_id: job.worker_id, p_progress: progress });
      if (error) throw new Error('Could not verify image ownership.'); return z.enum(['ok', 'cancel', 'lost']).parse(data);
    },
    async upload(job, png) {
      const name = `${job.project_id}/media/${job.id}-${randomUUID()}.png`;
      const { error } = await client.storage.from('cloud-lesson-assets').upload(name, png, { contentType: 'image/png', upsert: false });
      if (error) throw new Error('Could not save image.'); return client.storage.from('cloud-lesson-assets').getPublicUrl(name).data.publicUrl;
    },
    async complete(job, url, metadata, cost) {
      const { data, error } = await client.rpc('complete_cloud_lesson_job', { p_job_id: job.id, p_worker_id: job.worker_id, p_output_url: url,
        p_output_metadata: JSON.parse(JSON.stringify(metadata)) as Json, p_cost_usd: cost });
      if (error) throw new Error('Could not complete image.'); return data === true;
    },
    async fail(job, code, message, cost) {
      const { data, error } = await client.rpc('fail_cloud_lesson_job', { p_job_id: job.id, p_worker_id: job.worker_id, p_error_code: code,
        p_error_message: message, p_retry_delay_seconds: 2, p_cost_usd: cost });
      if (error) throw new Error('Could not record image failure.'); return data === true;
    },
  };
}

export interface RunImageOptions extends Omit<CallOptions, 'stage'> {
  model?: string;
  job: ImageJob;
  store: CloudImageStore;
  signal?: AbortSignal;
  heartbeatMs?: number;
  onStage?: (stage: string, progress: number) => void;
}
export type ImageRunResult = { status: 'completed' | 'failed' | 'cancelled' | 'lost' | 'shutdown'; costUsd: number };

/** Process one claimed job. Its heartbeat is alive even during long Gemini calls. */
export async function runCloudImageJob(options: RunImageOptions): Promise<ImageRunResult> {
  const job = ImageJobSchema.parse(options.job);
  const meter = options.meter ?? new CostMeter();
  let progress = 0;
  let stopped: PreparationStopped | undefined;
  const stoppedReason = () => stopped?.reason;
  let heartbeatPending: Promise<void> | undefined;
  const assertActive = () => {
    if (stopped) throw stopped;
    if (options.signal?.aborted) throw new PreparationStopped('shutdown');
  };
  const beat = async () => {
    assertActive();
    if (!heartbeatPending) {
      heartbeatPending = (async () => {
        try {
          const state = await options.store.heartbeat(job, progress);
          if (state !== 'ok') stopped = new PreparationStopped(state);
        } catch {
          // If ownership cannot be verified, stop spending and writing. Let
          // database lease recovery decide which worker is next.
          stopped = new PreparationStopped('lost');
        }
      })();
    }
    const pending = heartbeatPending;
    await pending;
    if (heartbeatPending === pending) heartbeatPending = undefined;
    assertActive();
  };
  const checkpoint = async (stage: string, percent: number) => {
    progress = Math.max(progress, percent);
    await beat();
    options.onStage?.(stage, progress);
  };
  const transport: GeminiTransport = {
    async generateContent(request) {
      await beat();
      const response = await (options.transport ?? geminiTransport()).generateContent(request);
      // Return the response so Gemini records its billed usage. The next
      // checkpoint/provider call rejects cancelled or lost work.
      return response;
    },
  };
  const timer = setInterval(() => { void beat().catch(() => undefined); }, options.heartbeatMs ?? 15_000);
  try {
    await checkpoint('claimed', 1);
    const scene = await options.store.scene(job);
    await checkpoint('style-reference', 10);
    const styleReference = job.parameters.styleReferenceUrl ? await options.store.reference(job, job.parameters.styleReferenceUrl) : undefined;
    if (scene.index > 1 && !styleReference) throw new Error('Missing style reference.');
    await checkpoint('generate-image', 20);
    const generated = await generateImage({ ...options, transport, meter,
      model: options.model ?? serverEnv.cloudLessonImageModel, aspectRatio: '16:9', imageSize: '2K',
      styleReference, prompt: `${job.prompt}\nAvoid: ${job.negative_prompt ?? 'text, writing, logos, watermarks'}` });
    await checkpoint('normalize-image', 65);
    const image = await normalizeKeyframe(generated.data);
    await checkpoint('check-image', 75);
    const decision = await checkKeyframe({ ...options, transport, meter, image, description: scene.description, finalAttempt: job.attempts >= job.max_attempts });
    if (!decision.accept) throw new KeyframeRejected();
    await checkpoint('upload-image', 90);
    const url = await options.store.upload(job, image.data);
    await checkpoint('save-image', 98);
    if (!await options.store.complete(job, url, { ...meter.summary(), sceneIndex: scene.index,
      model: options.model ?? serverEnv.cloudLessonImageModel, width: 2560, height: 1440,
      requestedImageSize: '2K', styleReferenceUsed: Boolean(styleReference), keyframe: decision,
      warnings: decision.acceptedOnFinalAttempt ? decision.problems : [] }, meter.totalUsd)) throw new PreparationStopped('lost');
    return { status: 'completed', costUsd: meter.totalUsd };
  } catch (error) {
    if (stopped?.reason === 'lost' || (error instanceof PreparationStopped && error.reason === 'lost')) {
      return { status: 'lost', costUsd: meter.totalUsd };
    }
    if (options.signal?.aborted || (error instanceof PreparationStopped && error.reason === 'shutdown')) {
      // Leave the lease for recovery, rather than spending a retry on shutdown.
      return { status: 'shutdown', costUsd: meter.totalUsd };
    }
    // Refresh the lease before recording failure; cancellation racing a Gemini
    // rejection must not turn a cancelled lesson back into queued work.
    try { await beat(); } catch { /* state is inspected below */ }
    if (stoppedReason() === 'lost') return { status: 'lost', costUsd: meter.totalUsd };
    const failure = error instanceof KeyframeRejected ? { code: 'keyframe_rejected', message: 'The scene image did not pass its quality checks.' } : preparationFailure(stopped ?? error);
    if (failure.code === 'cloud_preparation_failed') { failure.code = 'cloud_image_failed'; failure.message = 'Scene image generation could not finish. Please check the cloud worker.'; }
    const accepted = await options.store.fail(job, failure.code, failure.message, meter.totalUsd);
    const cancelled = stoppedReason() === 'cancel' || (error instanceof PreparationStopped && error.reason === 'cancel');
    return { status: accepted ? cancelled ? 'cancelled' : 'failed' : 'lost', costUsd: meter.totalUsd };
  } finally {
    clearInterval(timer);
    if (heartbeatPending) await heartbeatPending;
  }
}
