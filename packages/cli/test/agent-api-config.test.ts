import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentApiConfigStore } from '../dist/agent-api-config.js';

test('API model profiles hide keys, preserve them on edit, and map to stable agent ids', () => {
  const root = mkdtempSync(join(tmpdir(), 'html-video-agent-api-'));
  try {
    const store = new AgentApiConfigStore(root);
    const created = store.upsert({
      provider: 'dashscope',
      name: 'Qwen Plus',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
      model: 'qwen-plus',
      apiKey: 'sk-secret-value',
    });
    assert.equal(created.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
    assert.equal(created.agentId, `api-profile-${created.id}`);
    assert.equal(created.configured, true);
    assert.ok(!JSON.stringify(created).includes('sk-secret-value'));
    const updated = store.upsert({
      id: created.id,
      provider: 'dashscope',
      name: 'Qwen Max',
      baseUrl: created.baseUrl,
      model: 'qwen-max',
      apiKey: '',
    });
    assert.equal(updated.model, 'qwen-max');
    assert.equal(store.resolveByAgentId(updated.agentId)?.apiKey, 'sk-secret-value');
    store.remove(created.id);
    assert.deepEqual(store.list(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
