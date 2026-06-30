import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { TemplateMetadata } from '@html-video/core';
import type { CliContext } from '../context.js';
import { fail, ok } from '../output.js';

const COVERAGE_RULES = {
  title_hero: /title|headline|hero|cover|poster|section-title/i,
  quote_statement: /quote|blockquote|statement|manifesto/i,
  list_steps: /list|ledger|agenda|steps?|items?|feature cards?/i,
  metric_kpi: /metric|kpi|stat(?:istic)?|number-counter|dashboard/i,
  bar_ranking: /bar(?:-chart)?|ranking|rollup|pstack|pixel stack/i,
  trend_line: /line-graph|line graph|trend|sparkline/i,
  process_timeline: /process|timeline|workflow|phase|steps?/i,
  comparison: /comparison|compare|contrast|before\s*\/\s*during\s*\/\s*after|versus/i,
  table_ledger: /table|ledger|financial grid|dense list/i,
  flow_decision: /flowchart|decision|branching|directional flow/i,
  network_system: /node-graph|node graph|system-diagram|service-map|network|dispatch/i,
  code_terminal: /code|terminal|vscode|workbench|developer-tool/i,
  product_media: /product-demo|product promo|showcase|<video\b|<img\b/i,
  intro_outro: /intro|outro|end-card|logo|closing|cover/i,
} as const;

type CoverageKey = keyof typeof COVERAGE_RULES;

export interface TemplateAuditItem {
  id: string;
  engine: string;
  motion: 'css' | 'gsap' | 'remotion' | 'raf' | 'none';
  capabilities: CoverageKey[];
  errors: string[];
  warnings: string[];
}

export interface TemplateAuditReport {
  template_count: number;
  error_count: number;
  warning_count: number;
  coverage: Record<CoverageKey, string[]>;
  templates: TemplateAuditItem[];
}

export async function auditTemplates(ctx: CliContext, opts: { strict?: boolean } = {}): Promise<void> {
  const report = await collectTemplateAudit(ctx.templates.list());
  if (opts.strict && report.error_count > 0) {
    fail('template-quality-failed', `${report.error_count} template quality errors`, { report });
  }
  ok({ report });
}

export async function collectTemplateAudit(templates: TemplateMetadata[]): Promise<TemplateAuditReport> {
  const items: TemplateAuditItem[] = [];
  const coverage = Object.fromEntries(
    Object.keys(COVERAGE_RULES).map((key) => [key, [] as string[]]),
  ) as Record<CoverageKey, string[]>;

  for (const template of templates) {
    const bundle = await readTemplateSource(template);
    const item = analyzeTemplateSource(template, bundle.source);
    item.errors.push(...bundle.errors);
    item.warnings.push(...bundle.warnings);
    items.push(item);
    for (const capability of item.capabilities) coverage[capability].push(template.id);
  }

  for (const [capability, providers] of Object.entries(coverage) as Array<[CoverageKey, string[]]>) {
    if (providers.length === 0) {
      items.push({
        id: `library:${capability}`,
        engine: 'library',
        motion: 'none',
        capabilities: [],
        errors: [`library has no template covering ${capability}`],
        warnings: [],
      });
    }
  }

  return {
    template_count: templates.length,
    error_count: items.reduce((sum, item) => sum + item.errors.length, 0),
    warning_count: items.reduce((sum, item) => sum + item.warnings.length, 0),
    coverage,
    templates: items,
  };
}

