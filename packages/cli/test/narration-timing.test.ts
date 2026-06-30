import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allocateNarrationDurations,
  applyFrameMotionTiming,
  estimateNarrationSeconds,
  planFrameMotionTiming,
} from '../dist/narration-timing.js';

test('allocates measured audio exactly at 0.1s precision', () => {
  const durations = allocateNarrationDurations(
    ['新品发布。', '先建立核心能力，再解决复杂流程。', '现在开始。'],
    14.37,
  );
  assert.equal(Math.round(durations.reduce((sum, value) => sum + value, 0) * 10) / 10, 14.4);
  assert.ok(durations.every((value) => value >= 2));
  assert.ok(durations[1]! > durations[0]!);
});

test('accounts for natural punctuation pauses', () => {
  assert.ok(estimateNarrationSeconds('同样内容，稍作停顿。') > estimateNarrationSeconds('同样内容稍作停顿'));
});

test('keeps entrances brisk and gives longer shots more breathing room', () => {
  const short = planFrameMotionTiming(3);
  const long = planFrameMotionTiming(12);
  assert.ok(short.enterStartSec < short.buildEndSec);
  assert.ok(short.buildEndSec <= short.resolveStartSec);
  assert.ok(short.resolveStartSec < short.durationSec);
  assert.ok(long.enterDurationSec <= 0.9);
  assert.ok(long.breatheDurationSec > short.breatheDurationSec);
  assert.ok(long.ambientIterations > 0);
});

test('injects replaceable timing variables without duplicating the contract', () => {
  const html = '<!doctype html><html><head></head><body></body></html>';
  const first = applyFrameMotionTiming(html, 4.2);
  const second = applyFrameMotionTiming(first, 7.5);
  assert.match(second, /data-hv-duration="7\.5"/);
  assert.match(second, /--hv-frame-duration: 7\.5s/);
  assert.equal((second.match(/id="hv-motion-timing"/g) ?? []).length, 1);
});
