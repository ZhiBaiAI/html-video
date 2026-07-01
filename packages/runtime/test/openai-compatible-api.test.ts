import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createOpenAiCompatibleAgent, spawnAgent } from '../dist/index.js';

test('OpenAI-compatible profile sends the selected model and streams text', async () => {
  let requestBody = '';
  let authorization = '';
  let requestPath = '';
  const server = createServer((req, res) => {
    requestPath = req.url ?? '';
    authorization = String(req.headers.authorization ?? '');
    req.setEncoding('utf8');
    req.on('data', (chunk) => { requestBody += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const def = createOpenAiCompatibleAgent({
    id: 'api-profile-test',
    name: 'Test API',
    apiKey: 'secret-key',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: 'default-model',
  });
  let output = '';
  const handle = spawnAgent({
    def,
    prompt: 'ping',
    context: { cwd: '/tmp', model: 'selected-model' },
    onEvent: (event) => { if (event.type === 'text') output += event.chunk; },
  });
  const result = await handle.done;
  server.close();
  assert.equal(result.exitCode, 0);
  assert.equal(output, 'hello');
  assert.equal(requestPath, '/v1/chat/completions');
  assert.equal(authorization, 'Bearer secret-key');
  assert.deepEqual(JSON.parse(requestBody), {
    model: 'selected-model',
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 16000,
    stream: true,
  });
});

test('accepts a non-stream JSON response from a compatible gateway', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'complete' } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const def = createOpenAiCompatibleAgent({
    id: 'api-profile-json', name: 'JSON API', apiKey: 'key',
    baseUrl: `http://127.0.0.1:${address.port}`, model: 'model',
  });
  let output = '';
  const result = await spawnAgent({
    def, prompt: 'ping', context: { cwd: '/tmp' },
    onEvent: (event) => { if (event.type === 'text') output += event.chunk; },
  }).done;
  server.close();
  assert.equal(result.exitCode, 0);
  assert.equal(output, 'complete');
});
