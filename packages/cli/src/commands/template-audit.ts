import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
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
    const source = await readTemplateSource(template);
    const item = analyzeTemplateSource(template, source);
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

async function readTemplateSource(template: TemplateMetadata): Promise<string> {
  if (!template.__dir) return '';
  const entry = join(template.__dir, template.source_entry);
  const files = template.native
    ? await sourceFilesBelow(dirname(entry))
    : [entry];
  const chunks: string[] = [];
  for (const file of files) chunks.push(await readFile(file, 'utf8'));
  return chunks.join('\n');
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
