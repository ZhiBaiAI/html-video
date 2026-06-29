import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TemplateMetadata } from '@html-video/core';
import { analyzeTemplateSource } from '../dist/commands/template-audit.js';

const template = {
  id: 'frame-test',
  name: 'Test',
  description: 'Animated metric bar chart',
  engine: 'hyperframes',
  category: 'data-viz',
  tags: ['metric', 'bar'],
  best_for: ['KPI'],
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
