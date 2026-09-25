import 'server-only';

import { z } from 'zod';

import { serverEnv } from '@/lib/env';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function localServiceUrl(name: string, raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${name} must use a loopback HTTP address; connect to RunPod with an SSH tunnel.`);
  }
  return url;
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? raw.trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate);
}

export async function generateLocalStructured<T>(options: {
  stage: string;
  systemPrompt: string;
  userPrompt: string;
  schema: z.ZodType<T>;
  timeoutMs?: number;
  maxValidationAttempts?: number;
}): Promise<T> {
  const baseUrl = localServiceUrl('LOCAL_VIDEO_AGENT_URL', serverEnv.localVideoAgentUrl);
  const jsonSchema = z.toJSONSchema(options.schema as z.ZodType<unknown>, {
    io: 'input',
    unrepresentable: 'any',
  });
  const attempts = Math.max(1, Math.min(3, options.maxValidationAttempts ?? 2));
  let correction = '';
  let lastError: z.ZodError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(new URL('/structured', baseUrl), {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stage: options.stage,
        systemPrompt: options.systemPrompt,
        userPrompt: `${options.userPrompt}${correction}`,
        jsonSchema,
        maxNewTokens: options.stage === 'video-narration-duration-editor' ? 1_400 : 2_400,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });

    const body = await response.json().catch(() => null) as {
      output?: unknown;
      raw?: string;
      error?: string;
    } | null;
    if (!response.ok) {
      throw new Error(body?.error || `Local ${options.stage} service returned HTTP ${response.status}.`);
    }

    const output = body?.output ?? (body?.raw ? extractJson(body.raw) : undefined);
    if (output === undefined) throw new Error(`Local ${options.stage} returned no structured output.`);
    const parsed = options.schema.safeParse(output);
    if (parsed.success) return parsed.data;
    lastError = parsed.error;
    correction = `\n\nYour previous JSON failed validation. Correct every listed problem and return the complete JSON again.\nValidation problems:\n${parsed.error.issues
      .slice(0, 12)
      .map((issue) => `- ${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('\n')}\nPrevious JSON:\n${JSON.stringify(output)}`;
  }

  throw lastError ?? new Error(`Local ${options.stage} output failed validation.`);
}

export async function synthesizeLocalSpeech(input: {
  transcript: string;
  languageCode: string;
  pace: 'natural' | 'brisk';
}): Promise<{ wave: Buffer; model: string; voice: string }> {
  const baseUrl = localServiceUrl('LOCAL_VIDEO_TTS_URL', serverEnv.localVideoTtsUrl);
  const response = await fetch(new URL('/synthesize', baseUrl), {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `Local narration service returned HTTP ${response.status}.`);
  }
  return {
    wave: Buffer.from(await response.arrayBuffer()),
    model: response.headers.get('x-lumina-model') || 'ai4bharat/indic-parler-tts',
    voice: response.headers.get('x-lumina-voice') || 'local-indic-educator',
  };
}

export async function translateLocalTexts(input: {
  texts: string[];
  languageCode: string;
}): Promise<string[]> {
  const baseUrl = localServiceUrl(
    'LOCAL_VIDEO_TRANSLATION_URL',
    serverEnv.localVideoTranslationUrl,
  );
  const response = await fetch(new URL('/translate', baseUrl), {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json().catch(() => null) as {
    translations?: unknown;
    error?: string;
  } | null;
  if (!response.ok) {
    throw new Error(body?.error || `Local translation service returned HTTP ${response.status}.`);
  }
  if (
    !Array.isArray(body?.translations)
    || body.translations.length !== input.texts.length
    || body.translations.some((text) => typeof text !== 'string' || !text.trim())
  ) {
    throw new Error('Local translation service returned an invalid translation batch.');
  }
  return body.translations as string[];
}
