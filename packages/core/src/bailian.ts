/** Alibaba Cloud Model Studio (Bailian) CosyVoice TTS provider. */

import { HtmlVideoError } from './errors.js';
import type { MinimaxAudioResult } from './minimax.js';

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
const TTS_PATH = '/services/audio/tts/SpeechSynthesizer';
const CUSTOMIZATION_PATH = '/services/audio/tts/customization';
const REQUEST_TIMEOUT_MS = 120_000;

export const BAILIAN_COSYVOICE_TTS_MODELS = [
  'cosyvoice-v3.5-plus',
  'cosyvoice-v3.5-flash',
  'cosyvoice-v3-plus',
  'cosyvoice-v3-flash',
  'cosyvoice-v2',
] as const;

export type BailianCosyVoiceTtsModel = (typeof BAILIAN_COSYVOICE_TTS_MODELS)[number];

export interface BailianCredentials {
  apiKey: string;
  baseUrl: string;
}

export interface BailianVoiceCloneResult {
  voiceId: string;
  model: BailianCosyVoiceTtsModel;
  requestId?: string;
}

export function resolveBailianCredentials(
  env: NodeJS.ProcessEnv = process.env,
): BailianCredentials | null {
  const apiKey = (env.DASHSCOPE_API_KEY || '').trim();
  if (!apiKey) return null;
  const baseUrl = (env.DASHSCOPE_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/$/, '');
  return { apiKey, baseUrl };
}

export async function generateBailianTts(opts: {
  text: string;
  voiceId?: string;
  model?: BailianCosyVoiceTtsModel;
  rate?: number;
  volume?: number;
  pitch?: number;
  instruction?: string;
  emotion?: string;
  scene?: string;
  creds: BailianCredentials;
  signal?: AbortSignal;
}): Promise<MinimaxAudioResult> {
  const text = (opts.text || '').trim();
  if (!text) throw new HtmlVideoError('invalid-input', 'narration text is empty');

  const model = opts.model ?? 'cosyvoice-v3-flash';
  if (!BAILIAN_COSYVOICE_TTS_MODELS.includes(model)) {
    throw new HtmlVideoError('invalid-input', `unsupported Bailian CosyVoice TTS model: ${model}`);
  }
  const voiceId = (opts.voiceId || '').trim() || 'longanyang';
  const input: Record<string, unknown> = {
    text,
    voice: voiceId,
    format: 'mp3',
    sample_rate: 24000,
  };
  if (opts.volume !== undefined) input.volume = clampInteger(opts.volume, 0, 100, 'volume');
  if (opts.rate !== undefined) input.rate = clampNumber(opts.rate, 0.5, 2, 'rate');
  if (opts.pitch !== undefined) input.pitch = clampNumber(opts.pitch, 0.5, 2, 'pitch');
  const instruction = buildCosyVoiceInstruction({
    instruction: opts.instruction,
    emotion: opts.emotion,
    scene: opts.scene,
  });
  if (instruction) input.instruction = instruction;

  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = opts.signal
    ? (AbortSignal.any ? AbortSignal.any([opts.signal, timeoutSignal]) : opts.signal)
    : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(`${opts.creds.baseUrl}${TTS_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.creds.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input,
      }),
      signal,
    });
  } catch (error) {
    const isTimeout = error instanceof Error
      && (error.name === 'TimeoutError' || error.name === 'AbortError');
    const message = error instanceof Error ? error.message : String(error);
    throw new HtmlVideoError(
      'render-failed',
      isTimeout
        ? `Bailian CosyVoice TTS timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : `Bailian CosyVoice TTS request failed: ${message}`,
      true,
    );
  }

  const responseText = await response.text();
  if (!response.ok) {
    throw new HtmlVideoError(
      'render-failed',
      `Bailian CosyVoice TTS ${response.status}: ${truncate(responseText, 300)}`,
      response.status >= 500,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new HtmlVideoError('render-failed', 'Bailian CosyVoice TTS returned non-JSON data');
  }

  const code = findString(payload, [['code'], ['output', 'code']]);
  if (code && code !== 'Success') {
    const message = findString(payload, [['message'], ['output', 'message'], ['error', 'message']]);
    throw new HtmlVideoError('render-failed', `Bailian CosyVoice TTS ${code}: ${message || 'request failed'}`);
  }

  const audioData = findString(payload, [
    ['output', 'audio'],
    ['output', 'audio', 'data'],
    ['output', 'data', 'audio'],
    ['data', 'audio'],
    ['audio', 'data'],
  ]);
  const audioUrl = findString(payload, [
    ['output', 'audio', 'url'],
    ['output', 'url'],
    ['data', 'audio_url'],
    ['audio', 'url'],
  ]);

  let bytes: Buffer;
  if (audioData) {
    bytes = decodeAudioData(audioData);
  } else if (audioUrl) {
    const audioResponse = await fetch(audioUrl, { signal });
    if (!audioResponse.ok) {
      throw new HtmlVideoError('render-failed', `Bailian audio download ${audioResponse.status}`);
    }
    bytes = Buffer.from(await audioResponse.arrayBuffer());
  } else {
    throw new HtmlVideoError(
      'render-failed',
      `Bailian CosyVoice TTS response missing audio: ${truncate(responseText, 300)}`,
    );
  }

  if (bytes.length === 0) {
    throw new HtmlVideoError('render-failed', 'Bailian CosyVoice TTS returned zero audio bytes');
  }
  return {
    bytes,
    ext: '.mp3',
    providerNote: `bailian/cosyvoice/${model} / ${voiceId} / ${bytes.length} bytes`,
  };
}

