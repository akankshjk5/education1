import assert from 'node:assert/strict';

import {
  lessonProgressSnapshot,
  type LessonProgressJob,
} from '../src/lib/videos/progress.ts';
import type {
  LessonVideoProject,
  LessonVideoScene,
} from '../src/lib/videos/lesson-contracts.ts';

const project: LessonVideoProject = {
  id: '11111111-1111-4111-8111-111111111111',
  owner_id: 'user_test',
  class_level: 6,
  subject: 'Science',
  topic: 'Water cycle',
  language_code: 'en-IN',
  language_name: 'English',
  target_duration_seconds: 60,
  title: 'The water cycle',
  learning_objective: 'Explain the water cycle.',
  narration_text: 'Water moves through the environment.',
  narration_url: null,
  narration_duration_seconds: null,
  status: 'generating_videos',
  final_video_url: null,
  error_message: null,
  created_at: '2026-10-19T08:00:00.000Z',
  updated_at: '2026-10-19T08:00:00.000Z',
  completed_at: null,
};

const scene: LessonVideoScene = {
  id: '22222222-2222-4222-8222-222222222222',
  project_id: project.id,
  scene_index: 1,
  duration_seconds: 7.5,
  fact: 'Water evaporates.',
  narration: 'Water evaporates.',
  image_prompt: 'Water in a glass vessel.',
  video_prompt: 'Show the water moving.',
  caption: 'Evaporation',
  overlay: { kind: 'none' },
  status: 'generating_video',
  image_url: 'https://storage.test/image.png',
  video_url: null,
  error_message: null,
  created_at: project.created_at,
  updated_at: project.updated_at,
  completed_at: null,
};

const jobs: LessonProgressJob[] = [
  {
    kind: 'image',
    scene_id: scene.id,
    status: 'succeeded',
    started_at: project.created_at,
    output_metadata: { latency_seconds: { total: 12 } },
  },
  {
    kind: 'video',
    scene_id: scene.id,
    status: 'processing',
    started_at: '2026-10-19T08:01:00.000Z',
    output_metadata: {},
  },
];

const noMeasuredSamples = lessonProgressSnapshot(
  project,
  [scene],
  [{ ...jobs[1], started_at: project.created_at }],
  Date.parse('2026-10-19T08:02:00.000Z'),
);
assert.equal(noMeasuredSamples.etaSeconds, null);
assert.equal(noMeasuredSamples.completedClips, 0);
assert.equal(noMeasuredSamples.totalClips, 1);

const imageVideoMeasuredButAssemblyUnmeasured = lessonProgressSnapshot(
  project,
  [scene],
  [
    ...jobs,
    {
      kind: 'video',
      scene_id: '33333333-3333-4333-8333-333333333333',
      status: 'succeeded',
      started_at: project.created_at,
      output_metadata: { latency_seconds: { total: 60 } },
    },
  ],
  Date.parse('2026-10-19T08:02:00.000Z'),
);
assert.equal(imageVideoMeasuredButAssemblyUnmeasured.etaSeconds, null);

const completed = lessonProgressSnapshot(
  { ...project, status: 'succeeded' },
  [{ ...scene, status: 'succeeded', video_url: 'https://storage.test/video.mp4' }],
  [],
);
assert.equal(completed.etaSeconds, 0);
assert.equal(completed.completedClips, 1);
assert.equal(completed.totalClips, 1);

console.log('Lesson-video progress uses measured timings only.');
