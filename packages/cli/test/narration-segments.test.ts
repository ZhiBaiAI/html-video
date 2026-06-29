import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitNarrationSegments } from '../dist/studio-server.js';

test('splits a Chinese voiceover into the exact requested count without rewriting it', () => {
  const script = '先理解内容，再确定视觉重点。数据出现时用图表解释关系，结尾再收束观点。';
  const segments = splitNarrationSegments(script, 3);
  assert.equal(segments.length, 3);
  assert.equal(segments.join(''), script);
  assert.ok(segments.every(Boolean));
});

test('splits one long sentence and preserves Unicode characters exactly', () => {
  const script = '这是一个没有句号但仍然需要按画面节奏切分的口播脚本🎬';
  const segments = splitNarrationSegments(script, 4);
  assert.equal(segments.length, 4);
  assert.equal(segments.join(''), script);
});

