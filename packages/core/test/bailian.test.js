import assert from 'node:assert/strict';
import test from 'node:test';

import { cloneBailianMinimaxVoice, generateBailianTts } from '../dist/bailian.js';

test('generateBailianTts sends MiniMax model and cloned voice id', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      output: { audio: { data: Buffer.from('fake-mp3').toString('base64') } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await generateBailianTts({
    text: '测试旁白',
    voiceId: 'my-cloned-voice',
    model: 'MiniMax/speech-2.8-turbo',
    creds: { apiKey: 'test-key', baseUrl: 'https://dashscope.aliyuncs.com/api/v1' },
  });

  assert.equal(requestBody.model, 'MiniMax/speech-2.8-turbo');
  assert.equal(requestBody.input.voice_setting.voice_id, 'my-cloned-voice');
  assert.equal(result.bytes.toString(), 'fake-mp3');
  assert.equal(result.ext, '.mp3');
});

test('generateBailianTts accepts output.audio as a base64 string', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response(JSON.stringify({
    output: { audio: Buffer.from('direct-audio').toString('base64') },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const result = await generateBailianTts({
    text: '测试',
    creds: { apiKey: 'test-key', baseUrl: 'https://dashscope.aliyuncs.com/api/v1' },
  });

  assert.equal(result.bytes.toString(), 'direct-audio');
});

test('cloneBailianMinimaxVoice sends the public audio URL and chosen voice id', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      output: { audio: Buffer.from('clone-preview').toString('base64') },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await cloneBailianMinimaxVoice({
    voiceId: 'joey-narrator',
    audioUrl: 'https://example.com/voice.wav',
    previewText: '这是一段试听文本。',
    model: 'MiniMax/speech-2.8-turbo',
    creds: { apiKey: 'test-key', baseUrl: 'https://dashscope.aliyuncs.com/api/v1' },
  });

  assert.equal(requestBody.input.action, 'voice_clone');
  assert.equal(requestBody.input.voice_id, 'joey-narrator');
  assert.equal(requestBody.input.audio_url, 'https://example.com/voice.wav');
  assert.equal(result.voiceId, 'joey-narrator');
  assert.equal(result.previewBytes.toString(), 'clone-preview');
});
