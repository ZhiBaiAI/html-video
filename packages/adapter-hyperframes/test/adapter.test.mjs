import { test } from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../dist/index.js';

test('exports a render-capable Hyperframes adapter', () => {
  assert.equal(adapter.id, 'hyperframes');
  assert.equal(adapter.name, 'Hyperframes');
  assert.equal(typeof adapter.render, 'function');
  assert.equal(typeof adapter.renderToHtml, 'function');
  assert.ok(adapter.capabilities.outputFormats.includes('mp4'));
  assert.ok(adapter.capabilities.paradigms.includes('html-css-gsap'));
});
