import type { LessonVideoProject, LessonVideoScene } from '@/lib/videos/lesson-contracts';

export interface LessonProgressJob {
  kind: string;
  scene_id: string | null;
  status: string;
  started_at: string | null;
  output_metadata: unknown;
}

export interface LessonProgressSnapshot {
  etaSeconds: number | null;
  completedClips: number;
  totalClips: number;
  activeSceneIndex: number | null;
}

function metadataLatency(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const latency = (metadata as { latency_seconds?: unknown }).latency_seconds;
  if (!latency || typeof latency !== 'object') return null;
  const total = Number((latency as { total?: unknown }).total);
  return Number.isFinite(total) && total > 0 ? total : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function estimateFor(kind: 'image' | 'video' | 'assemble', jobs: LessonProgressJob[]): number | null {
  const measured = jobs
    .filter((job) => job.kind === kind && job.status === 'succeeded')
    .map((job) => metadataLatency(job.output_metadata))
    .filter((value): value is number => value !== null);
  return median(measured);
}

function remainingFor(
  job: LessonProgressJob | undefined,
  estimate: number,
  now: number,
): number {
  if (job?.status === 'succeeded') return 0;
  if (job?.status !== 'processing' || !job.started_at) return estimate;
  const started = Date.parse(job.started_at);
  if (!Number.isFinite(started)) return estimate;
  return Math.max(0, estimate - Math.max(0, now - started) / 1000);
}

export function lessonProgressSnapshot(
  project: LessonVideoProject,
  scenes: LessonVideoScene[],
  jobs: LessonProgressJob[],
  now = Date.now(),
): LessonProgressSnapshot {
  if (project.status === 'preparing') {
    return {
      etaSeconds: null,
      completedClips: 0,
      totalClips: 0,
      activeSceneIndex: null,
    };
  }
  if (project.status === 'succeeded') {
    return {
      etaSeconds: 0,
      completedClips: scenes.length,
      totalClips: scenes.length,
      activeSceneIndex: null,
    };
  }
  if (project.status === 'failed' || project.status === 'cancelled') {
    return {
      etaSeconds: null,
      completedClips: scenes.filter((scene) => Boolean(scene.video_url)).length,
      totalClips: scenes.length,
      activeSceneIndex: null,
    };
  }

  const imageSeconds = estimateFor('image', jobs);
  const videoSeconds = estimateFor('video', jobs);
  const assemblySeconds = estimateFor('assemble', jobs);
  const latestJob = (sceneId: string, kind: 'image' | 'video') => jobs.findLast((job) =>
    job.scene_id === sceneId && job.kind === kind && job.status !== 'cancelled');
  let remainingSeconds = 0;
  let hasUnmeasuredStage = false;
  let activeSceneIndex: number | null = null;

  for (const scene of scenes) {
    const imageJob = latestJob(scene.id, 'image');
    const videoJob = latestJob(scene.id, 'video');
    if (!scene.image_url) {
      if (imageSeconds === null) hasUnmeasuredStage = true;
      else remainingSeconds += remainingFor(imageJob, imageSeconds, now);
    }
    if (!scene.video_url) {
      if (videoSeconds === null) hasUnmeasuredStage = true;
      else remainingSeconds += remainingFor(videoJob, videoSeconds, now);
    }
    if (activeSceneIndex === null && (
      scene.status === 'generating_image' || scene.status === 'generating_video'
    )) activeSceneIndex = scene.scene_index;
  }

  const assemblyJob = jobs.findLast((job) => job.kind === 'assemble' && job.status !== 'cancelled');
  if (assemblyJob?.status !== 'succeeded') {
    if (assemblySeconds === null) hasUnmeasuredStage = true;
    else remainingSeconds += remainingFor(assemblyJob, assemblySeconds, now);
  }

  return {
    etaSeconds: hasUnmeasuredStage ? null : Math.max(0, Math.round(remainingSeconds)),
    completedClips: scenes.filter((scene) => Boolean(scene.video_url)).length,
    totalClips: scenes.length,
    activeSceneIndex,
  };
}
