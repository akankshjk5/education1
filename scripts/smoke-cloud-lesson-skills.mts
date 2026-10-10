/**
 * Deterministic smoke test for the cloud lesson skills — no network, no cost.
 *
 *   npm run smoke:cloud-skills
 *
 * Checks that every skill in Agents/Skills/cloud-lesson/ loads, names a
 * vertex/ model, renders with no placeholder left over, honours its env
 * override, refuses bad files — and that the deck pipeline's own skill loader
 * still sees exactly the deck specialists and none of these.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { listSkills } from '../Agents/skill-loader.ts';
import {
  CLOUD_LESSON_SKILLS,
  CloudLessonSkillError,
  loadAllCloudLessonSkills,
  parseCloudLessonSkill,
  renderCloudLessonPrompt,
} from '../src/lib/cloud-lesson/skills.ts';

const values = {
  durationSeconds: 60,
  classLevel: 7,
  subject: 'Science',
  topic: 'How plants make food',
  sceneCount: 8,
  sceneSeconds: 7.5,
  languageName: 'Kannada',
  direction: 'too long',
  targetWords: 11,
};

// 1. Every skill loads and renders cleanly.
const skills = await loadAllCloudLessonSkills();
assert.equal(skills.length, CLOUD_LESSON_SKILLS.length);
console.log(`cloud lesson skills: ${skills.length}`);
for (const skill of skills) {
  assert.match(skill.model, /^vertex\/gemini-/, `${skill.name} model`);
  const prompt = renderCloudLessonPrompt(skill, values);
  assert.ok(!/\{\{\w+\}\}/.test(prompt), `${skill.name} left a placeholder unfilled`);
  assert.ok(prompt.includes('[OUTPUT]'), `${skill.name} has no [OUTPUT] section`);
  console.log(
    `  ${skill.name.padEnd(30)} ${skill.vertexModel.padEnd(22)} temp ${skill.temperature}  `
    + `thinking ${String(skill.thinkingBudget).padStart(4)}  out ${skill.maxOutputTokens}  `
    + `${prompt.length} chars  {{${skill.placeholders.join(', ')}}}`,
  );
}

// 2. A missing value is an error, not a prompt that says "Class {{classLevel}}".
const writer = skills.find((skill) => skill.name === 'cloud-lesson-writer')!;
assert.throws(
  () => renderCloudLessonPrompt(writer, { ...values, classLevel: '' }),
  (error: unknown) => error instanceof CloudLessonSkillError && /classLevel/.test(error.message),
);

// 3. The env override wins, and must still be a vertex/ model.
const translatorFile = await readFile(
  path.join(process.cwd(), 'Agents', 'Skills', 'cloud-lesson', 'cloud-lesson-translator.md'),
  'utf8',
);
process.env.CLOUD_LESSON_MODEL_CLOUD_LESSON_TRANSLATOR = 'vertex/gemini-2.5-pro';
assert.equal(parseCloudLessonSkill('cloud-lesson-translator', translatorFile).vertexModel, 'gemini-2.5-pro');
process.env.CLOUD_LESSON_MODEL_CLOUD_LESSON_TRANSLATOR = 'google/gemini-2.5-pro';
assert.throws(() => parseCloudLessonSkill('cloud-lesson-translator', translatorFile), CloudLessonSkillError);
delete process.env.CLOUD_LESSON_MODEL_CLOUD_LESSON_TRANSLATOR;

// 4. Bad files are refused.
const withKey = translatorFile.replace('temperature:', 'tools: yes\ntemperature:');
assert.throws(() => parseCloudLessonSkill('cloud-lesson-translator', withKey), /unknown frontmatter key/);
const withTools = `${translatorFile}\n[TOOLS]\n\`\`\`json\n[]\n\`\`\`\n`;
assert.throws(() => parseCloudLessonSkill('cloud-lesson-translator', withTools), /\[TOOLS\]/);
assert.throws(() => parseCloudLessonSkill('cloud-lesson-translator', 'no frontmatter'), /frontmatter/);
const hot = translatorFile.replace('temperature: 0.2', 'temperature: 9');
assert.throws(() => parseCloudLessonSkill('cloud-lesson-translator', hot), /temperature/);

// 5. The deck pipeline is untouched: its loader sees none of these files.
const deckSkills = await listSkills();
assert.ok(deckSkills.every((skill) => !skill.name.startsWith('cloud-lesson')), 'deck loader saw a cloud skill');
console.log(`deck skills unchanged: ${deckSkills.length} (${deckSkills.map((s) => s.name).join(', ')})`);

console.log('cloud lesson skills: all checks passed');
