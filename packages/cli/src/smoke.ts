/**
 * End-to-end smoke test for project-centric workflow (RFC-05).
 * Asserts: bootstrap → create project → add assets → set template → preview → render
 */

import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { bootstrap } from './context.js';

const log = (msg: string) => process.stdout.write(`▸ ${msg}\n`);
const ok = (msg: string) => process.stdout.write(`  ✓ ${msg}\n`);

async function main() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'html-video-smoke-'));
  await mkdir(join(projectRoot, '.html-video'), { recursive: true });
  log(`workdir: ${projectRoot}`);

  const monorepoRoot = resolve(__dirname_polyfill(), '..', '..', '..');

  const fakeLogoPath = join(projectRoot, 'fake-logo.png');
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
    'base64',
  );
  await writeFile(fakeLogoPath, PNG_1x1);

  log('bootstrap context');
  const ctx = await bootstrap({ cwd: projectRoot });
  if (ctx.templates.list().length === 0) {
    await ctx.templates.scan(join(monorepoRoot, 'templates'));
  }
  ok(`engines: ${ctx.engines.list().map((e) => e.id).join(', ')}`);
  ok(`templates: ${ctx.templates.list().map((t) => t.id).join(', ')}`);

  // 1. Create a project
  log('project create');
  const project1 = await ctx.orchestrator.create({
    name: 'OD Plugin Library Demo',
    intent: 'Show OD plugin library distribution',
    preferences: { aspect: '16:9', commercial: true },
  });
  ok(`project ${project1.id} status=${project1.status}`);

  // 2. Add assets
  log('add image asset');
  let p = await ctx.orchestrator.addFileAsset(project1.id, fakeLogoPath, 'OD logo');
  ok(`assets=${p.assets.length}`);

  log('add inline text asset');
  p = await ctx.orchestrator.addInlineAsset(project1.id, 'Design that evolves itself', 'text');
  ok(`assets=${p.assets.length}`);

  log('add inline data asset');
  const chartData = JSON.stringify([
    { label: 'Templates', value: 231, color: '#ffb84d' },
    { label: 'Skills', value: 15, color: '#9b87f5' },
    { label: 'Systems', value: 150, color: '#6dd99c' },
    { label: 'Craft', value: 11, color: '#ff8a4d' },
  ]);
  p = await ctx.orchestrator.addInlineAsset(project1.id, chartData, 'data');
  ok(`assets=${p.assets.length}`);

  // 3. Pick a template
  log('set template = frame-data-chart-nyt');
  p = await ctx.orchestrator.setTemplate(project1.id, 'frame-data-chart-nyt');
  ok(`templateId=${p.templateId} variables(after-defaults)=${JSON.stringify(p.variables).slice(0, 80)}…`);

  // 4. Set variables (use the chart data we just added)
  log('set variables');
  p = await ctx.orchestrator.setVariables(project1.id, {
    title: 'OD Plugin Library Distribution',
    subtitle: '2026-05-27',
    data: JSON.parse(chartData),
    value_format: 'number',
    duration_sec: 8,
  });
  ok('variables saved');

  // 5. Render preview HTML
  log('render preview html');
  const { project: previewedProj, htmlPath } = await ctx.orchestrator.renderPreviewHtml(project1.id);
  if (!existsSync(htmlPath)) throw new Error('Preview HTML missing: ' + htmlPath);
  const content = await readFile(htmlPath, 'utf8');
  if (!content.includes('<html')) throw new Error('Preview HTML malformed');
  ok(`status=${previewedProj.status} html=${htmlPath}`);

  // 6. Switch template to test variable preservation
  log('switch template to frame-glitch-title');
  p = await ctx.orchestrator.setTemplate(project1.id, 'frame-glitch-title');
  ok(`now templateId=${p.templateId} kept-vars=${JSON.stringify(p.variables)}`);

  // 7. Switch back + render again
  log('switch back to frame-data-chart-nyt');
  p = await ctx.orchestrator.setTemplate(project1.id, 'frame-data-chart-nyt');
  p = await ctx.orchestrator.setVariables(project1.id, {
    title: 'OD Plugin Library Distribution',
    data: JSON.parse(chartData),
    duration_sec: 8,
  });

  // 8. Export MP4
  log('export MP4');
  const { project: rendered, outputPath } = await ctx.orchestrator.exportMp4({
    projectId: project1.id,
    onProgress: (pct, stage) => {
      if (pct === 0 || pct === 100 || pct % 25 === 0) ok(`render ${stage} ${pct}%`);
    },
  });
  if (!existsSync(outputPath)) throw new Error('MP4 output missing');
  ok(`status=${rendered.status} mp4=${outputPath}`);

  const singleStats = await stat(outputPath);
  if (singleStats.size <= 0) throw new Error('single-frame MP4 is empty');

  // 9. v0.8: ContentGraph + multi-frame self-test
  log('v0.8 multi-frame: write content-graph + 3 frames + export');
  const project2 = await ctx.orchestrator.create({
    name: 'Multi-frame explainer demo',
    intent: 'Test content-graph + frames pipeline',
    preferences: {},
  });
  const graph = {
    schemaVersion: 1 as const,
    intent: 'explainer' as const,
    synopsis: 'Smoke-test explainer with three frames',
    nodes: [
      { id: 'intro', kind: 'text' as const, text: 'Hello world', durationSec: 3 },
      { id: 'middle', kind: 'data' as const, data: { v: 42 }, durationSec: 3 },
      { id: 'outro', kind: 'entity' as const, props: { logo: 'OD' }, durationSec: 3 },
    ],
    edges: [
      { from: 'intro', to: 'middle', kind: 'sequence' as const },
      { from: 'middle', to: 'outro', kind: 'dependency' as const },
    ],
  };
  await ctx.orchestrator.writeContentGraph(project2.id, graph);
  ok('graph persisted + validated');

  for (const node of graph.nodes) {
    const html = animatedSmokeFrameHtml(node.id);
    const { frame } = await ctx.orchestrator.writeFrameHtml(project2.id, node.id, html);
    ok(`frame written: ${frame.graphNodeId} order=${frame.order} dur=${frame.durationSec}s path=${frame.htmlPath.split('/').slice(-3).join('/')}`);
  }

  const finalProject = await ctx.orchestrator.load(project2.id);
  if (!finalProject.frames || finalProject.frames.length !== 3) {
    throw new Error(`expected 3 frames, got ${finalProject.frames?.length}`);
  }
  // Order should be: intro (no deps), middle (after intro by sequence + before outro), outro (depends on middle)
  const order = finalProject.frames.map((f) => f.graphNodeId).join(',');
  if (order !== 'intro,middle,outro') {
    throw new Error(`unexpected play order: ${order}`);
  }
  ok(`play order: ${order}`);

  log('export multi-frame MP4');
  const { project: renderedMulti, outputPath: multiOut } = await ctx.orchestrator.exportMp4({
    projectId: project2.id,
    onProgress: (pct, stage) => {
      if (pct === 100) ok(`multi render ${stage} ${pct}%`);
    },
  });
  if (!existsSync(multiOut)) throw new Error('multi-frame MP4 output missing');
  const multiStats = await stat(multiOut);
  if (multiStats.size <= 0) throw new Error('multi-frame MP4 is empty');
  await assertVideoHasMotion(multiOut);
  ok('multi-frame MP4 preserves browser-recorded motion');
  if (renderedMulti.status !== 'rendered') {
    throw new Error(`expected rendered multi-frame project, got ${renderedMulti.status}`);
  }
  ok(`multi-frame mp4=${multiOut} size=${multiStats.size}`);

  // 10. Verify project list works
  log('list projects');
  const all = await ctx.orchestrator.list();
  ok(`${all.length} project(s) in store`);

  process.stdout.write('\n✅ smoke test passed\n');
}

