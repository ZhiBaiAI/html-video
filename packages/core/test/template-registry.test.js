import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TemplateRegistry } from '../dist/index.js';

function manifest(id, extra = '') {
  return `spec_version: 1
id: ${id}
name: ${id}
name_zh: 测试模板
description: Test template
description_zh: 测试模板描述
engine: hyperframes
engine_version: ^0.4.0
source_entry: index.html
category: data-viz
tags: [data, chart, metric]
best_for:
  - GitHub stars and growth metrics
output:
  formats: [mp4]
  default_format: mp4
  resolution:
    default: { width: 1920, height: 1080 }
    supported_aspects: ["16:9"]
  fps:
    default: 60
    supported: [60]
  duration:
    type: variable
    min_sec: 3
    max_sec: 10
    default_sec: 5
  alpha: false
  audio: { supported: false, expected_inputs: [] }
inputs:
  schema: { type: object }
  examples: [{}]
license:
  spdx: Apache-2.0
  attribution_required: false
  redistribution_allowed: true
  commercial_use: true
author: { name: test }
version: 0.1.0
preview: { poster: poster.svg }
${extra}`;
}

async function writeTemplate(root, id, yaml) {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), '<!doctype html><html></html>', 'utf8');
  await writeFile(join(dir, 'template.html-video.yaml'), yaml, 'utf8');
}

test('scan rejects invalid template metadata before registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hv-registry-invalid-'));
  await writeTemplate(root, 'bad-template', manifest('different-id'));
  const registry = new TemplateRegistry();
  await assert.rejects(() => registry.scan(root), /id "different-id" must match directory "bad-template"/);
  assert.equal(registry.list().length, 0);
});

test('scan rejects templates that do not implement the unified output contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hv-registry-output-contract-'));
  const incomplete = manifest('incomplete-output')
    .replace('    default_sec: 5\n', '')
    .replace('audio: { supported: false, expected_inputs: [] }', 'audio: { supported: false }');
  await writeTemplate(root, 'incomplete-output', incomplete);
  const registry = new TemplateRegistry();
  await assert.rejects(
    () => registry.scan(root),
    /output\.duration min_sec\/max_sec\/default_sec are required; output\.audio\.expected_inputs must be an array/,
  );
});

test('search ranks data templates for github stars style intents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hv-registry-search-'));
  await writeTemplate(root, 'data-stars', manifest('data-stars'));
  await writeTemplate(
    root,
    'brand-poster',
    manifest(
      'brand-poster',
      `category: marketing
tags: [brand, poster]
best_for:
  - Brand manifesto
`,
    ).replace('category: data-viz\ntags: [data, chart, metric]\nbest_for:\n  - GitHub stars and growth metrics\n', ''),
  );
  const registry = new TemplateRegistry();
  await registry.scan(root);
  const [first] = registry.search({ intent: 'github stars', top: 2 });
  assert.equal(first.template.id, 'data-stars');
  assert.ok(first.score > 0);
});