export function analyzeTemplateSource(template: TemplateMetadata, source: string): TemplateAuditItem {
  const cssMotion = /@keyframes\b/i.test(source) && /\banimation(?:-name)?\s*:/i.test(source);
  const gsapMotion = /\bgsap\.(?:timeline|to|from|fromTo)\b/i.test(source);
  const remotionMotion = /\buseCurrentFrame\b/i.test(source) && /\b(?:interpolate|spring)\s*\(/i.test(source);
  const rafMotion = /\brequestAnimationFrame\s*\(/i.test(source);
  const motion: TemplateAuditItem['motion'] = remotionMotion
    ? 'remotion'
    : gsapMotion
      ? 'gsap'
      : cssMotion
        ? 'css'
        : rafMotion
          ? 'raf'
          : 'none';
  const errors: string[] = [];
  const warnings: string[] = [];
  const hasChinese = (value: string | undefined) => /[\u3400-\u9fff]/u.test(value ?? '');
  if (!template.name_zh?.trim() || !hasChinese(template.name_zh)) {
    errors.push('name_zh must be a non-empty Chinese display name');
  }
  if (hasChinese(template.name)) errors.push('name must be the canonical English display name');
  if (!template.description_zh?.trim() || !hasChinese(template.description_zh)) {
    errors.push('description_zh must be a non-empty Chinese description');
  }
  if (hasChinese(template.description)) errors.push('description must be the canonical English description');
  if (template.description_en?.trim()) errors.push('description_en is deprecated; use description for English');
  if (new Set(template.tags).size !== template.tags.length) errors.push('tags must not contain duplicates');
  if (template.tags.some((tag) => tag !== tag.toLowerCase())) errors.push('tags must use lowercase values');
  const duration = template.output?.duration;
  if (duration && (duration.default_sec < duration.min_sec || duration.default_sec > duration.max_sec)) {
    errors.push('output.duration.default_sec must be inside the supported range');
  }
  if (template.preview?.loop) errors.push('preview.loop is not allowed; template previews must be static');
  if (motion === 'none') errors.push('source entry has no load-triggered motion');
  if (/\b(?:Math\.random|Date\.now|crypto\.randomUUID)\s*\(/.test(source)) {
    errors.push('source contains nondeterministic time/random input');
  }
  if (/\binfinite\b|\brepeat\s*:\s*-1\b/i.test(source)) {
    errors.push('source contains an infinite animation loop');
  }
  if (/https?:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.tailwindcss\.com)/i.test(source)) {
    warnings.push('source uses remote font/style assets; renderer fallback must remain available offline');
  }

  const searchable = [
    template.id,
    template.name,
    template.name_zh ?? '',
    template.description,
    template.description_zh ?? '',
    template.category,
    template.subcategory ?? '',
    template.tags.join(' '),
    template.best_for.join(' '),
    source,
  ].join('\n');
  const capabilities = (Object.entries(COVERAGE_RULES) as Array<[CoverageKey, RegExp]>)
    .filter(([, pattern]) => pattern.test(searchable))
    .map(([key]) => key);

  return { id: template.id, engine: template.engine, motion, capabilities, errors, warnings };
}

async function readTemplateSource(
  template: TemplateMetadata,
): Promise<{ source: string; errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!template.__dir) return { source: '', errors: ['template directory is unavailable'], warnings };
  const entry = join(template.__dir, template.source_entry);
  if (!existsSync(entry)) return { source: '', errors: [`source entry missing: ${template.source_entry}`], warnings };
  const poster = resolve(template.__dir, template.preview.poster);
  if (!isPathInside(template.__dir, poster) || !existsSync(poster)) {
    errors.push(`preview poster missing: ${template.preview.poster}`);
  } else if ((await stat(poster)).size === 0) {
    errors.push(`preview poster is empty: ${template.preview.poster}`);
  } else {
    const dimensions = await readPosterDimensions(poster);
    if (!dimensions) {
      warnings.push(`preview poster dimensions could not be read: ${template.preview.poster}`);
    } else {
      const output = template.output.resolution.default;
      const posterAspect = dimensions.width / dimensions.height;
      const outputAspect = output.width / output.height;
      if (Math.abs(posterAspect - outputAspect) > 0.01) {
        errors.push(`preview poster aspect ${dimensions.width}x${dimensions.height} does not match output ${output.width}x${output.height}`);
      }
    }
  }

  const entrySource = await readFile(entry, 'utf8');
  const files = template.native ? await sourceFilesBelow(dirname(entry)) : [entry];
  const chunks: string[] = [];
  for (const file of files) chunks.push(await readFile(file, 'utf8'));

  if (!template.native && extname(entry).toLowerCase() === '.html') {
    const refs = [...new Set(Array.from(entrySource.matchAll(/data-composition-src=["']([^"']+)["']/gi))
      .map((match) => match[1] ?? '')
      .filter(Boolean))];
    for (const ref of refs) {
      const compositionPath = resolve(dirname(entry), ref);
      if (!isPathInside(template.__dir, compositionPath)) {
        errors.push(`composition escapes template directory: ${ref}`);
        continue;
      }
      if (!existsSync(compositionPath)) {
        errors.push(`composition missing: ${ref}`);
        continue;
      }
      const composition = await readFile(compositionPath, 'utf8');
      chunks.push(composition);
      if (!/<template\b/i.test(composition)) errors.push(`sub-composition must use <template>: ${ref}`);
      if (!/data-composition-id=["'][^"']+["']/i.test(composition)) errors.push(`composition id missing: ${ref}`);
      if (!/data-width=["']\d+["']/i.test(composition) || !/data-height=["']\d+["']/i.test(composition)) {
        errors.push(`composition dimensions missing: ${ref}`);
      }
      if (/gsap\.timeline/i.test(composition) && !/window\.__timelines/i.test(composition)) {
        errors.push(`GSAP timeline is not registered: ${ref}`);
      }
    }
  }
  const inputProperties = (template.inputs.schema as { properties?: Record<string, unknown> })?.properties;
  if (inputProperties && Object.keys(inputProperties).length > 0 && (template.inputs.examples?.length ?? 0) === 0) {
    errors.push('template declares input properties but has no input example');
  }
  const requiredInputs = (template.inputs.schema as { required?: unknown })?.required;
  if (Array.isArray(requiredInputs)) {
    for (const [index, example] of template.inputs.examples.entries()) {
      if (!example || typeof example !== 'object') {
        errors.push(`input example ${index + 1} must be an object`);
        continue;
      }
      const missing = requiredInputs.filter((key): key is string => typeof key === 'string' && !(key in example));
      if (missing.length > 0) errors.push(`input example ${index + 1} misses required fields: ${missing.join(', ')}`);
    }
  }
  return { source: chunks.join('\n'), errors, warnings };
}

async function readPosterDimensions(path: string): Promise<{ width: number; height: number } | undefined> {
  const data = await readFile(path);
  if (extname(path).toLowerCase() === '.png' && data.length >= 24
    && data.subarray(1, 4).toString('ascii') === 'PNG') {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (extname(path).toLowerCase() === '.svg') {
    const source = data.toString('utf8');
    const width = Number(source.match(/<svg[^>]*\bwidth=["']([\d.]+)/i)?.[1]);
    const height = Number(source.match(/<svg[^>]*\bheight=["']([\d.]+)/i)?.[1]);
    if (width > 0 && height > 0) return { width, height };
    const viewBox = source.match(/<svg[^>]*\bviewBox=["'][\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i);
    if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
  }
  return undefined;
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function sourceFilesBelow(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root)) {
    const path = join(root, entry);
    const info = await stat(path);
    if (info.isDirectory()) out.push(...await sourceFilesBelow(path));
    else if (['.ts', '.tsx', '.js', '.jsx', '.css', '.html'].includes(extname(path))) out.push(path);
  }
  return out;
}
