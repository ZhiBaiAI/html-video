import assert from 'node:assert/strict';
import test from 'node:test';
import { findAgent } from '../dist/index.js';

const context = { cwd: '/tmp/html-video', model: 'vendor/model-x' };

test('model-configurable CLI agents pass the saved model to their real argv', () => {
  const cases: Array<[string, string[]]> = [
    ['codex', ['--model', 'vendor/model-x']],
    ['qoder-cli', ['--model', 'vendor/model-x']],
    ['hermes', ['--model', 'vendor/model-x']],
  ];
  for (const [id, expected] of cases) {
    const def = findAgent(id);
    assert.ok(def, `${id} is registered`);
    assert.equal(def.modelSelection?.mode, 'custom');
    const args = def.buildArgs('hello', context);
    const start = args.indexOf(expected[0]!);
    assert.deepEqual(args.slice(start, start + expected.length), expected);
  }
});

test('AMR remains catalog-backed and uses its default when no override is saved', () => {
  const def = findAgent('amr');
  assert.ok(def);
  assert.equal(def.modelSelection?.mode, 'catalog');
  assert.equal(def.defaultModel, 'deepseek-v4-flash');
});
