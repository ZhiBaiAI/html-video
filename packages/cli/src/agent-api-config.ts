import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ApiModelProvider = 'dashscope' | 'deepseek' | 'custom';

export interface ApiModelProfile {
  id: string;
  name: string;
  provider: ApiModelProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiModelProfileStatus extends Omit<ApiModelProfile, 'apiKey'> {
  configured: boolean;
  maskedKey: string;
  agentId: string;
}

interface AgentApiConfigFile {
  profiles?: ApiModelProfile[];
}

export const API_MODEL_PRESETS = {
  dashscope: {
    name: '阿里百炼 · 千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  deepseek: {
    name: 'DeepSeek API',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
  },
  custom: {
    name: '自定义兼容 API',
    baseUrl: '',
    model: '',
  },
} as const;

export const apiProfileAgentId = (profileId: string): string => `api-profile-${profileId}`;

export class AgentApiConfigStore {
  private readonly path: string;
  private readonly dir: string;

  constructor(projectRoot: string) {
    this.dir = join(projectRoot, '.html-video');
    this.path = join(this.dir, 'agent-api-config.json');
  }

  private read(): AgentApiConfigFile {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as AgentApiConfigFile;
    } catch {
      return {};
    }
  }

  private write(config: AgentApiConfigFile): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify(config, null, 2), { mode: 0o600 });
  }

  list(): ApiModelProfileStatus[] {
    return (this.read().profiles ?? []).map((profile) => ({
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      configured: !!profile.apiKey,
      maskedKey: maskSecret(profile.apiKey),
      agentId: apiProfileAgentId(profile.id),
    }));
  }

  resolveByAgentId(agentId: string): ApiModelProfile | null {
    const prefix = 'api-profile-';
    if (!agentId.startsWith(prefix)) return null;
    const id = agentId.slice(prefix.length);
    return (this.read().profiles ?? []).find((profile) => profile.id === id) ?? null;
  }

  upsert(input: {
    id?: string;
    name: string;
    provider: ApiModelProvider;
    baseUrl: string;
    model: string;
    apiKey?: string;
  }): ApiModelProfileStatus {
    const config = this.read();
    const profiles = [...(config.profiles ?? [])];
    const index = input.id ? profiles.findIndex((profile) => profile.id === input.id) : -1;
    const existing = index >= 0 ? profiles[index] : undefined;
    const name = input.name.trim();
    const model = input.model.trim();
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const apiKey = input.apiKey?.trim() || existing?.apiKey || '';
    if (!name) throw new Error('Configuration name is required.');
    if (!model) throw new Error('Model ID is required.');
    if (!baseUrl) throw new Error('Base URL is required.');
    if (!apiKey) throw new Error('API Key is required.');
    const now = new Date().toISOString();
    const profile: ApiModelProfile = {
      id: existing?.id ?? randomUUID(),
      name,
      provider: input.provider,
      baseUrl,
      model,
      apiKey,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (index >= 0) profiles[index] = profile;
    else profiles.push(profile);
    config.profiles = profiles;
    this.write(config);
    return this.list().find((item) => item.id === profile.id)!;
  }

  remove(id: string): void {
    const config = this.read();
    config.profiles = (config.profiles ?? []).filter((profile) => profile.id !== id);
    this.write(config);
  }
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  if (!normalized) return '';
  const url = new URL(normalized);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Base URL must use http or https.');
  return normalized;
}

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return `${value.slice(0, 2)}••••`;
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
