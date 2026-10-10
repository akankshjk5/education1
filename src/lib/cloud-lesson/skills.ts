import 'server-only';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { serverEnv } from '@/lib/env';

/**
 * Loader for the cloud lesson engine's skills: `Agents/Skills/cloud-lesson/*.md`.
 *
 * The same idea as `Agents/skill-loader.ts` — a specialist is a Markdown file,
 * its prose is the system prompt, its frontmatter names its model — kept in a
 * separate folder with a separate loader on purpose:
 *
 *  - The deck pipeline's `listSkills()` reads only the top level of
 *    `Agents/Skills/`, so it never sees these files, and the deck smoke test's
 *    rule that every specialist declares `reset_to_manager` does not apply.
 *  - These skills run on Gemini via Vertex, not OpenRouter, so their model
 *    slugs are `vertex/<model>` and only that prefix is accepted here.
 *  - They return structured JSON and call no tools, so a `[TOOLS]` block is
 *    refused rather than silently ignored.
 *
 * Prompts use `{{name}}` placeholders. `renderCloudLessonPrompt` fills them and
 * throws on any placeholder left without a value: a prompt that says
 * "Class {{classLevel}}" to the model is a bug, not a lesson.
 */

const SKILLS_DIR = path.join(process.cwd(), 'Agents', 'Skills', 'cloud-lesson');

/** Every cloud lesson specialist, in the order the prep worker runs them. */
export const CLOUD_LESSON_SKILLS = [
  'cloud-lesson-writer',
  'cloud-lesson-fact-auditor',
  'cloud-lesson-math-repair',
  'cloud-lesson-scene-director',
  'cloud-lesson-translator',
  'cloud-lesson-narration-editor',
] as const;
export type CloudLessonSkillName = (typeof CLOUD_LESSON_SKILLS)[number];

/** `vertex/<model>`, e.g. `vertex/gemini-2.5-flash`. */
const VERTEX_MODEL = /^vertex\/([a-z0-9][a-z0-9.-]*)$/;

/** Frontmatter keys a cloud skill may set. Anything else is refused. */
const ALLOWED_KEYS = new Set(['model', 'temperature', 'thinkingBudget', 'maxOutputTokens']);

export interface CloudLessonSkill {
  name: CloudLessonSkillName;
  /** The full `vertex/...` slug, after any env override. */
  model: string;
  /** The Gemini model id to send to Vertex, e.g. `gemini-2.5-flash`. */
  vertexModel: string;
  temperature: number;
  /** Gemini thinking budget in tokens; 0 turns thinking off. */
  thinkingBudget: number;
  maxOutputTokens: number;
  /** The prompt with `{{placeholders}}` still in it. */
  template: string;
  /** Placeholder names the template uses, sorted. */
  placeholders: string[];
}

export class CloudLessonSkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudLessonSkillError';
  }
}

function parseFrontmatter(raw: string, name: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new CloudLessonSkillError(`Skill "${name}" has no frontmatter; it must declare a model`);
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const pair = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!pair) throw new CloudLessonSkillError(`Skill "${name}" has an unreadable frontmatter line: ${line}`);
    if (!ALLOWED_KEYS.has(pair[1])) {
      throw new CloudLessonSkillError(`Skill "${name}" sets unknown frontmatter key "${pair[1]}"`);
    }
    meta[pair[1]] = pair[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return { meta, body: raw.slice(match[0].length) };
}

function numberSetting(
  meta: Record<string, string>,
  key: string,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (meta[key] === undefined) return fallback;
  const value = Number(meta[key]);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new CloudLessonSkillError(`Skill "${name}" sets ${key} to ${meta[key]}; expected ${min}-${max}`);
  }
  return value;
}

/** Parses one skill file. Exported for tests; callers use `loadCloudLessonSkill`. */
export function parseCloudLessonSkill(name: CloudLessonSkillName, raw: string): CloudLessonSkill {
  const { meta, body } = parseFrontmatter(raw, name);

  if (/^\s*\[TOOLS\]\s*$/m.test(body)) {
    throw new CloudLessonSkillError(`Skill "${name}" declares [TOOLS]; cloud lesson skills return JSON only`);
  }

  const model = serverEnv.cloudLessonModelForSkill(name) ?? meta.model;
  if (!model) throw new CloudLessonSkillError(`Skill "${name}" declares no model`);
  const vertex = model.match(VERTEX_MODEL);
  if (!vertex) {
    throw new CloudLessonSkillError(
      `Skill "${name}" uses model "${model}"; cloud lesson skills need a vertex/<model> slug`,
    );
  }

  const template = body.trim();
  if (template.length < 200) throw new CloudLessonSkillError(`Skill "${name}" has an empty or truncated prompt`);
  const placeholders = [...new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort();
  const malformed = template.match(/\{\{(?!\w+\}\})[^}]*\}?\}?/);
  if (malformed) {
    throw new CloudLessonSkillError(`Skill "${name}" has a malformed placeholder: ${malformed[0].slice(0, 40)}`);
  }

  return {
    name,
    model,
    vertexModel: vertex[1],
    temperature: numberSetting(meta, 'temperature', name, 0.3, 0, 2),
    thinkingBudget: numberSetting(meta, 'thinkingBudget', name, 1024, 0, 24576),
    maxOutputTokens: numberSetting(meta, 'maxOutputTokens', name, 4096, 256, 65536),
    template,
    placeholders,
  };
}

const cache = new Map<CloudLessonSkillName, Promise<CloudLessonSkill>>();

/**
 * One cloud lesson specialist by name. Cached per process: the files are read
 * once by a long-running worker, not on every lesson.
 */
export function loadCloudLessonSkill(name: CloudLessonSkillName): Promise<CloudLessonSkill> {
  if (!(CLOUD_LESSON_SKILLS as readonly string[]).includes(name)) {
    return Promise.reject(new CloudLessonSkillError(`Unknown cloud lesson skill "${name}"`));
  }
  let loading = cache.get(name);
  if (!loading) {
    loading = readFile(path.join(SKILLS_DIR, `${name}.md`), 'utf8')
      .catch(() => {
        throw new CloudLessonSkillError(`Skill "${name}" not found in ${SKILLS_DIR}`);
      })
      .then((raw) => parseCloudLessonSkill(name, raw));
    // A failed load must not be cached forever: the next call retries.
    loading.catch(() => cache.delete(name));
    cache.set(name, loading);
  }
  return loading;
}

/** All six, for a startup check: a worker should refuse to start on a bad skill. */
export function loadAllCloudLessonSkills(): Promise<CloudLessonSkill[]> {
  return Promise.all(CLOUD_LESSON_SKILLS.map(loadCloudLessonSkill));
}

export type PromptValues = Record<string, string | number>;

/** Fills every `{{placeholder}}`. Throws if the skill needs a value it was not given. */
export function renderCloudLessonPrompt(skill: CloudLessonSkill, values: PromptValues): string {
  const missing = skill.placeholders.filter((key) => values[key] === undefined || values[key] === '');
  if (missing.length) {
    throw new CloudLessonSkillError(`Skill "${skill.name}" is missing prompt values: ${missing.join(', ')}`);
  }
  return skill.template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => String(values[key]));
}
