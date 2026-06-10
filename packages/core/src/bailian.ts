/** Alibaba Cloud Model Studio (Bailian) MiniMax TTS provider. */

import { HtmlVideoError } from './errors.js';
import type { MinimaxAudioResult } from './minimax.js';

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';
const TTS_PATH = '/services/aigc/multimodal-generation/generation';
const REQUEST_TIMEOUT_MS = 120_000;

export const BAILIAN_MINIMAX_TTS_MODELS = [
  'MiniMax/speech-02-turbo',
  'MiniMax/speech-02-hd',
  'MiniMax/speech-2.8-turbo',
  'MiniMax/speech-2.8-hd',
] as const;

export type BailianMinimaxTtsModel = (typeof BAILIAN_MINIMAX_TTS_MODELS)[number];

export interface BailianCredentials {
  apiKey: string;
  baseUrl: string;
}

export interface BailianVoiceCloneResult {
  voiceId: string;
  model: BailianMinimaxTtsModel;
  previewBytes?: Buffer;
  previewExt?: '.mp3';
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
  model?: BailianMinimaxTtsModel;
  speed?: number;
  vol?: number;
  pitch?: number;
  emotion?: string;
  creds: BailianCredentials;
  signal?: AbortSignal;
}): Promise<MinimaxAudioResult> {
  const text = (opts.text || '').trim();
  if (!text) throw new HtmlVideoError('invalid-input', 'narration text is empty');

  const model = opts.model ?? 'MiniMax/speech-02-turbo';
  if (!BAILIAN_MINIMAX_TTS_MODELS.includes(model)) {
    throw new HtmlVideoError('invalid-input', `unsupported Bailian MiniMax TTS model: ${model}`);
  }
  const voiceId = (opts.voiceId || '').trim() || 'male-qn-qingse';
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
        input: {
          text,
          voice_setting: {
            voice_id: voiceId,
            speed: opts.speed ?? 1,
            vol: opts.vol ?? 1,
            pitch: opts.pitch ?? 0,
            ...(opts.emotion ? { emotion: opts.emotion } : {}),
          },
          audio_setting: {
            sample_rate: 32000,
            bitrate: 128000,
            format: 'mp3',
            channel: 1,
          },
        },
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
        ? `Bailian MiniMax TTS timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : `Bailian MiniMax TTS request failed: ${message}`,
      true,
    );
  }

  const responseText = await response.text();
  if (!response.ok) {
    throw new HtmlVideoError(
      'render-failed',
      `Bailian MiniMax TTS ${response.status}: ${truncate(responseText, 300)}`,
      response.status >= 500,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new HtmlVideoError('render-failed', 'Bailian MiniMax TTS returned non-JSON data');
  }

  const code = findString(payload, [['code'], ['output', 'code']]);
  if (code && code !== 'Success') {
    const message = findString(payload, [['message'], ['output', 'message'], ['error', 'message']]);
    throw new HtmlVideoError('render-failed', `Bailian MiniMax TTS ${code}: ${message || 'request failed'}`);
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
      `Bailian MiniMax TTS response missing audio: ${truncate(responseText, 300)}`,
    );
  }

  if (bytes.length === 0) {
    throw new HtmlVideoError('render-failed', 'Bailian MiniMax TTS returned zero audio bytes');
  }
  return {
    bytes,
    ext: '.mp3',
    providerNote: `bailian/${model} / ${voiceId} / ${bytes.length} bytes`,
  };
}

export async function cloneBailianMinimaxVoice(opts: {
  voiceId: string;
  audioUrl: string;
  previewText: string;
  model?: BailianMinimaxTtsModel;
  creds: BailianCredentials;
  signal?: AbortSignal;
}): Promise<BailianVoiceCloneResult> {
  const voiceId = (opts.voiceId || '').trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(voiceId)) {
    throw new HtmlVideoError(
      'invalid-input',
      'voice id must be 4-64 characters using letters, numbers, hyphens, or underscores',
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
  const previewText = (opts.previewText || '').trim();
  if (!previewText) {
    throw new HtmlVideoError('invalid-input', 'voice clone preview text is empty');
  }
  const model = opts.model ?? 'MiniMax/speech-2.8-turbo';
  if (!BAILIAN_MINIMAX_TTS_MODELS.includes(model)) {
    throw new HtmlVideoError('invalid-input', `unsupported Bailian MiniMax TTS model: ${model}`);
  }

  const payload = await postJson({
    creds: opts.creds,
    signal: opts.signal,
    label: 'voice clone',
    body: {
      model,
      input: {
        action: 'voice_clone',
        voice_id: voiceId,
        audio_url: audioUrl,
        text: previewText,
      },
    },
  });

  const audioData = findString(payload, [
    ['output', 'audio'],
    ['output', 'audio', 'data'],
    ['output', 'data', 'audio'],
    ['data', 'audio'],
    ['audio', 'data'],
  ]);

  return {
    voiceId,
    model,
    ...(audioData ? { previewBytes: decodeAudioData(audioData), previewExt: '.mp3' as const } : {}),
  };
}

async function postJson(opts: {
  creds: BailianCredentials;
  body: unknown;
  label: string;
  signal?: AbortSignal;
}): Promise<unknown> {
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
        ? `Bailian MiniMax ${opts.label} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : `Bailian MiniMax ${opts.label} request failed: ${message}`,
      true,
    );
  }

  const responseText = await response.text();
  if (!response.ok) {
    throw new HtmlVideoError(
      'render-failed',
      `Bailian MiniMax ${opts.label} ${response.status}: ${truncate(responseText, 300)}`,
      response.status >= 500,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new HtmlVideoError('render-failed', `Bailian MiniMax ${opts.label} returned non-JSON data`);
  }
  const code = findString(payload, [['code'], ['output', 'code']]);
  if (code && code !== 'Success') {
    const message = findString(payload, [['message'], ['output', 'message'], ['error', 'message']]);
    throw new HtmlVideoError(
      'render-failed',
      `Bailian MiniMax ${opts.label} ${code}: ${message || 'request failed'}`,
    );
  }
  return payload;
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