function animatedSmokeFrameHtml(label: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${label}</title>
  <style>
    html, body { margin: 0; height: 100%; overflow: hidden; background: #0f1115; color: #f7f4ec; font-family: system-ui, sans-serif; }
    .stage { position: relative; width: 100vw; height: 100vh; display: grid; place-items: center; }
    h1 { font-size: 11vw; letter-spacing: -.04em; animation: title-in .8s ease-out both; }
    .dot { position: absolute; left: 10vw; top: 58vh; width: 14vw; height: 14vw; border-radius: 999px; background: #29e6a7; animation: sweep 2.4s ease-in-out infinite alternate; }
    @keyframes title-in { from { opacity: 0; transform: translateY(28px) scale(.96); } to { opacity: 1; transform: none; } }
    @keyframes sweep { to { transform: translateX(62vw) scale(.65); background: #ff5533; } }
  </style>
</head>
<body>
  <main class="stage">
    <div class="dot" aria-hidden="true"></div>
    <h1 data-hv-text="headline">${label}</h1>
  </main>
</body>
</html>`;
}

async function assertVideoHasMotion(videoPath: string): Promise<void> {
  const early = await frameMd5(videoPath, 0.6);
  const later = await frameMd5(videoPath, 1.8);
  if (!early || !later) {
    throw new Error('Could not sample exported MP4 frames for motion check');
  }
  if (early === later) {
    throw new Error(`Exported MP4 appears static inside the first frame (${early})`);
  }
}

function frameMd5(videoPath: string, atSec: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-v', 'error',
      '-i', videoPath,
      '-ss', atSec.toFixed(2),
      '-frames:v', '1',
      '-vf', 'scale=160:-1',
      '-f', 'md5',
      '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') reject(new Error('ffmpeg not found on PATH; cannot verify motion in exported MP4'));
      else reject(err);
    });
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg frame sample failed (${code}): ${stderr.slice(-800)}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function __dirname_polyfill(): string {
  const url = import.meta.url;
  const path = url.replace(/^file:\/\//, '');
  return path.replace(/\/[^/]*$/, '');
}

main().catch((err) => {
  process.stderr.write(`\n❌ smoke test failed: ${err.message ?? err}\n`);
  if (err.stack) process.stderr.write(err.stack + '\n');
  process.exit(1);
});
