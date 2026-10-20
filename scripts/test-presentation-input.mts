import assert from 'node:assert/strict';

import {
  MAX_PRESENTATION_CHAPTER_LENGTH,
  MAX_PRESENTATION_TOPIC_LENGTH,
  PRESENTATION_SLIDE_COUNTS,
  presentationInputError,
  type PresentationInput,
} from '../src/lib/presentation/input.ts';

const valid: PresentationInput = {
  topic: 'Photosynthesis',
  chapter: 'Life processes',
  subject: 'Science',
  board: 'CBSE',
  language: 'en',
  gradeLevel: 8,
  slideCount: 10,
};

assert.equal(presentationInputError(valid), null);

for (const slideCount of PRESENTATION_SLIDE_COUNTS) {
  assert.equal(presentationInputError({ ...valid, slideCount }), null);
}

assert.equal(presentationInputError({ ...valid, topic: '' }), 'Topic is required.');
assert.equal(
  presentationInputError({ ...valid, topic: 'x'.repeat(MAX_PRESENTATION_TOPIC_LENGTH + 1) }),
  `Topic must be ${MAX_PRESENTATION_TOPIC_LENGTH} characters or fewer.`,
);
assert.equal(
  presentationInputError({ ...valid, chapter: 'x'.repeat(MAX_PRESENTATION_CHAPTER_LENGTH + 1) }),
  `Chapter must be ${MAX_PRESENTATION_CHAPTER_LENGTH} characters or fewer.`,
);
assert.equal(presentationInputError({ ...valid, subject: 'Unknown subject' }), 'Select a supported subject.');
assert.equal(presentationInputError({ ...valid, board: 'Unknown board' }), 'Select a valid board.');
assert.equal(presentationInputError({ ...valid, language: 'fr' }), 'Select a supported language.');
assert.equal(presentationInputError({ ...valid, gradeLevel: 0 }), 'Class must be between 1 and 10.');
assert.equal(presentationInputError({ ...valid, slideCount: 7 }), 'Select a supported slide count.');

console.log('Presentation input validation passed.');
