/**
 * Studio media-provider config — persists API credentials entered through the
 * Settings UI to `.html-video/media-config.json` under the project root, so
 * users don't have to set environment variables by hand.
 *
 * Credential precedence when resolving (config file wins over env, since the
 * GUI is the explicit user choice):
 *   media-config.json  →  OD_MINIMAX_API_KEY / MINIMAX_API_KEY env
 *
 * Mirrors open-design's `.od/media-config.json` shape loosely; we only need
 * MiniMax here. The file holds the raw key, so it lives in the gitignored
 * `.html-video/` runtime dir, never the repo.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveBailianCredentials,
  resolveMinimaxCredentials,
  type BailianCredentials,
  type BailianMinimaxTtsModel,
  type MinimaxCredentials,
} from '@html-video/core';

export type NarrationProvider = 'minimax' | 'bailian';

export interface NarrationConfig {
  provider: NarrationProvider;
  model: BailianMinimaxTtsModel;
}

export interface ClonedNarrationVoice {
  id: string;
  name: string;
  model: BailianMinimaxTtsModel;
  audioUrl: string;
  createdAt: string;
}

interface MediaConfig {
  minimax?: { apiKey?: string; baseUrl?: string };
  bailian?: { apiKey?: string; baseUrl?: string };
  narration?: {
    provider?: NarrationProvider;
    model?: BailianMinimaxTtsModel;
    clonedVoices?: ClonedNarrationVoice[];
    defaultVoiceId?: string;
  };
}

export class MediaConfigStore {
  private readonly path: string;
  private readonly dir: string;

  constructor(projectRoot: string) {
    this.dir = join(projectRoot, '.html-video');
    this.path = join(this.dir, 'media-config.json');
  }

  private read(): MediaConfig {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as MediaConfig;
    } catch {
      return {};
    }
  }

  private write(cfg: MediaConfig): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }

  /** What the Settings UI shows: whether a key is set + masked key + base URL.
   *  Never returns the raw key. Reports the source (config file vs env). */
  getMinimaxStatus(): { configured: boolean; source: 'config' | 'env' | 'none'; maskedKey: string; baseUrl: string } {
    const cfg = this.read().minimax;
    if (cfg?.apiKey) {
      return { configured: true, source: 'config', maskedKey: mask(cfg.apiKey), baseUrl: cfg.baseUrl ?? '' };
    }
    const env = resolveMinimaxCredentials();
    if (env) {
      return { configured: true, source: 'env', maskedKey: mask(env.apiKey), baseUrl: env.baseUrl };
    }
    return { configured: false, source: 'none', maskedKey: '', baseUrl: '' };
  }

  /** Persist a key (and optional base URL) entered in the UI. */
  setMinimax(apiKey: string, baseUrl?: string): void {
    const cfg = this.read();
    cfg.minimax = { apiKey: apiKey.trim() };
    const b = (baseUrl ?? '').trim();
    if (b) cfg.minimax.baseUrl = b;
    this.write(cfg);
  }

  /** Forget the stored MiniMax key (env fallback, if any, still applies). */
  clearMinimax(): void {
    const cfg = this.read();
    delete cfg.minimax;
    this.write(cfg);
  }

  /** Resolve usable credentials: config file first, then env. null if neither. */
  resolveMinimax(): MinimaxCredentials | null {
    const cfg = this.read().minimax;
    if (cfg?.apiKey) {
      // Default to the international endpoint when none is set. The old
      // api.minimaxi.chat host is RETIRED server-side (issue #4); MiniMax now
      // splits into api.minimax.io (international) and api.minimaxi.com (China),
      // and keys are region-bound — so the Settings UI asks the user to pick.
      const baseUrl = (cfg.baseUrl || '').trim().replace(/\/$/, '') || 'https://api.minimax.io/v1';
      return { apiKey: cfg.apiKey, baseUrl };
    }
    return resolveMinimaxCredentials();
  }

  getNarrationStatus(): NarrationConfig & {
    configured: boolean;
    source: 'config' | 'env' | 'none';
    maskedKey: string;
    baseUrl: string;
  } {
    const cfg = this.read();
    const provider = cfg.narration?.provider ?? 'minimax';
    const model = cfg.narration?.model ?? 'MiniMax/speech-02-turbo';
    if (provider === 'bailian') {
      const stored = cfg.bailian;
      if (stored?.apiKey) {
        return {
          provider,
          model,
          configured: true,
          source: 'config',
          maskedKey: mask(stored.apiKey),
          baseUrl: stored.baseUrl ?? 'https://dashscope.aliyuncs.com/api/v1',
        };
      }
      const env = resolveBailianCredentials();
      return {
        provider,
        model,
        configured: !!env,
        source: env ? 'env' : 'none',
        maskedKey: env ? mask(env.apiKey) : '',
        baseUrl: env?.baseUrl ?? 'https://dashscope.aliyuncs.com/api/v1',
      };
    }
    return { provider, model, ...this.getMinimaxStatus() };
  }

  setNarration(opts: {
    provider: NarrationProvider;
    model?: BailianMinimaxTtsModel;
    apiKey?: string;
    baseUrl?: string;
  }): void {
    const cfg = this.read();
    cfg.narration = {
      ...(cfg.narration ?? {}),
      provider: opts.provider,
      model: opts.model ?? 'MiniMax/speech-02-turbo',
    };
    const apiKey = (opts.apiKey ?? '').trim();
    const baseUrl = (opts.baseUrl ?? '').trim().replace(/\/$/, '');
    if (opts.provider === 'bailian' && apiKey) {
      cfg.bailian = { apiKey, ...(baseUrl ? { baseUrl } : {}) };
    } else if (opts.provider === 'minimax' && apiKey) {
      cfg.minimax = { apiKey, ...(baseUrl ? { baseUrl } : {}) };
    }
    this.write(cfg);
  }

  clearNarration(): void {
    const cfg = this.read();
    const provider = cfg.narration?.provider ?? 'minimax';
    if (provider === 'bailian') delete cfg.bailian;
    else delete cfg.minimax;
    if (cfg.narration?.clonedVoices?.length || cfg.narration?.defaultVoiceId) {
      delete cfg.narration.provider;
      delete cfg.narration.model;
    } else {
      delete cfg.narration;
    }
    this.write(cfg);
  }

  resolveNarration():
    | { provider: 'minimax'; creds: MinimaxCredentials }
    | { provider: 'bailian'; creds: BailianCredentials; model: BailianMinimaxTtsModel }
    | null {
    const cfg = this.read();
    const provider = cfg.narration?.provider ?? 'minimax';
    if (provider === 'bailian') {
      const stored = cfg.bailian;
      const creds = stored?.apiKey
        ? {
            apiKey: stored.apiKey,
            baseUrl: (stored.baseUrl || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/$/, ''),
          }
        : resolveBailianCredentials();
      return creds
        ? {
            provider,
            creds,
            model: cfg.narration?.model ?? 'MiniMax/speech-02-turbo',
          }
        : null;
    }
    const creds = this.resolveMinimax();
    return creds ? { provider, creds } : null;
  }

  resolveBailian(): BailianCredentials | null {
    const stored = this.read().bailian;
    if (stored?.apiKey) {
      return {
        apiKey: stored.apiKey,
        baseUrl: (stored.baseUrl || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/$/, ''),
      };
    }
    return resolveBailianCredentials();
  }

  listClonedVoices(): { voices: ClonedNarrationVoice[]; defaultVoiceId?: string } {
    const narration = this.read().narration;
    return {
      voices: [...(narration?.clonedVoices ?? [])],
      ...(narration?.defaultVoiceId ? { defaultVoiceId: narration.defaultVoiceId } : {}),
    };
  }

  getClonedVoice(voiceId: string): ClonedNarrationVoice | undefined {
    return this.read().narration?.clonedVoices?.find((voice) => voice.id === voiceId);
  }

  addClonedVoice(voice: ClonedNarrationVoice): void {
    const cfg = this.read();
    const narration = cfg.narration ?? {
      provider: 'bailian' as const,
      model: voice.model,
    };
    const voices = narration.clonedVoices ?? [];
    if (voices.some((item) => item.id === voice.id)) {
      throw new Error(`Voice ID already exists locally: ${voice.id}`);
    }
    narration.clonedVoices = [...voices, voice];
    narration.defaultVoiceId ??= voice.id;
    cfg.narration = narration;
    this.write(cfg);
  }

  updateClonedVoice(
    voiceId: string,
    opts: { name?: string; isDefault?: boolean },
  ): ClonedNarrationVoice {
    const cfg = this.read();
    const narration = cfg.narration;
    const voices = narration?.clonedVoices ?? [];
    const index = voices.findIndex((voice) => voice.id === voiceId);
    if (index < 0) throw new Error(`Cloned voice not found: ${voiceId}`);
    const current = voices[index]!;
    const name = (opts.name ?? '').trim();
    const updated = { ...current, ...(name ? { name } : {}) };
    voices[index] = updated;
    narration!.clonedVoices = voices;
    if (opts.isDefault) narration!.defaultVoiceId = voiceId;
    this.write(cfg);
    return updated;
  }

  removeClonedVoice(voiceId: string): void {
    const cfg = this.read();
    const narration = cfg.narration;
    if (!narration) return;
    narration.clonedVoices = (narration.clonedVoices ?? []).filter((voice) => voice.id !== voiceId);
    if (narration.defaultVoiceId === voiceId) {
      narration.defaultVoiceId = narration.clonedVoices[0]?.id;
    }
    this.write(cfg);
  }
}

function mask(key: string): string {
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}
