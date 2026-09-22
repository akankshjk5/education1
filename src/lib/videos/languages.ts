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

export function videoLanguage(code: VideoLanguageCode) {
  const language = VIDEO_LANGUAGES.find((item) => item.code === code);
  if (!language) throw new Error(`Unsupported video language: ${code}`);
  return language;
}
