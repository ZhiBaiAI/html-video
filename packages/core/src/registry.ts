/**
 * Registries for engine adapters, templates, and projects.
 * RFC-05: Storyboard removed; Project takes its place.
 */

import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  EngineAdapter,
  EngineId,
  Project,
  TemplateMetadata,
} from './types/index.js';
import { HtmlVideoError } from './errors.js';

// ---------------------------------------------------------------------------
// EngineRegistry
// ---------------------------------------------------------------------------

export class EngineRegistry {
  private adapters = new Map<EngineId, EngineAdapter>();

  register(adapter: EngineAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: EngineId): EngineAdapter {
    const a = this.adapters.get(id);
    if (!a) {
      throw new HtmlVideoError(
        'engine-not-registered',
        `Engine "${id}" is not registered. Did you forget to install @html-video/adapter-${id}?`,
      );
    }
    return a;
  }

  list(): EngineAdapter[] {
    return [...this.adapters.values()];
  }

  has(id: EngineId): boolean {
    return this.adapters.has(id);
  }
}

// ---------------------------------------------------------------------------
// TemplateRegistry
// ---------------------------------------------------------------------------

export class TemplateRegistry {
  private templates = new Map<string, TemplateMetadata>();

  async scan(rootDir: string): Promise<TemplateMetadata[]> {
    if (!existsSync(rootDir)) return [];
    this.templates.clear();
    const entries = await readdir(rootDir, { withFileTypes: true });
    const found: TemplateMetadata[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(rootDir, entry.name);
      const yamlPath = join(dir, 'template.html-video.yaml');
      if (!existsSync(yamlPath)) continue;
      const raw = await readFile(yamlPath, 'utf8');
      const meta = parseYaml(raw) as TemplateMetadata;
      const errors = validateTemplateMetadata(meta, dir, entry.name);
      if (errors.length > 0) {
        throw new HtmlVideoError(
          'template-invalid',
          `Template metadata invalid at ${yamlPath}: ${errors.join('; ')}`,
        );
      }
      if (seen.has(meta.id)) {
        throw new HtmlVideoError('template-invalid', `Duplicate template id "${meta.id}"`);
      }
      seen.add(meta.id);
      meta.__dir = dir;
      this.templates.set(meta.id, meta);
      found.push(meta);
    }
    return found;
  }

  get(id: string): TemplateMetadata {
    const t = this.templates.get(id);
    if (!t) {
      throw new HtmlVideoError('template-not-found', `Template "${id}" not found`);
    }
    return t;
  }

  has(id: string): boolean {
    return this.templates.has(id);
  }

  list(): TemplateMetadata[] {
    return [...this.templates.values()];
  }

  search(opts: {
    intent?: string;
    aspect?: string;
    licenseAllow?: string[];
    enginesAvailable?: EngineId[];
    top?: number;
  }): { template: TemplateMetadata; score: number; reason: string }[] {
    const top = opts.top ?? 5;
    const intentTokens = expandIntentTokens(opts.intent ?? '');

    const ranked: { template: TemplateMetadata; score: number; reason: string }[] = [];

    for (const t of this.templates.values()) {
      const reasonParts: string[] = [];
      let score = 0;

      if (intentTokens.length > 0) {
        const weightedFields: Array<[string, number]> = [
          [[...t.tags, t.category, t.subcategory ?? ''].join(' '), 0.26],
          [t.best_for.join(' '), 0.3],
          [[t.name, t.name_zh ?? ''].join(' '), 0.18],
          [[t.description, t.description_zh ?? '', t.description_en ?? ''].join(' '), 0.18],
          [t.engine, 0.08],
        ];
        const matched = new Set<string>();
        for (const token of intentTokens) {
          for (const [field, weight] of weightedFields) {
            if (normaliseSearchText(field).includes(token)) {
              score += weight;
              matched.add(token);
              break;
            }
          }
        }
        if (matched.size > 0) {
          reasonParts.push(`matched ${matched.size} intent signals`);
        }

        // Intent-level nudges for common video requests where exact tokens
        // often won't appear in manifest prose.
        const intent = normaliseSearchText(opts.intent ?? '');
        if (/\b(star|stars|github|repo|metric|metrics|kpi|chart|data|growth)\b/.test(intent)) {
          if (t.category === 'data-viz') {
            score += 0.25;
            reasonParts.push('data intent boost');
          }
          if (t.tags.some((tag) => /data|chart|metric|graph|kpi/i.test(tag))) {
            score += 0.1;
          }
        }
        if (/\b(product|launch|promo|marketing|saas|demo)\b/.test(intent) && /product|marketing|promo/.test(t.category)) {
          score += 0.18;
          reasonParts.push('product intent boost');
        }
      }

      if (opts.aspect) {
        if (t.output.resolution.supported_aspects.includes(opts.aspect)) {
          score += 0.15;
          reasonParts.push(`aspect ${opts.aspect} supported`);
        } else {
          score -= 0.1;
        }
      }

      if (opts.licenseAllow && !opts.licenseAllow.includes(t.license.spdx)) {
        continue;
      }
      reasonParts.push(`license ${t.license.spdx} ok`);

      if (opts.enginesAvailable && !opts.enginesAvailable.includes(t.engine)) {
        continue;
      }

      score = Math.max(0, Math.min(1, score));

      ranked.push({
        template: t,
        score,
        reason: reasonParts.join('; '),
      });
    }

    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, top);
  }
}

