import assert from 'node:assert/strict';
import test from 'node:test';

import { cloneBailianCosyVoice, generateBailianTts } from '../dist/bailian.js';

test('generateBailianTts sends CosyVoice model, voice, and controls', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let requestUrl;
  let requestBody;
  globalThis.fetch = async (url, init) => {
    requestUrl = String(url);
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      output: { audio: { data: Buffer.from('fake-mp3').toString('base64') } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await generateBailianTts({
    text: '测试旁白',
    voiceId: 'my-cloned-voice',
    model: 'cosyvoice-v3-flash',
    rate: 1.2,
    volume: 68,
    emotion: 'happy',
    scene: '新闻播报',
    creds: { apiKey: 'test-key', baseUrl: 'https://dashscope.aliyuncs.com/api/v1' },
  });

  assert.equal(requestUrl, 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer');
  assert.equal(requestBody.model, 'cosyvoice-v3-flash');
  assert.equal(requestBody.input.voice, 'my-cloned-voice');
  assert.equal(requestBody.input.format, 'mp3');
  assert.equal(requestBody.input.sample_rate, 24000);
  assert.equal(requestBody.input.rate, 1.2);
  assert.equal(requestBody.input.volume, 68);
  assert.equal(requestBody.input.instruction, '你正在进行新闻播报，你说话的情感是happy。');
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

test('cloneBailianCosyVoice sends the public audio URL and chosen voice prefix', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let requestUrl;
  let requestBody;
  globalThis.fetch = async (url, init) => {
    requestUrl = String(url);
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      output: { voice_id: 'cosyvoice-v3-flash-joeyvoice-abc123' },
      request_id: 'req-123',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await cloneBailianCosyVoice({
    prefix: 'joeyvoice',
    audioUrl: 'https://example.com/voice.wav',
    model: 'cosyvoice-v3-flash',
    languageHints: ['zh'],
    creds: { apiKey: 'test-key', baseUrl: 'https://dashscope.aliyuncs.com/api/v1' },
  });

  assert.equal(requestUrl, 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization');
  assert.equal(requestBody.model, 'voice-enrollment');
  assert.equal(requestBody.input.action, 'create_voice');
  assert.equal(requestBody.input.target_model, 'cosyvoice-v3-flash');
  assert.equal(requestBody.input.prefix, 'joeyvoice');
  assert.equal(requestBody.input.url, 'https://example.com/voice.wav');
  assert.deepEqual(requestBody.input.language_hints, ['zh']);
  assert.equal(result.voiceId, 'cosyvoice-v3-flash-joeyvoice-abc123');
  assert.equal(result.requestId, 'req-123');
});
