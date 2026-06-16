/**
 * @html-video/core — MiniMax audio provider.
 *
 * MiniMax exposes speech (`/t2a_v2`) under a region-bound host and returns the
 * audio in a `base_resp` envelope as a hex string in `data.audio`.
 *
 * The request/parse pattern is ported from open-design's `renderMinimaxTTS`
 * (apps/daemon/src/media.ts): fetch → Bearer → check `base_resp.status_code`
 * (an HTTP 200 can still be a logical failure) → `Buffer.from(hex, 'hex')`.
 *
 * Credentials are read from the environment so the studio works without any
 * config file; a missing key yields `null` from {@link resolveMinimaxCredentials}
 * and callers report it gracefully instead of throwing.
 */

import { HtmlVideoError } from './errors.js';

/** Default base URL. The old `api.minimaxi.chat` host is RETIRED server-side
 *  (issue #4). MiniMax now has two region-bound endpoints — international
 *  `api.minimax.io` and China `api.minimaxi.com` — and a key only authenticates
 *  against its own region. We default to international; override via
 *  OD_MINIMAX_BASE_URL / MINIMAX_BASE_URL (or the Studio Settings UI). */
const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimax.io/v1';

/** Hard ceiling for a single MiniMax request. */
const MINIMAX_REQUEST_TIMEOUT_MS = 120_000;
/** Fast turbo speech tier (same default open-design ships). */
const MINIMAX_TTS_MODEL = 'speech-02-turbo';

export interface MinimaxCredentials {
  apiKey: string;
  baseUrl: string;
}

export interface MinimaxAudioResult {
  /** Decoded audio bytes (MP3). */
  bytes: Buffer;
  /** File extension to store under. */
  ext: '.mp3';
  /** Human-readable note of what was produced (provider · model · size). */
  providerNote: string;
  /** Reported duration in seconds, if the API surfaced it. */
  durationSec?: number;
}

/**
 * Resolve MiniMax credentials from the environment. Returns `null` (not throw)
 * when no key is set, so the studio can show a friendly "configure your key"
 * message instead of a 500.
 *
 * Key precedence:  OD_MINIMAX_API_KEY → MINIMAX_API_KEY
 * Base precedence: OD_MINIMAX_BASE_URL → MINIMAX_BASE_URL → default
 */
export function resolveMinimaxCredentials(
  env: NodeJS.ProcessEnv = process.env,
): MinimaxCredentials | null {
  const apiKey = (env.OD_MINIMAX_API_KEY || env.MINIMAX_API_KEY || '').trim();
  if (!apiKey) return null;
  const baseUrl = (env.OD_MINIMAX_BASE_URL || env.MINIMAX_BASE_URL || MINIMAX_DEFAULT_BASE_URL)
    .trim()
    .replace(/\/$/, '');
  return { apiKey, baseUrl };
}

/**
 * Shared POST + decode for MiniMax audio endpoints. Throws
 * HtmlVideoError('render-failed', …) on transport / API / decode failure.
 */
async function postAndDecode(
  endpoint: string,
  body: unknown,
  creds: MinimaxCredentials,
  label: string,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; extraInfo: Record<string, unknown> }> {
  // MiniMax generation can take tens of seconds, but it must NOT
  // hang forever — an unbounded fetch leaves the studio's SSE stream stuck on
  // "generating…" with no failure event, which reads to the user as "the button
  // does nothing". Cap it; if the caller passed its own signal, respect that.
  const timeoutSignal = AbortSignal.timeout(MINIMAX_REQUEST_TIMEOUT_MS);
  const effectiveSignal = signal
    ? (AbortSignal.any ? AbortSignal.any([signal, timeoutSignal]) : signal)
    : timeoutSignal;
  let resp: Response;
  try {
    resp = await fetch(`${creds.baseUrl}/${endpoint}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${creds.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: effectiveSignal,
    });
  } catch (e) {
    const isTimeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    const msg = e instanceof Error ? e.message : String(e);
    throw new HtmlVideoError(
      'render-failed',
      isTimeout
        ? `minimax ${label} timed out after ${Math.round(MINIMAX_REQUEST_TIMEOUT_MS / 1000)}s (the API did not respond — try again, or check OD_MINIMAX_BASE_URL)`
        : `minimax ${label} request failed: ${msg} (check the API region — international is api.minimax.io, China is api.minimaxi.com; a key only works against its own region)`,
      true,
    );
  }

  const respText = await resp.text();
  if (!resp.ok) {
    throw new HtmlVideoError(
      'render-failed',
      `minimax ${label} ${resp.status}: ${truncate(respText, 240)}`,
      resp.status >= 500,
    );
  }

  let data: {
    base_resp?: { status_code?: number; status_msg?: string };
    data?: { audio?: unknown };
    extra_info?: Record<string, unknown>;
  };
  try {
    data = JSON.parse(respText);
  } catch {
    throw new HtmlVideoError('render-failed', `minimax ${label} non-JSON: ${truncate(respText, 200)}`);
  }

  // MiniMax wraps every response in base_resp; an HTTP 200 can still be a
  // logical failure (auth / params), surfaced via a non-zero status_code.
  if (data.base_resp && data.base_resp.status_code !== 0) {
    const code = data.base_resp.status_code;
    const hint = code === 1004 || code === 1008 ? ' (auth / insufficient balance — check the API key)' : '';
    throw new HtmlVideoError(
      'render-failed',
      `minimax ${label} api error ${code}: ${data.base_resp.status_msg || 'unknown'}${hint}`,
    );
  }

  const hex = data.data?.audio;
  if (typeof hex !== 'string' || !hex) {
    throw new HtmlVideoError('render-failed', `minimax ${label} response missing data.audio`);
  }
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length === 0) {
    throw new HtmlVideoError('render-failed', `minimax ${label} decoded zero bytes`);
  }
  return { bytes, extraInfo: data.extra_info ?? {} };
}

/**
 * Generate spoken narration via MiniMax TTS (`/t2a_v2`).
 * Defaults to a neutral Mandarin male voice that reads both zh + en well.
 */
export async function generateTts(opts: {
  text: string;
  voiceId?: string;
  languageBoost?: string;
  speed?: number;
  vol?: number;
  pitch?: number;
  creds: MinimaxCredentials;
  signal?: AbortSignal;
}): Promise<MinimaxAudioResult> {
  const text = (opts.text || '').trim();
  if (!text) {
    throw new HtmlVideoError('invalid-input', 'narration text is empty');
  }
  const voiceId = (opts.voiceId || '').trim() || 'male-qn-qingse';
  const languageBoost = (opts.languageBoost || '').trim();

  const body = {
    model: MINIMAX_TTS_MODEL,
    text,
    stream: false,
    ...(languageBoost ? { language_boost: languageBoost } : {}),
    voice_setting: {
      voice_id: voiceId,
      speed: opts.speed ?? 1.0,
      vol: opts.vol ?? 1.0,
      pitch: opts.pitch ?? 0,
    },
    audio_setting: { sample_rate: 32000, format: 'mp3' },
  };

  const { bytes, extraInfo } = await postAndDecode('t2a_v2', body, opts.creds, 'tts', opts.signal);
  const audioLen = typeof extraInfo.audio_length === 'number' ? extraInfo.audio_length : undefined;
  const durationSec = audioLen ? Math.round(audioLen / 100) / 10 : undefined;
  return {
    bytes,
    ext: '.mp3',
    providerNote: `minimax/${MINIMAX_TTS_MODEL} · ${voiceId} · ${durationSec ?? '?'}s · ${bytes.length} bytes`,
    durationSec,
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
