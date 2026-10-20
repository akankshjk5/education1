export const PRESENTATION_SUBJECTS = [
  'Mathematics',
  'Science',
  'Social Science',
  'English',
  'Hindi',
  'EVS',
  'Computer Science',
] as const;

export const PRESENTATION_LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'Hindi' },
] as const;

export const PRESENTATION_GRADES = Array.from({ length: 10 }, (_, index) => index + 1);
export const PRESENTATION_SLIDE_COUNTS = [6, 8, 10, 12, 15, 20] as const;
export const MAX_PRESENTATION_TOPIC_LENGTH = 300;
export const MAX_PRESENTATION_CHAPTER_LENGTH = 120;

export type PresentationInput = {
  topic: string;
  chapter: string;
  subject: string;
  board: string;
  language: string;
  gradeLevel: number;
  slideCount: number;
};

export function presentationInputError(input: PresentationInput): string | null {
  if (!input.topic) return 'Topic is required.';
  if (input.topic.length > MAX_PRESENTATION_TOPIC_LENGTH) {
    return `Topic must be ${MAX_PRESENTATION_TOPIC_LENGTH} characters or fewer.`;
  }
  if (input.chapter.length > MAX_PRESENTATION_CHAPTER_LENGTH) {
    return `Chapter must be ${MAX_PRESENTATION_CHAPTER_LENGTH} characters or fewer.`;
  }
  if (!PRESENTATION_SUBJECTS.some((subject) => subject === input.subject)) {
    return 'Select a supported subject.';
  }
  if (!isValidBoard(input.board)) return 'Select a valid board.';
  if (!PRESENTATION_LANGUAGES.some(({ value }) => value === input.language)) {
    return 'Select a supported language.';
  }
  if (!Number.isInteger(input.gradeLevel) || input.gradeLevel < 1 || input.gradeLevel > 10) {
    return 'Class must be between 1 and 10.';
  }
  if (!(PRESENTATION_SLIDE_COUNTS as readonly number[]).includes(input.slideCount)) {
    return 'Select a supported slide count.';
  }
  return null;
}
import { isValidBoard } from '@/lib/boards';
