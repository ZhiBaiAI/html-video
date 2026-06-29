import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolutionForAspect } from '../dist/studio-server.js';

test('maps every Studio aspect to the exact export resolution', () => {
  assert.deepEqual(resolutionForAspect('16:9'), [1920, 1080]);
  assert.deepEqual(resolutionForAspect('9:16'), [1080, 1920]);
  assert.deepEqual(resolutionForAspect('1:1'), [1080, 1080]);
  assert.deepEqual(resolutionForAspect('4:5'), [1080, 1350]);
});

test('accepts the localized aspect labels used by format cards', () => {
  assert.deepEqual(resolutionForAspect('9:16 手机竖屏'), [1080, 1920]);
  assert.deepEqual(resolutionForAspect('4:5 小红书'), [1080, 1350]);
});
