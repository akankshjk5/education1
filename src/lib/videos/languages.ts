export const VIDEO_LANGUAGES = [
  { code: 'en-IN', label: 'English (India)', promptName: 'Indian English' },
  { code: 'hi-IN', label: 'Hindi', promptName: 'Hindi' },
  { code: 'bn-IN', label: 'Bengali', promptName: 'Bengali' },
  { code: 'gu-IN', label: 'Gujarati', promptName: 'Gujarati' },
  { code: 'kn-IN', label: 'Kannada', promptName: 'Kannada' },
  { code: 'ml-IN', label: 'Malayalam', promptName: 'Malayalam' },
  { code: 'mr-IN', label: 'Marathi', promptName: 'Marathi' },
  { code: 'ta-IN', label: 'Tamil', promptName: 'Tamil' },
  { code: 'te-IN', label: 'Telugu', promptName: 'Telugu' },
] as const;

export type VideoLanguageCode = (typeof VIDEO_LANGUAGES)[number]['code'];

const INDIAN_SCRIPT_PATTERN = /[\u0900-\u0D7F]/u;
const LANGUAGE_SCRIPT_PATTERNS: Partial<Record<VideoLanguageCode, RegExp>> = {
  'hi-IN': /[\u0900-\u097F]/u,
  'bn-IN': /[\u0980-\u09FF]/u,
  'gu-IN': /[\u0A80-\u0AFF]/u,
  'kn-IN': /[\u0C80-\u0CFF]/u,
  'ml-IN': /[\u0D00-\u0D7F]/u,
  'mr-IN': /[\u0900-\u097F]/u,
  'ta-IN': /[\u0B80-\u0BFF]/u,
  'te-IN': /[\u0C00-\u0C7F]/u,
};

export function videoLanguage(code: VideoLanguageCode) {
  const language = VIDEO_LANGUAGES.find((item) => item.code === code);
  if (!language) throw new Error(`Unsupported video language: ${code}`);
  return language;
}

export function narrationUsesSelectedLanguage(
  text: string,
  code: VideoLanguageCode,
): boolean {
  if (code === 'en-IN') return !INDIAN_SCRIPT_PATTERN.test(text);
  const script = LANGUAGE_SCRIPT_PATTERNS[code];
  if (!script) return false;
  const letters = [...text].filter((character) => /\p{L}/u.test(character));
  if (letters.length === 0) return false;
  const nativeLetters = letters.filter((character) => script.test(character)).length;
  return nativeLetters >= Math.max(12, Math.floor(letters.length * 0.35));
}
