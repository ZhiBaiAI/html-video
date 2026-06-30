import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTemplateGenerationReference,
  buildLocalTemplateAdaptedGraph,
  compatibleAgentModelForError,
  summarizeAgentFailure,
} from '../dist/studio-server.js';

test('falls back to the known-compatible Codex model only for version errors', () => {
  assert.equal(
    compatibleAgentModelForError(
      'codex',
      undefined,
      "The 'gpt-5.5' model requires a newer version of Codex.",
    ),
    'gpt-5.4',
  );
  assert.equal(compatibleAgentModelForError('codex', 'gpt-5.4', 'requires a newer version of Codex'), undefined);
  assert.equal(compatibleAgentModelForError('hermes', undefined, 'requires a newer version of Codex'), undefined);
  assert.equal(compatibleAgentModelForError('codex', undefined, 'network unavailable'), undefined);
});

test('surfaces the actionable API error instead of leading CLI warnings', () => {
  const error = [
    'agent exit code 1: 2026-06-29T00:00:00Z WARN unknown feature',
    'ERROR: {"error":{"message":"The gpt-5.5 model requires a newer version of Codex."}}',
  ].join('\n');
  assert.equal(summarizeAgentFailure(error), 'The gpt-5.5 model requires a newer version of Codex.');
});

test('narration fallback graph preserves exact per-frame script and invents no metrics', () => {
  const frameTexts = [
    '真正厉害的 AI 已经开始替财务处理重复工作。',
    '多个财税专家协同完成校验、清洗和分析。',
  ];
  const metricTemplate = '<!doctype html><html><body><div class="frame"><div class="c"></div><div class="c"></div></div></body></html>';
  const graph = buildLocalTemplateAdaptedGraph({
    frameCount: 2,
    perFrameDurationSec: 3,
    contentTurns: ['完整口播脚本：不应覆盖逐帧原文', '第 1 帧口播原文：不应泄漏'],
    sourceTexts: [],
    frameTexts,
    templateHtml: metricTemplate,
    fallbackSynopsis: '财税智能体',
  });

  assert.deepEqual(graph.nodes.map((node) => ('text' in node ? node.text : undefined)), frameTexts);
  assert.ok(graph.nodes.every((node) => node.kind === 'text'));
  assert.equal(graph.synopsis.includes('第 1 帧口播原文'), false);
});

test('fallback data frames only reuse figures that exist in the script', () => {
  const metricTemplate = '<!doctype html><html><body><div class="frame"><div class="c"></div><div class="c"></div></div></body></html>';
  const graph = buildLocalTemplateAdaptedGraph({
    frameCount: 1,
    perFrameDurationSec: 3,
    contentTurns: [],
    sourceTexts: [],
    frameTexts: ['原来需要 6 小时，现在只要 10 分钟。'],
    templateHtml: metricTemplate,
    fallbackSynopsis: '效率提升',
  });
  const node = graph.nodes[0];
  assert.equal(node?.kind, 'data');
  if (node?.kind !== 'data') return;
  assert.ok(node.data.items.every((item) => item.value === 6 || item.value === 10));
});

test('fallback chooses a data composition by meaning instead of frame order', () => {
  const semanticTemplate = `<!doctype html><html><body>
    <div class="frame hero"><h1>Hero</h1></div>
    <div class="frame dashboard"><div class="c">A</div><div class="c">B</div></div>
  </body></html>`;
  const graph = buildLocalTemplateAdaptedGraph({
    frameCount: 1,
    perFrameDurationSec: 3,
    contentTurns: [],
    sourceTexts: [],
    frameTexts: ['转化率从 18% 提升到 42%。'],
    templateHtml: semanticTemplate,
    fallbackSynopsis: '增长数据',
  });

  assert.equal(graph.nodes[0]?.kind, 'data');
  assert.equal(graph.nodes[0]?.frameIntent, 'metric-card frame');
});

test('fallback chooses a process composition for ordered script content', () => {
  const semanticTemplate = `<!doctype html><html><body>
    <div class="frame hero"><h1>Hero</h1></div>
    <div class="frame process"><div class="steps"><span>1</span><span>2</span></div></div>
  </body></html>`;
  const graph = buildLocalTemplateAdaptedGraph({
    frameCount: 1,
    perFrameDurationSec: 3,
    contentTurns: [],
    sourceTexts: [],
    frameTexts: ['流程分三步：先收集素材，再完成分析，最后输出视频。'],
    templateHtml: semanticTemplate,
    fallbackSynopsis: '制作流程',
  });

  assert.equal(graph.nodes[0]?.kind, 'text');
  assert.equal(graph.nodes[0]?.frameIntent, 'process/timeline frame');
});

test('template generation reference includes the semantically matched frame beyond the source prefix', () => {
  const templateHtml = `<!doctype html><html><head><style>:root{--paper:#f4f0e8;--ink:#1838d8}</style></head><body>
    ${'<!-- long design documentation -->'.repeat(180)}
    <div class="frame hero"><h1>Generic cover</h1></div>
    <div class="frame dashboard"><div class="c">Revenue</div><div class="c">Margin</div></div>
  </body></html>`;
  const reference = buildTemplateGenerationReference({
    templateName: 'Cobalt Report',
    templateDescription: 'Editorial data system',
    templateHtml,
    index: 1,
    total: 3,
    text: '营收从 18 增长到 42，利润率提升到 65%。',
    contentKind: 'data',
  });

  assert.match(reference, /SELECTED TEMPLATE CONTRACT/);
  assert.match(reference, /--paper:#f4f0e8/);
  assert.match(reference, /Revenue/);
  assert.doesNotMatch(reference, /Generic cover/);
});
