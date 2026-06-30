import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TemplateMetadata } from '@html-video/core';
import { analyzeTemplateSource } from '../dist/commands/template-audit.js';

const template = {
  id: 'frame-test',
  name: 'Test',
  name_zh: '测试模板',
  description: 'Animated metric bar chart',
  description_zh: '动态指标柱状图',
  engine: 'hyperframes',
  engine_version: '^0.4.0',
  source_entry: 'index.html',
  category: 'data-viz',
  tags: ['metric', 'bar'],
  best_for: ['KPI'],
  output: {
    formats: ['mp4', 'webm'],
    default_format: 'mp4',
    resolution: { default: { width: 1920, height: 1080 }, supported_aspects: ['16:9'] },
    fps: { default: 30, supported: [30, 60] },
    duration: { type: 'variable', min_sec: 3, max_sec: 10, default_sec: 5 },
    alpha: false,
    audio: { supported: false, expected_inputs: [] },
  },
  inputs: { schema: { type: 'object' }, examples: [] },
  preview: { poster: 'poster.svg' },
} as TemplateMetadata;

test('template audit accepts finite deterministic motion', () => {
  const result = analyzeTemplateSource(template, `
    <style>.bar { animation: grow 1s ease-out 2 both } @keyframes grow { from { scale: 0 1 } }</style>
  `);
  assert.equal(result.motion, 'css');
  assert.deepEqual(result.errors, []);
  assert.ok(result.capabilities.includes('bar_ranking'));
});

test('template audit rejects static and non-deterministic loops', () => {
  const result = analyzeTemplateSource(template, `
    <script>const seed = Math.random();</script>
    <style>.bar { animation: grow 1s infinite } @keyframes grow { to { opacity: .5 } }</style>
  `);
  assert.ok(result.errors.includes('source contains nondeterministic time/random input'));
  assert.ok(result.errors.includes('source contains an infinite animation loop'));
});

test('template audit rejects legacy localization and dynamic preview fields', () => {
  const result = analyzeTemplateSource({
    ...template,
    name: '中英混合 Name',
    description: '中文主描述',
    description_en: 'Legacy English description',
    preview: { poster: 'poster.svg', loop: 'loop.mp4' },
  }, '<style>.bar { animation: grow 1s both } @keyframes grow { to { opacity: 1 } }</style>');
  assert.ok(result.errors.includes('name must be the canonical English display name'));
  assert.ok(result.errors.includes('description must be the canonical English description'));
  assert.ok(result.errors.includes('description_en is deprecated; use description for English'));
  assert.ok(result.errors.includes('preview.loop is not allowed; template previews must be static'));
});