function validateTemplateMetadata(meta: TemplateMetadata, dir: string, dirname: string): string[] {
  const errors: string[] = [];
  const reqString = (key: keyof TemplateMetadata) => {
    if (typeof meta[key] !== 'string' || String(meta[key]).trim() === '') {
      errors.push(`${String(key)} must be a non-empty string`);
    }
  };
  if (meta.spec_version !== 1) errors.push('spec_version must be 1');
  reqString('id');
  reqString('name');
  reqString('description');
  reqString('engine');
  reqString('engine_version');
  reqString('source_entry');
  reqString('category');
  reqString('version');
  if (meta.id && meta.id !== dirname) {
    errors.push(`id "${meta.id}" must match directory "${dirname}"`);
  }
  if (!Array.isArray(meta.tags)) errors.push('tags must be an array');
  if (!Array.isArray(meta.best_for) || meta.best_for.length === 0) {
    errors.push('best_for must be a non-empty array');
  }
  if (!meta.output?.formats?.length) errors.push('output.formats must be a non-empty array');
  if (!meta.output?.default_format) errors.push('output.default_format is required');
  if (!meta.output?.resolution?.default?.width || !meta.output?.resolution?.default?.height) {
    errors.push('output.resolution.default width/height are required');
  }
  if (!Array.isArray(meta.output?.resolution?.supported_aspects)) {
    errors.push('output.resolution.supported_aspects must be an array');
  }
  if (!meta.inputs?.schema || typeof meta.inputs.schema !== 'object') {
    errors.push('inputs.schema is required');
  }
  if (!Array.isArray(meta.inputs?.examples)) errors.push('inputs.examples must be an array');
  if (!meta.license?.spdx) errors.push('license.spdx is required');
  if (!meta.author?.name) errors.push('author.name is required');
  if (!meta.preview?.poster) errors.push('preview.poster is required');
  if (meta.source_entry && !existsSync(join(dir, meta.source_entry))) {
    errors.push(`source_entry not found: ${meta.source_entry}`);
  }
  if (meta.native && !meta.native.compositionId) {
    errors.push('native.compositionId is required when native is set');
  }
  return errors;
}

function normaliseSearchText(text: string): string {
  return text.toLowerCase().replace(/[×·・]/g, ' ').replace(/[_-]/g, ' ');
}

function expandIntentTokens(intent: string): string[] {
  const base = normaliseSearchText(intent)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((s) => s.length > 1);
  const synonyms: Record<string, string[]> = {
    github: ['repo', 'repository', 'open source', 'stars'],
    repo: ['github', 'repository', 'open source'],
    stars: ['star', 'github', 'metric', 'data', 'chart'],
    star: ['stars', 'github', 'metric', 'data', 'chart'],
    metric: ['metrics', 'kpi', 'data', 'chart'],
    metrics: ['metric', 'kpi', 'data', 'chart'],
    growth: ['data', 'chart', 'metric'],
    kpi: ['metric', 'data', 'chart'],
    graph: ['chart', 'data'],
    chart: ['graph', 'data'],
    数据: ['data', 'chart', 'metric'],
    图表: ['chart', 'graph', 'data'],
    指标: ['metric', 'kpi', 'data'],
    增长: ['growth', 'data', 'chart'],
  };
  const out = new Set(base);
  for (const token of base) {
    for (const s of synonyms[token] ?? []) {
      for (const part of normaliseSearchText(s).split(/\s+/).filter(Boolean)) out.add(part);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// ProjectStore — JSON-on-disk persistence
// ---------------------------------------------------------------------------

export class ProjectStore {
  constructor(private projectRoot: string) {}

  private dir(): string {
    return join(this.projectRoot, '.html-video', 'projects');
  }

  private projectDir(id: string): string {
    return join(this.dir(), id);
  }

  private path(id: string): string {
    return join(this.projectDir(id), 'project.json');
  }

  /** Ensure project directory exists; returns its absolute path. */
  async ensureDir(id: string): Promise<string> {
    const dir = this.projectDir(id);
    await mkdir(join(dir, 'assets'), { recursive: true });
    return dir;
  }

  async save(project: Project): Promise<void> {
    await this.ensureDir(project.id);
    project.updatedAt = new Date().toISOString();
    await writeFile(this.path(project.id), JSON.stringify(project, null, 2), 'utf8');
  }

  async load(id: string): Promise<Project> {
    const p = this.path(id);
    if (!existsSync(p)) {
      throw new HtmlVideoError('project-not-found', `Project ${id} not found`);
    }
    return JSON.parse(await readFile(p, 'utf8')) as Project;
  }

  async list(): Promise<Project[]> {
    const d = this.dir();
    if (!existsSync(d)) return [];
    const ids = await readdir(d);
    const out: Project[] = [];
    for (const id of ids) {
      try {
        out.push(await this.load(id));
      } catch {
        // skip corrupt
      }
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out;
  }

  async remove(id: string): Promise<void> {
    const dir = this.projectDir(id);
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
