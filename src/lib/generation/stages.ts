/**
 * The build's stages and their user-facing labels.
 *
 * No imports: this is pulled into a Client Component.
 */

export const STAGES = [
  { key: 'queued', label: 'Queued' },
  { key: 'researching', label: 'Researching the topic' },
  { key: 'planning', label: 'Planning slides' },
  { key: 'awaiting-review', label: 'Waiting for your review' },
  { key: 'analyzing-style', label: 'Reading your reference image' },
  { key: 'designing', label: 'Writing the slides' },
  { key: 'illustrating', label: 'Drawing the images' },
  { key: 'generating', label: 'Choosing fonts and building the PowerPoint' },
  { key: 'reviewing', label: 'Checking the layout' },
  { key: 'complete', label: 'Finishing up' },
] as const;

const REVISING = { key: 'revising', label: 'Fixing layout issues' } as const;

const BY_KEY = new Map<string, string>([
  ...STAGES.map((stage) => [stage.key, stage.label] as const),
  [REVISING.key, REVISING.label],
]);

export function labelForStage(stage: string): string {
  return BY_KEY.get(stage) ?? 'Working';
}
