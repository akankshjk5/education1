import 'server-only';

import { synthesizeLocalSpeech } from '@/lib/videos/local-ai';
import { videoLanguage, type VideoLanguageCode } from '@/lib/videos/languages';

function waveDurationSeconds(wave: Buffer): number {
  if (wave.length < 44 || wave.toString('ascii', 0, 4) !== 'RIFF' || wave.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Local narration service returned an invalid WAV file.');
  }
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= wave.length) {
    const id = wave.toString('ascii', offset, offset + 4);
    const size = wave.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (id === 'fmt ' && size >= 16 && payload + size <= wave.length) {
      byteRate = wave.readUInt32LE(payload + 8);
    } else if (id === 'data' && payload + size <= wave.length) {
      dataBytes = size;
      break;
    }
    offset = payload + size + (size % 2);
  }
  if (byteRate <= 0 || dataBytes <= 0) throw new Error('Local narration WAV has no playable PCM data.');
  return Number((dataBytes / byteRate).toFixed(3));
}

export interface NarrationAudio {
  wave: Buffer;
  durationSeconds: number;
  model: string;
  voice: string;
}

export async function synthesizeNarration(
  transcript: string,
  languageCode: VideoLanguageCode,
  pace: 'natural' | 'brisk' = 'natural',
): Promise<NarrationAudio> {
  videoLanguage(languageCode);
  const audio = await synthesizeLocalSpeech({ transcript, languageCode, pace });
  const durationSeconds = waveDurationSeconds(audio.wave);
  if (durationSeconds < 1) throw new Error('Local narration audio was unexpectedly short.');
  return { ...audio, durationSeconds };
}
