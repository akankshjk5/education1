import assert from 'node:assert/strict';

import {
  removeProjectAssets,
  type ProjectAssetBucket,
  type StorageEntry,
} from '../src/lib/videos/project-assets.ts';

const projectId = '11111111-1111-4111-8111-111111111111';
const listed: string[] = [];
const removed: string[][] = [];
const pages: Record<string, StorageEntry[]> = {
  [projectId]: [
    { name: 'narration.wav', id: 'audio-id' },
    { name: 'scenes', id: null },
  ],
  [`${projectId}/scenes`]: [
    { name: '01.mp4', id: 'video-id' },
    { name: 'frames', id: null },
  ],
  [`${projectId}/scenes/frames`]: [
    { name: '01.webp', id: 'image-id' },
  ],
};

const bucket: ProjectAssetBucket = {
  async list(path) {
    listed.push(path);
    return { data: pages[path] ?? [], error: null };
  },
  async remove(paths) {
    removed.push(paths);
    return { error: null };
  },
};

await removeProjectAssets(bucket, projectId);
assert.deepEqual(new Set(listed), new Set(Object.keys(pages)));
assert.deepEqual(removed.flat(), [
  `${projectId}/narration.wav`,
  `${projectId}/scenes/01.mp4`,
  `${projectId}/scenes/frames/01.webp`,
]);

const failedBucket: ProjectAssetBucket = {
  async list() {
    return { data: null, error: { message: 'storage unavailable' } };
  },
  async remove() {
    return { error: null };
  },
};
await assert.rejects(
  removeProjectAssets(failedBucket, projectId),
  /Could not list video assets: storage unavailable/,
);

console.log('video asset deletion tests passed');
