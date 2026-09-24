import 'server-only';

import { GoogleGenAI, Modality } from '@google/genai';

import { serverEnv } from '@/lib/env';
import { videoLanguage, type VideoLanguageCode } from '@/lib/videos/languages';

function pcmToWave(pcm: Buffer, sampleRate = 24_000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
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
  const language = videoLanguage(languageCode);
  const voice = process.env.GEMINI_TTS_VOICE?.trim() || 'Kore';
  const model = process.env.GEMINI_TTS_MODEL?.trim() || 'gemini-2.5-flash-preview-tts';
  const vertexKey = process.env.GOOGLE_VERTEX_API_KEY?.trim();
  const geminiKey = process.env.GENAI_API_KEY?.trim();
  const apiKey = vertexKey || geminiKey;
  if (!apiKey) {
    throw new Error('Narration is not configured. Set GOOGLE_VERTEX_API_KEY or GENAI_API_KEY.');
  }

  const client = vertexKey
    ? new GoogleGenAI({
        vertexai: true,
        apiKey,
        project: serverEnv.googleCloudProject,
        location: serverEnv.googleCloudLocation,
      })
    : new GoogleGenAI({ apiKey });

  const response = await client.models.generateContent({
    model,
    contents: `Synthesize speech only. Do not read these directions aloud. Use a warm, clear, knowledgeable Indian educator voice. Speak only in ${language.promptName}, using accurate pronunciation. Use a ${pace === 'brisk' ? 'brisk but clearly understandable' : 'steady, natural'} pace suitable for classroom learning. Do not add, translate, summarize, repeat, or omit any words.\n\nTRANSCRIPT BEGINS:\n${transcript}\nTRANSCRIPT ENDS.`,
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        languageCode,
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
      },
    },
  });

  if (!response.data) throw new Error('Narration model returned no audio.');
  const pcm = Buffer.from(response.data, 'base64');
  if (pcm.length < 48_000) throw new Error('Narration audio was unexpectedly short.');

  return {
    wave: pcmToWave(pcm),
    durationSeconds: Number((pcm.length / (24_000 * 2)).toFixed(3)),
    model,
    voice,
  };
}