export async function cloneBailianCosyVoice(opts: {
  prefix: string;
  audioUrl: string;
  model?: BailianCosyVoiceTtsModel;
  languageHints?: string[];
  creds: BailianCredentials;
  signal?: AbortSignal;
}): Promise<BailianVoiceCloneResult> {
  const prefix = (opts.prefix || '').trim();
  if (!/^[A-Za-z0-9]{1,10}$/.test(prefix)) {
    throw new HtmlVideoError(
      'invalid-input',
      'voice prefix must be 1-10 characters using letters or numbers',
    );
  }
  const audioUrl = (opts.audioUrl || '').trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(audioUrl);
  } catch {
    throw new HtmlVideoError('invalid-input', 'voice clone audio URL is invalid');
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new HtmlVideoError('invalid-input', 'voice clone audio must use a public HTTP(S) URL');
  }
  const model = opts.model ?? 'cosyvoice-v3-flash';
  if (!BAILIAN_COSYVOICE_TTS_MODELS.includes(model)) {
    throw new HtmlVideoError('invalid-input', `unsupported Bailian CosyVoice TTS model: ${model}`);
  }
  const languageHints = sanitizeLanguageHints(opts.languageHints);

  const payload = await postJson({
    creds: opts.creds,
    signal: opts.signal,
    label: 'voice clone',
    path: CUSTOMIZATION_PATH,
    body: {
      model: 'voice-enrollment',
      input: {
        action: 'create_voice',
        target_model: model,
        prefix,
        url: audioUrl,
        ...(languageHints.length ? { language_hints: languageHints } : {}),
      },
    },
  });

  const voiceId = findString(payload, [
    ['output', 'voice_id'],
    ['output', 'voice'],
    ['data', 'voice_id'],
    ['voice_id'],
  ]);
  const requestId = findString(payload, [['request_id'], ['requestId']]);

  return {
    voiceId: voiceId ?? prefix,
    model,
    ...(requestId ? { requestId } : {}),
  };
}

async function postJson(opts: {
  creds: BailianCredentials;
  body: unknown;
  label: string;
  path?: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = opts.signal
    ? (AbortSignal.any ? AbortSignal.any([opts.signal, timeoutSignal]) : opts.signal)
    : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(`${opts.creds.baseUrl}${opts.path ?? TTS_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.creds.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(opts.body),
      signal,
    });
  } catch (error) {
    const isTimeout = error instanceof Error
      && (error.name === 'TimeoutError' || error.name === 'AbortError');
    const message = error instanceof Error ? error.message : String(error);
    throw new HtmlVideoError(
      'render-failed',
      isTimeout
        ? `Bailian CosyVoice ${opts.label} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : `Bailian CosyVoice ${opts.label} request failed: ${message}`,
      true,
    );
  }

  const responseText = await response.text();
  if (!response.ok) {
    throw new HtmlVideoError(
      'render-failed',
      `Bailian CosyVoice ${opts.label} ${response.status}: ${truncate(responseText, 300)}`,
      response.status >= 500,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new HtmlVideoError('render-failed', `Bailian CosyVoice ${opts.label} returned non-JSON data`);
  }
  const code = findString(payload, [['code'], ['output', 'code']]);
  if (code && code !== 'Success') {
    const message = findString(payload, [['message'], ['output', 'message'], ['error', 'message']]);
    throw new HtmlVideoError(
      'render-failed',
      `Bailian CosyVoice ${opts.label} ${code}: ${message || 'request failed'}`,
    );
  }
  return payload;
}

function buildCosyVoiceInstruction(opts: {
  instruction?: string;
  emotion?: string;
  scene?: string;
}): string | undefined {
  const instruction = (opts.instruction || '').trim();
  if (instruction) return instruction.slice(0, 100);
  const emotion = (opts.emotion || '').trim();
  const scene = (opts.scene || '').trim();
  if (scene && emotion) return `你正在进行${scene}，你说话的情感是${emotion}。`;
  if (emotion) return `你说话的情感是${emotion}。`;
  if (scene) return `你正在进行${scene}。`;
  return undefined;
}

function clampInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new HtmlVideoError('invalid-input', `${label} must be a finite number`);
  }
  return Math.round(Math.min(max, Math.max(min, value)));
}

function clampNumber(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new HtmlVideoError('invalid-input', `${label} must be a finite number`);
  }
  return Math.min(max, Math.max(min, value));
}

function sanitizeLanguageHints(value?: string[]): string[] {
  return (value ?? [])
    .map((item) => item.trim())
    .filter((item) => /^[a-z]{2}$/.test(item))
    .slice(0, 1);
}

function decodeAudioData(value: string): Buffer {
  const data = value.replace(/^data:audio\/[^;]+;base64,/, '').trim();
  if (/^[0-9a-f]+$/i.test(data) && data.length % 2 === 0) return Buffer.from(data, 'hex');
  return Buffer.from(data, 'base64');
}

function findString(value: unknown, paths: string[][]): string | undefined {
  for (const path of paths) {
    let current: unknown = value;
    for (const key of path) {
      if (!current || typeof current !== 'object') {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[key];
    }
    if (typeof current === 'string' && current) return current;
  }
  return undefined;
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}...` : value;
}
