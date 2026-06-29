/**
 * HTTP server for the project studio (RFC-05 §UI).
 * Serves @html-video/project-studio static UI + project / template REST APIs.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, basename, posix, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import type { CliContext } from './context.js';
import type { Project, TemplateMetadata } from '@html-video/core';
import {
  AssetStore,
  cloneBailianCosyVoice,
  generateBailianTts,
  generateTts,
  probeMediaDurationSec,
} from '@html-video/core';
import { extractUrls, fetchSource } from './fetch-source.js';
import { detectAll, findAgent, spawnAgent } from '@html-video/runtime';

interface StudioHandle {
  url: string;
  port: number;
  close: () => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mpga': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

const DEFAULT_COSYVOICE_SAMPLE_URL = [
  'https://bailian-bmp-prod.oss-cn-beijing.aliyuncs.com/model_offline_result/11751412/1781175777482/qianwen/recording_1781175775568.wav',
  '?Expires=1781182978',
  '&OSSAccessKeyId=STS.NZ1WVUaukZeMxYoE4jg34Rd3J',
  '&Signature=k9V3dbCdhTD4RTpuwARFC1WGnNQ%3D',
  '&security-token=CAIS2AJ1q6Ft5B2yfSjIr5mEHOzhjKpK7aemen%2FeoTQ%2Fa7wYvaGYqDz2IHhMenRoAu8fv%2FU1nmlQ6%2FsZlrp6SJtIXleCZtF94oxN9h2gb4fb4y1LA2qH08%2FLI3OaLjKm9u2wCryLYbGwU%2FOpbE%2B%2B5U0X6LDmdDKkckW4OJmS8%2FBOZcgWWQ%2FKBlgvRq0hRG1YpdQdKGHaONu0LxfumRCwNkdzvRdmgm4NgsbWgO%2Fks0CD0w2rlLFL%2BdugcsT4MvMBZskvD42Hu8VtbbfE3SJq7BxHybx7lqQs%2B02c5onDXgEKvEzXYrCOq4UycVRjE6IgHKdIt%2FP7jfA9sOHVnITywgxOePlRWjjRQ5ql0E4ehBQP3yBTn9%2FVTJeturjnXvGd24ikVa0RnwBBMhytfsq8tbjo7uXGa%2FbB1hmjSUyYUMumi%2BluDkYtlgzV9eKArlL3Sa2Rv07lcjH7NCtAXxqAAT6Yetg3RRB6Z%2BsfiRqjNnfHABdKlyh38F%2Fvw2aRvgJxA2efFAA5N6MvQY2g6juFRm3amck7ITMezlp1SMVRAhGORlhklC03RCVGB8zcadmvQ0pvS0id0%2BoND0X92QVgN7DPUk98f5uO0TJP9d28fxW8by6sZn8s4%2FFcDtO2o%2BVSIAA%3D',
].join('');

function resolveUiRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'project-studio', 'public'),
    resolve(here, '..', 'public'),
    resolve(here, '..', '..', 'storyboard-ui', 'public'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0]!;
}

/** Cross-platform containment check; avoids hard-coding '/' on Windows. */
export function isPathInside(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === 'win32' ? win32 : posix;
  const rel = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${pathApi.sep}`) && rel !== '..' && !pathApi.isAbsolute(rel));
}

export async function startStudioServer(ctx: CliContext, port: number): Promise<StudioHandle> {
  const uiRoot = resolveUiRoot();

  const server = createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400);
        res.end();
        return;
      }
      const url = new URL(req.url, 'http://x');
      const m = req.method ?? 'GET';

      // ============== API ==============

      // List projects
      if (url.pathname === '/api/projects' && m === 'GET') {
        const list = await ctx.orchestrator.list();
        return json(res, 200, { projects: list });
      }

      // Create project
      if (url.pathname === '/api/projects' && m === 'POST') {
        const body = await readBody(req);
        const project = await ctx.orchestrator.create({
          name: (body.name as string) ?? 'Untitled',
          ...(body.intent !== undefined && { intent: body.intent as string }),
          preferences: (body.preferences as Record<string, unknown>) ?? {},
        });
        return json(res, 200, { project });
      }

      // Get / update / delete single project
      const projMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projMatch && projMatch[1]) {
        const id = projMatch[1];
        if (m === 'GET') {
          return json(res, 200, { project: await ctx.orchestrator.load(id) });
        }
        if (m === 'PATCH') {
          const body = await readBody(req);
          const project = await ctx.orchestrator.load(id);
          if (typeof body.name === 'string' && body.name.trim()) {
            project.name = body.name.trim().slice(0, 80);
          }
          if (typeof body.intent === 'string') {
            project.intent = body.intent.slice(0, 280);
          }
          await ctx.projects.save(project);
          return json(res, 200, { project: await ctx.orchestrator.load(id) });
        }
        if (m === 'DELETE') {
          await ctx.orchestrator.remove(id);
          MESSAGES.delete(id);
          return json(res, 200, { ok: true });
        }
      }

      // List engines + templates
      if (url.pathname === '/api/templates' && m === 'GET') {
        return json(res, 200, {
          templates: await Promise.all(ctx.templates.list().map(async (t) => {
            // Decide how the gallery should preview this template:
            //  - 'iframe'  → the entry HTML is self-contained; render it live.
            //  - 'poster'  → the entry only references sub-compositions via
            //    data-composition-src and needs the Hyperframes player (not yet
            //    built, v0.9) to show anything, so a live iframe is blank.
            //    Fall back to the shipped poster image instead.
            const { mode, posterUrl } = templatePreviewMode(t);
            const staticPreview = await templateStaticPreview(t, posterUrl);
            return {
              id: t.id,
              name: t.name,
              name_zh: t.name_zh,
              description: t.description,
              description_zh: t.description_zh,
              description_en: t.description_en,
              engine: t.engine,
              source_entry: t.source_entry,
              category: t.category,
              tags: t.tags,
              best_for: t.best_for,
              inputs_schema: t.inputs.schema,
              inputs_examples: t.inputs.examples,
              license: t.license,
              provenance: t.provenance,
              preview: t.preview,
              preview_mode: mode,
              poster_url: posterUrl,
              preview_frames: staticPreview.frames,
              preview_elements: staticPreview.elements,
              preview_motion: staticPreview.motion,
              output: t.output,
            };
          })),
        });
      }

      // Add asset (multipart-style via JSON for v0.1: paths or inline content)
      const addAssetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/assets$/);
      if (addAssetMatch && addAssetMatch[1] && m === 'POST') {
        const id = addAssetMatch[1];
        const ct = req.headers['content-type'] ?? '';
        let project;
        if (ct.startsWith('multipart/form-data')) {
          // Save uploaded file to /tmp then add
          const saved = await receiveMultipartFile(req, ct);
          project = await ctx.orchestrator.addFileAsset(id, saved.filePath);
        } else {
          const body = await readBody(req);
          if (body.kind === 'text') {
            project = await ctx.orchestrator.addInlineAsset(
              id,
              (body.content as string) ?? '',
              'text',
              body.caption as string | undefined,
            );
          } else if (body.kind === 'data') {
            project = await ctx.orchestrator.addInlineAsset(
              id,
              (body.content as string) ?? '',
              'data',
              body.caption as string | undefined,
            );
          } else if (body.kind === 'file' && body.path) {
            project = await ctx.orchestrator.addFileAsset(id, body.path as string);
          } else {
            return json(res, 400, { error: 'Provide kind=text|data|file with content/path' });
          }
        }
        return json(res, 200, { project });
      }

      // Remove asset
      const rmAssetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/assets\/([^/]+)$/);
      if (rmAssetMatch && rmAssetMatch[1] && rmAssetMatch[2] && m === 'DELETE') {
        const project = await ctx.orchestrator.removeAsset(rmAssetMatch[1], rmAssetMatch[2]);
        return json(res, 200, { project });
      }

      // Talking-head source media: upload or bind an existing video/image asset.
      // Videos can be transcribed and optionally provide original audio; images
      // and GIFs are overlaid bottom-right as a speaking avatar.
      const thMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/talking-head$/);
      if (thMatch && thMatch[1] && m === 'POST') {
        const projectId = thMatch[1];
        const ct = req.headers['content-type'] ?? '';
        try {
          let videoAssetId = '';
          if (ct.startsWith('multipart/form-data')) {
            const saved = await receiveMultipartFile(req, ct);
            const guessed = AssetStore.guessMime(saved.filePath);
            if (guessed.type !== 'video' && guessed.type !== 'image') {
              return json(res, 400, { error: 'Upload a video, GIF, or image file for talking-head mode.' });
            }
            const project = await ctx.orchestrator.addFileAsset(projectId, saved.filePath, 'talking-head source');
            const asset = project.assets[project.assets.length - 1];
            if (!asset || (asset.type !== 'video' && asset.type !== 'image')) return json(res, 400, { error: 'Upload a video, GIF, or image file for talking-head mode.' });
            videoAssetId = asset.id;
          } else {
            const body = await readBody(req);
            videoAssetId = String(body.videoAssetId ?? '');
          }
          if (!videoAssetId) return json(res, 400, { error: 'videoAssetId or video upload required' });
          const project = await ctx.orchestrator.setTalkingHead(projectId, videoAssetId, { audioMode: 'synthetic' });
          return json(res, 200, { project });
        } catch (err) {
          return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (thMatch && thMatch[1] && m === 'PATCH') {
        try {
          const body = (await readBody(req).catch(() => ({}))) as { audioMode?: string };
          if (body.audioMode !== 'synthetic' && body.audioMode !== 'original') {
            return json(res, 400, { error: 'audioMode must be synthetic or original' });
          }
          const project = await ctx.orchestrator.setTalkingHeadAudioMode(thMatch[1], body.audioMode);
          return json(res, 200, { project });
        } catch (err) {
          return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (thMatch && thMatch[1] && m === 'DELETE') {
        const project = await ctx.orchestrator.clearTalkingHead(thMatch[1]);
        return json(res, 200, { project });
      }

      const thTranscribeMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/talking-head\/transcribe$/);
      if (thTranscribeMatch && thTranscribeMatch[1] && m === 'POST') {
        const projectId = thTranscribeMatch[1];
        try {
          const body = (await readBody(req).catch(() => ({}))) as {
            videoAssetId?: string;
            model?: string;
            language?: string;
          };
          const project = await ctx.orchestrator.load(projectId);
          const videoAssetId = body.videoAssetId || project.talkingHead?.videoAssetId;
          if (!videoAssetId) return json(res, 400, { error: 'No talking-head source selected.' });
          const asset = project.assets.find((a) => a.id === videoAssetId);
          if (!asset || asset.type !== 'video') {
            return json(res, 400, { error: 'Only uploaded videos can be transcribed. GIFs/images are overlay-only.' });
          }
          const out = await ctx.orchestrator.transcribeTalkingHead({
            projectId,
            videoAssetId,
            model: body.model || 'tiny',
            ...(body.language ? { language: body.language } : {}),
          });
          return json(res, 200, {
            project: out.project,
            transcript: out.transcript,
            transcript_path: out.transcriptPath,
            srt_path: out.srtPath,
            vtt_path: out.vttPath,
          });
        } catch (err) {
          return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Set template
      const tplMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/template$/);
      if (tplMatch && tplMatch[1] && m === 'PUT') {
        const projectId = tplMatch[1];
        if (GENERATING.has(projectId)) {
          return json(res, 409, { error: 'This project is already generating. Wait for the current run to finish.' });
        }
        const body = await readBody(req);
        const templateId = typeof body.template_id === 'string' ? body.template_id : '';
        const tmpl = ctx.templates.list().find((candidate) => candidate.id === templateId);
        if (!tmpl) return json(res, 404, { error: `Template "${templateId}" not found.` });
        const before = await ctx.orchestrator.load(projectId);
        const hasStoryboard = (before.frames?.length ?? 0) > 0;
        const project = await ctx.orchestrator.setTemplate(projectId, templateId);
        // Empty projects get an immediate template preview. Existing storyboard
        // frames must survive the switch so the optional restyle action can
        // actually re-render them; writePreviewHtmlRaw() intentionally resets
        // frames and was the reason template switching appeared ineffective.
        if (!hasStoryboard && tmpl.__dir && tmpl.source_entry) {
          const exampleHtmlPath = resolve(tmpl.__dir, tmpl.source_entry);
          if (isPathInside(tmpl.__dir, exampleHtmlPath) && existsSync(exampleHtmlPath)) {
            const html = await readFile(exampleHtmlPath, 'utf8');
            await ctx.orchestrator.writePreviewHtmlRaw(project.id, html);
          }
        }
        return json(res, 200, { project: await ctx.orchestrator.load(project.id) });
      }

      // Set agent (runtime selection)
      const agentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/agent$/);
      if (agentMatch && agentMatch[1] && m === 'PUT') {
        const body = await readBody(req);
        const project = await ctx.orchestrator.setAgent(
          agentMatch[1],
          (body.agent_id as string) || null,
          body.agent_model === undefined ? undefined : ((body.agent_model as string) || null),
        );
        return json(res, 200, { project });
      }

      // Set variables (whole bag)
      const varsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/variables$/);
      if (varsMatch && varsMatch[1] && m === 'PUT') {
        const body = await readBody(req);
        const project = await ctx.orchestrator.setVariables(
          varsMatch[1],
          (body.variables as Record<string, unknown>) ?? {},
        );
        return json(res, 200, { project });
      }

      // Render preview HTML (legacy; v0.3+ uses chat-driven path)
      const prevMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/preview$/);
      if (prevMatch && prevMatch[1] && m === 'POST') {
        const { project, htmlPath } = await ctx.orchestrator.renderPreviewHtml(prevMatch[1]);
        return json(res, 200, {
          project,
          preview_url: `/preview/${project.id}`,
          html_path: htmlPath,
        });
      }

      // Get raw preview HTML (frontend reads to parse data-hv-text nodes)
      const rawGetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/raw-html$/);
      if (rawGetMatch && rawGetMatch[1] && m === 'GET') {
        const project = await ctx.orchestrator.load(rawGetMatch[1]);
        if (!project.lastPreviewHtmlPath || !existsSync(project.lastPreviewHtmlPath)) {
          return json(res, 404, { error: 'No preview HTML yet — pick a template or send a chat first' });
        }
        const html = await readFile(project.lastPreviewHtmlPath, 'utf8');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(html);
        return;
      }

      // Write raw preview HTML (frontend posts back the modified HTML
      // after the user edits a data-hv-text field in the middle column)
      if (rawGetMatch && rawGetMatch[1] && m === 'PUT') {
        const project = await ctx.orchestrator.load(rawGetMatch[1]);
        const ct = req.headers['content-type'] ?? '';
        let html: string;
        if (ct.includes('application/json')) {
          const body = await readBody(req);
          html = (body.html as string) ?? '';
        } else {
          html = await readBodyText(req);
        }
        if (!html || !/<\/html>/i.test(html)) {
          return json(res, 400, { error: 'Body must be a complete HTML document' });
        }
        await ctx.orchestrator.writePreviewHtmlRaw(project.id, html);
        return json(res, 200, { project: await ctx.orchestrator.load(project.id) });
      }

      // Frame-specific raw HTML — keeps frames[] intact (writePreviewHtmlRaw
      // resets the storyboard, which is wrong for multi-frame edits).
      const frameRawMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/frames\/([^/]+)\/raw-html$/);
      if (frameRawMatch && frameRawMatch[1] && frameRawMatch[2]) {
        const projId = frameRawMatch[1];
        const nodeId = frameRawMatch[2];
        if (m === 'GET') {
          const project = await ctx.orchestrator.load(projId);
          const frame = (project.frames ?? []).find((f) => f.graphNodeId === nodeId);
          if (!frame || !existsSync(frame.htmlPath)) {
            return json(res, 404, { error: `Frame ${nodeId} not found` });
          }
          const html = await readFile(frame.htmlPath, 'utf8');
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(html);
          return;
        }
        if (m === 'PUT') {
          const ct = req.headers['content-type'] ?? '';
          let html: string;
          if (ct.includes('application/json')) {
            const body = await readBody(req);
            html = (body.html as string) ?? '';
          } else {
            html = await readBodyText(req);
          }
          if (!html || !/<\/html>/i.test(html)) {
            return json(res, 400, { error: 'Body must be a complete HTML document' });
          }
          await ctx.orchestrator.writeFrameHtml(projId, nodeId, html);
          return json(res, 200, { ok: true });
        }
      }

      // Enhance a data frame with a native Remotion template (user-initiated
      // motion enhancement, RFC-08/09). Sets the frame's engine + renders a
      // short single-frame preview MP4 so the studio can play the native
      // animation before a full export. Streams SSE progress like export.
      const enhMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/frames\/([^/]+)\/enhance$/);
      if (enhMatch && enhMatch[1] && enhMatch[2] && m === 'POST') {
        const projectId = enhMatch[1];
        const nodeId = enhMatch[2];
        const body = await readBody(req).catch(() => ({} as Record<string, unknown>));
        const nativeTemplateId = (body.nativeTemplateId as string) || 'frame-data-rollup';
        const wantsStream = (req.headers.accept ?? '').includes('text/event-stream');
        if (!wantsStream) {
          try {
            await ctx.orchestrator.enhanceFrameNative(projectId, nodeId, nativeTemplateId);
            const { project } = await ctx.orchestrator.renderFrameNativePreview({ projectId, graphNodeId: nodeId });
            return json(res, 200, { ok: true, project, node_id: nodeId });
          } catch (err) {
            return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const sse = (obj: unknown) => {
          try { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); }
          catch { /* client gone — work keeps running, result is persisted */ }
        };
        const t0 = Date.now();
        try {
          sse({ type: 'enhance_started' });
          sse({ type: 'enhance_progress', pct: 5, stage: 'preparing' });
          await ctx.orchestrator.enhanceFrameNative(projectId, nodeId, nativeTemplateId);
          const { project } = await ctx.orchestrator.renderFrameNativePreview({
            projectId,
            graphNodeId: nodeId,
            onProgress: (pct, stage) => sse({ type: 'enhance_progress', pct, stage }),
          });
          const ms = Date.now() - t0;
          process.stderr.write(`[studio:enhance] proj=${projectId} frame=${nodeId} done in ${ms}ms\n`);
          sse({ type: 'enhance_done', project, node_id: nodeId, elapsed_ms: ms });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[studio:enhance] proj=${projectId} frame=${nodeId} failed: ${msg}\n`);
          sse({ type: 'enhance_failed', message: msg });
        }
        res.end();
        return;
      }

      // Revert a frame's native enhancement back to its base hyperframes HTML.
      // Instant (no render) — the original HTML at frame.htmlPath is untouched.
      const unenhMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/frames\/([^/]+)\/unenhance$/);
      if (unenhMatch && unenhMatch[1] && unenhMatch[2] && m === 'POST') {
        try {
          const { project } = await ctx.orchestrator.unenhanceFrame(unenhMatch[1], unenhMatch[2]);
          return json(res, 200, { ok: true, project, node_id: unenhMatch[2] });
        } catch (err) {
          return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Export MP4 — streams progress via SSE so the user sees per-frame
      // recording status during a multi-minute multi-frame export.
      const expMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/export$/);
      if (expMatch && expMatch[1] && m === 'POST') {
        const projectId = expMatch[1];
        // The studio uses the SSE branch by default. A plain POST (curl /
        // tests) gets the legacy blocking response.
        const wantsStream = (req.headers.accept ?? '').includes('text/event-stream');
        if (!wantsStream) {
          try {
            const { project, outputPath } = await ctx.orchestrator.exportMp4({ projectId });
            return json(res, 200, { project, output_path: outputPath });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return json(res, 500, { error: msg });
          }
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const sse = (obj: unknown) => {
          try { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); }
          catch { /* client gone — generation keeps running, result is persisted */ }
        };
        const t0 = Date.now();
        try {
          sse({ type: 'export_started' });
          const { project, outputPath } = await ctx.orchestrator.exportMp4({
            projectId,
            onProgress: (pct, stage) => {
              sse({ type: 'export_progress', pct, stage });
            },
          });
          const ms = Date.now() - t0;
          process.stderr.write(
            `[studio:export] proj=${projectId} done in ${ms}ms → ${outputPath}\n`,
          );
          sse({ type: 'export_done', output_path: outputPath, project, elapsed_ms: ms });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[studio:export] proj=${projectId} failed: ${msg}\n`);
          sse({ type: 'export_failed', message: msg });
        }
        res.end();
        return;
      }

      // Generate synthesized narration. Streams SSE progress like export. The
      // generated MP3 is stored as a project asset; its id lands in
      // project.soundtrack so exportMp4 mixes it in. Generation itself does
      // NOT need ffmpeg — only the export-time mux does.
      const genAudioMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/generate-audio$/);
      if (genAudioMatch && genAudioMatch[1] && m === 'POST') {
        const projectId = genAudioMatch[1];
        const body = (await readBody(req)) as {
          music?: { prompt?: string; instrumental?: boolean; volumeDb?: number };
          narration?: {
            text?: string;
            voiceId?: string;
            volumeDb?: number;
            languageBoost?: string;
            byFrame?: Record<string, string>;
            emotion?: string;
            scene?: string;
            rate?: number;
            volume?: number;
          };
        };
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const sse = (obj: unknown) => {
          try { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); }
          catch { /* client gone — generation keeps running, result is persisted */ }
        };
        try {
          sse({ type: 'audio_started' });
          if (body.music?.prompt?.trim()) {
            sse({ type: 'audio_failed', message: 'Background music generation is disabled.' });
            res.end();
            return;
          }

          const project = await ctx.orchestrator.load(projectId);
          const soundtrack = { ...(project.soundtrack ?? {}) };
          const wantNarration = !!body.narration?.text?.trim();
          if (!wantNarration) {
            sse({ type: 'audio_failed', message: 'Nothing to generate — provide narration text.' });
            res.end();
            return;
          }

          delete soundtrack.musicAssetId;
          delete soundtrack.musicPrompt;
          delete soundtrack.musicVolumeDb;
          delete soundtrack.fadeInSec;
          delete soundtrack.fadeOutSec;

          if (wantNarration) {
            sse({ type: 'audio_progress', stage: 'narration', message: 'generating narration…' });
            const narration = ctx.mediaConfig.resolveNarration();
            if (!narration) {
              throw new Error('Narration API key not configured - add it in Settings > Audio.');
            }
            const shared = {
              text: body.narration!.text!.trim(),
              ...(body.narration!.voiceId !== undefined && { voiceId: body.narration!.voiceId }),
            };
            const nar = narration.provider === 'bailian'
              ? await generateBailianTts({
                  ...shared,
                  model: body.narration!.voiceId
                    ? (ctx.mediaConfig.getClonedVoice(body.narration!.voiceId)?.model ?? narration.model)
                    : narration.model,
                  ...(body.narration!.emotion !== undefined && { emotion: body.narration!.emotion }),
                  ...(body.narration!.scene !== undefined && { scene: body.narration!.scene }),
                  ...(body.narration!.rate !== undefined && { rate: body.narration!.rate }),
                  ...(body.narration!.volume !== undefined && { volume: body.narration!.volume }),
                  creds: narration.creds,
                })
              : await generateTts({
                  ...shared,
                  ...(body.narration!.languageBoost !== undefined && { languageBoost: body.narration!.languageBoost }),
                  creds: narration.creds,
                });
            const { asset } = await ctx.orchestrator.addBufferAsset(
              projectId,
              nar.bytes,
              nar.ext,
              `narration · ${body.narration!.text!.trim().slice(0, 60)}`,
            );
            soundtrack.narrationAssetId = asset.id;
            soundtrack.narrationText = body.narration!.text!.trim();
            if (body.narration!.byFrame) soundtrack.narrationByFrame = body.narration!.byFrame;
            if (body.narration!.volumeDb !== undefined) soundtrack.narrationVolumeDb = body.narration!.volumeDb;
            sse({ type: 'audio_progress', stage: 'narration', message: nar.providerNote, asset_id: asset.id });
          }

          // Persist soundtrack onto the project (reload to avoid clobbering the
          // asset pushes addBufferAsset already saved).
          const fresh = await ctx.orchestrator.load(projectId);
          fresh.soundtrack = soundtrack;
          if (wantNarration && fresh.talkingHead?.enabled) {
            fresh.talkingHead.audioMode = 'synthetic';
          }
          await ctx.projects.save(fresh);
          sse({ type: 'audio_done', project: fresh, soundtrack });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[studio:generate-audio] proj=${projectId} failed: ${msg}\n`);
          sse({ type: 'audio_failed', message: msg });
        }
        res.end();
        return;
      }

      // ============== One-click narrate-to-video orchestration ==============
      // Turns a spoken-voiceover script (or a topic the agent expands into one)
      // into a finished narrated MP4 in a single SSE-streaming call:
      //   script/topic → split into N segments → content-graph (N text frames)
      //   → per-frame HTML via the agent → TTS narration → fit frame durations
      //   to the REAL audio length (ffprobe) → export MP4 (auto-muxes audio).
      // Reuses the same building blocks as the manual Storyboard → Narration
      // panel, just chains them so the user types a script and clicks once.
      const narrateMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/narrate$/);
      if (narrateMatch && narrateMatch[1] && m === 'POST') {
        const projectId = narrateMatch[1];
        if (GENERATING.has(projectId)) {
          return json(res, 409, { error: 'This project is already generating. Wait for the current run to finish.' });
        }
        const body = (await readBody(req)) as {
          script?: string;
          topic?: string;        // when script is omitted, agent expands this into a script first
          mode?: 'script' | 'topic';
          agentId?: string;
          agentModel?: string;
          voiceId?: string;
          volumeDb?: number;
          templateId?: string;
          aspect?: string;
        };
        const agentId = body.agentId;
        if (!agentId) return json(res, 400, { error: 'No agent selected.' });
        const agentDef = findAgent(agentId);
        if (!agentDef) return json(res, 400, { error: `agent "${agentId}" not registered` });
        const aspect = normalizeTemplateAspect(body.aspect ?? '16:9');
        const requestedNarrateTemplate = body.templateId
          ? ctx.templates.list().find((t) => t.id === body.templateId) ?? null
          : null;
        if (body.templateId && !requestedNarrateTemplate) {
          return json(res, 400, { error: `Template "${body.templateId}" not found.` });
        }
        if (requestedNarrateTemplate && !templateSupportsAspect(requestedNarrateTemplate, aspect)) {
          return json(res, 400, {
            error: `Template "${requestedNarrateTemplate.name_zh ?? requestedNarrateTemplate.name}" does not support ${aspect}. Choose a compatible template or use automatic selection.`,
          });
        }

        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const sse = (obj: unknown) => {
          try { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); }
          catch { /* client gone — pipeline keeps running, result is persisted */ }
        };
        const progress = (stage: string, messageKey: string) => sse({ type: 'narrate_progress', stage, message_key: messageKey });

        GENERATING.add(projectId);
        try {
          const projectDir = await ctx.projects.ensureDir(projectId);

          // ---- Step 1: obtain the spoken script + split into segments ----
          let script = (body.script ?? '').trim();
          const isTopicMode = (body.mode === 'topic') || (!script && !!body.topic?.trim());
          if (isTopicMode) {
            const topic = (body.topic ?? script ?? '').trim();
            if (!topic) throw new Error('Nothing to narrate — provide a script or a topic.');
            progress('script', 'narrate.progress.script');
            const expandPrompt = [
              `Write a short spoken voiceover script (~60-120 words) for a video about: "${topic}".`,
              `Output ONLY the spoken script as plain text — no headings, no markdown, no numbering.`,
              `Write it in the same language as the topic.`,
              `Make it natural to read aloud, with clear sentence boundaries.`,
            ].join('\n');
            script = (await callAgentSimple(agentDef, expandPrompt, projectDir, body.agentModel)).trim();
            if (!script) throw new Error('Agent returned an empty script.');
            sse({ type: 'narrate_script', script });
          }
          if (!script) throw new Error('Nothing to narrate — provide a script.');
          const selectedNarrateTemplate = requestedNarrateTemplate
            ?? autoSelectTemplate(ctx.templates.list(), {
                text: `${body.topic ?? ''}\n${script}`,
                aspect,
                mode: 'narrate',
              });
          if (selectedNarrateTemplate && !body.templateId) {
            sse({
              type: 'template_auto_selected',
              template_id: selectedNarrateTemplate.id,
              template_name: selectedNarrateTemplate.name_zh ?? selectedNarrateTemplate.name,
            });
          }

          // Split the script into per-frame segments (one sentence-group each).
          // Ask the agent for a JSON array so splits are semantic, not just on
          // punctuation. Hard-cap to 2-6 frames (enough to storyboard, not so
          // many that each frame is a single word).
          progress('split', 'narrate.progress.split');
          const targetFrames = Math.min(6, Math.max(2, Math.ceil(script.length / 40)));
          const splitPrompt = [
            `Split this voiceover script into ${targetFrames} segments, one per video frame, IN ORDER.`,
            `Keep the wording UNCHANGED — only choose where to cut.`,
            `Script:`,
            script,
            ``,
            `Output ONLY a JSON array of ${targetFrames} strings, each one a contiguous chunk of the script (in order, concatenated they must equal the whole script). No prose, no numbering.`,
          ].join('\n');
          let segments: string[] = [];
          const splitRaw = (await callAgentSimple(agentDef, splitPrompt, projectDir, body.agentModel)).trim();
          const jsonMatch = /\[[\s\S]*\]/.exec(splitRaw);
          if (jsonMatch) {
            try { segments = JSON.parse(jsonMatch[0]).map((s: unknown) => String(s).trim()).filter(Boolean); }
            catch { /* fall back below */ }
          }
          const normalizedSource = script.replace(/\s+/g, '');
          const normalizedSplit = segments.join('').replace(/\s+/g, '');
          if (segments.length !== targetFrames || normalizedSplit !== normalizedSource) {
            // The split must be positional metadata only. If the agent rewrites,
            // omits, duplicates, or returns the wrong count, use an exact local
            // split that preserves every source character in order.
            segments = splitNarrationSegments(script, targetFrames);
          }
          const fullNarrationText = script.trim();

          // ---- Steps 2-3: understand the script, plan the storyboard, and
          // design every frame with the selected template's visual language.
          // The old path immediately ran localTemplateFrameHtml() for selected
          // templates, which reduced generation to text substitution. The
          // shared split generator gives the agent both semantic planning and
          // per-frame composition/motion responsibility; local rendering is
          // retained only as the timeout/error fallback.
          {
            const [w, h] = resolutionForAspect(aspect);
            const proj = await ctx.projects.load(projectId);
            proj.preferences = { ...proj.preferences, resolution: { width: w, height: h } };
            proj.templateId = selectedNarrateTemplate?.id ?? null;
            await ctx.projects.save(proj);
          }
          progress('frames', 'narrate.progress.frames');
          await runSplitMultiFrameGenerate({
            ctx,
            projectId,
            projectDir,
            agentDef,
            agentModel: body.agentModel,
            tmpl: selectedNarrateTemplate,
            priorHtml: '',
            inputs: {
              collected: {
                aspect,
                frame_count: String(segments.length),
                per_frame: '3',
              },
              pickedType: '口播脚本视频',
              pickedStyle: selectedNarrateTemplate ? '从设计模板选择' : '内容驱动的专业视频设计',
              contentTurns: [
                `完整口播脚本：${fullNarrationText}`,
                ...segments.map((segment, index) => `第 ${index + 1} 帧口播原文（语义和事实必须保持）：${segment}`),
                `先理解每段的核心语义、事实、对象和关系，再设计画面信息层级与动画。禁止只把口播原文塞进模板或做成普通字幕卡。`,
              ],
            },
            attachments: [],
            fallbackFrameTexts: segments,
            openingTopic: fullNarrationText.slice(0, 160),
            restyleOnly: false,
            failOnAgentError: true,
            onProgress: (message) => sse({ type: 'narrate_design_progress', message }),
            onSse: (event) => {
              const detail = event as Record<string, unknown>;
              if (detail.type === 'plan_ready') {
                sse({ type: 'narrate_graph', frame_count: detail.frame_count, intent: detail.intent });
              } else if (detail.type === 'frame_done') {
                sse({
                  type: 'narrate_frame_done',
                  node_id: detail.node_id,
                  order: detail.order,
                  total: detail.total,
                });
              }
            },
          });
          const graph = await ctx.orchestrator.readContentGraph(projectId);
          if (!graph || graph.nodes.length === 0) {
            throw new Error('Storyboard generation produced no frames.');
          }

          // ---- Step 4: synthesize the narration TTS ----
          progress('audio', 'narrate.progress.audio');
          const narration = ctx.mediaConfig.resolveNarration();
          if (!narration) {
            throw new Error('Narration API key not configured — add it in Settings > Audio.');
          }
          const nar = narration.provider === 'bailian'
            ? await generateBailianTts({
                text: fullNarrationText,
                ...(body.voiceId !== undefined && { voiceId: body.voiceId }),
                model: body.voiceId
                  ? (ctx.mediaConfig.getClonedVoice(body.voiceId)?.model ?? narration.model)
                  : narration.model,
                creds: narration.creds,
              })
            : await generateTts({
                text: fullNarrationText,
                ...(body.voiceId !== undefined && { voiceId: body.voiceId }),
                creds: narration.creds,
              });
          const { asset: narAsset } = await ctx.orchestrator.addBufferAsset(
            projectId,
            nar.bytes,
            nar.ext,
            `narration · ${fullNarrationText.slice(0, 60)}`,
          );
          const narrationByFrame = Object.fromEntries(graph.nodes.map((n, i) => [n.id, segments[i] ?? '']));
          const fresh = await ctx.orchestrator.load(projectId);
          fresh.soundtrack = {
            ...(fresh.soundtrack ?? {}),
            narrationAssetId: narAsset.id,
            narrationText: fullNarrationText,
            narrationByFrame,
            ...(body.volumeDb !== undefined && { narrationVolumeDb: body.volumeDb }),
          };
          await ctx.projects.save(fresh);
          sse({ type: 'narrate_audio_done', asset_id: narAsset.id });

          // ---- Step 5: fit frame durations to the REAL audio length ----
          progress('fit', 'narrate.progress.fit');
          const totalChars = segments.reduce((s, seg2) => s + seg2.trim().length, 0);
          const audioDur = narAsset.path ? await probeMediaDurationSec(narAsset.path) : NaN;
          let fitSource: 'audio' | 'estimate' = 'estimate';
          const updatedGraph = await ctx.orchestrator.readContentGraph(projectId);
          if (updatedGraph && Number.isFinite(audioDur) && audioDur > 0 && totalChars > 0) {
            fitSource = 'audio';
            const MIN = 2;
            // Each frame's share of the real audio length, by char count.
            let durs = updatedGraph.nodes.map((n) => {
              const seg2 = narrationByFrame[n.id] ?? '';
              const d = Math.max(MIN, Math.round((seg2.trim().length / totalChars) * audioDur));
              return { n, d };
            });
            const sum = durs.reduce((s, x) => s + x.d, 0);
            if (sum !== Math.round(audioDur) && durs.length) {
              const longest = durs.reduce((a, b) => (b.d > a.d ? b : a));
              longest.d = Math.max(MIN, longest.d + (Math.round(audioDur) - sum));
            }
            for (const { n, d } of durs) n.durationSec = d;
            await ctx.orchestrator.writeContentGraph(projectId, updatedGraph, { preserveFrames: true });
          }

          // ---- Step 6: export MP4 (auto-muxes the narration) ----
          progress('export', 'narrate.progress.export');
          const { project: renderedProj, outputPath } = await ctx.orchestrator.exportMp4({
            projectId,
            onProgress: (pct, stage) => sse({ type: 'narrate_export_progress', pct, stage }),
          });
          sse({
            type: 'narrate_done',
            project: renderedProj,
            mp4_path: outputPath,
            mp4_filename: basename(outputPath),
            audio_duration_sec: Number.isFinite(audioDur) ? audioDur : null,
            fit_source: fitSource,
            frame_count: graph.nodes.length,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[studio:narrate] proj=${projectId} failed: ${msg}\n`);
          sse({ type: 'narrate_failed', message: msg });
        } finally {
          GENERATING.delete(projectId);
        }
        res.end();
        return;
      }

      // Draft a narration script from the project's already-generated frames.
      // Reads the content-graph (per-frame text) and asks the agent for a short
      // spoken voiceover IN THE SAME LANGUAGE as that text. Returns plain JSON
      // { narration } — the user edits it before generating audio.
      const draftNarrMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/draft-narration$/);
      if (draftNarrMatch && draftNarrMatch[1] && m === 'POST') {
        const projectId = draftNarrMatch[1];
        try {
          // body.frameId set → draft ONLY that frame (single-frame regenerate).
          // unset → draft every frame (global). Either way returns a per-frame map.
          const body = (await readBody(req)) as { agentId?: string; frameId?: string };
          const graph = await ctx.orchestrator.readContentGraph(projectId);
          if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
            return json(res, 400, { error: 'No frames yet — generate the video first.' });
          }
          if (!body.agentId) return json(res, 400, { error: 'No agent selected.' });
          const agentDef = findAgent(body.agentId);
          if (!agentDef) return json(res, 400, { error: `agent "${body.agentId}" not registered` });
          const projectDir = await ctx.projects.ensureDir(projectId);
          // Only TextNode carries copy; fall back to label/id for entity/data.
          const nodeText = (n: typeof graph.nodes[number]): string =>
            (n.kind === 'text' ? n.text : undefined) ?? n.label ?? n.id;
          const allFrames = graph.nodes.map((n, i) => ({ id: n.id, idx: i, text: nodeText(n).replace(/\n/g, ' ').slice(0, 240) }));
          const frameLines = allFrames.map((f) => `${f.idx + 1}. ${f.text}`).join('\n');

          const narrationByFrame: Record<string, string> = {};

          if (body.frameId) {
            // ---- single frame: narrate just this one, with the rest as context ----
            const target = allFrames.find((f) => f.id === body.frameId);
            if (!target) return json(res, 400, { error: `frame "${body.frameId}" not in content-graph` });
            const prompt = [
              `This is a ${allFrames.length}-frame video. Write the spoken NARRATION for FRAME ${target.idx + 1} ONLY.`,
              ``,
              `All frames (for context):`,
              frameLines,
              ``,
              graph.synopsis ? `Synopsis: ${graph.synopsis}` : '',
              ``,
              `Write ONE short spoken sentence narrating frame ${target.idx + 1} ("${target.text}") specifically — distinct, not generic.`,
              `Same language as the frame text. Plain text only: just the sentence, no numbering, quotes, or markdown.`,
            ].filter((l) => l !== undefined).join('\n');
            const raw = (await callAgentSimple(agentDef, prompt, projectDir)).trim();
            const line = raw.split('\n').map((l) => l.replace(/^\s*(?:\d+[.)、]|[-*•])\s*/, '').trim()).find((l) => l.length > 0) ?? raw;
            narrationByFrame[target.id] = line;
          } else {
            // ---- global: one line per frame, in order ----
            const prompt = [
              `Write a spoken NARRATION script for this ${allFrames.length}-frame video — ONE line per frame, IN FRAME ORDER.`,
              ``,
              `Frames (in order):`,
              frameLines,
              ``,
              graph.synopsis ? `Synopsis: ${graph.synopsis}` : '',
              ``,
              `Rules:`,
              `- Output EXACTLY ${allFrames.length} lines, one per frame, in the SAME order. Line 1 narrates frame 1, etc.`,
              `- Each line is ONE short spoken sentence about THAT specific frame's content — distinct per frame, not a generic restatement.`,
              `- The lines should still flow as a continuous voiceover read top to bottom.`,
              `- Same language as the frame text. Plain text only: one sentence per line, no numbering, bullets, blank lines, or markdown.`,
            ].filter((l) => l !== undefined).join('\n');
            const raw = (await callAgentSimple(agentDef, prompt, projectDir)).trim();
            const lines = raw.split('\n').map((l) => l.replace(/^\s*(?:\d+[.)、]|[-*•])\s*/, '').trim()).filter((l) => l.length > 0);
            // Map lines onto frames positionally; if the model under/over-produced,
            // pair as far as they line up and leave the rest blank.
            allFrames.forEach((f, i) => { if (lines[i]) narrationByFrame[f.id] = lines[i]!; });
          }
          return json(res, 200, { narrationByFrame });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[studio:draft-narration] proj=${projectId} failed: ${msg}\n`);
          return json(res, 500, { error: msg });
        }
      }

      // Clear a project's soundtrack (keeps the asset files, just drops the
      // references so the next export has no audio).
      const clearAudioMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/soundtrack$/);
      if (clearAudioMatch && clearAudioMatch[1] && m === 'DELETE') {
        const project = await ctx.orchestrator.load(clearAudioMatch[1]);
        delete project.soundtrack;
        await ctx.projects.save(project);
        return json(res, 200, { project });
      }

      // Reveal an exported file in the OS file browser. macOS: `open -R`
      // opens Finder with the file selected. Other platforms fall through
      // to a plain `open` which the OS handles best-effort.
      const revealMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/reveal$/);
      if (revealMatch && revealMatch[1] && m === 'POST') {
        const project = await ctx.orchestrator.load(revealMatch[1]);
        const target = project.lastOutputMp4Path;
        if (!target || !existsSync(target)) {
          return json(res, 404, { error: 'No exported MP4 to reveal' });
        }
        const { spawn } = await import('node:child_process');
        const platform = process.platform;
        const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';
        const args = platform === 'darwin' ? ['-R', target] : [target];
        spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
        return json(res, 200, { ok: true, target, platform });
      }

      // MiniMax audio API config — GET status (masked), POST to save, DELETE to clear.
      // Lets users configure the key in the Settings UI instead of env vars.
      if (url.pathname === '/api/config/minimax' && m === 'GET') {
        return json(res, 200, ctx.mediaConfig.getMinimaxStatus());
      }
      if (url.pathname === '/api/config/minimax' && m === 'POST') {
        const body = (await readBody(req)) as { apiKey?: string; baseUrl?: string };
        const key = (body.apiKey ?? '').trim();
        if (!key) return json(res, 400, { error: 'apiKey is required' });
        ctx.mediaConfig.setMinimax(key, body.baseUrl);
        return json(res, 200, ctx.mediaConfig.getMinimaxStatus());
      }
      if (url.pathname === '/api/config/minimax' && m === 'DELETE') {
        ctx.mediaConfig.clearMinimax();
        return json(res, 200, ctx.mediaConfig.getMinimaxStatus());
      }

      if (url.pathname === '/api/config/narration' && m === 'GET') {
        return json(res, 200, ctx.mediaConfig.getNarrationStatus());
      }
      if (url.pathname === '/api/config/narration' && m === 'POST') {
        const body = (await readBody(req)) as {
          provider?: 'minimax' | 'bailian';
          model?: 'cosyvoice-v3.5-plus' | 'cosyvoice-v3.5-flash' | 'cosyvoice-v3-plus' | 'cosyvoice-v3-flash' | 'cosyvoice-v2';
          apiKey?: string;
          baseUrl?: string;
        };
        ctx.mediaConfig.setNarration({
          provider: body.provider === 'bailian' ? 'bailian' : 'minimax',
          ...(body.model ? { model: body.model } : {}),
          ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
          ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
        });
        return json(res, 200, ctx.mediaConfig.getNarrationStatus());
      }
      if (url.pathname === '/api/config/narration' && m === 'DELETE') {
        ctx.mediaConfig.clearNarration();
        return json(res, 200, ctx.mediaConfig.getNarrationStatus());
      }

      if (url.pathname === '/api/config/narration/voices' && m === 'GET') {
        return json(res, 200, ctx.mediaConfig.listClonedVoices());
      }
      if (url.pathname === '/api/config/narration/voices' && m === 'POST') {
        try {
          const body = (await readBody(req)) as {
            name?: string;
            audioUrl?: string;
            model?: string;
            languageHint?: string;
            languageHints?: string[];
          };
          const creds = ctx.mediaConfig.resolveBailian();
          if (!creds) return json(res, 400, { error: 'Bailian API key is not configured' });
          const audioUrl = (body.audioUrl ?? '').trim();
          if (!audioUrl) return json(res, 400, { error: 'Remote audio URL is required.' });
          const model = normalizeCosyVoiceModelField(body.model);
          const result = await cloneBailianCosyVoice({
            prefix: createCosyVoicePrefix(),
            audioUrl,
            model,
            ...(body.languageHint
              ? { languageHints: [body.languageHint] }
              : Array.isArray(body.languageHints) ? { languageHints: body.languageHints } : {}),
            creds,
          });
          ctx.mediaConfig.addClonedVoice({
            id: result.voiceId,
            name: (body.name ?? '').trim() || 'My voice',
            model: result.model,
            audioUrl,
            createdAt: new Date().toISOString(),
          });
          return json(res, 200, {
            ...ctx.mediaConfig.listClonedVoices(),
            created: result.voiceId,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[studio:voice-clone-compat] failed: ${message}\n`);
          return json(res, 500, { error: message });
        }
      }
      if (url.pathname === '/api/config/narration/voices/from-url' && m === 'POST') {
        try {
          const body = (await readBody(req)) as {
            name?: string;
            audioUrl?: string;
            model?: string;
            languageHint?: string;
          };
          const creds = ctx.mediaConfig.resolveBailian();
          if (!creds) return json(res, 400, { error: 'Bailian API key is not configured' });
          const audioUrl = (body.audioUrl ?? '').trim();
          if (!audioUrl) return json(res, 400, { error: 'Remote audio URL is required.' });
          const model = normalizeCosyVoiceModelField(body.model);
          const result = await cloneBailianCosyVoice({
            prefix: createCosyVoicePrefix(),
            audioUrl,
            model,
            ...(body.languageHint ? { languageHints: [body.languageHint] } : {}),
            creds,
          });
          ctx.mediaConfig.addClonedVoice({
            id: result.voiceId,
            name: (body.name ?? '').trim() || 'My voice',
            model: result.model,
            audioUrl,
            createdAt: new Date().toISOString(),
          });
          return json(res, 200, {
            ...ctx.mediaConfig.listClonedVoices(),
            created: result.voiceId,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[studio:voice-clone-url] failed: ${message}\n`);
          return json(res, 500, { error: message });
        }
      }
      if (url.pathname === '/api/config/narration/voices/recording' && m === 'POST') {
        try {
          const ct = req.headers['content-type'] ?? '';
          if (!ct.startsWith('multipart/form-data')) {
            return json(res, 400, { error: 'Upload a recorded audio file.' });
          }
          const creds = ctx.mediaConfig.resolveBailian();
          if (!creds) return json(res, 400, { error: 'Bailian API key is not configured' });
          const parts = await receiveMultipart(req, ct);
          const file = parts.find((p): p is Extract<MultipartPart, { kind: 'file' }> => p.kind === 'file' && p.name === 'audio')
            ?? parts.find((p): p is Extract<MultipartPart, { kind: 'file' }> => p.kind === 'file');
          if (!file) return json(res, 400, { error: 'Audio recording is required.' });
          const fields = Object.fromEntries(
            parts
              .filter((p): p is Extract<MultipartPart, { kind: 'field' }> => p.kind === 'field')
              .map((p) => [p.name, p.value]),
          );
          const model = normalizeCosyVoiceModelField(fields.model);
          const name = (fields.name ?? '').trim() || 'My voice';
          const sample = await persistVoiceCloneSample(ctx.projectRoot, file.tmpPath, file.filename);
          const publicBaseUrl = resolvePublicBaseUrl(req);
          process.stderr.write(`[studio:voice-clone] sample=${sample.filename} publicBase=${publicBaseUrl || 'none'} model=${model}\n`);
          const audioUrl = publicBaseUrl
            ? `${publicBaseUrl}/voice-samples/${encodeURIComponent(sample.filename)}`
            : DEFAULT_COSYVOICE_SAMPLE_URL;
          if (publicBaseUrl) {
            await assertVoiceSampleReachable(audioUrl);
          } else {
            process.stderr.write('[studio:voice-clone] no public base URL; using default Bailian sample URL\n');
          }
          const result = await cloneBailianCosyVoice({
            prefix: createCosyVoicePrefix(),
            audioUrl,
            model,
            ...(fields.languageHint ? { languageHints: [fields.languageHint] } : {}),
            creds,
          });
          ctx.mediaConfig.addClonedVoice({
            id: result.voiceId,
            name,
            model: result.model,
            audioUrl,
            createdAt: new Date().toISOString(),
          });
          return json(res, 200, {
            ...ctx.mediaConfig.listClonedVoices(),
            created: result.voiceId,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[studio:voice-clone] failed: ${message}\n`);
          return json(res, 500, { error: message });
        }
      }
      const clonedVoiceMatch = url.pathname.match(/^\/api\/config\/narration\/voices\/([^/]+)$/);
      if (clonedVoiceMatch?.[1] && m === 'PATCH') {
        const id = decodeURIComponent(clonedVoiceMatch[1]);
        const body = (await readBody(req)) as { name?: string; isDefault?: boolean };
        const voice = ctx.mediaConfig.updateClonedVoice(id, body);
        return json(res, 200, { voice, ...ctx.mediaConfig.listClonedVoices() });
      }
      if (clonedVoiceMatch?.[1] && m === 'DELETE') {
        const id = decodeURIComponent(clonedVoiceMatch[1]);
        ctx.mediaConfig.removeClonedVoice(id);
        return json(res, 200, ctx.mediaConfig.listClonedVoices());
      }

      // Agents (detected on each call; cheap thanks to the in-process cache)
      if (url.pathname === '/api/agents' && m === 'GET') {
        const force = url.searchParams.get('force') === '1';
        const agents = await detectAll(force ? { force: true } : undefined);
        return json(res, 200, { agents });
      }

      // Agent models — currently AMR only. Lists the live `vela model list`
      // catalog so the UI can offer a model picker (deepseek/claude/gpt/…).
      const modelsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/models$/);
      if (modelsMatch && modelsMatch[1] && m === 'GET') {
        const agentId = modelsMatch[1];
        if (agentId !== 'amr') return json(res, 200, { models: [] });
        const def = findAgent(agentId);
        if (!def) return json(res, 404, { error: `agent "${agentId}" not registered` });
        const { resolveBin, listAmrModels } = await import('@html-video/runtime');
        const bin = await resolveBin(def);
        if (!bin) return json(res, 400, { error: 'vela binary not found' });
        try {
          const models = await listAmrModels(bin);
          return json(res, 200, { models, default: def.defaultModel ?? null });
        } catch (err) {
          return json(res, 200, { models: [], error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Agent login — currently AMR/vela only. Spawns `vela login`, which opens
      // the browser for OAuth; we wait for the process to exit (auth complete or
      // cancelled). The user signs in with their OWN Open Design account.
      const loginMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/login$/);
      if (loginMatch && loginMatch[1] && m === 'POST') {
        const agentId = loginMatch[1];
        if (agentId !== 'amr') return json(res, 400, { error: `agent "${agentId}" has no login flow` });
        const def = findAgent(agentId);
        if (!def) return json(res, 404, { error: `agent "${agentId}" not registered` });
        const { resolveBin } = await import('@html-video/runtime');
        const bin = await resolveBin(def);
        if (!bin) return json(res, 400, { error: 'vela binary not found' });
        try {
          const { spawn } = await import('node:child_process');
          const code = await new Promise<number>((resolveCode, rejectCode) => {
            const child = spawn(bin, ['login'], { stdio: 'ignore' });
            // vela login opens the browser itself; it exits once auth completes
            // or is cancelled. Cap the wait so a never-finished login can't hang.
            const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* */ } rejectCode(new Error('login timed out (5 min)')); }, 5 * 60_000);
            child.on('error', (e: Error) => { clearTimeout(timer); rejectCode(e); });
            child.on('exit', (c: number | null) => { clearTimeout(timer); resolveCode(c ?? -1); });
          });
          if (code !== 0) return json(res, 400, { ok: false, error: `vela login exited with code ${code}` });
          // Re-detect (force) so the agent flips to available immediately.
          const agents = await detectAll({ force: true });
          const amr = agents.find((a) => a.id === 'amr');
          return json(res, 200, { ok: !!amr?.available, available: !!amr?.available, ...(amr?.hint && { hint: amr.hint }) });
        } catch (err) {
          return json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Agent smoke test — fires a tiny prompt at the requested agent and
      // reports timing + bytes. Used by the Settings modal so the user can
      // confirm a CLI is actually responding (not just on PATH).
      const testMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/test$/);
      if (testMatch && testMatch[1] && m === 'POST') {
        const agentId = testMatch[1];
        const def = findAgent(agentId);
        if (!def) return json(res, 404, { error: `agent "${agentId}" not registered` });
        const prompt = 'Reply with one word: hello.';
        const t0 = Date.now();
        try {
          const out = await callAgentSimple(def, prompt, process.cwd(), undefined, 45_000);
          return json(res, 200, {
            ok: true,
            exit_code: 0,
            ms: Date.now() - t0,
            bytes: out.length,
            stdout_head: out.slice(0, 200),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return json(res, 200, {
            ok: false,
            exit_code: 1,
            ms: Date.now() - t0,
            bytes: 0,
            stdout_head: '',
            error: summarizeAgentFailure(message),
          });
        }
      }

      // Messages: GET history (lazy-loads from messages.json on first hit)
      const msgsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/messages$/);
      if (msgsMatch && msgsMatch[1] && m === 'GET') {
        const arr = await loadMessages(ctx, msgsMatch[1]);
        return json(res, 200, { messages: arr });
      }

      // Messages: POST = send + stream agent reply via SSE
      // v0.5: accepts multipart (text + files) OR JSON. Files become real
      // project assets via AssetStore; their paths are passed to the agent
      // prompt as attachments.
      if (msgsMatch && msgsMatch[1] && m === 'POST') {
        const id = msgsMatch[1];
        if (GENERATING.has(id)) {
          return json(res, 409, { error: 'This project is already generating. Wait for the current run to finish.' });
        }
        const ct = req.headers['content-type'] ?? '';
        let userText = '';
        let focusFrameId = '';
        const attachments: Attachment[] = [];

        const project0 = await ctx.orchestrator.load(id);
        const sourceEvents: Array<Record<string, unknown>> = [];
        if (ct.startsWith('multipart/form-data')) {
          const parts = await receiveMultipart(req, ct);
          for (const p of parts) {
            if (p.kind === 'field' && p.name === 'content') {
              userText = p.value;
            } else if (p.kind === 'field' && p.name === 'focus_frame_id') {
              focusFrameId = p.value;
            } else if (p.kind === 'file') {
              const updatedProject = await ctx.orchestrator.addFileAsset(id, p.tmpPath);
              const newAsset = updatedProject.assets[updatedProject.assets.length - 1];
              if (newAsset) {
                const att: Attachment = {
                  path: newAsset.path ?? p.tmpPath,
                  kind: newAsset.type as Attachment['kind'],
                  filename: p.filename,
                  size: newAsset.metadata.sizeBytes ?? 0,
                };
                // Inline small text/data uploads so the agent (incl. HTTP ones)
                // actually sees the content, not just a local path.
                if ((newAsset.type === 'text' || newAsset.type === 'data') && newAsset.path) {
                  try {
                    const txt = await readFile(newAsset.path, 'utf8');
                    if (txt.length <= 20_000) att.inlineText = txt;
                  } catch { /* fall back to path-only */ }
                }
                attachments.push(att);
              }
            }
          }
        } else {
          const body = await readBody(req);
          userText = (body.content as string) ?? '';
          focusFrameId = (body.focus_frame_id as string) ?? '';
        }

        if (!userText && attachments.length === 0) {
          return json(res, 400, { error: 'content or attachments required' });
        }

        // External content sources: any URL (web article or GitHub repo) in the
        // user's message is fetched server-side and turned into a text asset, so
        // the offline agent can base the video on it. Reuses the attachment
        // pipeline (kind:'text' flows into the prompt downstream). Lossless
        // degradation: a fetch that fails is logged and skipped, never a 400.
        for (const sourceUrl of extractUrls(userText)) {
          try {
            const src = await fetchSource(sourceUrl);
            const label = src.kind === 'repo' ? 'GitHub repo' : 'Web article';
            const updated = await ctx.orchestrator.addInlineAsset(
              id,
              src.markdown,
              'text',
              `${label}: ${src.title || sourceUrl}`,
            );
            const asset = updated.assets[updated.assets.length - 1];
            if (asset?.path) {
              let host = sourceUrl;
              try { host = new URL(sourceUrl).hostname; } catch { /* keep raw */ }
              attachments.push({
                path: asset.path,
                kind: 'text',
                filename: `${host}.md`,
                size: src.markdown.length,
                inlineText: src.markdown,
              });
              process.stderr.write(
                `[studio:fetch-source] ${src.kind} ${sourceUrl} → ${src.markdown.length} chars${src.truncated ? ' (truncated)' : ''}\n`,
              );
              sourceEvents.push({
                type: 'source_status',
                status: 'ok',
                url: sourceUrl,
                title: src.title || sourceUrl,
                kind: src.kind,
                truncated: src.truncated,
              });
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            process.stderr.write(`[studio:fetch-source] skip ${sourceUrl}: ${msg}\n`);
            sourceEvents.push({
              type: 'source_status',
              status: 'failed',
              url: sourceUrl,
              message: msg,
            });
          }
        }

        // Re-fetch project after potential addFileAsset side-effects
        let project = await ctx.orchestrator.load(id);
        let tmpl = project.templateId ? ctx.templates.get(project.templateId) : null;
        if (!tmpl) {
          const autoTemplate = autoSelectTemplate(ctx.templates.list(), {
            text: [
              userText,
              ...attachments.map((a) => `${a.filename} ${a.inlineText ?? ''}`),
              ...project.assets.map((a) => `${a.metadata.filename ?? ''} ${a.metadata.userCaption ?? ''}`),
            ].join('\n'),
            aspect: String(project.preferences.resolution?.width && project.preferences.resolution?.height
              ? `${project.preferences.resolution.width}:${project.preferences.resolution.height}`
              : '16:9'),
            mode: 'chat',
          });
          if (autoTemplate) {
            project = await ctx.orchestrator.setTemplate(id, autoTemplate.id);
            tmpl = autoTemplate;
            sourceEvents.push({
              type: 'template_auto_selected',
              template_id: autoTemplate.id,
              template_name: autoTemplate.name_zh ?? autoTemplate.name,
            });
          }
        }

        // Resolve the agent. Pinned project agent wins. Otherwise pick the first
        // available agent that needs no extra setup (skip AMR — it's available
        // but billed/needs balance, so it must be an explicit choice, not a
        // silent default). anthropic-api is the final HTTP fallback. This keeps
        // "what the toolbar shows" === "what actually runs".
        let agentId = project.agentId;
        let detectedAgents: Awaited<ReturnType<typeof detectAll>> | null = null;
        if (!agentId) {
          detectedAgents = await detectAll();
          // Prefer a real, ready-to-run CLI agent (claude/codex/…). Only fall
          // back to anthropic-api if it's actually configured (has a key) —
          // otherwise picking it would fail mid-flow with "No ANTHROPIC_API_KEY"
          // on a later turn (e.g. after the detect cache expires and a transient
          // probe miss drops the CLI agent). Persist the choice so every
          // subsequent turn in this project uses the same agent, not whatever
          // a fresh probe happens to return.
          const ready = detectedAgents.filter((a) => a.available && a.id !== 'amr');
          const apiReady = ready.find((a) => a.id === 'anthropic-api');
          agentId =
            ready.find((a) => a.id !== 'anthropic-api')?.id ??
            apiReady?.id ??
            'anthropic-api';
          if (project.agentId !== agentId) {
            try {
              await ctx.orchestrator.setAgent(id, agentId, undefined);
            } catch {
              /* persist is best-effort; resolution above still holds for this turn */
            }
          }
        }
        detectedAgents ??= await detectAll();
        let agentAvailable = !!detectedAgents.find((a) => a.id === agentId)?.available;
        if (!agentAvailable) {
          const fallbackAgent = detectedAgents.find((a) => a.available && a.id !== 'amr');
          if (!fallbackAgent) {
            return json(res, 400, { error: `agent "${agentId}" is unavailable and no fallback agent is ready` });
          }
          process.stderr.write(`[studio:msg] proj=${id} agent=${agentId} unavailable; falling back to ${fallbackAgent.id}\n`);
          agentId = fallbackAgent.id;
          agentAvailable = true;
          try {
            await ctx.orchestrator.setAgent(id, agentId, null);
          } catch { /* best-effort; this request can still proceed */ }
        }
        const agentDef = findAgent(agentId);
        if (!agentDef) {
          return json(res, 400, { error: `agent "${agentId}" not registered` });
        }
        // Model the user picked for this agent (AMR); undefined → agent default.
        const agentModel = project.agentModel ?? undefined;

        // Append user message to history (with attachment summary)
        const attachmentSummary = attachments.length > 0
          ? `\n\n📎 ${attachments.length} attachment(s): ${attachments.map((a) => a.filename).join(', ')}`
          : '';
        const history = await loadMessages(ctx, id);
        history.push({
          role: 'user',
          content: userText + attachmentSummary,
          ts: Date.now(),
        });
        MESSAGES.set(id, history);
        // Persist immediately so the user message survives even if the
        // streaming agent call below crashes mid-flight.
        await saveMessages(ctx, id, history);

        // Compose prompt — template-aware OR template-free
        const projectDir = await ctx.projects.ensureDir(id);
        // Frame focus: when iterating, the user can pin a specific frame
        // so the next turn only rewrites that frame's HTML instead of the
        // whole-project preview.html.
        const focusFrame = focusFrameId
          ? (project.frames ?? []).find((f) => f.graphNodeId === focusFrameId)
          : undefined;
        const focusFrameHtml = focusFrame && existsSync(focusFrame.htmlPath)
          ? await readFile(focusFrame.htmlPath, 'utf8')
          : '';
        const priorHtmlPath = join(projectDir, 'preview.html');
        const priorHtml = focusFrameHtml
          || (existsSync(priorHtmlPath) ? await readFile(priorHtmlPath, 'utf8') : '');
        let exampleHtml = '';
        if (tmpl) {
          const exampleHtmlPath = join(tmpl.__dir!, tmpl.source_entry);
          if (existsSync(exampleHtmlPath)) {
            exampleHtml = await readFile(exampleHtmlPath, 'utf8');
          }
        }

        // Carry source material across turns: a link/file is usually attached
        // on an early turn (e.g. while picking a content type), but generation
        // happens several turns later with no attachment on that request. Merge
        // the project's stored text/data assets (fetched articles/repos,
        // uploaded docs) into this turn's attachments so they reach the prompt.
        const seenPaths = new Set(attachments.map((a) => a.path));
        for (const asset of project.assets) {
          if ((asset.type === 'text' || asset.type === 'data') && asset.path && !seenPaths.has(asset.path)) {
            let inlineText: string | undefined;
            try {
              const txt = await readFile(asset.path, 'utf8');
              if (txt.length <= 20_000) inlineText = txt;
            } catch { /* path-only fallback */ }
            attachments.push({
              path: asset.path,
              kind: asset.type as Attachment['kind'],
              filename: asset.metadata.filename ?? `${asset.type}-${asset.id.slice(0, 8)}`,
              size: asset.metadata.sizeBytes ?? 0,
              ...(inlineText !== undefined && { inlineText }),
            });
            seenPaths.add(asset.path);
          }
        }

        const talkingHeadTranscript = await readTalkingHeadTranscript(project);
        if (talkingHeadTranscript && shouldHandleLocalTalkingHeadFlow(userText, history, agentAvailable)) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          const sseWrite = (obj: unknown) => {
            try { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); }
            catch { /* client disconnected */ }
          };
          GENERATING.add(id);
          try {
            const result = await handleLocalTalkingHeadFlow({
              ctx,
              projectId: id,
              project,
              transcript: talkingHeadTranscript,
              history,
              userText,
            });
            const message = result.message;
            sseWrite({ type: 'text', chunk: message });
            if (result.frameCount) {
              sseWrite({ type: 'preview_ready', preview_url: `/preview/${id}`, frames: result.frameCount });
            }
            sseWrite({ type: 'message_end', reason: 'ok' });
            history.push({
              role: 'assistant',
              agent: 'local-transcript',
              content: message,
              ts: Date.now(),
            });
            MESSAGES.set(id, history);
            await saveMessages(ctx, id, history);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const message = `⚠️ 本地字幕生成失败：${msg}`;
            sseWrite({ type: 'text', chunk: message });
            sseWrite({ type: 'message_end', reason: 'error' });
            history.push({ role: 'assistant', agent: 'local-transcript', content: message, ts: Date.now() });
            MESSAGES.set(id, history);
            await saveMessages(ctx, id, history);
          } finally {
            GENERATING.delete(id);
          }
          void project0;
          res.end();
          return;
        }

        const fullPrompt = buildHtmlGenerationPrompt({
          tmpl,
          exampleHtml,
          priorHtml,
          history,
          userText,
          attachments,
          focusFrameId: focusFrameId || undefined,
          openingTopic: resolveOpeningTopic(project, history),
        });
        const phaseInfo = detectPhase(
          history,
          userText,
          !!project.templateId,
          attachments.some((a) => !!a.inlineText),
          focusFrameId,
          (project.frames ?? []).length > 0,
        );
        const t0 = Date.now();
        // Save the prompt next to the project so we can inspect what we sent.
        // Also dump the previous one as .prev for diffing across turns.
        const promptDumpPath = join(projectDir, 'last-prompt.txt');
        try {
          if (existsSync(promptDumpPath)) {
            const prev = await readFile(promptDumpPath, 'utf8');
            const fs = await import('node:fs/promises');
            await fs.writeFile(join(projectDir, 'last-prompt.prev.txt'), prev, 'utf8');
          }
          const fs = await import('node:fs/promises');
          await fs.writeFile(promptDumpPath, fullPrompt, 'utf8');
        } catch {/* non-fatal */}
        process.stderr.write(
          `[studio:msg] proj=${id} phase=${phaseInfo.phase} prompt=${fullPrompt.length}B user=${JSON.stringify(userText.slice(0, 80))} attachments=${attachments.length}\n`,
        );

        // Mark this project as generating so a returning client knows the task
        // is still alive. Cleared in the finally below (covers all exit paths).
        GENERATING.add(id);
        try {

        // SSE response
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });

        // Tolerant write: if the client navigated away (switched project) the
        // socket is gone and res.write throws. Swallow it so generation keeps
        // running to completion and still persists to messages.json — the user
        // sees the finished result when they come back, instead of a killed task.
        const sseWrite = (obj: unknown) => {
          try { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); }
          catch { /* client disconnected — keep generating, result is persisted below */ }
        };
        for (const ev of sourceEvents) sseWrite(ev);

        let assistantText = '';
        let textChunks = 0;
        let summaryLine = '';

        // ---- generate-phase: multi-frame path runs split (graph + per-frame) ----
        // Empirically claude --print returns 1 byte ~50% of the time when asked
        // to emit a graph and 4-6 full HTML pages in a single response. Each
        // call individually is reliable, so we orchestrate them ourselves and
        // stream progress events to the UI.
        const isMultiGenerate =
          phaseInfo.phase === 'generate' &&
          Number(phaseInfo.inputs.collected?.frame_count ?? '1') > 1;

        // Post-generation iteration: the card-driven sub-flow resolved to a
        // concrete change. Re-use the existing storyboard rather than guessing.
        //   restyle         → keep the existing video's meaning/source, but
        //                      re-plan frame content so the new template's
        //                      native structures (hero/list/metrics/etc.) fit.
        //   iterate-content → re-plan the whole storyboard around new content.
        //   iterate-format  → re-time and re-render with the new per-frame length.
        const isMultiFrameProject =
          (project.frames ?? []).length > 1 ||
          Number(phaseInfo.inputs.collected?.frame_count ?? '1') > 1;
        let rewriteInputs: PhaseInputs | undefined;
        let restyleOnly = false;
        if (phaseInfo.phase === 'restyle' && isMultiFrameProject) {
          const n = (project.frames ?? []).length || Number(phaseInfo.inputs.collected?.frame_count ?? '4') || 4;
          const storyboardSource = await existingStoryboardSource(ctx, id, project);
          rewriteInputs = {
            ...phaseInfo.inputs,
            collected: {
              ...(phaseInfo.inputs.collected ?? {}),
              frame_count: String(n),
            },
            pickedType: lastCardPickByPhase(history, 'type') ?? phaseInfo.inputs.pickedType,
            pickedStyle: phaseInfo.inputs.pickedStyle || userText.trim(),
            contentTurns: [
              ...collectContentTurns(history),
              storyboardSource,
              `按当前选择的新模板重新组织这些内容。不是机械替换皮肤；要根据模板的结构槽位重排每一帧的标题、列表、指标和说明。`,
            ].filter((s) => s.trim() && !isControlPhrase(s)),
          };
        } else if (phaseInfo.phase === 'iterate-content' && isMultiFrameProject) {
          // Re-plan around the user's new content instruction.
          const turns = [...collectContentTurns(history), userText].filter((s) => !isControlPhrase(s));
          rewriteInputs = {
            ...phaseInfo.inputs,
            pickedType: lastCardPickByPhase(history, 'type') ?? phaseInfo.inputs.pickedType,
            pickedStyle: lastCardPickByPhase(history, 'style') ?? phaseInfo.inputs.pickedStyle ?? '',
            contentTurns: turns,
          };
        } else if (phaseInfo.phase === 'iterate-format' && isMultiFrameProject) {
          // New per-frame timing was submitted; keep content + style, re-render.
          restyleOnly = true; // reuse the existing graph text; only timing/visual recompute
          rewriteInputs = {
            ...phaseInfo.inputs,
            pickedType: lastCardPickByPhase(history, 'type') ?? phaseInfo.inputs.pickedType,
            pickedStyle: lastCardPickByPhase(history, 'style') ?? phaseInfo.inputs.pickedStyle ?? '',
            contentTurns: collectContentTurns(history),
          };
        }

        if (isMultiGenerate || rewriteInputs) {
          if (rewriteInputs) {
            const n = (project.frames ?? []).length || Number(phaseInfo.inputs.collected?.frame_count ?? '3');
            const notice = restyleOnly
              ? `🎨 沿用文案，按新风格重做全部 ${n} 帧…\n`
              : phaseInfo.phase === 'restyle'
                ? `🎨 按新模板结构重新编排全部 ${n} 帧…\n`
                : `🔄 基于新内容重做全部 ${n} 帧（已手动修改过的帧会被覆盖）…\n`;
            assistantText += notice;
            sseWrite({ type: 'text', chunk: notice });
          }
          try {
            const result = await runSplitMultiFrameGenerate({
              ctx,
              projectId: id,
              projectDir,
              agentDef,
              agentModel,
              tmpl,
              priorHtml,
              inputs: rewriteInputs ?? phaseInfo.inputs,
              attachments,
              openingTopic: resolveOpeningTopic(project, history),
              restyleOnly,
              onProgress: (msg) => {
                assistantText += msg + '\n';
                textChunks += 1;
                sseWrite({ type: 'text', chunk: msg + '\n' });
              },
              onSse: sseWrite,
            });
            summaryLine = rewriteInputs
              ? `✓ ${result.frameCount}-frame storyboard ${phaseInfo.phase === 'restyle' ? 'adapted to template' : restyleOnly ? 'restyled' : 'regenerated'} (intent: ${result.intent})`
              : `✓ ${result.frameCount}-frame storyboard generated (intent: ${result.intent})`;
            sseWrite({ type: 'preview_ready', preview_url: `/preview/${id}`, frames: result.frameCount });
            sseWrite({ type: 'message_end', reason: 'ok' });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[studio:msg] proj=${id} split-generate failed: ${msg}\n`);
            sseWrite({ type: 'text', chunk: `\n⚠️ Split generate failed: ${msg}` });
            sseWrite({ type: 'message_end', reason: 'error' });
            assistantText = `⚠️ Split generate failed: ${msg}`;
          }
          process.stderr.write(
            `[studio:msg] proj=${id} phase=split-generate done text=${assistantText.length}B\n`,
          );
        } else {
          // ---- single-shot path (all other phases + single-frame generate) ----
          const handle = spawnAgent({
            def: agentDef,
            prompt: fullPrompt,
            context: { cwd: projectDir, ...(agentModel && { model: agentModel }) },
            onEvent: (ev) => {
              if (ev.type === 'text') {
                assistantText += ev.chunk;
                textChunks += 1;
                sseWrite(ev);
              } else if (ev.type === 'error' || ev.type === 'message_end') {
                if (ev.type === 'error') {
                  process.stderr.write(`[studio:msg] proj=${id} agent-error: ${ev.message}\n`);
                }
                sseWrite(ev);
              }
            },
          });
          const exitInfo = await awaitAgentDone(handle);
          const elapsedMs = Date.now() - t0;
          process.stderr.write(
            `[studio:msg] proj=${id} phase=${phaseInfo.phase} done in ${elapsedMs}ms exit=${exitInfo.exitCode} text=${assistantText.length}B chunks=${textChunks}\n`,
          );

          // Empty-reply retry: if the agent returned almost nothing AND we
          // were on the iterate path with prior HTML, try a tighter prompt
          // that only ships the user's request + a tiny instruction. This
          // catches the 6-8KB-prompt empty-reply mode.
          if (assistantText.trim().length < 32 && phaseInfo.phase === 'iterate' && priorHtml) {
            sseWrite({ type: 'text', chunk: '\n↻ 第一次输出为空，重试中…\n' });
            // Retry without inlining the prior HTML — same observation as
            // the iterate prompt itself: claude --print silently no-ops
            // when fed multi-KB of HTML to rewrite.
            const sum = summariseHtmlForIterate(priorHtml);
            const retryPrompt = [
              `Output ONE complete \`\`\`html block — full self-contained 1920×1080 page. Nothing else.`,
              ``,
              `User request: ${userText.slice(0, 300)}`,
              sum.headline ? `Headline: ${sum.headline}` : '',
              sum.subheads.length ? `Subheads:\n${sum.subheads.slice(0, 4).map((s) => `  · ${s}`).join('\n')}` : '',
              sum.bgColors.length ? `Palette: ${sum.bgColors.join(' / ')}` : '',
              sum.fontFamilies.length ? `Fonts: ${sum.fontFamilies.join(', ')}` : '',
              ``,
              `Begin reply with \`\`\`html. Tag visible text with data-hv-text. No prose outside the block.`,
            ].filter(Boolean).join('\n');
            let retryText = '';
            const retryHandle = spawnAgent({
              def: agentDef,
              prompt: retryPrompt,
              context: { cwd: projectDir },
              onEvent: (ev) => {
                if (ev.type === 'text') {
                  retryText += ev.chunk;
                  textChunks += 1;
                  sseWrite(ev);
                } else if (ev.type === 'error' || ev.type === 'message_end') {
                  sseWrite(ev);
                }
              },
            });
            await awaitAgentDone(retryHandle);
            assistantText += retryText;
            process.stderr.write(
              `[studio:msg] proj=${id} retry done text=${retryText.length}B\n`,
            );
          }

          // Single-frame iterate: result HTML goes back to the focused frame
          // only — never overwrites the whole preview.html.
          if (focusFrameId) {
            const extracted = extractHtmlDocument(assistantText);
            if (extracted) {
              try {
                await ctx.orchestrator.writeFrameHtml(id, focusFrameId, extracted);
                sseWrite({ type: 'preview_ready', preview_url: `/preview/${id}`, focused_frame: focusFrameId });
                summaryLine = `✓ frame ${focusFrameId} updated`;
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                sseWrite({ type: 'text', chunk: `\n[frame ${focusFrameId} write failed: ${msg}]\n` });
              }
            }
          } else {
            // Multi-frame extraction on the off chance the agent did emit it
            // (e.g. on a free-text iterate turn the user's text triggered it).
            const multi = extractContentGraphAndFrames(assistantText);
            if (multi && multi.frames.length > 0) {
              await ctx.orchestrator.writeContentGraph(id, multi.graph);
              for (const f of multi.frames) {
                try {
                  await ctx.orchestrator.writeFrameHtml(id, f.nodeId, f.html);
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  sseWrite({ type: 'text', chunk: `\n[frame ${f.nodeId} skipped: ${msg}]\n` });
                }
              }
              sseWrite({ type: 'preview_ready', preview_url: `/preview/${id}`, frames: multi.frames.length });
              summaryLine = `✓ ${multi.frames.length}-frame storyboard generated (intent: ${multi.graph.intent})`;
            } else {
              const extracted = extractHtmlDocument(assistantText);
              if (extracted) {
                await ctx.orchestrator.writePreviewHtmlRaw(id, extracted);
                sseWrite({ type: 'preview_ready', preview_url: `/preview/${id}` });
                summaryLine = '✓ updated the HTML preview';
              }
            }
          }
        }

        // Auto-advance: the content prompt instructs the agent to append
        // <!-- hv-phase:content-question --> when it still needs more info.
        // Absence of that marker means it has enough — immediately run the
        // style phase in the same SSE stream so the user sees the style card
        // without having to send an extra "ok" message.
        if (phaseInfo.phase === 'content' && !/<!--\s*hv-phase:content-question\s*-->/i.test(assistantText)) {
          const autoPickedType = lastCardPickByPhase(history, 'type') ?? phaseInfo.inputs.pickedType ?? '';
          const stylePrompt = buildStylePhasePrompt(autoPickedType);
          const styleHandle = spawnAgent({
            def: agentDef,
            prompt: stylePrompt,
            context: { cwd: projectDir, ...(agentModel && { model: agentModel }) },
            onEvent: (ev) => {
              if (ev.type === 'text') {
                assistantText += ev.chunk;
                textChunks += 1;
                sseWrite(ev);
              } else if (ev.type === 'error') {
                process.stderr.write(`[studio:msg] proj=${id} style-autoadvance error: ${ev.message}\n`);
              }
            },
          });
          await awaitAgentDone(styleHandle);
        }

        // Persist assistant message — strip the html / graph blocks when present (UI sees summary line)
        let persistText = summaryLine
          ? assistantText
              .replace(/```html[#\w-]*[\s\S]*?```/gi, '')
              .replace(/```json#content-graph[\s\S]*?```/i, '')
              .replace(/```json[\s\S]*?```/i, (m) =>
                /content-graph|"intent"\s*:|"nodes"\s*:/i.test(m) ? '' : m,
              )
              .trim() || summaryLine
          : assistantText;

        // Empty agent reply (no HTML, no graph, no prose) usually means the
        // prompt confused the model into doing nothing. Give the user something
        // actionable instead of a blank speech bubble.
        if (!persistText.trim()) {
          const fallback = '⚠️ The agent returned an empty reply. Try rephrasing your request — e.g. tell it the brand / topic / 1-2 concrete details, or which kind of frame you want first.';
          sseWrite({ type: 'text', chunk: fallback });
          persistText = fallback;
        }
        history.push({
          role: 'assistant',
          agent: agentDef.id,
          content: persistText,
          ts: Date.now(),
        });
        MESSAGES.set(id, history);
        await saveMessages(ctx, id, history);
        // discard project0 reference to keep TS happy
        void project0;
        res.end();
        return;
        } finally {
          GENERATING.delete(id);
        }
      }

      // Is a generation currently running for this project? Lets a returning
      // client show "still generating…" instead of a blank where the live
      // progress lines used to be.
      const genStatusMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/generating$/);
      if (genStatusMatch && genStatusMatch[1] && m === 'GET') {
        return json(res, 200, { generating: GENERATING.has(genStatusMatch[1]) });
      }

      // ============== v0.8: content-graph + frames API ==============

      // GET content graph as JSON
      const cgMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/content-graph$/);
      if (cgMatch && cgMatch[1] && m === 'GET') {
        const graph = await ctx.orchestrator.readContentGraph(cgMatch[1]);
        if (!graph) return json(res, 200, { graph: null });
        return json(res, 200, { graph });
      }

      // Re-pace each frame's duration to match the narration: split the total
      // duration across frames in proportion to each frame's narration length
      // (a frame with twice the words holds twice as long), so a generated
      // voiceover and the visuals stay in step. Min 2s per frame.
      const fitMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/fit-durations$/);
      if (fitMatch && fitMatch[1] && m === 'POST') {
        const projectId = fitMatch[1];
        const graph = await ctx.orchestrator.readContentGraph(projectId);
        if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
          return json(res, 400, { error: 'No frames yet — generate the video first.' });
        }
        const bodyRaw = (await readBody(req)) as {
          narrationByFrame?: Record<string, string>;
          audioAssetId?: string;
        };
        const byFrame = bodyRaw.narrationByFrame ?? {};
        const lenOf = (id: string) => (byFrame[id]?.trim().length ?? 0);
        const totalChars = graph.nodes.reduce((s, n) => s + lenOf(n.id), 0);
        if (totalChars === 0) {
          return json(res, 400, { error: 'No narration yet — draft narration first, then fit.' });
        }
        const MIN = 2;
        // Keep total duration, but if there isn't enough to give every frame the
        // minimum at its char-share, scale the total up so MIN is always honored
        // (≈0.18s of speech per character is a comfortable narration pace).
        const SEC_PER_CHAR = 0.18;
        const currentTotal = graph.nodes.reduce((s, n) => s + (n.durationSec ?? MIN), 0);
        const neededForSpeech = Math.ceil(totalChars * SEC_PER_CHAR);
        // If a synthesized narration audio asset is provided, probe its REAL
        // duration with ffprobe and use that as the authoritative total — far
        // more accurate than the chars-per-second heuristic. Falls back to the
        // heuristic when ffprobe is missing or the asset can't be probed.
        let audioTotal: number | undefined;
        if (bodyRaw.audioAssetId) {
          try {
            const proj = await ctx.orchestrator.load(projectId);
            const audioAsset = proj.assets.find((a) => a.id === bodyRaw.audioAssetId);
            if (audioAsset?.path && existsSync(audioAsset.path)) {
              const dur = await probeMediaDurationSec(audioAsset.path);
              if (Number.isFinite(dur) && dur > 0) audioTotal = dur;
            }
          } catch {
            // asset missing / probe failed → fall through to heuristic below
          }
        }
        const total = audioTotal ?? Math.max(currentTotal, neededForSpeech, MIN * graph.nodes.length);
        // Proportional by char share, then lift any frame below MIN.
        let durs = graph.nodes.map((n) => ({ n, d: Math.max(MIN, Math.round((lenOf(n.id) / totalChars) * total)) }));
        // Re-normalize so the rounded sum matches `total` (adjust the longest frame).
        const sum = durs.reduce((s, x) => s + x.d, 0);
        if (sum !== total && durs.length) {
          const longest = durs.reduce((a, b) => (b.d > a.d ? b : a));
          longest.d = Math.max(MIN, longest.d + (total - sum));
        }
        for (const { n, d } of durs) n.durationSec = d;
        // preserveFrames: fit only re-times an EXISTING storyboard — must not
        // wipe the rendered frames (that left export with no frames → it fell
        // back to a single 5s template still instead of the multi-frame video).
        await ctx.orchestrator.writeContentGraph(projectId, graph, { preserveFrames: true });
        const durations = Object.fromEntries(graph.nodes.map((n) => [n.id, n.durationSec]));
        return json(res, 200, {
          ok: true,
          durations,
          totalSec: graph.nodes.reduce((s, n) => s + (n.durationSec ?? 0), 0),
          ...(audioTotal !== undefined && { source: 'audio' as const }),
        });
      }

      // ============== File serving ==============

      // Project preview HTML (and any sibling files like assets/)
      const previewServeMatch = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
      if (previewServeMatch && previewServeMatch[1]) {
        const projId = previewServeMatch[1];
        const sub = previewServeMatch[2] ?? '/preview.html';
        const project = await ctx.orchestrator.load(projId);

        // Phase C: serve an enhanced frame's preview MP4 (native Remotion frames
        // have no HTML). Match the `.mp4` suffix BEFORE the plain HTML frame route.
        const frameMp4Match = sub.match(/^\/frame\/([a-z0-9_-]+)\.mp4$/i);
        if (frameMp4Match && frameMp4Match[1]) {
          const frame = (project.frames ?? []).find((f) => f.graphNodeId === frameMp4Match[1]);
          if (frame?.previewMp4Path && existsSync(frame.previewMp4Path)) {
            return serveFile(frame.previewMp4Path, res);
          }
          res.writeHead(404);
          return res.end('No preview MP4 for frame');
        }

        // v0.8: serve a specific frame HTML by graph node id
        const frameMatch = sub.match(/^\/frame\/([a-z0-9_-]+)$/i);
        if (frameMatch && frameMatch[1]) {
          const nodeId = frameMatch[1];
          const frame = (project.frames ?? []).find((f) => f.graphNodeId === nodeId);
          if (frame && existsSync(frame.htmlPath)) {
            return serveFile(frame.htmlPath, res);
          }
          res.writeHead(404);
          return res.end('Frame not found');
        }

        const baseDir = project.lastPreviewHtmlPath
          ? dirname(project.lastPreviewHtmlPath)
          : null;
        if (!baseDir) {
          res.writeHead(404);
          return res.end('Preview not rendered yet');
        }
        const filePath = sub === '/preview.html' || sub === '/'
          ? project.lastPreviewHtmlPath!
          : join(baseDir, sub);
        if (isPathInside(baseDir, filePath) && existsSync(filePath) && statSync(filePath).isFile()) {
          return serveFile(filePath, res);
        }
        // Fallback: also try project assets/
        const projAssets = join(dirname(baseDir), 'assets', basename(sub));
        if (existsSync(projAssets)) return serveFile(projAssets, res);
        // Fallback 2 (multi-composition templates): hyperframes templates ship
        // with sibling files like compositions/intro.html that the entry
        // index.html references via data-composition-src. Project dir only
        // holds the rewritten preview.html — sibling files live in the
        // template's own dir. Resolve relative to that, but only when the
        // requested path is below the project's selected template (so a
        // project can't read a different template's files).
        if (project.templateId) {
          try {
            const tmpl = ctx.templates.get(project.templateId);
            if (tmpl?.__dir && sub.length > 1) {
              const tmplFile = join(tmpl.__dir, sub.replace(/^\//, ''));
              const tmplResolved = resolve(tmplFile);
              const tmplRoot = resolve(tmpl.__dir);
              if (isPathInside(tmplRoot, tmplResolved) && existsSync(tmplResolved) && statSync(tmplResolved).isFile()) {
                return serveFile(tmplResolved, res);
              }
            }
          } catch {
            /* template lookup failed → just 404 */
          }
        }
        res.writeHead(404);
        return res.end('Not found');
      }

      // Asset direct serve (so iframe can load image_path etc)
      // /asset?path=<absolute-path>  — must be inside .html-video/projects
      if (url.pathname === '/asset' && m === 'GET') {
        const p = url.searchParams.get('path');
        if (!p) {
          res.writeHead(400);
          return res.end('missing ?path');
        }
        const safe = resolve(p);
        const projectsDir = resolve(join(ctx.projectRoot, '.html-video', 'projects'));
        if (!isPathInside(projectsDir, safe)) {
          res.writeHead(403);
          return res.end('forbidden');
        }
        if (existsSync(safe)) return serveFile(safe, res);
        res.writeHead(404);
        return res.end();
      }

      const voiceSampleMatch = url.pathname.match(/^\/voice-samples\/([A-Za-z0-9._-]+)$/);
      if (voiceSampleMatch?.[1] && m === 'GET') {
        const samplesDir = voiceCloneSamplesDir(ctx.projectRoot);
        const safe = resolve(samplesDir, basename(voiceSampleMatch[1]));
        const resolvedSamplesDir = resolve(samplesDir);
        if (!isPathInside(resolvedSamplesDir, safe)) {
          res.writeHead(403);
          return res.end('forbidden');
        }
        if (existsSync(safe) && statSync(safe).isFile()) return serveFile(safe, res);
        res.writeHead(404);
        return res.end();
      }

      // Template poster (e.g. /template-asset/<id>/preview.png)
      const tplAssetMatch = url.pathname.match(/^\/template-asset\/([^/]+)\/(.+)$/);
      if (tplAssetMatch && tplAssetMatch[1] && tplAssetMatch[2]) {
        let t: import('@html-video/core').TemplateMetadata;
        try {
          t = ctx.templates.get(tplAssetMatch[1]);
        } catch {
          res.writeHead(404);
          return res.end('template not found');
        }
        const rel = tplAssetMatch[2];
        const filePath = resolve(t.__dir!, rel);
        if (!isPathInside(t.__dir!, filePath)) {
          res.writeHead(403);
          return res.end('forbidden');
        }
        if (!existsSync(filePath)) {
          res.writeHead(404);
          return res.end();
        }
        // Multi-composition templates ship an entry HTML that only stitches
        // sub-comps via data-composition-src; a raw iframe renders blank
        // because nothing assembles them. For the studio *preview* we inject a
        // tiny client-side player that fetches each composition, instantiates
        // its <template>, wires placeholders, and plays the GSAP timelines so
        // the gallery shows live motion. The template files on disk are never
        // touched — this rewrite happens only on the way out the wire.
        if (extname(filePath).toLowerCase() === '.html') {
          let html = await readFile(filePath, 'utf8');
          const staticPreview = url.searchParams.get('static') === '1';
          if (staticPreview) {
            const frameIndex = Math.max(0, Number(url.searchParams.get('frame') ?? '0') || 0);
            const progress = Math.max(0.08, Math.min(0.95, Number(url.searchParams.get('progress') ?? '0.68') || 0.68));
            html = /data-composition-src/.test(html)
              ? injectCompositionPlayer(html, t.id, { staticFrameIndex: frameIndex, staticProgress: progress })
              : injectStaticTemplatePreview(html, { frameIndex, progress });
            res.writeHead(200, {
              'content-type': MIME['.html']!,
              'cache-control': 'no-store, no-cache, must-revalidate',
              pragma: 'no-cache',
            });
            return res.end(html);
          }
          if (/data-composition-src/.test(html)) {
            html = injectCompositionPlayer(html, t.id);
            res.writeHead(200, {
              'content-type': MIME['.html']!,
              'cache-control': 'no-store, no-cache, must-revalidate',
              pragma: 'no-cache',
            });
            return res.end(html);
          }
        }
        return serveFile(filePath, res);
      }

      // ============== Static UI ==============
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = join(uiRoot, path);
      if (isPathInside(uiRoot, filePath) && existsSync(filePath) && statSync(filePath).isFile()) {
        return serveFile(filePath, res);
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: string }).code ?? 'unknown';
      json(res, 500, { error: msg, code });
    }
  });

  return new Promise((resolveFn) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolveFn({
        url: `http://127.0.0.1:${actualPort}`,
        port: actualPort,
        close: () => server.close(),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': MIME['.json']! });
  res.end(JSON.stringify(body));
}

/**
 * Decide how the gallery should preview a template. Hyperframes HTML entries
 * render live in an iframe; native engine entries (for example Remotion
 * TypeScript compositions) use the shipped poster because loading source TS in
 * an iframe produces a blank card and can stall the preview modal.
 *
 * `posterUrl` is still surfaced (when the poster file exists) so the frontend
 * can fall back to a static poster if the live iframe ever fails to render.
 */
function templatePreviewMode(
  t: import('@html-video/core').TemplateMetadata,
): { mode: 'iframe' | 'poster'; posterUrl: string | null } {
  const posterRel = t.preview?.poster;
  const posterPath = posterRel && t.__dir ? join(t.__dir, posterRel) : null;
  const posterUrl =
    posterPath && existsSync(posterPath)
      ? `/template-asset/${t.id}/${posterRel}`
      : null;
  const entry = t.source_entry ?? '';
  if (t.engine !== 'hyperframes' || !entry.endsWith('.html')) {
    return { mode: posterUrl ? 'poster' : 'iframe', posterUrl };
  }
  return { mode: 'iframe', posterUrl };
}

type StaticTemplatePreviewFrame = {
  label: string;
  url: string;
  kind: 'iframe' | 'poster';
  progress?: number;
};

async function templateStaticPreview(
  t: TemplateMetadata,
  posterUrl: string | null,
): Promise<{ frames: StaticTemplatePreviewFrame[]; elements: string[]; motion: string[] }> {
  const posterFrame = (): StaticTemplatePreviewFrame[] => posterUrl
    ? [{ label: 'overview', url: posterUrl, kind: 'poster' }]
    : [];
  if (!t.__dir || !t.source_entry || t.native || !t.source_entry.endsWith('.html')) {
    return { frames: posterFrame(), elements: templatePreviewElements(t, ''), motion: ['data-growth'] };
  }

  const entryPath = join(t.__dir, t.source_entry);
  if (!existsSync(entryPath)) {
    return { frames: posterFrame(), elements: templatePreviewElements(t, ''), motion: [] };
  }
  const source = await readFile(entryPath, 'utf8');
  const encodedId = encodeURIComponent(t.id);
  const encodedEntry = t.source_entry.split('/').map(encodeURIComponent).join('/');
  const base = `/template-asset/${encodedId}/${encodedEntry}`;
  const compositionPaths = Array.from(source.matchAll(/data-composition-src=["']([^"']+)["']/gi))
    .map((match) => match[1] ?? '')
    .filter(Boolean);
  const uniqueCompositions = [...new Set(compositionPaths)].slice(0, 6);
  let frames: StaticTemplatePreviewFrame[];

  if (uniqueCompositions.length > 0) {
    frames = uniqueCompositions.map((path, index) => ({
      label: basename(path, extname(path)).replace(/[-_]+/g, ' '),
      url: `${base}?static=1&frame=${index}&progress=.68`,
      kind: 'iframe',
      progress: 0.68,
    }));
  } else {
    const frameCount = Math.min(6, extractTemplateFrameBlocks(source).length);
    if (frameCount > 1) {
      const labels = Array.from(source.matchAll(/class=["'][^"']*flabel[^"']*["'][^>]*>[\s\S]*?<b>([^<]+)<\/b>/gi))
        .map((match) => (match[1] ?? '').trim());
      frames = Array.from({ length: frameCount }, (_, index) => ({
        label: labels[index] || `frame ${String(index + 1).padStart(2, '0')}`,
        url: `${base}?static=1&frame=${index}&progress=.72`,
        kind: 'iframe' as const,
        progress: 0.72,
      }));
    } else {
      // A single animated composition is shown as three frozen key moments.
      // They are ordinary HTML frames, never a playing video/animation.
      frames = [0.22, 0.58, 0.9].map((progress, index) => ({
        label: ['opening', 'main', 'final'][index]!,
        url: `${base}?static=1&frame=0&progress=${progress}`,
        kind: 'iframe' as const,
        progress,
      }));
    }
  }
  return {
    frames: frames.length > 0 ? frames : posterFrame(),
    elements: templatePreviewElements(t, source),
    motion: templatePreviewMotion(source),
  };
}

function templatePreviewElements(t: TemplateMetadata, source: string): string[] {
  const hay = [t.category, t.subcategory ?? '', t.tags.join(' '), t.best_for.join(' '), source].join('\n');
  const rules: Array<[string, RegExp]> = [
    ['title', /headline|hero|title|cover|<h1\b/i],
    ['body', /standfirst|subtitle|description|lede|<p\b/i],
    ['list', /ledger|agenda|steps?|cards?|items?/i],
    ['quote', /quote|blockquote|manifesto/i],
    ['metrics', /metric|kpi|stat|number-counter|dashboard/i],
    ['chart', /chart|graph|bar|ranking|rollup/i],
    ['timeline', /timeline|process|workflow|phase/i],
    ['diagram', /flowchart|decision|branching|node-graph|system-diagram|service-map/i],
    ['code', /code|terminal|vscode|workbench/i],
    ['media', /<img\b|<video\b|product-demo|showcase/i],
    ['brand', /logo|brand|outro|end-card/i],
  ];
  return rules.filter(([, pattern]) => pattern.test(hay)).map(([key]) => key).slice(0, 7);
}

function templatePreviewMotion(source: string): string[] {
  const motion: string[] = [];
  if (/opacity|fade|reveal/i.test(source)) motion.push('fade');
  if (/translate[XY3d(]|slide|sweep/i.test(source)) motion.push('slide');
  if (/\bscale[XY(]|zoom|pop/i.test(source)) motion.push('scale');
  if (/stagger/i.test(source)) motion.push('stagger');
  if (/strokeDash|lineDraw|connector/i.test(source)) motion.push('line-draw');
  if (/counter|rolled|barHeight|grow|chart/i.test(source)) motion.push('data-growth');
  if (/gsap\.timeline|__timelines/i.test(source)) motion.push('timeline');
  return [...new Set(motion)].slice(0, 6);
}

function autoSelectTemplate(
  templates: TemplateMetadata[],
  args: { text: string; aspect?: string; mode?: 'narrate' | 'chat' | 'talking-head' },
): TemplateMetadata | null {
  const q = normalizeTemplateQuery(args.text);
  const aspect = normalizeTemplateAspect(args.aspect ?? '16:9');
  const candidates = templates.filter((t) => templateSupportsAspect(t, aspect));
  // Do not force an aspect-incompatible template into the requested canvas.
  // If no template supports the aspect (currently common for 4:5), returning
  // null deliberately routes generation through the responsive full-bleed path.
  if (candidates.length === 0) return null;
  const pool = candidates;
  let best: { template: TemplateMetadata; score: number } | null = null;
  for (const t of pool) {
    let score = 0;
    const hay = normalizeTemplateQuery([
      t.id,
      t.name,
      t.name_zh ?? '',
      t.description,
      t.description_zh ?? '',
      t.tags.join(' '),
      t.best_for.join(' '),
      t.category,
      t.subcategory ?? '',
    ].join(' '));

    if (t.engine === 'hyperframes' && (t.source_entry ?? '').endsWith('.html')) score += 18;
    if (/^frame-design-/.test(t.id)) score += 22;
    if (t.id === 'frame-design-cobalt-grid') score += 8;
    if (t.id === 'frame-wechat-ai-dispatch') score += 6;

    for (const token of q.split(/\s+/).filter((s) => s.length >= 2)) {
      if (hay.includes(token)) score += token.length >= 4 ? 5 : 2;
    }

    if (/(报告|严肃|专业|分析|预测|经营|b2b|business|professional|analysis|forecast|report)/i.test(q)) {
      if (/cobalt|grid|editorial|forest|nyt|chart|data|blue-professional|ledger|report/.test(hay)) score += 52;
      if (/poster|glitch|play|warm|product-promo/.test(hay)) score -= 12;
    }
    if (/(ai|智能体|微信|小程序|调度|分发|agent|wechat|mini program)/i.test(q)) {
      if (/wechat|ai-dispatch|dispatch|cobalt|grid|data/.test(hay)) score += 34;
    }
    if (/(数据|数字|图表|增长|指标|排名|趋势|data|chart|metric|trend|github|star)/i.test(q)) {
      if (/data|chart|nyt|rollup|graph|cobalt|grid|metric/.test(hay)) score += 48;
    }
    if (/(产品|发布|推广|卖点|营销|promo|launch|product|brand)/i.test(q)) {
      if (/product|promo|bold|poster|signal|creative|voltage|electric/.test(hay)) score += 38;
    }
    if (/(代码|开发|ide|github|repo|开源|程序员|developer|code|vscode)/i.test(q)) {
      if (/vscode|cobalt|grid|data|github/.test(hay)) score += 38;
    }
    if (/(温暖|生活|故事|情绪|柔和|warm|grain|magazine|story)/i.test(q)) {
      if (/warm|grain|magazine|editorial|forest|daisy/.test(hay)) score += 34;
    }
    if (/(logo|片尾|outro|结尾)/i.test(q)) {
      if (/logo|outro/.test(hay)) score += 80;
    }
    if ((args.mode === 'narrate' || args.mode === 'talking-head') && /^frame-design-/.test(t.id)) {
      score += 8;
    }

    if (!best || score > best.score || (score === best.score && t.id < best.template.id)) {
      best = { template: t, score };
    }
  }
  return best?.template ?? null;
}

function normalizeTemplateQuery(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function normalizeTemplateAspect(value: string): string {
  const v = value.trim();
  if (/9\s*:\s*16|1080\s*[:×x]\s*1920/i.test(v)) return '9:16';
  if (/1\s*:\s*1|1080\s*[:×x]\s*1080/i.test(v)) return '1:1';
  if (/4\s*:\s*5|1080\s*[:×x]\s*1350/i.test(v)) return '4:5';
  return '16:9';
}

function templateSupportsAspect(t: TemplateMetadata, aspect: string): boolean {
  const supported = t.output?.resolution?.supported_aspects;
  return !Array.isArray(supported) || supported.length === 0 || supported.includes(aspect);
}

/**
 * Inject a minimal client-side composition player into a multi-comp entry
 * HTML so the studio preview shows live motion instead of a blank iframe.
 *
 * Hyperframes templates declare their scenes as `<div data-composition-src=
 * "compositions/x.html">` placeholders; each composition file is a `<template>`
 * wrapping markup + <style> + a <script> that registers a paused GSAP timeline
 * on `window.__timelines[name]`. The real (v0.9) renderer assembles these for
 * frame-accurate export; this player is a lightweight stand-in that just makes
 * the preview move:
 *   1. swap the two known placeholders so nothing 404s / NaNs,
 *   2. fetch each composition (relative to /template-asset/<id>/), graft its
 *      <template>.content into the placeholder div, and re-run its scripts
 *      (cloned <script> nodes never execute on their own),
 *   3. once every timeline has registered, play them all on a loop.
 * Templates on disk are untouched — this is a serve-time transform only.
 */
function injectCompositionPlayer(
  html: string,
  templateId: string,
  options: { staticFrameIndex?: number; staticProgress?: number } = {},
): string {
  // 15s is a sane default duration for the preview loop; __VIDEO_SRC__ has no
  // real asset in-repo, so point it at an empty data URI to avoid a 404 fetch.
  let out = html
    .replace(/__VIDEO_DURATION__/g, '15')
    .replace(/__VIDEO_SRC__/g, 'data:video/mp4;base64,');

  // The entry's own inline scripts assign window.__timelines["background"]
  // etc. before the entry ever initialises the registry — in the real HF
  // runtime the player defines it first. Mirror that: seed the registry in
  // <head> so those early assignments don't throw on an undefined object.
  const seed = '<script>window.__timelines = window.__timelines || {};</script>';
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => m + '\n' + seed);
  } else {
    out = seed + '\n' + out;
  }

  const player = `
<script>
(function () {
  var templateAssetBase = ${JSON.stringify(`/template-asset/${templateId}/`)};
  var staticFrameIndex = ${options.staticFrameIndex ?? 'null'};
  var staticProgress = ${options.staticProgress ?? 0.68};
  function reexec(root) {
    // Cloned/innerHTML'd <script> nodes don't run — recreate them so each
    // composition's timeline-registration IIFE actually executes. Skip the
    // external gsap CDN tag: the entry already loaded gsap synchronously, and
    // re-adding it would race (async load) ahead of the inline IIFE that calls
    // gsap.timeline() right after it.
    root.querySelectorAll('script').forEach(function (old) {
      if (old.src) { old.parentNode.removeChild(old); return; }
      var s = document.createElement('script');
      // Each composition's inline script declares top-level \`const tl = ...\`.
      // Re-injecting several into the shared global scope collides ("tl has
      // already been declared"). Wrap each in its own block so those locals
      // stay private; window.__timelines assignments still escape the block.
      s.textContent = '{\\n' + old.textContent + '\\n}';
      old.parentNode.replaceChild(s, old);
    });
  }
  async function mountOne(host) {
    var src = host.getAttribute('data-composition-src');
    if (!src) return;
    try {
      var url = new URL(src, window.location.origin + templateAssetBase).href;
      var res = await fetch(url);
      if (!res.ok) return;
      var text = await res.text();
      var holder = document.createElement('div');
      holder.innerHTML = text;
      var tpl = holder.querySelector('template');
      var frag = tpl ? tpl.content.cloneNode(true) : holder;
      host.appendChild(frag);
      reexec(host);
    } catch (e) { /* a missing comp shouldn't blank the whole preview */ }
  }
  async function boot() {
    window.__timelines = window.__timelines || {};
    var hosts = Array.prototype.slice.call(
      document.querySelectorAll('[data-composition-src]'));
    var activeHosts = hosts;
    if (staticFrameIndex !== null) {
      activeHosts = hosts.filter(function (host, index) {
        var active = index === Math.min(staticFrameIndex, hosts.length - 1);
        host.style.display = active ? 'block' : 'none';
        if (active) {
          host.style.opacity = '1';
          host.style.visibility = 'visible';
          host.setAttribute('data-start', '0');
        }
        return active;
      });
    }
    await Promise.all(activeHosts.map(mountOne));
    // Give the just-injected <script> tags a tick to register timelines.
    setTimeout(function () {
      var tls = window.__timelines || {};
      Object.keys(tls).forEach(function (k) {
        var tl = tls[k];
        if (!tl) return;
        if (staticFrameIndex !== null && typeof tl.pause === 'function') {
          try {
            if (typeof tl.totalProgress === 'function') tl.totalProgress(staticProgress);
            else if (typeof tl.progress === 'function') tl.progress(staticProgress);
            tl.pause();
          } catch (e) {}
        } else if (typeof tl.play === 'function') {
          try { tl.repeat(-1); } catch (e) {}
          tl.play(0);
        }
      });
      if (staticFrameIndex !== null) {
        document.querySelectorAll('video').forEach(function (video) { try { video.pause(); } catch (e) {} });
        document.documentElement.setAttribute('data-hv-static-ready', 'true');
      }
    }, 120);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();
</script>`;

  if (out.includes('</body>')) return out.replace('</body>', player + '\n</body>');
  return out + player;
}

function injectStaticTemplatePreview(
  html: string,
  options: { frameIndex: number; progress: number },
): string {
  const freezeStyle = `<style id="__hv_static_freeze">
    *, *::before, *::after { animation-play-state: paused !important; }
    html, body { overflow: hidden !important; }
    .__hv_static_stage { width: 1920px; height: 1080px; overflow: hidden; display: grid; place-items: center; background: #000; }
    .__hv_static_stage > .frame { width: 1920px !important; height: 1080px !important; max-width: none !important; aspect-ratio: auto !important; margin: 0 !important; box-shadow: none !important; }
  </style>`;
  let out = html;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (head) => `${head}\n${freezeStyle}`);
  else out = `${freezeStyle}\n${out}`;

  const script = `<script>
(function () {
  var frameIndex = ${options.frameIndex};
  var progress = ${options.progress};
  function freeze() {
    var frames = Array.prototype.slice.call(document.querySelectorAll('.frame'));
    if (frames.length > 1) {
      var picked = frames[Math.min(frameIndex, frames.length - 1)];
      if (picked) {
        var stage = document.createElement('main');
        stage.className = '__hv_static_stage';
        stage.appendChild(picked.cloneNode(true));
        document.body.replaceChildren(stage);
      }
    }
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        document.getAnimations().forEach(function (animation) {
          try {
            var timing = animation.effect && animation.effect.getComputedTiming
              ? animation.effect.getComputedTiming()
              : null;
            var end = timing && Number.isFinite(timing.endTime) ? timing.endTime : 1000;
            animation.currentTime = Math.max(1, end * progress);
            animation.pause();
          } catch (e) {}
        });
        var tls = window.__timelines || {};
        Object.keys(tls).forEach(function (key) {
          var tl = tls[key];
          try {
            if (typeof tl.totalProgress === 'function') tl.totalProgress(progress);
            else if (typeof tl.progress === 'function') tl.progress(progress);
            if (typeof tl.pause === 'function') tl.pause();
          } catch (e) {}
        });
        document.querySelectorAll('video').forEach(function (video) { try { video.pause(); } catch (e) {} });
        document.documentElement.setAttribute('data-hv-static-ready', 'true');
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', freeze, { once: true });
  else freeze();
})();
</script>`;
  if (out.includes('</body>')) return out.replace('</body>', `${script}\n</body>`);
  return out + script;
}

async function serveFile(filePath: string, res: ServerResponse): Promise<void> {
  const ext = extname(filePath).toLowerCase();
  const buf = await readFile(filePath);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    // Studio is a local dev tool — always serve fresh so v0.x updates show
    // up immediately on page load instead of being held in disk cache.
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
  });
  res.end(buf);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveFn, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolveFn(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function readBodyText(req: IncomingMessage): Promise<string> {
  return new Promise((resolveFn, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolveFn(data));
    req.on('error', reject);
  });
}

/**
 * Minimal multipart parser — returns ALL parts (fields + files).
 * Files are written to a tmp path and the path is returned.
 * For production switch to formidable / busboy.
 */
type MultipartPart =
  | { kind: 'field'; name: string; value: string }
  | { kind: 'file'; name: string; filename: string; tmpPath: string };

/**
 * Recover the real filename from a multipart part header (issue #9).
 *
 * Two encodings can appear:
 *  - `filename*=UTF-8''%E4%B8%AD%E6%96%87.md` (RFC 5987, percent-encoded) —
 *    decode the percent-escapes after stripping the charset prefix.
 *  - `filename="中文.md"` — the bytes are UTF-8, but the multipart body was
 *    read as a latin1 string, so each UTF-8 byte became one latin1 char. Round
 *    -trip latin1→utf8 to restore the original. If the name was plain ASCII the
 *    round-trip is a no-op.
 */
export function decodeUploadFilename(star: string | undefined, plain: string | undefined): string {
  if (star) {
    // RFC 5987 ext-value: charset "'" [language] "'" value  (e.g.
    // UTF-8''%E4%B8%AD.md  or  UTF-8'zh-CN'%E6%95%B0%E6%8D%AE.json).
    const m = /^[\w-]*'[^']*'(.*)$/.exec(star.trim());
    const enc = m?.[1] ?? star.trim();
    try { return decodeURIComponent(enc); } catch { return enc; }
  }
  if (plain !== undefined) {
    try { return Buffer.from(plain, 'latin1').toString('utf8'); } catch { return plain; }
  }
  return 'upload';
}

async function receiveMultipart(
  req: IncomingMessage,
  contentType: string,
): Promise<MultipartPart[]> {
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) throw new Error('No multipart boundary');
  const boundary = `--${boundaryMatch[1]}`;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const buf = Buffer.concat(chunks);
  const text = buf.toString('binary');
  const parts = text.split(boundary).slice(1, -1);
  const out: MultipartPart[] = [];
  const fs = await import('node:fs/promises');
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    const bodyRaw = part.slice(headerEnd + 4, part.length - 2);
    const nameMatch = headers.match(/name="([^"]+)"/);
    if (!nameMatch || !nameMatch[1]) continue;
    const name = nameMatch[1];
    // RFC 5987 `filename*=UTF-8''...` (percent-encoded) wins when present;
    // otherwise fall back to the plain `filename="..."`. The plain form carries
    // raw UTF-8 BYTES, but the part was sliced out of a latin1 string above, so
    // a CJK filename arrives mojibake'd — re-decode latin1→utf8 to restore it
    // (issue #9). decodeUploadFilename handles both.
    const fnStarMatch = headers.match(/filename\*=([^;\r\n]+)/i);
    const fnMatch = headers.match(/filename="([^"]*)"/);
    if (fnStarMatch || fnMatch) {
      const filename = decodeUploadFilename(fnStarMatch?.[1], fnMatch?.[1]);
      // Keep the tmp path ASCII-safe; the real (possibly CJK) name rides on the
      // returned part, not the on-disk temp file.
      const ext = (filename.match(/\.[A-Za-z0-9]{1,8}$/)?.[0]) ?? '';
      const tmpPath = join(tmpdir(), `hv-upload-${randomUUID().slice(0, 8)}${ext}`);
      await mkdir(dirname(tmpPath), { recursive: true });
      await fs.writeFile(tmpPath, Buffer.from(bodyRaw, 'binary'));
      out.push({ kind: 'file', name, filename, tmpPath });
    } else {
      // Field — body is utf8 text
      out.push({ kind: 'field', name, value: Buffer.from(bodyRaw, 'binary').toString('utf8') });
    }
  }
  return out;
}

// Backward-compat shim used by the older /api/projects/:id/assets endpoint
async function receiveMultipartFile(
  req: IncomingMessage,
  contentType: string,
): Promise<{ filePath: string; filename: string }> {
  const parts = await receiveMultipart(req, contentType);
  const file = parts.find((p): p is Extract<MultipartPart, { kind: 'file' }> => p.kind === 'file');
  if (!file) throw new Error('No file field in multipart body');
  return { filePath: file.tmpPath, filename: file.filename };
}

function voiceCloneSamplesDir(projectRoot: string): string {
  return join(projectRoot, '.html-video', 'voice-samples');
}

async function persistVoiceCloneSample(
  projectRoot: string,
  tmpPath: string,
  originalName: string,
): Promise<{ filename: string; path: string }> {
  const sourceExt = normalizeAudioExt(originalName);
  const ext = sourceExt === '.webm' ? '.wav' : sourceExt;
  const filename = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}${ext}`;
  const dir = voiceCloneSamplesDir(projectRoot);
  const target = join(dir, filename);
  await mkdir(dir, { recursive: true });
  if (sourceExt === '.webm') {
    await convertAudioToWav(tmpPath, target);
  } else {
    await copyFile(tmpPath, target);
  }
  return { filename, path: target };
}

function normalizeAudioExt(filename: string): string {
  const ext = extname(filename).toLowerCase();
  if (['.mp3', '.wav', '.m4a', '.mp4', '.webm'].includes(ext)) return ext;
  return '.webm';
}

async function convertAudioToWav(inputPath: string, outputPath: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-ar', '24000',
      '-ac', '1',
      outputPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk).slice(0, 1000);
    });
    child.on('error', (error) => {
      reject(new Error(`Recording conversion requires ffmpeg. Upload a WAV, MP3, or M4A file instead. ${error.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Recording conversion failed. Upload a WAV, MP3, or M4A file instead. ${stderr.trim()}`));
    });
  });
}

function createCosyVoicePrefix(): string {
  return `hv${Date.now().toString(36).slice(-8)}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
}

function normalizeCosyVoiceModelField(value: string | undefined):
  'cosyvoice-v3.5-plus' | 'cosyvoice-v3.5-flash' | 'cosyvoice-v3-plus' | 'cosyvoice-v3-flash' | 'cosyvoice-v2' {
  return value === 'cosyvoice-v3.5-plus'
    || value === 'cosyvoice-v3.5-flash'
    || value === 'cosyvoice-v3-plus'
    || value === 'cosyvoice-v3-flash'
    || value === 'cosyvoice-v2'
    ? value
    : 'cosyvoice-v3-flash';
}

function resolvePublicBaseUrl(req: IncomingMessage): string | null {
  const configured = (process.env.HTML_VIDEO_PUBLIC_BASE_URL || process.env.HV_PUBLIC_BASE_URL || '')
    .trim()
    .replace(/\/$/, '');
  if (configured) {
    const parsed = safeUrl(configured);
    if (!parsed || isLocalHostname(parsed.hostname)) return null;
    return configured;
  }

  const host = firstHeader(req.headers['x-forwarded-host']) || firstHeader(req.headers.host);
  if (!host) return null;
  const hostname = host.replace(/^\[/, '').replace(/\](:\d+)?$/, '').split(':')[0]?.toLowerCase();
  if (!hostname || isLocalHostname(hostname)) return null;
  const proto = (firstHeader(req.headers['x-forwarded-proto']) || 'https').split(',')[0]!.trim() || 'https';
  return `${proto}://${host}`;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function assertVoiceSampleReachable(audioUrl: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(audioUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Recorded voice sample is not reachable at the public URL: ${message}`);
  }
  if (!response.ok) {
    throw new Error(`Recorded voice sample URL returned HTTP ${response.status}. Check HTML_VIDEO_PUBLIC_BASE_URL and restart Studio.`);
  }
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1';
}

// Keep TS aware that copyFile is used somewhere (indirectly via orchestrator)
void copyFile;

// ---------------------------------------------------------------------------
// Message history — in-memory cache, JSON file as source of truth.
//
// v0.8.2: previously memory-only, so chat history evaporated on every studio
// restart. Now persisted to <projectDir>/messages.json. Cache is lazy-loaded
// on first GET / POST per project; writes go through saveMessages().
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  agent?: string;
  tool?: string;
  output?: unknown;
  ts: number;
}

const MESSAGES = new Map<string, ChatMessage[]>();

/** Projects with a generation running right now (detached from any request).
 *  Lets a client that switched away and came back learn the task is still alive
 *  ("⏳ still generating…") instead of seeing the progress lines vanish. */
const GENERATING = new Set<string>();

async function loadMessages(ctx: CliContext, projectId: string): Promise<ChatMessage[]> {
  const cached = MESSAGES.get(projectId);
  if (cached) return cached;
  const projectDir = await ctx.projects.ensureDir(projectId);
  const filePath = join(projectDir, 'messages.json');
  if (!existsSync(filePath)) {
    MESSAGES.set(projectId, []);
    return MESSAGES.get(projectId)!;
  }
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
    MESSAGES.set(projectId, arr);
    return arr;
  } catch {
    // Corrupt file — start fresh in memory but don't overwrite the file
    // until the next save (gives the user a chance to recover by hand).
    MESSAGES.set(projectId, []);
    return MESSAGES.get(projectId)!;
  }
}

async function saveMessages(
  ctx: CliContext,
  projectId: string,
  messages: ChatMessage[],
): Promise<void> {
  const projectDir = await ctx.projects.ensureDir(projectId);
  const filePath = join(projectDir, 'messages.json');
  const fs = await import('node:fs/promises');
  await fs.writeFile(filePath, JSON.stringify(messages, null, 2), 'utf8');
}

// `Attachment` is declared above (at the buildHtmlGenerationPrompt section)

interface BuildPromptArgs {
  tmpl: import('@html-video/core').TemplateMetadata | null;
  exampleHtml: string;
  priorHtml: string;
  history: ChatMessage[];
  userText: string;
  attachments: Attachment[];
  /** When set, iterate-phase prompts target only this frame's HTML. */
  focusFrameId?: string;
  /** The user's original opening subject, locked across phases. */
  openingTopic?: string;
}

interface Attachment {
  /** absolute path on disk */
  path: string;
  /** type the AssetStore detected */
  kind: 'image' | 'video' | 'audio' | 'data' | 'text' | 'reference-link';
  /** display name */
  filename: string;
  /** byte size */
  size: number;
  /**
   * For text sources (fetched articles/repos, uploaded .md/.txt), the actual
   * content — inlined directly into the prompt. A bare path is useless to HTTP
   * agents (Messages API runs in the cloud, can't read local disk), and even
   * for CLI agents the content should be the source material, not a file ref.
   */
  inlineText?: string;
}

/**
 * v0.5 chat prompt — guidance-first, not write-HTML-immediately.
 *
 * The system prompt tells the agent to:
 *   - On a vague first turn, ask 1–3 sharp questions instead of writing HTML
 *   - When the request + context are concrete enough, generate the full HTML
 *   - Use attachments as references / actual assets
 *   - Never use a fixed 4-question script — judge per turn what's missing
 *
 * Whether the agent writes HTML this turn is up to the agent. The server
 * extracts a fenced ```html block if present; if not, it's just a chat reply.
 */
/**
 * Conversation phases — fully sequential. Each card the assistant emits has
 * a `meta.phase` JSON field so the server can route the user's reply without
 * guessing.
 *
 *   opener  → hv-options{meta.phase:"type"}  → user picks content type
 *   content → free chat: agent asks about topic / headline / data, user
 *             can answer in 1+ turns or say "skip" / "随便"
 *   template → user picks a concrete template from the gallery (required)
 *   format  → hv-form{meta.phase:"format"}   → 3 segmented controls
 *             (aspect, duration, frame_count)
 *   confirm → hv-confirm{meta.phase:"confirm"} →  ✓ generate / ✏️ edit
 *   generate → emits HTML / content-graph + frames
 *
 *   info-edit → user clicked edit on confirm; re-emit format hv-form
 *   iterate   → after successful generate, free-form revision pass
 */
type ConvPhase =
  | 'opener'
  | 'content'
  | 'style'
  | 'need-template'
  | 'format'
  | 'format-edit'
  | 'confirm'
  | 'generate'
  | 'iterate'
  // Post-generation iteration sub-flow:
  | 'edit-menu'        // ask what to change (style / content / duration)
  | 'restyle'          // adapt the existing video content to a new template/style
  | 'iterate-content'  // re-plan the storyboard around new content
  | 'iterate-format';  // re-time / re-render with a new per-frame length

interface PhaseInputs {
  collected?: Record<string, string>; // last submitted hv-form values (format only)
  pickedType?: string;
  pickedStyle?: string;
  contentTurns?: string[];            // free-text user messages between type-pick and style/format
}

/** A phase reached during post-generation iteration carries postGen=true so the
 * prompt builder re-uses a card but bases the final regeneration on the existing
 * storyboard rather than starting fresh. */
type PhaseResult = { phase: ConvPhase; inputs: PhaseInputs; postGen?: boolean };

function detectPhase(
  history: ChatMessage[],
  userText: string,
  hasTemplate: boolean,
  hasSourceMaterial = false,
  focusFrameId = '',
  hasExistingStoryboard = false,
): PhaseResult {
  const trimmed = userText.trim();
  const inputs: PhaseInputs = {};

  // Explicit markers always win.
  if (trimmed.startsWith('[hv-form:submit]')) {
    const body = trimmed.slice('[hv-form:submit]'.length).trim();
    try { inputs.collected = JSON.parse(body); } catch { /* ignore */ }
    return { phase: 'confirm', inputs };
  }
  if (trimmed === '[hv-confirm:generate]') {
    inputs.collected = lastFormSubmission(history);
    inputs.pickedType = lastCardPickByPhase(history, 'type');
    inputs.pickedStyle = lastCardPickByPhase(history, 'style') ?? '';
    inputs.contentTurns = collectContentTurns(history);
    return { phase: 'generate', inputs };
  }
  if (trimmed === '[hv-confirm:edit]') {
    inputs.collected = lastFormSubmission(history);
    return { phase: 'format-edit', inputs };
  }

  // Free-text format reply rescue (issue #2): if the previous assistant turn
  // was asking for format params (whether it rendered the hv-form card or — as
  // the model sometimes does — just asked in prose), and this user turn parses
  // as a format answer, treat it like a card submit and advance to confirm.
  // This stops the loop where a typed "16:9 横屏 / 5s / 10" goes unrecognised
  // and the flow re-asks the same params in a different shape.
  if (!hadGenerationYet(history) && lastAssistantAskedFormat(history)) {
    const parsed = parseFormatReply(trimmed);
    if (parsed) {
      // Merge over any earlier card submit so partial typed answers keep
      // the defaults the user already had.
      inputs.collected = { ...(lastFormSubmission(history) ?? {}), ...parsed };
      return { phase: 'confirm', inputs };
    }
  }

  // Post-generation iteration. Previously ANY message after a generation was
  // forced to phase 'iterate', which only ever did a vague single-frame rewrite
  // of preview.html — so "换个风格" / "改内容" looked like nothing happened
  // (the user's recurring "后面的指令好像都没用了"). Instead, run a small
  // card-driven sub-flow: a vague "改一下" pops an edit-menu (change style /
  // content / duration); picking an option re-uses the existing style / content
  // / format cards; the final regeneration is based on the existing storyboard.
  if (hadGenerationYet(history) || hasExistingStoryboard) {
    const last = lastAssistantCardWithMeta(history);
    // Mid-iteration: the user is answering one of the edit sub-flow cards.
    if (last?.metaPhase === 'edit-menu') {
      // Route the menu choice. Match by label keywords (works for clicks, which
      // send the option label, and for free text).
      if (/风格|style|视觉|配色|换个?样子|模板|template/i.test(trimmed)) {
        inputs.pickedType = lastCardPickByPhase(history, 'type');
        return hasTemplate
          ? { phase: 'restyle', inputs, postGen: true }
          : { phase: 'need-template', inputs, postGen: true };
      }
      if (/时长|时间|duration|长度|快|慢|秒|节奏/i.test(trimmed)) {
        inputs.pickedType = lastCardPickByPhase(history, 'type');
        return { phase: 'format', inputs, postGen: true };
      }
      // default / "内容 / content / 文案 / 主题 / 重写"
      inputs.pickedType = lastCardPickByPhase(history, 'type');
      inputs.contentTurns = collectContentTurns(history);
      return { phase: 'content', inputs, postGen: true };
    }
    // The user is answering a re-shown card during iteration.
    if (last?.metaPhase === 'style') {
      inputs.pickedType = lastCardPickByPhase(history, 'type');
      inputs.pickedStyle = trimmed;
      return hasTemplate
        ? { phase: 'restyle', inputs, postGen: true }
        : { phase: 'need-template', inputs, postGen: true };
    }
    if (last?.metaPhase === 'format' || last?.kind === 'hv-form') {
      inputs.collected = lastFormSubmission(history);
      return { phase: 'iterate-format', inputs, postGen: true };
    }
    if (last?.kind === 'content-question') {
      inputs.pickedType = lastCardPickByPhase(history, 'type');
      inputs.contentTurns = [...collectContentTurns(history), trimmed];
      return { phase: 'iterate-content', inputs, postGen: true };
    }
    // A fresh post-generation instruction. The DEFAULT is the card-driven
    // sub-flow, not a single-frame rewrite — a whitelist of trigger phrases was
    // the bug (e.g. "换个模板重新生成一下" didn't match and silently fell back to
    // a no-op preview rewrite). So:
    //   - pinned frame  → single-frame iterate (the user explicitly scoped it).
    //   - clearly names style / content / duration → jump straight there.
    //   - everything else (incl. vague "改一下" / "换个模板" / "重新生成") → pop
    //     the edit-menu and ask, rather than guess or no-op.
    const pinned = !!focusFrameId;
    if (pinned) {
      return { phase: 'iterate', inputs: { collected: lastFormSubmission(history) } };
    }
    // Direct shortcuts when the instruction is unambiguous about WHAT to change.
    if (/风格|样式|配色|视觉|主题色|模板|template|style|换个?样子|赛博|极简|杂志|brutal|cyber|swiss/i.test(trimmed)) {
      inputs.pickedType = lastCardPickByPhase(history, 'type');
      return hasTemplate
        ? { phase: 'restyle', inputs, postGen: true }
        : { phase: 'need-template', inputs, postGen: true };
    }
    if (/时长|时间|duration|时间长度|节奏|快一点|慢一点|更短|更长|多少秒/i.test(trimmed)) {
      inputs.pickedType = lastCardPickByPhase(history, 'type');
      return { phase: 'format', inputs, postGen: true };
    }
    if (/文案|内容|主题|改成|换成|重写|讲|介绍|加.{0,4}(信息|数据|卖点)|text|content|rewrite/i.test(trimmed)) {
      inputs.pickedType = lastCardPickByPhase(history, 'type');
      inputs.contentTurns = [...collectContentTurns(history), trimmed].filter((s) => !isControlPhrase(s));
      return { phase: 'iterate-content', inputs, postGen: true };
    }
    // Default: ask via the edit-menu (never silently no-op).
    return { phase: 'edit-menu', inputs };
  }

  // Walk backwards; what was the most recent CARD with a meta.phase tag?
  // (Skip empty / warning assistant turns.)
  const prev = lastAssistantCardWithMeta(history);

  if (!prev) {
    // No prior card → opener.
    return { phase: 'opener', inputs };
  }

  // Last card was an opener type-pick → user just answered with their type.
  if (prev.kind === 'hv-options' && prev.metaPhase === 'type') {
    inputs.pickedType = trimmed;
    // With source material already attached, there is nothing more to collect —
    // the article/repo IS the content. Skip the content-question step (which
    // otherwise stalls: the agent emits a statement, not an interactive card,
    // and the flow waits forever for a user reply that never comes) and go
    // straight to format once a template is picked; otherwise ask for a
    // concrete template instead of a separate style/theme choice.
    if (hasSourceMaterial) {
      inputs.contentTurns = collectContentTurns(history);
      return hasTemplate
        ? { phase: 'format', inputs }
        : { phase: 'need-template', inputs };
    }
    return { phase: 'content', inputs };
  }

  // Last card was a style-pick → user answered with style choice.
  if (prev.kind === 'hv-options' && prev.metaPhase === 'style') {
    inputs.pickedType = lastCardPickByPhase(history, 'type');
    inputs.pickedStyle = trimmed;
    inputs.contentTurns = collectContentTurns(history);
    return hasTemplate ? { phase: 'format', inputs } : { phase: 'need-template', inputs };
  }

  // User was told to pick a template (need-template card is an hv-options).
  if (prev.kind === 'hv-options' && prev.metaPhase === 'need-template') {
    inputs.pickedType = lastCardPickByPhase(history, 'type');
    inputs.contentTurns = collectContentTurns(history);
    // Said "I've picked one / continue": proceed only if a template is now set.
    if (hasTemplate) {
      return { phase: 'format', inputs };
    }
    return { phase: 'need-template', inputs }; // still none → ask again
  }

  // Last card was content-question (a plain assistant message asking for content).
  // We detect this by phase metadata in a hidden HTML comment we embed.
  if (prev.kind === 'content-question') {
    // User is replying to content question. Could be (a) more content, or
    // (b) a "skip / I'm done" signal.
    const isSkip = /^(skip|跳过|够了|够|done|next|下一步|ok|好|不知道)$/i.test(trimmed)
      || trimmed.length <= 3;
    // "Free rein" answers — the user is handing the subject's details to the
    // agent ("随便生成 / 随便发挥 / 你定 / 都行 / 随机"). These should advance the
    // flow (and pop the style card) just like a skip, instead of being treated
    // as more content to collect — which left the user stuck re-typing "风格选择".
    // Substring match (not anchored) with a length guard so it doesn't swallow a
    // real sentence that merely contains "随便".
    const isFreeRein =
      trimmed.length <= 16 &&
      /(随便|随机|随意|你定|你来定|你决定|都行|都可以|看着办|自由发挥|发挥|无所谓|任意|随你)/.test(trimmed);
    // With source material attached there's nothing to collect — advance as
    // soon as the user says anything (the article already is the content).
    if (isSkip || isFreeRein || hasSourceMaterial || hasEnoughContent(history, trimmed)) {
      // Move forward: template is required before format.
      inputs.pickedType = lastCardPickByPhase(history, 'type');
      inputs.contentTurns = [...collectContentTurns(history), trimmed];
      return hasTemplate
        ? { phase: 'format', inputs }
        : { phase: 'need-template', inputs };
    }
    // Continue chatting (still in content phase).
    inputs.pickedType = lastCardPickByPhase(history, 'type');
    inputs.contentTurns = [...collectContentTurns(history), trimmed];
    return { phase: 'content', inputs };
  }

  // Default fallback: treat as iterate.
  inputs.collected = lastFormSubmission(history);
  return { phase: 'iterate', inputs };
}

/** Heuristic: how many content turns has the user given. Beyond 2 we move on. */
function hasEnoughContent(history: ChatMessage[], pending: string): boolean {
  const turns = collectContentTurns(history);
  return turns.length >= 2 || (turns.length >= 1 && pending.length > 60);
}

/** Find the most recent assistant card with a meta.phase, plus its kind. */
function lastAssistantCardWithMeta(history: ChatMessage[]): {
  kind: 'hv-options' | 'hv-form' | 'hv-confirm' | 'content-question';
  metaPhase: string | null;
} | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== 'assistant') continue;
    const c = m.content;
    if (!c.trim() || /^⚠️/.test(c.trim())) continue;
    // Try each card kind, JSON-parse the body, look for meta.phase.
    const cards: { kind: 'hv-options' | 'hv-form' | 'hv-confirm'; re: RegExp }[] = [
      { kind: 'hv-confirm', re: /```hv-confirm\s*\n([\s\S]*?)```/i },
      { kind: 'hv-form',    re: /```hv-form\s*\n([\s\S]*?)```/i },
      { kind: 'hv-options', re: /```hv-options\s*\n([\s\S]*?)```/i },
    ];
    for (const { kind, re } of cards) {
      const match = re.exec(c);
      if (match && match[1]) {
        let metaPhase: string | null = null;
        try {
          const parsed = JSON.parse(match[1].trim());
          metaPhase = parsed?.meta?.phase ?? null;
        } catch { /* unparseable card body — treat as untagged */ }
        return { kind, metaPhase };
      }
    }
    // No card → was this a content-question? Look for our marker.
    if (/<!--\s*hv-phase:content-question\s*-->/i.test(c)) {
      return { kind: 'content-question', metaPhase: 'content' };
    }
    // A real assistant turn with no card and no marker — bail.
    return null;
  }
  return null;
}

/** Look back for the user message that answered an hv-options card with meta.phase=X. */
function lastCardPickByPhase(history: ChatMessage[], phase: string): string | undefined {
  for (let i = 0; i < history.length - 1; i++) {
    const a = history[i]!;
    const u = history[i + 1]!;
    if (a.role !== 'assistant' || u.role !== 'user') continue;
    const m = /```hv-options\s*\n([\s\S]*?)```/i.exec(a.content);
    if (!m || !m[1]) continue;
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed?.meta?.phase === phase) return u.content.trim();
    } catch { /* ignore */ }
  }
  return undefined;
}

/** All free-text user replies during the content phase (between type-pick and style/format). */
/** A short user turn that just nudges the flow forward ("continue", "go",
 *  "下一步", "开始生成") rather than supplying video content. Such turns must
 *  not be collected as content — otherwise they end up as on-screen text. */
function isControlPhrase(t: string): boolean {
  const s = t.trim().toLowerCase().replace(/[。.!！~\s]+$/u, '');
  if (s.length > 12) return false; // real content is longer; keep it
  return /^(继续|继续(刚刚|上次|之前)的?任务|接着|接着(来|做|生成)|下一步|开始(生成)?|生成(吧)?|go|continue|next|start|ok|好的?|行|走|动手|可以|确认)$/u.test(s);
}

function collectContentTurns(history: ChatMessage[]): string[] {
  const out: string[] = [];
  let inContent = false;
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    if (m.role === 'assistant') {
      const c = m.content;
      // Type pick assistant card opens content phase
      const typeMatch = /```hv-options\s*\n([\s\S]*?)```/i.exec(c);
      if (typeMatch && typeMatch[1]) {
        try {
          const parsed = JSON.parse(typeMatch[1].trim());
          if (parsed?.meta?.phase === 'type') { inContent = true; continue; }
          if (parsed?.meta?.phase === 'style') { inContent = false; continue; }
        } catch { /* ignore */ }
      }
      if (/```hv-form\s*\n/i.test(c)) inContent = false;
      continue;
    }
    if (m.role !== 'user') continue;
    if (!inContent) continue;
    const t = m.content.trim();
    if (!t) continue;
    if (t.startsWith('[hv-')) continue; // skip marker messages
    // Skip control phrases ("continue / next / go / 开始生成 …"). These are the
    // user nudging the flow forward, NOT video content — otherwise e.g.
    // "继续刚刚的任务" gets baked in as the opening frame's headline.
    if (isControlPhrase(t)) continue;
    // Skip the "trimmed answer" that picks the type — it's the first user turn
    // immediately after the type card; keep only later ones.
    if (out.length === 0) {
      // The very first user turn after a type card IS the type pick. Skip it.
      // (Subsequent turns in content phase get collected.)
      out.push('__TYPE_PICK__');
      continue;
    }
    out.push(t);
  }
  return out.filter((t) => t !== '__TYPE_PICK__');
}

async function existingStoryboardSource(ctx: CliContext, projectId: string, project: Project): Promise<string> {
  const lines: string[] = [];
  const narration = project.soundtrack?.narrationText?.trim();
  if (narration) {
    lines.push('当前视频口播全文：');
    lines.push(narration);
  }
  try {
    const graph = await ctx.orchestrator.readContentGraph(projectId);
    if (graph?.synopsis) {
      lines.push('');
      lines.push(`当前视频概要：${String(graph.synopsis).trim()}`);
    }
    if (Array.isArray(graph?.nodes) && graph.nodes.length > 0) {
      lines.push('');
      lines.push('当前分镜内容：');
      for (let i = 0; i < graph.nodes.length; i++) {
        const node = graph.nodes[i] as { text?: unknown; label?: unknown; id?: unknown };
        const text = String(node.text ?? node.label ?? '').trim();
        if (text) lines.push(`${i + 1}. ${text}`);
      }
    }
  } catch {
    // Best-effort; narration/current frames below are enough for template adaption.
  }
  if (!narration && project.frames?.length) {
    lines.push('');
    lines.push('当前帧顺序：');
    for (const frame of [...project.frames].sort((a, b) => a.order - b.order)) {
      lines.push(`${frame.order + 1}. ${frame.graphNodeId}`);
    }
  }
  return lines.join('\n').trim();
}

/**
 * The video's LOCKED subject, in the user's own words. The opening message
 * ("帮我生成一个关于 Open Design 的介绍视频") names the subject, but it never
 * reached the generate / storyboard prompts: collectContentTurns() only keeps
 * turns after the type-pick card, so a later vague answer like "随机" became the
 * entire content input and the video came out about randomness instead of Open
 * Design. This recovers the opening subject so every downstream prompt can lock
 * onto it.
 *
 * Prefer the persisted project.intent, but the studio UI creates projects with
 * a name only (intent is almost always empty), so fall back to the first user
 * message in history — which is the genuine opening request. Strip the
 * attachment summary suffix appended to message content.
 */
function resolveOpeningTopic(project: { intent?: string }, history: ChatMessage[]): string {
  const fromIntent = project.intent?.trim();
  if (fromIntent) return fromIntent.slice(0, 200);
  const firstUser = history.find((m) => m.role === 'user')?.content ?? '';
  const clean = (firstUser.split('\n\n📎')[0] ?? '').trim();
  // Don't lock onto a bare control phrase ("继续" / "ok") if that's somehow first.
  if (!clean || isControlPhrase(clean)) return '';
  return clean.slice(0, 200);
}

// Legacy helper retained for backward calls — now delegates to detectPhase's
// metadata-aware lookup.
function lastAssistantCardKind(history: ChatMessage[]): 'hv-options' | 'hv-form' | 'hv-confirm' | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== 'assistant') continue;
    if (/```hv-confirm\s*\n/i.test(m.content)) return 'hv-confirm';
    if (/```hv-form\s*\n/i.test(m.content)) return 'hv-form';
    if (/```hv-options\s*\n/i.test(m.content)) return 'hv-options';
    // Skip empty / warning-only assistant turns — the live card is one further back.
    if (!m.content.trim()) continue;
    if (/^⚠️/.test(m.content.trim())) continue;
    // A real assistant message with no card resets the search.
    return null;
  }
  return null;
}

function lastFormSubmission(history: ChatMessage[]): Record<string, string> | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== 'user') continue;
    const match = /^\[hv-form:submit\]\s*\n([\s\S]+)$/.exec(m.content.trim());
    if (match && match[1]) {
      try { return JSON.parse(match[1]); } catch { /* keep scanning */ }
    }
  }
  return undefined;
}

/** Has a successful generation already happened in this conversation? */
function hadGenerationYet(history: ChatMessage[]): boolean {
  // Only count a real storyboard/video generation, not any assistant turn that
  // happens to contain a "✓". The old broad check (`✓\s`) matched the persisted
  // summary lines of the iteration sub-flow itself, so once you'd generated, the
  // flow could never leave 'iterate'. Look for concrete generation markers.
  return history.some(
    (m) =>
      m.role === 'assistant' &&
      /```json#content-graph|故事板规划完成|storyboard (generated|regenerated|restyled)|帧完成|frame .* (done|完成)/i.test(m.content),
  );
}

/**
 * Was the most recent assistant turn asking the user for format params
 * (aspect / duration / frame count)? True for the proper `hv-form` card AND
 * for the prose fallback the model sometimes emits instead. Used to decide
 * whether a free-text user reply should be parsed as a format answer.
 */
function lastAssistantAskedFormat(history: ChatMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== 'assistant') continue;
    const c = m.content;
    if (!c.trim() || /^⚠️/.test(c.trim())) continue; // skip empty / warning turns
    // The real hv-form card.
    const form = /```hv-form\s*\n([\s\S]*?)```/i.exec(c);
    if (form?.[1]) {
      try { return JSON.parse(form[1].trim())?.meta?.phase === 'format'; } catch { return true; }
    }
    // Prose fallback: the turn talks about size/duration/frames without a card.
    // Require at least two of the three concepts so an unrelated mention of
    // "时长" elsewhere doesn't trigger it.
    const hits = [/尺寸|横屏|竖屏|方形|aspect|比例/i, /时?长|秒|duration|\bs\b/i, /帧|frames?/i]
      .filter((re) => re.test(c)).length;
    return hits >= 2;
  }
  return false;
}

/**
 * Best-effort parse of format params from a FREE-TEXT user reply.
 *
 * The format step is supposed to render an `hv-form` card (segmented buttons)
 * whose submit carries an explicit `[hv-form:submit]` marker. But the model
 * sometimes ignores that instruction and instead asks for the params in prose
 * ("9:16 竖屏 / 3s / 6 …"); the user then types the answer free-form, with no
 * marker. Without this parser the state machine can't tell the params were
 * already given, so it loops — re-asking the same thing in a different shape
 * (issue #2). We extract aspect / duration / frame_count heuristically so a
 * typed reply is treated the same as a card submit.
 *
 * Returns undefined when the text carries no recognisable format signal, so
 * callers can fall through to other phase logic.
 */
export function parseFormatReply(text: string): Record<string, string> | undefined {
  const t = text.trim();
  if (!t || t.length > 80) return undefined; // long text is content, not a format answer
  const out: Record<string, string> = {};

  // --- aspect: explicit ratio (16:9 / 9:16 / 1:1 / 4:5) or a keyword ---
  const ratio = /\b(16\s*[:：]\s*9|9\s*[:：]\s*16|1\s*[:：]\s*1|4\s*[:：]\s*5)\b/.exec(t);
  const ratioNorm = ratio?.[1]?.replace(/\s/g, '').replace('：', ':');
  if (ratioNorm === '16:9' || /横屏|landscape|宽屏/i.test(t)) out.aspect = '16:9 横屏';
  else if (ratioNorm === '9:16' || /竖屏|手机|portrait|vertical/i.test(t)) out.aspect = '9:16 手机竖屏';
  else if (ratioNorm === '1:1' || /方形|square/i.test(t)) out.aspect = '1:1 方形';
  else if (ratioNorm === '4:5' || /小红书|xiaohongshu|rednote/i.test(t)) out.aspect = '4:5 小红书';

  // --- duration: a number directly tied to seconds (5s / 5秒 / 5 sec) ---
  const dur = /(\d{1,3})\s*(?:s\b|秒|sec)/i.exec(t);
  if (dur?.[1]) out.duration = dur[1];

  // --- frame_count: a number tied to 帧/frame, or the lone trailing number in
  //     a "a / b / c" triple where a=ratio, b=duration. ---
  const fr = /(\d{1,2})\s*(?:帧|frames?)\b/i.exec(t);
  if (fr?.[1]) out.frame_count = fr[1];
  else {
    // "16:9 横屏 / 5s / 10" — after stripping ratio+duration tokens, a bare
    // small integer left over is the frame count.
    const parts = t.split(/[/、,，]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1]!;
      const bare = /^(\d{1,2})\s*帧?$/.exec(last);
      if (bare?.[1] && !/[:：s秒]/.test(last)) out.frame_count = bare[1];
    }
  }

  // Need at least one positively-identified signal to count as a format reply.
  return Object.keys(out).length > 0 ? out : undefined;
}

function lastTypePick(history: ChatMessage[]): string | undefined {
  // The first user turn that immediately follows the opener hv-options card.
  for (let i = 0; i < history.length - 1; i++) {
    const a = history[i]!;
    const u = history[i + 1]!;
    if (a.role === 'assistant' && u.role === 'user' && /```hv-options\s*\n/i.test(a.content)) {
      return u.content.trim();
    }
  }
  return undefined;
}

/**
 * Render one attachment for the prompt. Text sources with inlined content get
 * their actual content fenced inline (so HTTP agents that can't read local
 * disk still see it); binary/path-only attachments stay a one-line reference.
 */
function renderAttachment(a: Attachment): string[] {
  if (a.inlineText) {
    return [
      `- [${a.kind}] ${a.filename} — full content below:`,
      '```',
      a.inlineText,
      '```',
    ];
  }
  return [`- [${a.kind}] ${a.filename} — ${a.path}`];
}

/** A design.md / frame.md / DESIGN.md attachment is a brand + motion SPEC the
 *  video must FOLLOW (palette, type, tokens, pacing/scale/dwell/motion), not
 *  content to be narrated. Detect by filename or by the spec's tell-tale
 *  headings, so users can drop in a design.md (portable design system) or
 *  HeyGen-style frame.md (motion spec). */
function isDesignSpec(a: Attachment): boolean {
  const name = (a.filename || '').toLowerCase();
  if (/(^|\/)(design|frame)\.md$/.test(name) || /\bframe\.md\b|\bdesign\.md\b/.test(name)) return true;
  const txt = a.inlineText ?? '';
  if (!txt) return false;
  // Heading/section fingerprints shared by design.md & frame.md specs.
  return /#\s*(design|frame)\s*[—\-]/i.test(txt)
    || /(^|\n)##\s*(System|Theme|Tokens|Motion|Pacing|Composition)\b/i.test(txt)
    || /\b(pacing|dwell)\b.*\b(scale|motion)\b/i.test(txt);
}

/** Split attachments into design/motion specs vs ordinary source material. */
function partitionAttachments(atts: Attachment[]): { specs: Attachment[]; content: Attachment[] } {
  const specs: Attachment[] = [];
  const content: Attachment[] = [];
  for (const a of atts) (a.inlineText && isDesignSpec(a) ? specs : content).push(a);
  return { specs, content };
}

/** Prompt block telling the agent to OBEY a design/frame spec. */
function renderDesignSpecBlock(specs: Attachment[]): string[] {
  if (!specs.length) return [];
  const out: string[] = [
    `DESIGN SYSTEM / MOTION SPEC (REQUIRED — obey this for every frame): the file(s)`,
    `below define the brand's visual + motion language. Honour their palette,`,
    `typography, tokens, layout AND any motion direction (pacing, scale, dwell,`,
    `motion) over your own defaults. This is HOW the video must look/move; the`,
    `actual subject still comes from the user's content.`,
  ];
  for (const a of specs) {
    out.push(`--- ${a.filename} ---`);
    out.push((a.inlineText ?? '').slice(0, 6000));
  }
  out.push('');
  return out;
}

function renderMotionExportContract(): string {
  return [
    'Canvas fill contract (REQUIRED): the page must fill the requested output viewport edge-to-edge.',
    'Set html, body, and the single top-level scene/stage to margin:0, width:100%, height:100%, and overflow:hidden.',
    'Do not center a smaller fixed canvas; do not constrain the root with max-width/max-height; do not apply root zoom or transform:scale(<1); do not letterbox.',
    'Full-frame image/video backgrounds must use object-fit:cover, not contain. Keep text inside safe margins, but make the background/root reach all four edges.',
    'Motion/export contract (REQUIRED): the animation must be real browser-recordable motion that survives MP4 export.',
    'Use CSS @keyframes, a finite GSAP timeline that auto-plays, or requestAnimationFrame. The page must start motion by itself after load; do not rely on hover, scroll, clicks, or editor-only controls.',
    'Include visible change across the first 0.3-1.5 seconds (position, opacity, scale, stroke-dashoffset, counter/bar growth, wipe, or scene reveal), and keep a stable final state for the rest of the frame.',
    'Use finite animation iterations. Do not use CSS infinite loops, GSAP repeat:-1, Math.random(), Date.now(), or timer-driven randomness; export must be deterministic at every timestamp.',
    'Do not output only a static end frame. Do not create paused-only timelines unless they are also exposed through window.__timelines and auto-play when opened normally.',
  ].join('\n');
}

function extractHtmlFromAgentText(text: string): string | undefined {
  const fenced = /```(?:html)?[^\n`]*\n([\s\S]*?)```/i.exec(text)?.[1]?.trim();
  if (fenced) return fenced;
  const doc = /<!doctype html[\s\S]*?<\/html>/i.exec(text)?.[0]?.trim();
  if (doc) return doc;
  const html = /<html[\s\S]*?<\/html>/i.exec(text)?.[0]?.trim();
  return html || undefined;
}

/** LLMs emit not-quite-valid JSON for the content-graph more often than not:
 *  trailing commas, and (now that we ask them to quote article terms) stray
 *  straight double-quotes inside string values. Try strict parse first, then
 *  escalate through cheap, safe repairs before giving up. */
function parseGraphJsonTolerant(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through to repairs */
  }
  // 1) Strip trailing commas before } or ] — the most common LLM slip.
  const noTrailing = raw.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(noTrailing);
  } catch {
    /* fall through */
  }
  // 2) Escape stray straight double-quotes inside synopsis/text string values
  //    (e.g. text: "the "harness" idea"). Operate on the trailing-comma-cleaned
  //    text; for each "<key>": "<value>" pair, re-escape any bare " in <value>.
  const repaired = noTrailing.replace(
    /("(?:synopsis|text)"\s*:\s*")([\s\S]*?)("\s*(?:,|\}|\]))/g,
    (_m, pre: string, val: string, post: string) =>
      pre + val.replace(/\\?"/g, '\\"') + post,
  );
  return JSON.parse(repaired); // if this still throws, caller reports it
}

/** A content type is multi-frame UNLESS it's an explicitly single-frame kind
 *  (title card / cover / single still). Whitelisting "讲解/explainer/…" was too
 *  narrow — e.g. "概念解说短片" (解说, not 讲解) fell through to single-frame.
 *  Inverting the test makes new/renamed multi-frame types default correctly. */
function isMultiFrameType(pickedType: string): boolean {
  if (!pickedType) return false;
  const single = /单帧|单画面|标题卡|封面|logo|title.?card|single.?frame|cover|still/i.test(pickedType);
  return !single;
}

function buildStylePhasePrompt(pickedType: string): string {
  const p: string[] = [];
  p.push(`The user has shared their content for a "${pickedType}". Now ask them about visual style with ONE hv-options card. JSON shape EXACTLY as shown — keep "meta" verbatim:`);
  p.push('```hv-options');
  p.push(JSON.stringify({
    meta: { phase: 'style' },
    question: '视觉风格怎么定？',
    options: [
      { label: 'Cyberpunk glitch',    hint: '霓虹 / 故障感 / 高对比' },
      { label: 'Swiss minimalist',    hint: '网格 / 无衬线 / 留白' },
      { label: 'Warm-grain magazine', hint: '纸感 / 衬线 / 暖色' },
      { label: 'Mono brutalist',      hint: '黑白 / 块状 / 粗体' },
      { label: '从设计模板选',        hint: '上方挑一个现成模板' },
    ],
    allow_freeform: true,
  }, null, 2));
  p.push('```');
  p.push('');
  p.push(`Add ONE short sentence above the card in the user's language inviting them to pick or describe a vibe. Mention they can also upload a reference image via the 📎 button.`);
  p.push('');
  p.push(`Do NOT write HTML this turn. Do NOT return an empty reply.`);
  return p.join('\n');
}

function buildHtmlGenerationPrompt(args: BuildPromptArgs): string {
  const { tmpl, exampleHtml, priorHtml, history, userText, attachments, openingTopic } = args;

  // When a template is selected, its own source HTML is the style ground truth —
  // NOT a prior render. Otherwise a project that was previously rendered in some
  // other look would keep feeding that stale look back in as "the style to draw
  // from", and the freshly-picked template gets ignored. Only fall back to
  // priorHtml (iterate-on-last-render) when no template is in play.
  const baseHtml = tmpl
    ? exampleHtml
    : (priorHtml && priorHtml !== exampleHtml ? priorHtml : exampleHtml);
  const trimmed = userText.trim();
  // A fetched article / repo / uploaded doc carries inlined content — that IS
  // the topic, so we should not interrogate the user about what the video is
  // about. The source rides into every phase's prompt via `attachments`.
  const hasSourceMaterial = attachments.some((a) => !!a.inlineText);
  const { phase, inputs } = detectPhase(history, userText, !!tmpl, hasSourceMaterial, args.focusFrameId ?? '');

  // ---- edit-menu: post-generation "what do you want to change?" card ----
  if (phase === 'edit-menu') {
    const em: string[] = [];
    em.push(`The user wants to change the already-generated video but hasn't said what. Reply with ONE short line in their language asking what to change, then ONE fenced \`\`\`hv-options block. Use this EXACT JSON — keep "meta" verbatim:`);
    em.push('```hv-options');
    em.push(JSON.stringify({
      meta: { phase: 'edit-menu' },
      question: '想改哪方面？',
      options: [
        { label: '🎞 换模板', hint: '保留内容，改用当前选中的模板' },
        { label: '✏️ 改内容', hint: '改文案 / 主题 / 重写脚本' },
        { label: '⏱️ 改时长', hint: '调整每帧时长 / 节奏' },
      ],
      allow_freeform: true,
    }, null, 2));
    em.push('```');
    em.push('');
    em.push(`Do NOT write HTML this turn. Do NOT return an empty reply. The hv-options block is REQUIRED.`);
    return em.join('\n');
  }

  // ---- opener: hv-options card with meta.phase = "type" ----
  if (phase === 'opener') {
    const opener: string[] = [];
    opener.push(
      `The user just opened a project and said "${trimmed}". You are an HTML-video creation assistant.`,
    );
    opener.push('');
    opener.push(`Reply with TWO things, in this exact order:`);
    opener.push(`1. ONE friendly opening sentence in the user's language (≤ 25 chars).`);
    opener.push(`2. A fenced \`\`\`hv-options block with the 4 content-type choices below. JSON shape EXACTLY as shown — do not change keys or omit "meta":`);
    opener.push('```hv-options');
    opener.push(JSON.stringify({
      meta: { phase: 'type' },
      question: '想做哪种内容？',
      options: [
        { label: '单帧标题卡',   hint: 'logo / 封面 / 单画面 - 5-10s' },
        { label: '多帧预告片',   hint: '产品 / 活动 teaser, 3-6 帧' },
        { label: '数据大字报',   hint: '1-2 个核心数字, 社媒爆款风' },
        { label: '概念解说短片', hint: '几帧讲清一个 idea / feature' },
      ],
      allow_freeform: true,
    }, null, 2));
    opener.push('```');
    opener.push('');
    if (tmpl) {
      opener.push(
        `Note: a template "${tmpl.name}" is currently selected (${tmpl.description}). Treat it as a visual style reference only — content type still drives the structure.`,
      );
      opener.push('');
    }
    opener.push(`Do NOT write HTML this turn. Do NOT return an empty reply. The hv-options block is REQUIRED.`);
    return opener.join('\n');
  }

  // ---- content: free chat asking about topic / headline / data ----
  if (phase === 'content') {
    const pickedType = inputs.pickedType ?? '';
    const turns = inputs.contentTurns ?? [];
    const p: string[] = [];

    // Source material present → DON'T interrogate. The article/repo content is
    // the topic; acknowledge it and let the flow advance to style/format.
    if (hasSourceMaterial) {
      p.push(`The user is making a ${pickedType ? `"${pickedType}"` : 'video'} based on the source material below — do NOT ask them what it's about, the content is already provided.`);
      p.push('');
      for (const a of attachments) p.push(...renderAttachment(a));
      p.push('');
      p.push(`In the user's language, write ONE short line that names the actual topic/title you read from the source and states the video will be built from it (e.g. "好，我读完了《…》这篇文章 — 这就基于它生成。下一步确认格式。"). Do NOT ask the user to retype or summarize anything. End with this hidden marker on its own line:`);
      p.push('<!-- hv-phase:content-question -->');
      p.push('');
      p.push(`Plain text + the marker only. NO code blocks. NO questions. Do NOT return an empty reply.`);
      return p.join('\n');
    }

    p.push(`The user is making a ${pickedType ? `"${pickedType}"` : 'video'}. Collect concrete content for it via natural conversation — DO NOT emit any code block, hv-options, hv-form, or hv-confirm. End your reply with this hidden marker on its own line so the server knows you're still in the content phase:`);
    p.push('<!-- hv-phase:content-question -->');
    p.push('');
    p.push(`Goal: surface what the video is ABOUT (topic, brand / project name, headline / tagline, key numbers or data points). The user can answer, partially answer, or say "随便发挥 / skip / 不知道" — accept whatever they give and move on.`);
    p.push('');
    // The user's opening request already names the subject (e.g. "做一个 Open
    // Design 推广视频"). Lock onto it: don't let a vague follow-up answer like
    // "随机/随便/anything" silently become a literal NEW topic — that's how a
    // "promote Open Design" request turned into a probability explainer.
    {
      const openingTopic = history.find((m) => m.role === 'user')?.content?.trim().slice(0, 200);
      if (openingTopic) {
        p.push(`The user's ORIGINAL opening request was: "${openingTopic}". Treat this as the LOCKED subject of the video unless the user clearly asks to change it.`);
        p.push(`If the user's answer this turn CONTRADICTS or seems unrelated to that subject (e.g. they opened with a product/brand video but now answer with an off-topic word), do NOT silently switch topics. Ask ONE short clarifying question: keep the original subject (with the new word as a detail/example/angle), or genuinely change the subject? Treat vague answers like "随机 / 随便 / anything / 你定 / whatever" as "you decide the details, KEEP the original subject" — never as a literal new topic.`);
        p.push('');
      }
    }
    if (turns.length === 0) {
      p.push(`This is the first content turn. Ask 1–3 short, sharp questions, in the user's language. Keep it under 60 words. Mention they can answer fully, partially, or just say "skip" / "随便".`);
    } else {
      p.push(`The user has already shared:`);
      for (const t of turns) p.push(`  - ${t.slice(0, 200)}`);
      p.push('');
      p.push(`Two options:`);
      p.push(`- If you still need more info: ask ONE clarifying question and end your reply with the marker on its own line: <!-- hv-phase:content-question -->`);
      p.push(`- If you have enough: write ONLY a one-line confirmation in the user's language (e.g. "好，我有思路了，系统会自动匹配模板，下一步确认格式。" / "Got it. I'll auto-match a template next."). Do NOT add the marker — the server will advance automatically.`);
    }
    p.push('');
    p.push(`Reply in plain text. NO code blocks. Do NOT return an empty reply.`);
    return p.join('\n');
  }

  // ---- style: legacy route; template selection is now the only visual choice ----
  if (phase === 'style') {
    const p: string[] = [];
    p.push(`Do NOT ask the user to choose an abstract visual style. Tell them — in their language, ONE short friendly line — to pick a concrete template from the top-bar 模板 / Template dropdown, then offer this card so they can confirm once they've picked. JSON shape EXACTLY — keep "meta" verbatim:`);
    p.push('```hv-options');
    p.push(JSON.stringify({
      meta: { phase: 'need-template' },
      question: '先在顶部「模板」里选一个模板，选好后点下面继续：',
      options: [
        { label: '我已选好模板，继续', hint: '用顶部选中的模板生成' },
      ],
      allow_freeform: false,
    }, null, 2));
    p.push('```');
    p.push('');
    p.push(`Do NOT write HTML this turn. Do NOT return an empty reply.`);
    return p.join('\n');
  }

  // ---- need-template: user chose "from design template" but hasn't picked one
  if (phase === 'need-template') {
    const p: string[] = [];
    p.push(`The project has NOT selected a template yet. Do NOT generate. Tell the user — in their language, ONE short friendly line — to pick a template from the top-bar 模板 / Template dropdown, then offer this card so they can confirm once they've picked. JSON shape EXACTLY — keep "meta" verbatim:`);
    p.push('```hv-options');
    p.push(JSON.stringify({
      meta: { phase: 'need-template' },
      question: '先在顶部「模板」里选一个模板，选好后点下面继续：',
      options: [
        { label: '我已选好模板，继续', hint: '用顶部选中的模板生成' },
      ],
      allow_freeform: false,
    }, null, 2));
    p.push('```');
    p.push('');
    p.push(`Do NOT write HTML this turn. Do NOT return an empty reply.`);
    return p.join('\n');
  }

  // ---- format / format-edit: hv-form with 3 segmented controls ----
  if (phase === 'format' || phase === 'format-edit') {
    const isEdit = phase === 'format-edit';
    const pre = inputs.collected ?? {};
    const pickedType = isEdit
      ? lastCardPickByPhase(history, 'type') ?? ''
      : (inputs.pickedType ?? '');
    const isMulti = !!pickedType && isMultiFrameType(pickedType);
    const defaults = {
      aspect:      pre.aspect      ?? '16:9 横屏',
      duration:    pre.duration    ?? (isMulti ? '15' : '5'),
      frame_count: pre.frame_count ?? (isMulti ? '4' : '1'),
      // Per-frame pacing default 4s — comfortable, avoids the "rushed" feel a
      // short total ÷ many frames produces. Total is derived from this × frames.
      per_frame:   pre.per_frame   ?? '4',
    };
    const p: string[] = [];
    if (isEdit) {
      p.push(`The user wants to revise the format. Re-emit the SAME hv-form card with each \`default\` set to their last answer so they only need to change what they want.`);
    } else {
      p.push(`Now ask about format with ONE hv-form card — three segmented controls, no text inputs. JSON shape EXACTLY as shown — keep "meta" verbatim:`);
    }
    // The card is the ONLY acceptable way to ask this. Asking in prose makes
    // the user type a free-form answer with no submit marker, which the flow
    // then fails to recognise and re-asks (issue #2).
    p.push(`IMPORTANT: emit the hv-form card below — do NOT ask for size / duration / frames in plain prose, and do NOT list example answers for the user to type.`);
    p.push('```hv-form');
    p.push(JSON.stringify({
      meta: { phase: 'format' },
      title: isEdit ? '改一下格式' : (isMulti ? '最后一步：尺寸 / 每帧时长 / 帧数' : '最后一步：选个尺寸 / 时长'),
      fields: [
        {
          key: 'aspect', label: '画面尺寸', kind: 'buttons', required: true,
          default: defaults.aspect,
          options: [
            { value: '16:9 横屏',     label: '16:9 横屏' },
            { value: '9:16 手机竖屏', label: '9:16 竖屏' },
            { value: '1:1 方形',      label: '1:1 方形' },
            { value: '4:5 小红书',    label: '4:5 小红书' },
          ],
        },
        // Multi-frame: pace by PER-FRAME duration (total = per_frame × frames,
        // shown live). Single-frame: just a total duration.
        ...(isMulti
          ? [
              {
                key: 'per_frame', label: '每帧时长 (秒)', kind: 'buttons', required: true,
                default: defaults.per_frame,
                hint: '总时长 = 每帧时长 × 帧数',
                options: ['2', '3', '4', '5', '6', '8'].map((v) => ({ value: v, label: `${v}s` })),
              },
              {
                key: 'frame_count', label: '帧数', kind: 'buttons', required: true,
                default: defaults.frame_count,
                options: ['2', '3', '4', '5', '6', '7', '8', '9', '10'].map((v) => ({ value: v, label: v })),
              },
              // Opt-in: render data frames natively with Remotion (numbers roll,
              // bars grow) instead of static hyperframes HTML. Default OFF —
              // Remotion is a user-chosen enhancement, the AI never flips it.
              {
                key: 'remotion_enhance', label: '⚡ 数据帧用 Remotion', kind: 'buttons', required: false,
                default: '关',
                hint: '数据帧用原生 Remotion 渲染（数字滚动 / 柱子生长）；其余帧仍走 Hyperframes',
                options: [
                  { value: '关', label: '关' },
                  { value: '开', label: '开 · Remotion' },
                ],
              },
            ]
          : [
              {
                key: 'duration', label: '时长 (秒)', kind: 'buttons', required: true,
                default: defaults.duration,
                options: ['3', '5', '10', '15'].map((v) => ({ value: v, label: `${v}s` })),
              },
            ]),
      ],
      allow_attachments: false,
    }, null, 2));
    p.push('```');
    p.push('');
    p.push(`Do NOT write HTML this turn. Do NOT return an empty reply.`);
    return p.join('\n');
  }

  // ---- confirm: emit hv-confirm summarising what was collected ----
  if (phase === 'confirm') {
    const collected = inputs.collected ?? {};
    const pickedType = lastCardPickByPhase(history, 'type') ?? '';
    const pickedStyle = lastCardPickByPhase(history, 'style') ?? '';
    const contentTurns = collectContentTurns(history);
    const summaryRows: { label: string; value: string }[] = [];
    if (pickedType) summaryRows.push({ label: '类型', value: pickedType });
    if (contentTurns.length > 0) {
      summaryRows.push({ label: '内容', value: contentTurns.join(' · ').slice(0, 240) });
    }
    if (pickedStyle) summaryRows.push({ label: '风格', value: pickedStyle });
    if (tmpl) summaryRows.push({ label: '模板', value: tmpl.name });
    const labelMap: Record<string, string> = {
      aspect: '尺寸', duration: '时长', frame_count: '帧数', per_frame: '每帧时长',
    };
    // When pacing by per-frame, show per-frame + frames + derived total.
    const pf = Number(collected.per_frame ?? '') || 0;
    const keys = pf > 0 ? ['aspect', 'per_frame', 'frame_count'] : ['aspect', 'duration', 'frame_count'];
    for (const k of keys) {
      const v = collected[k];
      if (v) summaryRows.push({ label: labelMap[k] ?? k, value: k === 'per_frame' ? `${v}s` : v });
    }
    if (pf > 0) {
      const frames = Number(collected.frame_count ?? '4') || 4;
      summaryRows.push({ label: '总时长', value: `${pf * frames}s` });
    }
    if (attachments.length > 0) {
      summaryRows.push({ label: '素材', value: attachments.map((a) => a.filename).join(', ') });
    }

    const p: string[] = [];
    p.push(`The user has chosen the format. Emit ONE \`\`\`hv-confirm block (no other code blocks) summarising what you've got, in the user's language. Use this exact JSON — keep "meta":`);
    p.push('');
    p.push('```hv-confirm');
    p.push(JSON.stringify({
      meta: { phase: 'confirm' },
      title: '按这些信息生成？',
      summary: summaryRows,
      actions: ['generate', 'edit'],
    }, null, 2));
    p.push('```');
    p.push('');
    // Soft gate: if the subject is too thin to make a meaningful video, nudge
    // the user to add a concrete topic/brand/number — but never block, the card
    // still ships with both actions so they can proceed as-is.
    const contentBlob = contentTurns.join(' ').trim();
    const topicThin =
      attachments.length === 0 &&
      (contentBlob.replace(/\s/g, '').length < 8 ||
        /^(随机|随便|anything|random|whatever|都行|你定|skip|不知道)$/i.test(contentBlob));
    if (topicThin) {
      p.push(`NOTE: the collected content ("${contentBlob || '(empty)'}") is very thin / vague. BEFORE the hv-confirm block, add ONE short friendly sentence in the user's language gently flagging that the topic is sparse and inviting them to add a concrete subject / brand / key number for a stronger video — but STILL emit the hv-confirm block exactly as above so they can generate anyway if they want.`);
      p.push('');
    }
    p.push(`Do NOT write HTML this turn. Do NOT return an empty reply. The hv-confirm block is REQUIRED.`);
    return p.join('\n');
  }

  // ---- generate: actually write the HTML / content-graph ----
  if (phase === 'generate') {
    const collected = inputs.collected ?? {};
    const pickedType = inputs.pickedType ?? '';
    const pickedStyle = inputs.pickedStyle ?? '';
    const contentTurns = inputs.contentTurns ?? [];
    const aspect = ((collected.aspect ?? '16:9').split(/\s+/)[0] ?? '16:9'); // strip "16:9 横屏" → "16:9"
    const [w, h] = aspect.includes(':') ? aspect.split(':').map(Number) : [16, 9];
    const isMulti = isMultiFrameType(pickedType)
      || Number(collected.frame_count ?? '1') > 1
      || Number(collected.per_frame ?? '0') > 0;

    // Pick a concrete pixel resolution that respects the aspect choice.
    let resolution = '1920×1080';
    if (aspect === '9:16') resolution = '1080×1920';
    else if (aspect === '1:1') resolution = '1080×1080';
    else if (aspect === '4:5') resolution = '1080×1350';

    const styleLabel = pickedStyle && /^从设计模板选|template/i.test(pickedStyle)
      ? (tmpl ? `(use the selected template "${tmpl.name}" — ${tmpl.description})` : '(let the model choose)')
      : pickedStyle;

    const p: string[] = [];
    p.push(`Generate the HTML video file(s) the user just confirmed.`);
    p.push('');
    // Lock the subject to the user's opening request. The content turns below
    // can be as thin as "随机" — without this the video drifts onto that literal
    // word (a "promote Open Design" request became a randomness explainer).
    if (openingTopic) {
      p.push(`VIDEO SUBJECT (LOCKED): the user opened with "${openingTopic}". The video MUST be about THIS subject.`);
      p.push(`If a content line below is a vague placeholder like "随机 / 随便 / anything / 你定 / whatever", it means "YOU choose the concrete details (selling points, framing, copy) — but the SUBJECT stays "${openingTopic}"". NEVER treat "随机" as the literal topic; do NOT make a video about randomness.`);
      p.push('');
    }
    p.push(`Inputs (use these LITERALLY — do NOT make up brand names or facts beyond what is stated):`);
    p.push(`- 类型 / type: ${pickedType || '(未指定)'}`);
    if (contentTurns.length > 0) {
      p.push(`- 内容 / content (what the user told us in the chat):`);
      for (const t of contentTurns) p.push(`  · ${t.replace(/\n/g, ' ').slice(0, 280)}`);
    } else {
      p.push(`- 内容 / content: (the user did not specify; pick a sensible default that fits the type, but keep it generic — no fake brand names)`);
    }
    if (styleLabel) p.push(`- 风格 / style: ${styleLabel}`);
    p.push(`- 画面尺寸: ${aspect} (${resolution})`);
    p.push(`- 时长: ${collected.duration ?? '?'} 秒`);
    p.push(`- 帧数: ${collected.frame_count ?? (isMulti ? '4' : '1')}`);
    p.push('');
    if (attachments.length > 0) {
      const { specs, content } = partitionAttachments(attachments);
      // A design.md / frame.md is a style+motion spec to OBEY, surfaced first.
      p.push(...renderDesignSpecBlock(specs));
      if (content.length > 0 || specs.length === 0) {
        p.push(`Attachments:`);
        for (const a of (content.length ? content : attachments)) p.push(...renderAttachment(a));
        p.push(`Use binary attachments (images, data files) as actual assets where appropriate (logo, screenshot, data file). The inlined text/article/repo content above is the SOURCE MATERIAL — base the video's actual content (facts, names, numbers, narrative) on it, don't just decorate with it.`);
        p.push('');
      }
    }
    p.push(`Constraints: full-bleed ${resolution}, opens with an animation timeline, inline CSS + JS, single complete <!doctype html>...</html> document(s). CDN imports (Tailwind, GSAP) are fine. Tag every visible text node with data-hv-text set to a stable key (brand_name, headline, item_1, cta…). No prose outside code blocks.`);
    p.push(renderMotionExportContract());
    p.push('');
    // Frame-count safety: claude --print can truncate / stall on very large
    // multi-frame batches. Cap at 10 (high frame counts get progressively
    // less reliable in a single pass), and tell the model so it can plan.
    const requestedFrames = Math.max(1, Math.min(10, Number(collected.frame_count ?? '4') || 4));
    // ⚠️ FALLBACK ONLY. Real multi-frame generation goes through
    // runSplitMultiFrameGenerate (the server routes frame_count>1 there before
    // ever reaching this single-shot prompt). This branch only fires if that
    // routing is bypassed. If you change multi-frame grounding / template /
    // source-material rules, change runSplitMultiFrameGenerate — that's the
    // path users actually hit. Keep the two in sync.
    if (isMulti) {
      p.push(`Output (multi-frame storyboard) — emit IN THIS EXACT ORDER and SHAPE:`);
      p.push(`1. ONE \`\`\`json#content-graph block.`);
      p.push(`2. ONE \`\`\`html#<nodeId> block per node.`);
      p.push('');
      p.push(`Aim for ${requestedFrames} frames. Each frame should be self-contained, full-bleed ${resolution}, with its own opening animation and visible movement during export. Nothing between blocks.`);
      p.push('');
      if (attachments.length > 0) {
        // The agent has, in practice, been handed the full article yet fallen
        // back to generic "first-principles / see-the-essence" filler. Force it
        // to ground every node in the source material's actual specifics.
        p.push(`GROUNDING (REQUIRED — the source material above is the script, not decoration):`);
        p.push(`- EVERY node's "text" MUST quote or paraphrase a SPECIFIC fact, name, number, product, or claim from the source material. Pull the real proper nouns (product names, companies, metrics, version numbers) verbatim.`);
        p.push(`- The "synopsis" MUST name the article's actual subject — not "AI/technology trends" or any vague category.`);
        p.push(`- BANNED: generic motivational filler with no tie to the source ("看清本质", "第一性原理", "复杂表象之下", "you really understand…", "the logic behind…"). If a line would fit ANY article, it is wrong — replace it with something that could ONLY come from THIS source.`);
        p.push(`- A reader who knows the article must recognize each frame as being about it; a reader who doesn't must learn its specific points.`);
        p.push('');
      }
      // Skeleton for multi-frame — empirically claude --print returns 1 byte
      // without an example, ~10KB with one. Show the exact shape, even with
      // placeholder content; the model fills it in.
      p.push(`Skeleton (replace placeholders with the inputs above; expand styling per the chosen type / style):`);
      p.push('```json#content-graph');
      p.push(JSON.stringify({
        schemaVersion: 1,
        intent: 'explainer',
        synopsis: '<one-line description>',
        nodes: Array.from({ length: requestedFrames }, (_, i) => ({
          id: `frame_${i + 1}`,
          kind: i === 0 ? 'text' : i === requestedFrames - 1 ? 'entity' : (i % 2 ? 'data' : 'text'),
          durationSec: Math.max(2, Math.floor(Number(collected.duration ?? '15') / requestedFrames)),
        })),
        edges: Array.from({ length: requestedFrames - 1 }, (_, i) => ({
          from: `frame_${i + 1}`,
          to: `frame_${i + 2}`,
          kind: 'sequence',
        })),
      }, null, 2));
      p.push('```');
      p.push('');
      p.push('```html#frame_1');
      p.push(`<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#000;color:#fff;overflow:hidden;font-family:system-ui,sans-serif}
.stage{width:100vw;height:100vh;display:grid;place-items:center;text-align:center;padding:6vw}
h1{font-size:8vw;letter-spacing:-.03em;animation:in 1s ease forwards;opacity:0;transform:translateY(24px)}
.pulse{position:absolute;left:12vw;bottom:14vh;width:8vw;height:8vw;border-radius:999px;background:#22e6a8;animation:move 2.4s ease-in-out 2 alternate}
@keyframes in{to{opacity:1;transform:none}}
@keyframes move{to{transform:translateX(64vw) scale(.72);filter:hue-rotate(70deg)}}
</style></head><body>
<div class="stage"><h1 data-hv-text="headline">PLACEHOLDER</h1><div class="pulse"></div></div>
</body></html>`);
      p.push('```');
      p.push('');
      p.push(`(continue with the same shape for the remaining frames — \`\`\`html#frame_2 … \`\`\`html#frame_${requestedFrames})`);
      if (baseHtml && baseHtml.length > 0) {
        p.push('');
        p.push(tmpl
          ? `Template HTML — this is the REQUIRED visual style. Reuse its palette, layout, typography, and animation approach; change only the text/data to fit the source material. Do NOT switch to a different look (no dark "cosmic particle" default, etc.):`
          : `Prior preview HTML to draw style from:`);
        p.push('```html');
        p.push(baseHtml.slice(0, 3000));
        p.push('```');
      }
    } else {
      p.push(`Output (single-frame): begin your reply with \`\`\`html and end with \`\`\`. Nothing outside the block.`);
      p.push('');
      if (baseHtml && baseHtml.length > 0) {
        p.push(tmpl
          ? `Template HTML — this is the REQUIRED visual style. Reuse its palette, layout, typography, and animation approach; change only the text/data to fit the source material. Do NOT switch to a different look:`
          : `Prior preview HTML (iterate on its visual style if it fits, or replace if a different vibe is better):`);
        p.push('```html');
        p.push(baseHtml.slice(0, 4000));
        p.push('```');
      } else {
        p.push(`Skeleton to extend (replace placeholder with the inputs above; expand styling per the chosen type / style):`);
        p.push('```html');
        p.push(`<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#000;color:#fff;overflow:hidden;font-family:system-ui,sans-serif}
.stage{width:100vw;height:100vh;display:grid;place-items:center;text-align:center;padding:6vw}
h1{font-size:8vw;letter-spacing:-.03em;animation:in 1.2s ease forwards;opacity:0;transform:translateY(24px)}
.pulse{position:absolute;left:12vw;bottom:14vh;width:8vw;height:8vw;border-radius:999px;background:#22e6a8;animation:move 2.4s ease-in-out 2 alternate}
@keyframes in{to{opacity:1;transform:none}}
@keyframes move{to{transform:translateX(64vw) scale(.72);filter:hue-rotate(70deg)}}
</style></head><body>
<div class="stage"><h1 data-hv-text="headline">PLACEHOLDER</h1><div class="pulse"></div></div>
</body></html>`);
        p.push('```');
      }
    }
    p.push('');
    if (tmpl) {
      p.push(`Template visual signature (REQUIRED): ${tmpl.name} — ${tmpl.description}. Match this look — it is the whole reason the template was chosen. Only a single explicit user style note may override it; "based on this article" is NOT such an override.`);
      p.push('');
    }
    p.push(`Do NOT return an empty reply. Do NOT emit any of \`\`\`hv-options / \`\`\`hv-form / \`\`\`hv-confirm — those are over.`);
    // discard variable since some lints complain
    void w; void h;
    return p.join('\n');
  }

  // ---- iterate: post-generation free-form revision ----
  // claude --print is unreliable when fed 6KB+ of HTML and asked to emit
  // 6KB+ back — it silently no-ops in ~50% of attempts. Instead of feeding
  // the whole HTML, we extract the visible text + style summary and let
  // the model REWRITE rather than EDIT. Output is bounded by the same
  // skeleton trick used by generate-phase.
  const it: string[] = [];
  if (args.focusFrameId) {
    it.push(`The user has pinned frame "${args.focusFrameId}" and wants to revise ONLY that frame. Apply their request below — write a fresh complete HTML page that delivers the same content, in roughly the same visual style, but with the requested change.`);
  } else {
    it.push(`The user is iterating on an existing HTML video. Apply their request below — write a fresh complete HTML page that delivers the same content, in roughly the same visual style, but with the requested change.`);
  }
  it.push('');
  it.push(`# User request`);
  it.push(userText);
  it.push('');
  if (attachments.length > 0) {
    it.push(`# Attachments`);
    for (const a of attachments) it.push(...renderAttachment(a));
    it.push('');
  }
  if (baseHtml) {
    // IMPORTANT: do NOT inline the raw HTML. Empirically, including 6-8KB
    // of reference HTML in an iterate prompt makes `claude --print` return
    // 1 byte ~70% of the time (verified by hand). A summary of the
    // existing content + palette is enough to anchor a clean rewrite.
    const summary = summariseHtmlForIterate(baseHtml);
    it.push(`# Current frame — what's there now`);
    if (summary.headline) it.push(`Headline: ${summary.headline}`);
    if (summary.subheads.length) it.push(`Sub-text:\n${summary.subheads.map((s) => `  · ${s}`).join('\n')}`);
    if (summary.dataPoints.length) it.push(`Data points:\n${summary.dataPoints.map((s) => `  · ${s}`).join('\n')}`);
    if (summary.bgColors.length) it.push(`Palette: ${summary.bgColors.join(' / ')}`);
    if (summary.fontFamilies.length) it.push(`Fonts: ${summary.fontFamilies.join(', ')}`);
    it.push('');
  }
  it.push(`Output: ONE complete HTML document. Begin your reply with \`\`\`html and end with \`\`\`. Inline all CSS / JS. Full-bleed 1920×1080. Tag visible text with data-hv-text (preserve existing keys when meaningful). No prose outside the block. Do NOT return an empty reply.`);
  it.push('');
  it.push(`Skeleton to extend (replace with the real content + visual style):`);
  it.push('```html');
  it.push(`<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#000;color:#fff;overflow:hidden;font-family:system-ui,sans-serif}
.stage{width:100vw;height:100vh;display:grid;place-items:center;text-align:center;padding:6vw}
h1{font-size:8vw;letter-spacing:-.03em;animation:in 1s ease forwards;opacity:0;transform:translateY(24px)}
@keyframes in{to{opacity:1;transform:none}}
</style></head><body>
<div class="stage"><h1 data-hv-text="headline">PLACEHOLDER</h1></div>
</body></html>`);
  it.push('```');
  return it.join('\n');
}

/** Pull headline / subheads / data values / palette / fonts from a frame's HTML. */
function summariseHtmlForIterate(html: string): {
  headline: string;
  subheads: string[];
  dataPoints: string[];
  bgColors: string[];
  fontFamilies: string[];
} {
  const subheads: string[] = [];
  const dataPoints: string[] = [];
  // Visible text in tagged elements
  const textRe = /data-hv-text="([^"]+)"[^>]*>([^<]{1,160})</gi;
  let m: RegExpExecArray | null;
  let headline = '';
  while ((m = textRe.exec(html)) !== null) {
    const key = m[1] ?? '';
    const val = (m[2] ?? '').trim();
    if (!val) continue;
    if (/headline|title|hero/i.test(key) && !headline) headline = val;
    else if (/data|stat|value|number/i.test(key)) dataPoints.push(`${key}: ${val}`);
    else subheads.push(`${key}: ${val}`);
  }
  // Body / stage background colour (rough)
  const bgColors = Array.from(
    html.matchAll(/background[^:]*:\s*(#[0-9a-f]{3,8}|rgb[a]?\([^)]+\)|hsla?\([^)]+\))/gi),
  ).slice(0, 3).map((x) => x[1]!).filter(Boolean);
  // Font families (first occurrence in css)
  const fontFamilies = Array.from(
    new Set(
      Array.from(html.matchAll(/font-family\s*:\s*([^;}]+)/gi))
        .map((x) => (x[1] ?? '').trim().slice(0, 80))
        .filter(Boolean),
    ),
  ).slice(0, 2);
  return {
    headline,
    subheads: subheads.slice(0, 6),
    dataPoints: dataPoints.slice(0, 6),
    bgColors,
    fontFamilies,
  };
}

/**
 * Extract a full HTML document from agent output.
 * Tries (1) `\`\`\`html ... \`\`\`` block, (2) bare `<!doctype html>...</html>`.
 */
function extractHtmlDocument(text: string): string | null {
  // Plain ```html``` block (no node-id tag — single-frame fast path)
  const fence = /```html\s*\n([\s\S]*?)```/i.exec(text);
  if (fence && fence[1]) {
    const html = fence[1].trim();
    if (/<\/html>/i.test(html)) return html;
  }
  const bare = /<!doctype html[\s\S]*?<\/html>/i.exec(text);
  if (bare) return bare[0];
  return null;
}

/**
 * v0.8: extract a content-graph JSON block + N tagged html#<nodeId> blocks
 * from a single agent response.
 *
 * Expected agent output format for multi-frame:
 *   ```json#content-graph
 *   { "schemaVersion": 1, "intent": "explainer", "nodes": [...], "edges": [...] }
 *   ```
 *   ```html#node_1
 *   <!doctype html>...
 *   ```
 *   ```html#node_2
 *   <!doctype html>...
 *   ```
 *
 * Returns null when no content-graph block is found (caller falls back to
 * single-frame extraction).
 */
function extractContentGraphAndFrames(
  text: string,
): { graph: import('@html-video/content-graph').ContentGraph; frames: { nodeId: string; html: string }[] } | null {
  // Find a fenced JSON block tagged as content-graph.
  const graphMatch = /```json#content-graph\s*\n([\s\S]*?)```/i.exec(text);
  if (!graphMatch || !graphMatch[1]) return null;
  let graph: import('@html-video/content-graph').ContentGraph;
  try {
    graph = parseGraphJsonTolerant(graphMatch[1].trim()) as import('@html-video/content-graph').ContentGraph;
  } catch {
    return null;
  }
  if (!graph || !Array.isArray((graph as { nodes?: unknown[] }).nodes)) return null;

  // Find tagged html blocks: ```html#<nodeId>
  const frames: { nodeId: string; html: string }[] = [];
  const re = /```html#([a-z0-9_-]+)\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const nodeId = match[1];
    const html = match[2]?.trim() ?? '';
    if (nodeId && /<\/html>/i.test(html)) {
      frames.push({ nodeId, html });
    }
  }

  return { graph, frames };
}

// ---------------------------------------------------------------------------
// Split multi-frame generate
//
// `claude --print` is unreliable when asked to emit a content-graph PLUS
// 4-6 full HTML pages in one shot — it tends to time out at 100s+ with 1
// byte of output. Each call individually is fine, so we orchestrate:
//
//   1. one short call → graph JSON
//   2. one short call per node → frame HTML
//
// Each step writes its result to disk and pushes an SSE event so the UI
// can show "frame N/M" progress.
// ---------------------------------------------------------------------------
interface SplitGenerateArgs {
  ctx: CliContext;
  projectId: string;
  projectDir: string;
  agentDef: import('@html-video/runtime').AgentDef;
  agentModel?: string | undefined;
  tmpl: import('@html-video/core').TemplateMetadata | null;
  priorHtml: string;
  inputs: PhaseInputs;
  attachments: Attachment[];
  /** Exact per-frame source text used when agent planning is unavailable. */
  fallbackFrameTexts?: string[];
  /** The user's original opening subject, locked across phases. */
  openingTopic?: string;
  /**
   * Restyle mode: keep the EXISTING content-graph text verbatim and only
   * re-render each frame's HTML in the new style. Skips the Step-1 graph
   * re-plan. Used by the post-generation "换风格 / 改时长" sub-flows.
   */
  restyleOnly?: boolean;
  /** Quality-critical flows should stop instead of silently rendering all-local frames. */
  failOnAgentError?: boolean;
  /** Called for human-readable progress lines. */
  onProgress: (msg: string) => void;
  /** Called for structured SSE events. */
  onSse: (obj: unknown) => void;
}

// NOTE: the old classifyIterateIntent (LLM guesses rewrite-all/edit-visual/
// edit-frame from one sentence) was removed. The post-generation flow no longer
// guesses: detectPhase routes a vague "改一下" to an explicit edit-menu card
// (style / content / duration) and the user's pick drives restyle /
// iterate-content / iterate-format.

async function runSplitMultiFrameGenerate(
  args: SplitGenerateArgs,
): Promise<{ frameCount: number; intent: string }> {
  const { ctx, projectId, projectDir, agentDef, agentModel, tmpl, priorHtml, inputs, attachments, fallbackFrameTexts, openingTopic, restyleOnly, failOnAgentError, onProgress, onSse } = args;
  const collected = inputs.collected ?? {};
  const pickedType = inputs.pickedType ?? '';
  const pickedStyle = inputs.pickedStyle ?? '';
  const contentTurns = inputs.contentTurns ?? [];
  // When a template is selected, its OWN source HTML is the style ground truth —
  // every frame must reuse its palette/typography/layout/motion. Previously
  // split-generate only passed the template's one-line description, so a picked
  // template (e.g. Swiss Grid: light grey + black/gold serif) came out as a
  // generic dark theme. Read the real source once and force it into each frame.
  let templateHtml = '';
  if (tmpl?.__dir && tmpl.source_entry) {
    try {
      const { readFileSync } = await import('node:fs');
      const p = join(tmpl.__dir, tmpl.source_entry);
      if (existsSync(p)) templateHtml = readFileSync(p, 'utf8');
    } catch { /* fall back to description-only */ }
  }
  const aspect = ((collected.aspect ?? '16:9').split(/\s+/)[0] ?? '16:9');
  const frameCountReq = Math.max(2, Math.min(10, Number(collected.frame_count ?? '4') || 4));
  // Opt-in (format card): render data frames natively with Remotion. When on,
  // the planner must give every data node structured items, and after each
  // data frame's HTML is written we enhance it in place (best-effort).
  const enhanceData = (collected.remotion_enhance ?? '').startsWith('开');
  // Prefer per-frame pacing (total = per_frame × frames) — set by the format
  // card so a short total ÷ many frames can't produce a rushed clip. Fall back
  // to total ÷ frames for older projects that only stored `duration`.
  const perFrameInput = Number(collected.per_frame ?? '') || 0;
  const perFrameDurationSec = perFrameInput > 0
    ? Math.max(2, perFrameInput)
    : Math.max(2, Math.floor((Number(collected.duration ?? '15') || 15) / frameCountReq));
  const totalDurationSec = perFrameInput > 0
    ? perFrameDurationSec * frameCountReq
    : (Number(collected.duration ?? '15') || 15);
  let resolution = '1920×1080';
  if (aspect === '9:16') resolution = '1080×1920';
  else if (aspect === '1:1') resolution = '1080×1080';
  else if (aspect === '4:5') resolution = '1080×1350';
  // Persist the chosen resolution on the project so EXPORT records at the right
  // aspect (it reads project.preferences.resolution; without this it defaulted
  // to 1920×1080 and squashed a 4:5 / 9:16 frame into a 16:9 canvas).
  {
    const [w, h] = resolution.split('×').map(Number);
    if (w && h) {
      const proj = await ctx.projects.load(projectId);
      proj.preferences = { ...proj.preferences, resolution: { width: w, height: h } };
      await ctx.projects.save(proj);
    }
  }

  const styleLabel = pickedStyle && /^从设计模板选|template/i.test(pickedStyle)
    ? (tmpl ? `(use the selected template "${tmpl.name}" — ${tmpl.description})` : '(let the model choose)')
    : pickedStyle;

  // ---- Step 1: obtain the content graph ----
  let graph: import('@html-video/content-graph').ContentGraph;
  if (restyleOnly) {
    // Restyle / re-time: keep the EXISTING storyboard text verbatim, skip the
    // re-plan entirely. Only Step 2 (per-frame HTML) re-runs, in the new style.
    const existing = await ctx.orchestrator.readContentGraph(projectId);
    if (!existing || !Array.isArray(existing.nodes) || existing.nodes.length === 0) {
      throw new Error('restyle requested but the project has no existing storyboard to reuse');
    }
    graph = existing as import('@html-video/content-graph').ContentGraph;
    onProgress(`✓ 沿用现有文案：${graph.nodes.length} 帧`);
    onSse({ type: 'plan_ready', frame_count: graph.nodes.length, intent: graph.intent });
  } else {
  onProgress(`📋 规划 ${frameCountReq} 帧的故事板…`);
  const graphPromptParts: string[] = [];
  graphPromptParts.push(`Plan a ${frameCountReq}-frame HTML video storyboard. Output ONLY a content-graph JSON in a fenced \`\`\`json#content-graph block — no HTML, no prose outside.`);
  graphPromptParts.push('');
  graphPromptParts.push(`Inputs (use literally — do NOT invent brand names or facts beyond these):`);
  graphPromptParts.push(`- 类型 / type: ${pickedType || '(unspecified)'} (this is the FORMAT, NOT the subject — never make the video be "about" the type itself)`);
  // Lock the storyboard to the user's opening subject (unless a SOURCE MATERIAL
  // block below supersedes it). This is the path the user actually hits, and
  // where "随机" turned into a randomness explainer instead of the Open Design
  // promo they asked for.
  if (openingTopic && !attachments.some((a) => !!a.inlineText)) {
    graphPromptParts.push(`- 主题 / subject (LOCKED): the user opened with "${openingTopic}". The synopsis and EVERY node MUST be about this subject. If the content line below is a vague word like "随机 / 随便 / anything / 你定", it means "you choose the concrete angle and points — but keep the subject = "${openingTopic}"". NEVER make the video about randomness or the literal word.`);
  }
  if (contentTurns.length > 0) {
    graphPromptParts.push(`- 内容 / content:`);
    for (const t of contentTurns) graphPromptParts.push(`  · ${t.replace(/\n/g, ' ').slice(0, 280)}`);
  }
  // Inline the fetched article / repo / uploaded text — THIS is the subject of
  // the video. Without it the planner only sees the type word and invents a
  // video "about 概念解说" instead of about the user's actual source.
  const { specs: designSpecs, content: contentAtts } = partitionAttachments(attachments);
  if (designSpecs.length > 0) graphPromptParts.push('', ...renderDesignSpecBlock(designSpecs));
  const sourceTexts = contentAtts.filter((a) => !!a.inlineText);
  if (sourceTexts.length > 0) {
    graphPromptParts.push('');
    graphPromptParts.push(`SOURCE MATERIAL — the video MUST be about THIS content (real facts, names, numbers from it). This is the subject, not the type:`);
    for (const a of sourceTexts) {
      graphPromptParts.push(`--- ${a.filename} ---`);
      graphPromptParts.push((a.inlineText ?? '').slice(0, 6000));
    }
  }
  if (styleLabel) graphPromptParts.push(`- 风格 / style: ${styleLabel}`);
  const templateBrief = selectedTemplateStructureBrief(templateHtml);
  if (templateBrief) {
    graphPromptParts.push(`- 已选模板结构 / selected template structure:`);
    graphPromptParts.push(templateBrief);
    graphPromptParts.push(`  Re-plan the storyboard so each frame's content fits the matching template structure. For list/ledger frames, provide multiple short comparable points. For metric/bar/stat frames, prefer concise labels and real numbers if present. For hero/quote frames, use one strong short sentence. Do not merely copy the old frame text into every slot.`);
  }
  graphPromptParts.push(`- 总时长: ${totalDurationSec}s split across ${frameCountReq} frames (~${perFrameDurationSec}s each)`);
  graphPromptParts.push('');
  if (sourceTexts.length > 0) {
    graphPromptParts.push(`GROUNDING (REQUIRED): every node's text must come from the SOURCE MATERIAL above — quote its real product names, facts, numbers. The synopsis must name the source's actual subject. BANNED: generic filler about the content TYPE (e.g. "什么是概念解说", "信息密度×传播效率") that would fit any video. If a line could fit any topic, it's wrong.`);
    graphPromptParts.push('');
  }
  graphPromptParts.push(`Schema (keep all keys; one node per frame; nodes[].id should be a short readable slug like "intro" / "stat_users" / "outro"):`);
  graphPromptParts.push('```json#content-graph');
  graphPromptParts.push(JSON.stringify({
    schemaVersion: 1,
    intent: 'explainer',
    synopsis: '<one-line description of the video>',
    nodes: Array.from({ length: frameCountReq }, (_, i) => {
      const kind = i === 0 ? 'text' : i === frameCountReq - 1 ? 'entity' : 'data';
      const node: Record<string, unknown> = {
        id: `frame_${i + 1}`,
        kind,
        durationSec: perFrameDurationSec,
        text: '<headline / subtitle for this frame>',
      };
      // Every data node carries structured items so it can be rendered natively
      // with Remotion (numbers roll, bars grow) — whether the user opted in now
      // or enhances the frame later from the strip. A data frame without numbers
      // is just a text frame.
      if (kind === 'data') {
        node.data = {
          title: '<short chart title>',
          unit: '<optional unit, e.g. K / % / ★>',
          items: [
            { label: '<label>', value: 0 },
            { label: '<label>', value: 0 },
          ],
        };
      }
      return node;
    }),
    edges: Array.from({ length: frameCountReq - 1 }, (_, i) => ({
      from: `frame_${i + 1}`,
      to: `frame_${i + 2}`,
      kind: 'sequence',
    })),
  }, null, 2));
  graphPromptParts.push('```');
  graphPromptParts.push('');
  graphPromptParts.push(`Replace the placeholder text in each node with concrete content from the inputs. Adjust intent to match (single-frame|explainer|data-viz|promo|comparison|other). Keep node ids unique. Do NOT return an empty reply. Do NOT emit any HTML this turn.`);
  graphPromptParts.push(`DATA FRAMES: every \`kind:"data"\` node MUST carry a \`data\` object \`{ title?, unit?, items: [{ label, value }] }\` with at least 2 items and numeric \`value\`s drawn from the inputs/source — real figures, not placeholders (they can be animated with rolling counters / growing bars). The node's \`text\` still holds the headline. If a frame genuinely has no quantitative data, make it a \`text\` node instead of \`data\`.`);
  graphPromptParts.push(`DATA FRAME QUALITY: (1) Items in ONE data frame must be COMPARABLE — the same unit and a similar order of magnitude. Do NOT mix wildly different scales in one chart (e.g. 61,000 GitHub stars next to 142 plugins) — one giant bar makes the rest invisible. If figures have different units or scales, split them across separate data frames, or pick the 2-4 that genuinely compare. (2) \`unit\` is OPTIONAL and only for a real shared unit (e.g. "%", "K", "★", "ms"). If the numbers are plain counts with no meaningful unit, OMIT \`unit\` entirely — never use filler like "count" / "个" / "次".`);
  graphPromptParts.push(`STRICT JSON: the block must be valid JSON. Inside string values do NOT use straight double-quotes ("…") — if you need to quote a term or title, use 「」 or 《》 or single quotes. No trailing commas. No comments.`);

  const graphPrompt = graphPromptParts.join('\n');
  let graphText = '';
  let graphAgentFailure = '';
  try {
    graphText = await callAgentSimple(agentDef, graphPrompt, projectDir, agentModel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (failOnAgentError) {
      throw new Error(`故事板规划调用失败：${summarizeAgentFailure(message)}`);
    }
    graphAgentFailure = message;
    onProgress(`↻ 故事板规划调用失败：${summarizeAgentFailure(message)}；使用本地模板适配规划`);
    process.stderr.write(`[studio:split] proj=${projectId} graph agent failed: ${message}; using local template-adapted graph\n`);
  }
  const graphMatch = /```json#content-graph\s*\n([\s\S]*?)```/i.exec(graphText)
    ?? /```json\s*\n([\s\S]*?)```/i.exec(graphText);
  if (!graphMatch || !graphMatch[1]) {
    const reason = `agent did not return a content-graph (got ${graphText.length} bytes)`;
    if (!graphAgentFailure) onProgress(`↻ 故事板规划未返回内容图，使用本地模板适配规划`);
    graph = buildLocalTemplateAdaptedGraph({
      frameCount: frameCountReq,
      perFrameDurationSec,
      contentTurns,
      openingTopic,
      sourceTexts: sourceTexts.map((a) => a.inlineText ?? ''),
      frameTexts: fallbackFrameTexts,
      templateHtml,
      fallbackSynopsis: pickedType || tmpl?.name_zh || tmpl?.name || '模板适配视频',
    });
    process.stderr.write(`[studio:split] proj=${projectId} ${reason}; using local template-adapted graph\n`);
  } else {
    try {
      graph = parseGraphJsonTolerant(graphMatch[1].trim()) as import('@html-video/content-graph').ContentGraph;
    } catch (e) {
      onProgress(`↻ 故事板 JSON 解析失败，使用本地模板适配规划`);
      graph = buildLocalTemplateAdaptedGraph({
        frameCount: frameCountReq,
        perFrameDurationSec,
        contentTurns,
        openingTopic,
        sourceTexts: sourceTexts.map((a) => a.inlineText ?? ''),
        frameTexts: fallbackFrameTexts,
        templateHtml,
        fallbackSynopsis: pickedType || tmpl?.name_zh || tmpl?.name || '模板适配视频',
      });
      process.stderr.write(`[studio:split] proj=${projectId} graph JSON parse failed: ${e instanceof Error ? e.message : e}; using local template-adapted graph\n`);
    }
  }
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw new Error('graph has no nodes');
  }
  if (!restyleOnly && graph.nodes.length !== frameCountReq) {
    onProgress(`↻ 故事板返回 ${graph.nodes.length} 帧，按请求的 ${frameCountReq} 帧重新本地规划`);
    graph = buildLocalTemplateAdaptedGraph({
      frameCount: frameCountReq,
      perFrameDurationSec,
      contentTurns,
      openingTopic,
      sourceTexts: sourceTexts.map((a) => a.inlineText ?? ''),
      frameTexts: fallbackFrameTexts,
      templateHtml,
      fallbackSynopsis: pickedType || tmpl?.name_zh || tmpl?.name || '模板适配视频',
    });
  }
  await ctx.orchestrator.writeContentGraph(projectId, graph);
  onProgress(`✓ 故事板规划完成：${graph.nodes.length} 帧 (${graph.intent})`);
  onSse({ type: 'plan_ready', frame_count: graph.nodes.length, intent: graph.intent });
  }

  // ---- Step 2: one call per node, output a single ```html block ----
  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i]!;
    const nodeId = node.id;
    onProgress(`🎬 生成第 ${i + 1}/${graph.nodes.length} 帧 (${nodeId})…`);
    onSse({ type: 'frame_started', node_id: nodeId, order: i, total: graph.nodes.length });

    const frameContext = describeNode(node);
    const frameTextForLocal = templateTextFromGraphNode(node, frameContext);
    const localTemplateFrame = localTemplateFrameHtml({
      index: i,
      total: graph.nodes.length,
      text: frameTextForLocal,
      synopsis: graph.synopsis ?? '',
      contentKind: node.kind,
      structuredData: node.kind === 'data'
        ? node.data as LocalTemplateFrameArgs['structuredData']
        : undefined,
      type: pickedType || '分镜字幕',
      style: styleLabel || tmpl?.name || pickedStyle || '',
      captionMode: '关键句',
      templateId: tmpl?.id,
      templateName: tmpl?.name_zh ?? tmpl?.name,
      templateHtml,
      templateDir: tmpl?.__dir,
      templatePosterUrl: templatePosterFileUrl(tmpl),
    });
    const fp: string[] = [];
    fp.push(`Generate ONE complete HTML page for frame "${nodeId}" of a ${graph.nodes.length}-frame video. Output ONE \`\`\`html block, nothing else.`);
    fp.push('');
    fp.push(`Frame ${i + 1} of ${graph.nodes.length}: ${frameContext}`);
    if (restyleOnly) {
      // Keep the exact words; only the visual style changes.
      fp.push(`RESTYLE: keep this frame's TEXT EXACTLY as given above — same headline, subtitle, numbers, wording. Do NOT rewrite, translate, or reword anything. Change ONLY the visual style (layout, colour, typography, motion) to: ${styleLabel || pickedStyle || '(the new style)'}.`);
    }
    if (openingTopic && !attachments.some((a) => !!a.inlineText)) {
      fp.push(`Subject (locked): "${openingTopic}". This frame is about this subject; "随机/随便" anywhere in the inputs means you pick details, not a new topic.`);
    }
    fp.push(`Duration: ${node.durationSec ?? perFrameDurationSec}s`);
    fp.push(`Type: ${pickedType}`);
    if (styleLabel) fp.push(`Style: ${styleLabel}`);
    fp.push(`Resolution: ${aspect} (${resolution})`);
    fp.push('');
    fp.push(`CONTENT-DIRECTED DESIGN (REQUIRED): interpret this frame's meaning before choosing the composition. Decide what the viewer must notice first, which relationship or fact the layout should explain, and what the animation should reveal. Do not render the narration as a generic subtitle card and do not copy the template sample composition verbatim.`);
    fp.push(`The selected template is a design system and structural vocabulary, not a fill-in-the-blanks form. Choose and adapt the template structure that best communicates THIS frame's content while preserving its visual identity.`);
    fp.push('');
    if (contentTurns.length > 0) {
      fp.push(`Source material from the user (use literally; do NOT invent facts):`);
      for (const t of contentTurns) fp.push(`  · ${t.replace(/\n/g, ' ').slice(0, 280)}`);
      fp.push('');
    }
    // Fetched article/repo text — keep the per-frame HTML grounded in the real
    // source, not just the one-line graph node. (Graph step gets the full text;
    // give each frame a trimmed slice so it can pull accurate specifics.)
    const { specs: frameSpecs, content: frameContentAtts } = partitionAttachments(attachments);
    if (frameSpecs.length > 0) fp.push(...renderDesignSpecBlock(frameSpecs));
    const frameSourceTexts = frameContentAtts.filter((a) => !!a.inlineText);
    if (frameSourceTexts.length > 0) {
      fp.push(`SOURCE MATERIAL (the video's real subject — use its actual facts/names/numbers, never generic filler about the content type):`);
      for (const a of frameSourceTexts) fp.push((a.inlineText ?? '').slice(0, 3000));
      fp.push('');
    }
    fp.push(`Output: begin with \`\`\`html and end with \`\`\`. Inline CSS + JS, full-bleed ${resolution}, opens with an animation timeline. Tag visible text with data-hv-text. CDN imports (Tailwind, GSAP) fine. No prose outside the block.`);
    fp.push(renderMotionExportContract());
    fp.push('');
    if (templateHtml) {
      // A template is selected → its HTML is the REQUIRED look for every frame.
      fp.push(`Template HTML — this is the REQUIRED visual language for THIS frame. Reuse its palette, background, typography, spacing, component shapes and animation vocabulary. Select or adapt its structural patterns to explain this frame's meaning; do NOT merely replace sample text in the existing composition. Do NOT invent a different theme (no generic dark background unless the template itself is dark):`);
      fp.push('```html');
      fp.push(templateHtml.slice(0, 4000));
      fp.push('```');
      fp.push('');
      fp.push(`Keep all ${graph.nodes.length} frames visually consistent with this template so they read as one video.`);
    } else {
      fp.push(`Skeleton to extend (replace placeholder, expand styling per type / style):`);
      fp.push('```html');
      fp.push(`<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#000;color:#fff;overflow:hidden;font-family:system-ui,sans-serif}
.stage{width:100vw;height:100vh;display:grid;place-items:center;text-align:center;padding:6vw}
h1{font-size:8vw;letter-spacing:-.03em;animation:in 1s ease forwards;opacity:0;transform:translateY(24px)}
.pulse{position:absolute;left:12vw;bottom:14vh;width:8vw;height:8vw;border-radius:999px;background:#22e6a8;animation:move 2.4s ease-in-out 2 alternate}
@keyframes in{to{opacity:1;transform:none}}
@keyframes move{to{transform:translateX(64vw) scale(.72);filter:hue-rotate(70deg)}}
</style></head><body>
<div class="stage"><h1 data-hv-text="headline">PLACEHOLDER</h1><div class="pulse"></div></div>
</body></html>`);
      fp.push('```');
      if (priorHtml && priorHtml.length > 0) {
        fp.push('');
        fp.push(`Visual style reference (mine for palette / typography / motion vocabulary, do not copy literally):`);
        fp.push('```html');
        fp.push(priorHtml.slice(0, 2400));
        fp.push('```');
      }
    }
    if (i === 0 && attachments.length > 0) {
      fp.push('');
      fp.push(`User attachments (binary = assets; inlined text = source material to base content on):`);
      for (const a of attachments) fp.push(...renderAttachment(a));
    }
    fp.push('');
    fp.push(`Do NOT return an empty reply. Output the full HTML.`);

    const framePrompt = fp.join('\n');
    let frameText = '';
    const frameFailures: string[] = [];
    try {
      frameText = await callAgentSimple(agentDef, framePrompt, projectDir, agentModel);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (failOnAgentError) {
        throw new Error(`第 ${i + 1} 帧 agent 调用失败：${summarizeAgentFailure(message)}`);
      }
      frameFailures.push(message);
      onProgress(`  ↻ 第 ${i + 1} 帧调用失败：${summarizeAgentFailure(message)}；尝试精简重试…`);
      process.stderr.write(`[studio:split-generate] proj=${projectId} frame=${nodeId} agent failed: ${message}\n`);
    }
    let extracted = extractHtmlFromAgentText(frameText);

    // One retry on empty: shorter prompt, just the skeleton call.
    if (!extracted) {
      if (frameFailures.length === 0) onProgress(`  ↻ 第 ${i + 1} 帧未返回可用 HTML，重试…`);
      const retryPrompt = [
        `Output ONE complete HTML video frame in a fenced \`\`\`html block.`,
        `Frame purpose: ${frameContext}.`,
        `Style: ${styleLabel || 'tasteful default'}.`,
        `Resolution: ${resolution}.`,
        contentTurns.length ? `Content: ${contentTurns.join(' / ').slice(0, 200)}` : '',
        templateHtml
          ? `Selected template HTML remains REQUIRED. Match this style instead of falling back to a generic theme:\n\`\`\`html\n${templateHtml.slice(0, 4000)}\n\`\`\``
          : '',
        `Begin your reply with \`\`\`html. Inline CSS, opens with animation, tag text with data-hv-text. No prose.`,
        renderMotionExportContract(),
      ].filter(Boolean).join('\n\n');
      try {
        frameText = await callAgentSimple(agentDef, retryPrompt, projectDir, agentModel);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        frameFailures.push(message);
        process.stderr.write(`[studio:split-generate] proj=${projectId} frame=${nodeId} retry failed: ${message}\n`);
        frameText = '';
      }
      extracted = extractHtmlFromAgentText(frameText);
    }
    if (!extracted) {
      process.stderr.write(
        `[studio:split-generate] proj=${projectId} frame=${nodeId} no usable agent HTML; failures=${frameFailures.length}; using local fallback (${frameText.length}B)\n`,
      );
      onProgress(frameFailures.length > 0
        ? `  ⚠️ 第 ${i + 1} 帧两次 agent 调用失败，使用已选模板的本地兜底帧`
        : `  ⚠️ 第 ${i + 1} 帧两次均未返回可用 HTML，使用已选模板的本地兜底帧`);
      const fallbackText = 'text' in node && typeof node.text === 'string'
        ? node.text
        : describeNode(node);
      extracted = localTemplateFrame ?? localTranscriptFrameHtml({
        index: i,
        total: graph.nodes.length,
        text: fallbackText,
        synopsis: graph.synopsis ?? '',
        type: pickedType || '分镜字幕',
        style: styleLabel || tmpl?.name || pickedStyle || '现代科技发布会',
        captionMode: '关键句',
        templateId: tmpl?.id,
        templateName: tmpl?.name_zh ?? tmpl?.name,
        templateHtml,
        templateDir: tmpl?.__dir,
        templatePosterUrl: templatePosterFileUrl(tmpl),
      });
    }
    await ctx.orchestrator.writeFrameHtml(projectId, nodeId, extracted);
    // Native Remotion enhancement (opt-in via format card). The frame now has a
    // FrameRecord, so enhanceFrameNative can set engine/nativeTemplateId/data in
    // place. Best-effort: if the data node lacks usable {label,value} items it
    // throws — we keep the hyperframes HTML and warn rather than fail the run.
    // 'frame-data-rollup' is the only native template today (TODO: picker).
    if (enhanceData && node.kind === 'data') {
      try {
        // Two steps, same as the manual enhance endpoint: (1) set the frame's
        // engine/data, (2) actually RENDER the preview MP4. Without step 2 the
        // frame is flagged remotion but has no previewMp4Path, so the studio
        // tries to play a <video> that 404s → black thumbnail + preview.
        await ctx.orchestrator.enhanceFrameNative(projectId, nodeId, 'frame-data-rollup');
        onProgress(`  ⚡ 第 ${i + 1} 帧渲染 Remotion 动效 (数字滚动 / 柱子生长)…`);
        await ctx.orchestrator.renderFrameNativePreview({ projectId, graphNodeId: nodeId });
        onSse({ type: 'frame_enhanced', node_id: nodeId, order: i });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[studio:split-generate] proj=${projectId} frame=${nodeId} enhance skipped: ${msg}\n`);
        onProgress(`  ⚠️ 第 ${i + 1} 帧无法用 Remotion 增强（回落静态 HTML）：${msg}`);
        // Revert the engine flag so the frame falls back to its hyperframes HTML
        // (the <iframe> path) instead of showing a broken <video>.
        try { await ctx.orchestrator.unenhanceFrame(projectId, nodeId); } catch { /* ignore */ }
      }
    }
    onProgress(`  ✓ 第 ${i + 1}/${graph.nodes.length} 帧完成 (${nodeId})`);
    onSse({ type: 'frame_done', node_id: nodeId, order: i, total: graph.nodes.length });
  }

  return { frameCount: graph.nodes.length, intent: graph.intent };
}

/** Describe a node's purpose for prompt context. */
function describeNode(node: import('@html-video/content-graph').Node): string {
  const bits: string[] = [];
  if (node.label) bits.push(node.label);
  if ((node as { text?: string }).text) bits.push(`text: ${(node as { text: string }).text.slice(0, 200)}`);
  if (node.kind === 'data' && (node as { data?: unknown }).data !== undefined) {
    bits.push(`data: ${JSON.stringify((node as { data: unknown }).data).slice(0, 200)}`);
  }
  if (node.kind === 'entity' && (node as { props?: unknown }).props !== undefined) {
    bits.push(`entity props: ${JSON.stringify((node as { props: unknown }).props).slice(0, 200)}`);
  }
  if (node.frameIntent) bits.push(`intent: ${node.frameIntent}`);
  if (bits.length === 0) bits.push(`(${node.kind} frame "${node.id}")`);
  return bits.join('; ');
}

async function readTalkingHeadTranscript(
  project: import('@html-video/core').Project,
): Promise<import('@html-video/core').TranscriptDocument | null> {
  const id = project.talkingHead?.transcriptAssetId;
  if (!id) return null;
  const asset = project.assets.find((a) => a.id === id);
  if (!asset?.path || !existsSync(asset.path)) return null;
  try {
    return JSON.parse(await readFile(asset.path, 'utf8')) as import('@html-video/core').TranscriptDocument;
  } catch {
    return null;
  }
}

interface LocalTalkingHeadOptions {
  topic: string;
  type: string;
  style: string;
  template_label: string;
  aspect: string;
  frame_count: string;
  caption_mode: string;
  talking_head_overlay: string;
}

function shouldHandleLocalTalkingHeadFlow(
  userText: string,
  history: ChatMessage[],
  agentAvailable: boolean,
): boolean {
  const trimmed = userText.trim();
  if (isLocalTalkingHeadControl(trimmed)) return true;
  if (wantsLocalTranscriptFallback(trimmed)) return true;
  if (!agentAvailable) return true;
  return lastAssistantWasLocalTalkingHead(history);
}

function isLocalTalkingHeadControl(text: string): boolean {
  return text.startsWith('[hv-form:submit]') ||
    text === '[hv-confirm:generate]' ||
    text === '[hv-confirm:edit]';
}

function lastAssistantWasLocalTalkingHead(history: ChatMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== 'assistant') continue;
    if (m.agent === 'local-transcript') return true;
    if (!m.content.trim()) continue;
    return false;
  }
  return false;
}

async function handleLocalTalkingHeadFlow(args: {
  ctx: CliContext;
  projectId: string;
  project: import('@html-video/core').Project;
  transcript: import('@html-video/core').TranscriptDocument;
  history: ChatMessage[];
  userText: string;
}): Promise<{ message: string; frameCount?: number }> {
  const trimmed = args.userText.trim();
  const submitted = parseLocalTalkingHeadFormSubmission(trimmed);
  if (submitted) {
    if (!args.project.templateId) {
      const defaults = inferTalkingHeadDefaults(args.project, args.transcript);
      return {
        message: renderLocalTalkingHeadForm(defaults, args.transcript, true, false),
      };
    }
    const options = normalizeLocalTalkingHeadOptions({
      ...inferTalkingHeadDefaults(args.project, args.transcript),
      ...submitted,
      template_label: selectedTemplateLabel(args.ctx, args.project),
    });
    return {
      message: renderLocalTalkingHeadConfirm(options, args.transcript),
    };
  }

  if (trimmed === '[hv-confirm:edit]') {
    const options = normalizeLocalTalkingHeadOptions(
      {
        ...(lastLocalTalkingHeadForm(args.history) ?? inferTalkingHeadDefaults(args.project, args.transcript)),
        template_label: selectedTemplateLabel(args.ctx, args.project),
      },
    );
    return {
      message: renderLocalTalkingHeadForm(options, args.transcript, true, !!args.project.templateId),
    };
  }

  if (trimmed === '[hv-confirm:generate]') {
    if (!args.project.templateId) {
      const defaults = inferTalkingHeadDefaults(args.project, args.transcript);
      return {
        message: renderLocalTalkingHeadForm(defaults, args.transcript, true, false),
      };
    }
    const options = normalizeLocalTalkingHeadOptions(
      {
        ...(lastLocalTalkingHeadForm(args.history) ?? inferTalkingHeadDefaults(args.project, args.transcript)),
        template_label: selectedTemplateLabel(args.ctx, args.project),
      },
    );
    const result = await generateLocalTalkingHeadStoryboard(
      args.ctx,
      args.projectId,
      args.transcript,
      args.userText,
      options,
    );
    return {
      frameCount: result.frameCount,
      message: `✓ 已按确认设置生成 ${result.frameCount} 帧口播字幕视频。导出时${options.talking_head_overlay.startsWith('关') ? '不会叠加口播画中画' : '会保留右下角口播画中画和源视频音轨'}。`,
    };
  }

  const defaults = inferTalkingHeadDefaults(args.project, args.transcript);
  defaults.template_label = selectedTemplateLabel(args.ctx, args.project);
  return {
    message: renderLocalTalkingHeadForm(defaults, args.transcript, false, !!args.project.templateId),
  };
}

function selectedTemplateLabel(
  ctx: CliContext,
  project: import('@html-video/core').Project,
): string {
  if (!project.templateId) return '未选择模板';
  const tmpl = ctx.templates.get(project.templateId);
  return tmpl ? `${tmpl.name} (${tmpl.id})` : project.templateId;
}

function parseLocalTalkingHeadFormSubmission(text: string): Record<string, string> | null {
  const match = /^\[hv-form:submit\]\s*\n([\s\S]+)$/.exec(text);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : null;
  } catch {
    return null;
  }
}

function lastLocalTalkingHeadForm(history: ChatMessage[]): Record<string, string> | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== 'user') continue;
    const parsed = parseLocalTalkingHeadFormSubmission(m.content.trim());
    if (parsed) return parsed;
  }
  return undefined;
}

function inferTalkingHeadDefaults(
  project: import('@html-video/core').Project,
  transcript: import('@html-video/core').TranscriptDocument,
): LocalTalkingHeadOptions {
  const text = transcript.text.trim();
  const frameCount = Math.min(6, Math.max(3, transcript.segments.filter((s) => s.text.trim()).length || 4));
  const topic = inferTalkingHeadTopic(text);
  const type = /产品|发布|揭开|展示|创始人|品牌|科技|家居/.test(text)
    ? '产品发布 / 品牌宣传'
    : /\d|%|增长|数据|排名|指标|营收/.test(text)
      ? '数据汇报 / 关键数字'
      : /解释|教程|方法|步骤|为什么|如何/.test(text)
        ? '教育讲解 / 概念解释'
        : '口播精华 / 观点剪辑';
  const style = /科技|产品|发布|智能|AI|家居/.test(text)
    ? '现代科技发布会'
    : /生活|家|家庭|体验|需求/.test(text)
      ? '温暖生活方式'
      : /\d|%|数据|指标/.test(text)
        ? '数据感大字报'
        : '高端极简商业';
  return normalizeLocalTalkingHeadOptions({
    topic,
    type,
    style,
    template_label: project.templateId ?? '未选择模板',
    aspect: inferAspectFromProject(project),
    frame_count: String(frameCount),
    caption_mode: '关键句上屏',
    talking_head_overlay: '开',
  });
}

function inferTalkingHeadTopic(text: string): string {
  const founderMatch = /我是([^,，。]{2,16})[,，]/.exec(text);
  const companyMatch = /([^,，。]{2,12}(?:科技|AI|智能|家居|品牌|公司))/i.exec(text);
  const productHint = /产品|发布|揭开|展示/.test(text);
  if (companyMatch?.[1]) return `${companyMatch[1]}${productHint ? '产品发布' : '口播视频'}`;
  if (founderMatch?.[1]) return `${founderMatch[1]}口播视频`;
  return (text.split(/[。！？!?]/)[0] ?? text).slice(0, 28) || '口播字幕视频';
}

function inferAspectFromProject(project: import('@html-video/core').Project): string {
  const res = project.preferences?.resolution;
  if (!res?.width || !res?.height) return '16:9 横屏';
  const ratio = res.width / res.height;
  if (Math.abs(ratio - 9 / 16) < 0.08) return '9:16 手机竖屏';
  if (Math.abs(ratio - 1) < 0.08) return '1:1 方形';
  if (Math.abs(ratio - 4 / 5) < 0.08) return '4:5 小红书';
  return '16:9 横屏';
}

function normalizeLocalTalkingHeadOptions(
  input: Partial<LocalTalkingHeadOptions>,
): LocalTalkingHeadOptions {
  const frameCount = String(Math.min(8, Math.max(2, Number(input.frame_count ?? '4') || 4)));
  return {
    topic: (input.topic ?? '').trim() || '口播字幕视频',
    type: (input.type ?? '').trim() || '产品发布 / 品牌宣传',
    style: (input.style ?? input.template_label ?? '').trim() || '当前模板',
    template_label: (input.template_label ?? input.style ?? '').trim() || '当前模板',
    aspect: (input.aspect ?? '').trim() || '16:9 横屏',
    frame_count: frameCount,
    caption_mode: (input.caption_mode ?? '').trim() || '关键句上屏',
    talking_head_overlay: (input.talking_head_overlay ?? '').trim() || '开',
  };
}

function renderLocalTalkingHeadForm(
  defaults: LocalTalkingHeadOptions,
  transcript: import('@html-video/core').TranscriptDocument,
  isEdit: boolean,
  hasTemplate: boolean,
): string {
  const lead = isEdit
    ? '可以，下面是刚才的设置，改完再提交。'
    : '已读取本地 Whisper 字幕，并根据内容预填了生成设置。请确认或修改后再生成。';
  const summary = transcript.text.trim().slice(0, 90);
  const templateHint = hasTemplate
    ? `当前模板：${defaults.template_label}`
    : '还没有选择模板。请先在顶部 Template / 模板 下拉里选一个模板，再继续生成。';
  return `${lead}\n\n字幕摘要：${summary}${transcript.text.length > 90 ? '…' : ''}\n\n\`\`\`hv-form\n${JSON.stringify({
    meta: { phase: 'local-talking-head' },
    title: '口播视频生成设置',
    fields: [
      { key: 'template_label', label: '模板', kind: 'text', required: true, default: defaults.template_label, help: templateHint },
      {
        key: 'aspect', label: '画面尺寸', kind: 'buttons', required: true,
        default: defaults.aspect,
        options: [
          { value: '16:9 横屏', label: '16:9 横屏' },
          { value: '9:16 手机竖屏', label: '9:16 竖屏' },
          { value: '1:1 方形', label: '1:1 方形' },
          { value: '4:5 小红书', label: '4:5 小红书' },
        ],
      },
      {
        key: 'frame_count', label: '帧数', kind: 'buttons', required: true,
        default: defaults.frame_count,
        options: ['2', '3', '4', '5', '6', '7', '8'].map((v) => ({ value: v, label: v })),
      },
      {
        key: 'caption_mode', label: '字幕呈现', kind: 'buttons', required: true,
        default: defaults.caption_mode,
        options: [
          { value: '关键句上屏', label: '关键句上屏' },
          { value: '逐段字幕', label: '逐段字幕' },
          { value: '不上字幕', label: '不上字幕' },
        ],
      },
      {
        key: 'talking_head_overlay', label: '口播画中画', kind: 'buttons', required: true,
        default: defaults.talking_head_overlay,
        options: [
          { value: '开', label: '开' },
          { value: '关', label: '关' },
        ],
      },
    ],
    allow_attachments: false,
  }, null, 2)}\n\`\`\``;
}

function renderLocalTalkingHeadConfirm(
  options: LocalTalkingHeadOptions,
  transcript: import('@html-video/core').TranscriptDocument,
): string {
  const frameCount = Number(options.frame_count) || 4;
  const duration = Math.ceil(totalTranscriptDuration(transcript)) || frameCount * 4;
  return `按下面设置生成口播字幕视频？\n\n\`\`\`hv-confirm\n${JSON.stringify({
    meta: { phase: 'local-talking-head-confirm' },
    title: '确认生成设置',
    summary: [
      { label: '模板', value: options.template_label },
      { label: '尺寸', value: options.aspect },
      { label: '帧数', value: options.frame_count },
      { label: '字幕呈现', value: options.caption_mode },
      { label: '口播画中画', value: options.talking_head_overlay },
      { label: '估算时长', value: `${duration}s` },
    ],
    actions: ['generate', 'edit'],
  }, null, 2)}\n\`\`\``;
}

async function generateLocalTalkingHeadStoryboard(
  ctx: CliContext,
  projectId: string,
  transcript: import('@html-video/core').TranscriptDocument,
  userText: string,
  optionsInput?: Partial<LocalTalkingHeadOptions>,
): Promise<{ frameCount: number }> {
  const options = normalizeLocalTalkingHeadOptions(optionsInput ?? {});
  await applyLocalTalkingHeadProjectOptions(ctx, projectId, options);
  const project = await ctx.projects.load(projectId);
  const tmpl = project.templateId ? ctx.templates.get(project.templateId) : null;
  let templateHtml = '';
  if (tmpl?.__dir && tmpl.source_entry) {
    const templatePath = join(tmpl.__dir, tmpl.source_entry);
    if (existsSync(templatePath)) {
      templateHtml = await readFile(templatePath, 'utf8');
    }
  }
  const segments = buildTranscriptFrameSegments(transcript, Number(options.frame_count) || 4);
  if (segments.length === 0) {
    throw new Error('transcript has no usable text segments');
  }
  const nodes = segments.map((seg, i) => ({
    id: `subtitle_${String(i + 1).padStart(2, '0')}`,
    kind: 'text' as const,
    label: `${options.type} ${i + 1}`,
    frameIntent: i === 0 ? 'intro' : i === segments.length - 1 ? 'outro' : 'subtitle',
    durationSec: Math.max(3, Math.ceil((seg.endSec - seg.startSec) || 3)),
    text: frameTextForCaptionMode(seg.text.trim(), options.caption_mode, i),
  }));
  const graph: import('@html-video/content-graph').ContentGraph = {
    schemaVersion: 1,
    intent: 'promo',
    synopsis: options.topic || transcript.text.slice(0, 120) || userText.slice(0, 120) || 'Talking-head transcript video',
    nodes,
    edges: nodes.slice(1).map((node, i) => ({
      from: nodes[i]!.id,
      to: node.id,
      kind: 'sequence' as const,
      reason: 'follow transcript timing',
    })),
  };
  await ctx.orchestrator.writeContentGraph(projectId, graph);
  for (let i = 0; i < nodes.length; i++) {
    await ctx.orchestrator.writeFrameHtml(projectId, nodes[i]!.id, localTranscriptFrameHtml({
      index: i,
      total: nodes.length,
      text: nodes[i]!.text,
      synopsis: graph.synopsis ?? '',
      type: options.type,
      style: options.template_label || options.style,
      captionMode: options.caption_mode,
      templateId: tmpl?.id,
      templateName: tmpl?.name_zh ?? tmpl?.name,
      templateHtml,
      templateDir: tmpl?.__dir,
      templatePosterUrl: templatePosterFileUrl(tmpl),
    }));
  }
  return { frameCount: nodes.length };
}

async function applyLocalTalkingHeadProjectOptions(
  ctx: CliContext,
  projectId: string,
  options: LocalTalkingHeadOptions,
): Promise<void> {
  const [width, height] = resolutionForAspect(options.aspect);
  const project = await ctx.projects.load(projectId);
  project.preferences = { ...project.preferences, resolution: { width, height } };
  if (project.talkingHead) {
    project.talkingHead.enabled = !options.talking_head_overlay.startsWith('关');
  }
  await ctx.projects.save(project);
}

export function resolutionForAspect(aspect: string): [number, number] {
  if (aspect.startsWith('9:16')) return [1080, 1920];
  if (aspect.startsWith('1:1')) return [1080, 1080];
  if (aspect.startsWith('4:5')) return [1080, 1350];
  return [1920, 1080];
}

/**
 * Exact, deterministic fallback for voiceover segmentation. It prefers nearby
 * sentence/clause boundaries but never rewrites or drops source characters.
 */
export function splitNarrationSegments(script: string, requestedCount: number): string[] {
  const chars = Array.from(script);
  if (chars.length === 0) return [];
  const count = Math.max(1, Math.min(Math.floor(requestedCount) || 1, chars.length));
  if (count === 1) return [script];

  const preferred = new Set(['。', '！', '？', '!', '?', '；', ';', '，', ',', '、', ':', '：']);
  const boundaries: number[] = [];
  let previous = 0;
  for (let part = 1; part < count; part++) {
    const minimum = previous + 1;
    const maximum = chars.length - (count - part);
    const ideal = Math.max(minimum, Math.min(maximum, Math.round((chars.length * part) / count)));
    let selected = ideal;
    const searchRadius = Math.min(Math.max(12, Math.round(chars.length / count)), maximum - minimum);
    for (let distance = 0; distance <= searchRadius; distance++) {
      const candidates = distance === 0 ? [ideal] : [ideal - distance, ideal + distance];
      const match = candidates.find((candidate) => {
        if (candidate < minimum || candidate > maximum) return false;
        const before = chars[candidate - 1] ?? '';
        const after = chars[candidate] ?? '';
        return preferred.has(before) || /\s/.test(before) || /\s/.test(after);
      });
      if (match !== undefined) {
        selected = match;
        break;
      }
    }
    boundaries.push(selected);
    previous = selected;
  }

  const parts: string[] = [];
  let start = 0;
  for (const end of [...boundaries, chars.length]) {
    parts.push(chars.slice(start, end).join(''));
    start = end;
  }
  return parts;
}

function buildTranscriptFrameSegments(
  transcript: import('@html-video/core').TranscriptDocument,
  requestedCount: number,
): Array<{ startSec: number; endSec: number; text: string }> {
  const count = Math.min(8, Math.max(2, requestedCount || 4));
  const rawSegments = transcript.segments.length > 0
    ? transcript.segments
    : [{ startSec: 0, endSec: Math.max(3, transcript.text.length / 8), text: transcript.text }];
  const clean = rawSegments.filter((seg) => seg.text.trim().length > 0);
  if (clean.length === 0 && transcript.text.trim()) {
    return splitTranscriptText(transcript.text, count);
  }
  if (clean.length <= count) return clean;
  const grouped: Array<{ startSec: number; endSec: number; text: string }> = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * clean.length) / count);
    const end = Math.floor(((i + 1) * clean.length) / count);
    const parts = clean.slice(start, Math.max(start + 1, end));
    grouped.push({
      startSec: parts[0]?.startSec ?? i * 3,
      endSec: parts[parts.length - 1]?.endSec ?? (i + 1) * 3,
      text: parts.map((p) => p.text.trim()).join(' '),
    });
  }
  return grouped;
}

function splitTranscriptText(text: string, count: number): Array<{ startSec: number; endSec: number; text: string }> {
  const clauses = text.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean);
  const source = clauses.length > 0 ? clauses : [text.trim()];
  const grouped: string[] = [];
  for (let i = 0; i < Math.min(count, source.length); i++) {
    const start = Math.floor((i * source.length) / Math.min(count, source.length));
    const end = Math.floor(((i + 1) * source.length) / Math.min(count, source.length));
    grouped.push(source.slice(start, Math.max(start + 1, end)).join(''));
  }
  return grouped.map((part, i) => ({ startSec: i * 3, endSec: (i + 1) * 3, text: part }));
}

function frameTextForCaptionMode(text: string, captionMode: string, index: number): string {
  if (captionMode.startsWith('不上')) return index === 0 ? '核心观点' : `要点 ${index + 1}`;
  if (captionMode.startsWith('关键句')) {
    const first = text.split(/[。！？!?；;]/).map((s) => s.trim()).find(Boolean);
    return (first ?? text).slice(0, 72);
  }
  return text;
}

function totalTranscriptDuration(transcript: import('@html-video/core').TranscriptDocument): number {
  if (transcript.segments.length === 0) return Math.max(3, transcript.text.length / 8);
  const first = transcript.segments[0];
  const last = transcript.segments[transcript.segments.length - 1];
  return Math.max(0, (last?.endSec ?? 0) - (first?.startSec ?? 0));
}

type LocalTemplateFrameArgs = {
  index: number;
  total: number;
  text: string;
  synopsis: string;
  contentKind?: 'text' | 'data' | 'entity';
  structuredData?: {
    title?: string;
    unit?: string;
    items: Array<{ label: string; value: number; note?: string }>;
  };
  type?: string;
  style?: string;
  captionMode?: string;
  templateId?: string;
  templateName?: string;
  templateHtml?: string;
  templateDir?: string;
  templatePosterUrl?: string;
};

function localTranscriptFrameHtml(args: LocalTemplateFrameArgs): string {
  const templateFrame = localTemplateFrameHtml(args);
  if (templateFrame) return templateFrame;
  const safeText = escapeHtml(args.text);
  const safeSynopsis = escapeHtml(args.synopsis);
  const safeType = escapeHtml(args.type ?? '口播字幕');
  const style = args.style ?? '现代科技发布会';
  const palette = localFramePalette(style);
  const kicker = args.index === 0
    ? 'OPENING'
    : args.index === args.total - 1
      ? 'TAKEAWAY'
      : `POINT ${args.index + 1}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Talking-head transcript frame</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background:
        radial-gradient(circle at 18% 24%, ${palette.glow}, transparent 30%),
        linear-gradient(135deg, ${palette.bgA} 0%, ${palette.bgB} 48%, ${palette.bgC} 100%);
      color: ${palette.text};
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .stage {
      position: relative;
      width: 100%;
      height: 100%;
      padding: 92px 112px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 34px;
    }
    .kicker {
      width: max-content;
      border: 1px solid rgba(255,255,255,.34);
      padding: 9px 14px;
      font-size: 22px;
      letter-spacing: .18em;
      font-weight: 700;
      color: ${palette.accentSoft};
    }
    h1 {
      max-width: 1160px;
      margin: 0;
      font-size: 72px;
      line-height: 1.12;
      letter-spacing: 0;
      font-weight: 780;
      text-wrap: balance;
      text-shadow: 0 18px 50px rgba(0,0,0,.32);
      animation: rise .75s cubic-bezier(.2,.8,.2,1) both;
    }
    .synopsis {
      max-width: 920px;
      color: ${palette.muted};
      font-size: 24px;
      line-height: 1.5;
    }
    .type {
      position: absolute;
      right: 112px;
      top: 82px;
      color: ${palette.muted};
      font-size: 20px;
      font-weight: 650;
    }
    .count {
      position: absolute;
      left: 112px;
      bottom: 78px;
      color: ${palette.muted};
      font: 600 18px ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .line {
      position: absolute;
      right: 112px;
      bottom: 88px;
      width: 420px;
      height: 2px;
      background: linear-gradient(90deg, ${palette.accent}, rgba(255,255,255,.15));
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(28px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <main class="stage">
    <div class="type">${safeType}</div>
    <div class="kicker">${kicker}</div>
    <h1 data-hv-text="headline">${safeText}</h1>
    <div class="synopsis" data-hv-text="context">${safeSynopsis}</div>
    <div class="count">${String(args.index + 1).padStart(2, '0')} / ${String(args.total).padStart(2, '0')}</div>
    <div class="line"></div>
  </main>
</body>
</html>`;
}

function localTemplateFrameHtml(args: LocalTemplateFrameArgs): string | undefined {
  const templateKey = `${args.templateId ?? ''} ${args.templateName ?? ''} ${args.style ?? ''}`;
  if (/WeChat AI Dispatch|微信 AI|微信 AI 调度|frame-wechat-ai-dispatch/i.test(templateKey)) {
    return localWechatAiDispatchTranscriptFrameHtml(args);
  }
  if (args.templateHtml?.trim() || args.templatePosterUrl) {
    return localGenericSelectedTemplateFrameHtml(args);
  }
  return undefined;
}

function localGenericSelectedTemplateFrameHtml(args: LocalTemplateFrameArgs): string {
  const structuredFrame = localStructuredTemplateFrameHtml(args);
  if (structuredFrame) return structuredFrame;
  const safeText = escapeHtml(args.text);
  const safeSynopsis = escapeHtml(args.synopsis);
  const safeType = escapeHtml(args.type ?? '口播字幕');
  const safeTemplateName = escapeHtml(args.templateName ?? args.templateId ?? 'Selected template');
  const htmlTemplate = isRenderableHtmlTemplate(args.templateHtml ?? '');
  const srcdoc = htmlTemplate
    ? escapeHtmlAttr(withTemplateBaseHref(args.templateHtml ?? '', args.templateDir))
    : '';
  const safePosterUrl = args.templatePosterUrl ? escapeHtmlAttr(args.templatePosterUrl) : '';
  const templateLayer = htmlTemplate
    ? `<iframe class="template" srcdoc="${srcdoc}" aria-hidden="true"></iframe>`
    : safePosterUrl
      ? `<img class="template" src="${safePosterUrl}" alt="" aria-hidden="true" />`
      : `<div class="template template-empty" aria-hidden="true"></div>`;
  const frameNo = String(args.index + 1).padStart(2, '0');
  const frameTotal = String(args.total).padStart(2, '0');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Selected template transcript frame</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #101114; }
    body { font-family: Inter, "SF Pro Display", "PingFang SC", "Microsoft YaHei", Arial, sans-serif; color: #f8f5ee; }
    .template {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border: 0;
      background: #fff;
      object-fit: cover;
      opacity: .86;
      transform: scale(1.01);
      transform-origin: center;
      animation: templateDrift 8s ease-in-out 2 alternate;
    }
    .shade {
      position: absolute;
      inset: 0;
      background:
        linear-gradient(90deg, rgba(0,0,0,.64), rgba(0,0,0,.18) 48%, rgba(0,0,0,.44)),
        linear-gradient(0deg, rgba(0,0,0,.72), transparent 42%, rgba(0,0,0,.34));
      pointer-events: none;
    }
    .chrome {
      position: absolute;
      inset: 54px 66px;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: 28px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 24px;
      font-size: 18px;
      letter-spacing: .08em;
      text-transform: uppercase;
      opacity: 0;
      transform: translateY(-14px);
      animation: in .55s ease-out .2s forwards;
    }
    .template-name { max-width: 62vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 780; }
    .counter { font-variant-numeric: tabular-nums; color: rgba(248,245,238,.72); }
    .copy {
      align-self: end;
      width: min(980px, 78vw);
      padding: 36px 40px 34px;
      border: 1px solid rgba(248,245,238,.42);
      background: rgba(12,13,14,.70);
      box-shadow: 0 24px 70px rgba(0,0,0,.36);
      backdrop-filter: blur(10px);
      opacity: 0;
      transform: translateY(34px);
      animation: in .7s cubic-bezier(.16,1,.3,1) .38s forwards;
    }
    .type {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 24px;
      color: rgba(248,245,238,.78);
      font-size: 17px;
      font-weight: 760;
      letter-spacing: .1em;
      text-transform: uppercase;
    }
    .type::before { content: ""; width: 38px; height: 3px; background: currentColor; }
    h1 {
      margin: 0;
      max-width: 16ch;
      font-size: clamp(44px, 6.3vw, 108px);
      line-height: .98;
      font-weight: 850;
      letter-spacing: 0;
      text-wrap: balance;
    }
    .synopsis {
      margin-top: 24px;
      max-width: 760px;
      color: rgba(248,245,238,.72);
      font-size: clamp(18px, 1.6vw, 26px);
      line-height: 1.42;
    }
    .bottom {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      color: rgba(248,245,238,.70);
      font-size: 16px;
      letter-spacing: .06em;
      opacity: 0;
      transform: translateY(14px);
      animation: in .55s ease-out .74s forwards;
    }
    .rule { flex: 1; height: 1px; background: rgba(248,245,238,.46); }
    @keyframes in { to { opacity: 1; transform: translateY(0); } }
    @keyframes templateDrift { from { transform: scale(1.01) translate3d(0,0,0); } to { transform: scale(1.035) translate3d(-.7%, -.5%, 0); } }
  </style>
</head>
<body>
  ${templateLayer}
  <div class="shade"></div>
  <main class="chrome">
    <header class="topbar">
      <div class="template-name">${safeTemplateName}</div>
      <div class="counter">${frameNo} / ${frameTotal}</div>
    </header>
    <section class="copy">
      <div class="type">${safeType}</div>
      <h1 data-hv-text="headline">${safeText}</h1>
      <div class="synopsis" data-hv-text="context">${safeSynopsis}</div>
    </section>
    <footer class="bottom">
      <span>SELECTED TEMPLATE</span>
      <span class="rule"></span>
      <span>TRANSCRIPT FRAME</span>
    </footer>
  </main>
</body>
</html>`;
}

function localStructuredTemplateFrameHtml(args: LocalTemplateFrameArgs): string | undefined {
  const templateHtml = args.templateHtml ?? '';
  if (!isRenderableHtmlTemplate(templateHtml)) return undefined;
  const frameBlocks = extractTemplateFrameBlocks(templateHtml);
  if (frameBlocks.length === 0) return undefined;
  const css = extractTemplateStyles(templateHtml);
  const frame = selectTemplateFrameBlock(frameBlocks, args);
  if (!frame) return undefined;
  const structuredItems = args.structuredData?.items ?? [];
  const itemTitles = structuredItems.length > 0
    ? structuredItems.slice(0, 4).map((item) => truncateZh(item.label, 18))
    : templateFrameItemTitles(args.text, args.index);
  const itemDescriptions = structuredItems.length > 0
    ? structuredItems.slice(0, 4).map((item) => truncateZh(item.note || item.label, 22))
    : templateFrameItemDescriptions(args.text, itemTitles, args.index);
  const metricValues = structuredItems.length > 0
    ? structuredItems.slice(0, 4).map((item) => `${item.value}${args.structuredData?.unit ?? ''}`)
    : templateFrameMetricValues(args.text, args.index);
  const data = {
    headline: headlineFromNarrationText(args.text),
    context: shortFrameContext(args.text),
    synopsis: shortFrameContext(args.synopsis || args.text),
    type: args.type ?? '口播字幕',
    frameNo: `${String(args.index + 1).padStart(2, '0')} / ${String(args.total).padStart(2, '0')}`,
    templateName: args.templateName ?? args.templateId ?? 'Selected template',
    sentences: splitFrameSentences(args.text, 4),
    itemTitles,
    itemDescriptions,
    metricValues,
  };
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(args.templateName ?? args.templateId ?? 'Template frame')}</title>
  ${args.templateDir ? `<base href="${escapeHtmlAttr(templateDirectoryFileUrl(args.templateDir))}">` : ''}
  <style>
${css}
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    body {
      min-height: 100vh;
      display: grid;
      place-items: center;
    }
    .hv-template-stage {
      width: 100vw;
      height: 100vh;
      display: grid;
      place-items: center;
      overflow: hidden;
      background: inherit;
    }
    .hv-template-stage > .frame {
      width: 100vw;
      height: 100vh;
      aspect-ratio: auto;
      box-shadow: none;
      animation: hvFrameIn 1.05s cubic-bezier(.16,1,.3,1) both;
    }
    .hv-template-stage > .frame h1,
    .hv-template-stage > .frame h2,
    .hv-template-stage > .frame h3,
    .hv-template-stage > .frame .nm,
    .hv-template-stage > .frame .dx,
    .hv-template-stage > .frame .lede,
    .hv-template-stage > .frame .ed {
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .hv-template-stage > .frame .glitch .step,
    .hv-template-stage > .frame [class*="glitch"] .step {
      animation: hvGlitchDrift 6.2s ease-in-out 2 alternate;
    }
    .hv-template-stage > .frame .ht {
      transform-origin: left center;
      animation: hvRuleDraw 1.05s cubic-bezier(.16,1,.3,1) .08s both;
    }
    .hv-template-stage > .frame .hb {
      transform-origin: right center;
      animation: hvRuleDraw 1.05s cubic-bezier(.16,1,.3,1) .26s both;
    }
    .hv-template-stage > .frame .body > *,
    .hv-template-stage > .frame .tb,
    .hv-template-stage > .frame .r,
    .hv-template-stage > .frame .pg {
      animation: hvTextIn .95s cubic-bezier(.16,1,.3,1) both;
    }
    .hv-template-stage > .frame .body > *:nth-child(1) { animation-delay: .34s; }
    .hv-template-stage > .frame .body > *:nth-child(2) { animation-delay: .58s; }
    .hv-template-stage > .frame .body > *:nth-child(3) { animation-delay: .84s; }
    .hv-template-stage > .frame .r:nth-child(2) { animation-delay: .44s; }
    .hv-template-stage > .frame .r:nth-child(3) { animation-delay: .64s; }
    .hv-template-stage > .frame .r:nth-child(4) { animation-delay: .84s; }
    .hv-template-stage > .frame .r:nth-child(5) { animation-delay: 1.04s; }
    .hv-template-stage > .frame .pg { animation-delay: 1.12s; }
    .hv-template-stage > .frame .qr i.on {
      animation: hvQrPulse 3.8s steps(2,end) 2;
    }
    .hv-template-stage > .frame .qr i.on:nth-child(3n) { animation-delay: .44s; }
    .hv-template-stage > .frame .qr i.on:nth-child(4n) { animation-delay: .92s; }
    .hv-template-stage > .frame .st .c {
      transform-origin: center bottom;
      animation: hvCellGrow 1.1s cubic-bezier(.16,1,.3,1) both;
    }
    .hv-template-stage > .frame .st:nth-child(1) .c { animation-delay: .36s; }
    .hv-template-stage > .frame .st:nth-child(2) .c { animation-delay: .50s; }
    .hv-template-stage > .frame .st:nth-child(3) .c { animation-delay: .64s; }
    .hv-template-stage > .frame .st:nth-child(4) .c { animation-delay: .78s; }
    .hv-template-stage > .frame .st:nth-child(5) .c { animation-delay: .92s; }
    .hv-template-stage > .frame .st:nth-child(6) .c { animation-delay: 1.06s; }
    .hv-template-stage > .frame h1[data-hv-text="headline"],
    .hv-template-stage > .frame h2[data-hv-text="headline"],
    .hv-template-stage > .frame h3[data-hv-text="headline"],
    .hv-template-stage > .frame .h[data-hv-text="headline"] {
      font-size: clamp(42px, 6.6cqw, 96px);
      line-height: 1.02;
      max-width: 68cqw;
      white-space: normal;
    }
    .hv-template-stage > .frame .ed[data-hv-text="context"],
    .hv-template-stage > .frame .lede[data-hv-text="context"],
    .hv-template-stage > .frame .dx[data-hv-text="context"],
    .hv-template-stage > .frame p[data-hv-text="context"] {
      font-size: clamp(18px, 1.9cqw, 30px);
      line-height: 1.35;
      max-width: 58cqw;
    }
    .hv-template-stage > .frame .tb .h[data-hv-text="headline"],
    .hv-template-stage > .frame .topbar .h[data-hv-text="headline"] {
      font-size: clamp(30px, 3.4cqw, 54px);
      max-width: 62cqw;
    }
    .hv-template-stage > .frame .nm[data-hv-text^="item_title"] {
      font-size: clamp(24px, 2.1cqw, 38px);
      line-height: 1.08;
    }
    .hv-template-stage > .frame .dx[data-hv-text^="item_desc"],
    .hv-template-stage > .frame .ds[data-hv-text^="item_desc"] {
      font-size: clamp(15px, 1.15cqw, 21px);
      line-height: 1.35;
    }
    @keyframes hvFrameIn {
      from { opacity: 0; transform: translateY(14px) scale(.99); filter: blur(2px); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes hvGlitchDrift {
      from { transform: translateX(0) scaleX(1); opacity: .58; }
      45% { transform: translateX(-1.8%) scaleX(1.025); opacity: .82; }
      to { transform: translateX(.8%) scaleX(.99); opacity: .68; }
    }
    @keyframes hvRuleDraw {
      from { transform: scaleX(0); opacity: .2; }
      to { transform: scaleX(1); opacity: 1; }
    }
    @keyframes hvTextIn {
      from { opacity: 0; transform: translateY(12px); filter: blur(1.5px); }
      to { opacity: 1; transform: translateY(0); filter: blur(0); }
    }
    @keyframes hvQrPulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: .62; transform: scale(.92); }
    }
    @keyframes hvCellGrow {
      from { transform: scaleY(.08); opacity: .18; }
      to { transform: scaleY(1); opacity: 1; }
    }
  </style>
</head>
<body>
  <main class="hv-template-stage">
${frame}
  </main>
  <script>
    const hv = ${JSON.stringify(data)};
    const root = document.querySelector('.hv-template-stage > .frame') || document;
    const setText = (selector, value, key) => {
      const el = root.querySelector(selector);
      if (!el || value == null || value === '') return false;
      el.textContent = value;
      if (key) el.setAttribute('data-hv-text', key);
      return true;
    };
    const setAll = (selector, values, keyPrefix) => {
      const nodes = Array.from(root.querySelectorAll(selector));
      nodes.forEach((el, i) => {
        const value = values[i];
        if (value == null || value === '') return;
        el.textContent = value;
        el.setAttribute('data-hv-text', keyPrefix + '_' + (i + 1));
      });
    };
    const headline = hv.headline || hv.context || hv.synopsis;
    const context = hv.context || headline;
    const profile = (() => {
      if (root.querySelectorAll('.r .nm, .lrow .nm').length >= 2) return 'ledger';
      if (root.querySelectorAll('.grid .c').length >= 2) return 'metrics';
      if (root.querySelectorAll('.row .bl').length >= 2) return 'bars';
      if (root.querySelector('.fig')) return 'stat';
      if (root.querySelectorAll('.t .ti').length >= 2) return 'tiles';
      if (root.querySelector('.q')) return 'quote';
      return 'hero';
    })();
    setText('.kick, .ix, .cap, .label, .eyebrow, .ey', hv.type, 'type');
    setText('.pg, .count', hv.frameNo, 'frame_no');
    if (profile === 'ledger') {
      setText('.tb .h, .topbar .h', headline, 'headline');
      setText('.tb .t, .topbar .t', hv.frameNo, 'frame_no');
      setAll('.r .nm, .lrow .nm', hv.itemTitles || hv.sentences, 'item_title');
      setAll('.r .dx, .lrow .ds', hv.itemDescriptions || hv.sentences, 'item_desc');
    } else if (profile === 'metrics') {
      setText('h3, h2, h1', headline, 'headline');
      setAll('.grid .c .n', hv.metricValues, 'metric_value');
      setAll('.grid .c .nm', hv.itemTitles || hv.sentences, 'item_title');
      setAll('.grid .c .d', hv.itemDescriptions || hv.sentences, 'item_desc');
      setText('.tp', hv.frameNo, 'frame_no');
    } else if (profile === 'bars') {
      setText('h3, h2, h1', headline, 'headline');
      setAll('.row .bl', hv.itemTitles || hv.sentences, 'item_title');
      setAll('.row .pct', hv.metricValues, 'metric_value');
      Array.from(root.querySelectorAll('.row .fill')).forEach((el, i) => {
        const n = Number((hv.metricValues || [])[i]);
        if (Number.isFinite(n)) el.style.width = Math.max(18, Math.min(96, n)) + '%';
      });
    } else if (profile === 'stat') {
      setText('.tag', (hv.itemTitles || [])[0] || hv.type, 'item_title_1');
      setText('.fig', (hv.metricValues || [])[0] || headline, 'metric_value_1');
      setText('.d, .ed, .lede, .sub, .desc, p', context, 'context');
      setText('.tb .l:first-child, .fl .l:first-child', hv.templateName, 'template');
      setText('.tb .l:last-child, .fl .l:last-child', hv.frameNo, 'frame_no');
    } else if (profile === 'tiles') {
      setText('h3, h2, h1', headline, 'headline');
      setAll('.t .ti', hv.itemTitles || hv.sentences, 'item_title');
      setText('.tb .l:first-child', hv.type, 'type');
      setText('.tb .l:last-child', hv.frameNo, 'frame_no');
    } else if (profile === 'quote') {
      setText('.q, blockquote, h3, h2, h1', context, 'context');
      setText('.c, .at', hv.templateName, 'template');
      setText('.ro', hv.frameNo, 'frame_no');
    } else {
      setText('h3, h2, h1, .tb .h, .topbar .h', headline, 'headline');
      setText('.ed, .lede, .sub, .desc, p', context, 'context');
      setText('.tb .t, .topbar .t, .meta, .tagline', hv.frameNo, 'frame_no');
    }
    const titleNodes = Array.from(root.querySelectorAll('h1,h2,h3,.h,.nm'));
    if (!titleNodes.some((el) => el.getAttribute('data-hv-text') === 'headline') && titleNodes[0]) {
      titleNodes[0].textContent = headline;
      titleNodes[0].setAttribute('data-hv-text', 'headline');
    }
  </script>
</body>
</html>`;
}

function extractTemplateStyles(html: string): string {
  const styles: string[] = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && match[1]) styles.push(match[1]);
  return styles.join('\n\n');
}

function extractTemplateFrameBlocks(html: string): string[] {
  const out: string[] = [];
  const re = /<div\b[^>]*class=(["'])[^"']*\bframe\b[^"']*\1[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const block = extractBalancedDiv(html, match.index);
    if (block) out.push(block);
  }
  return out;
}

function extractBalancedDiv(html: string, start: number): string | undefined {
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = start;
  let depth = 0;
  let first = true;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html))) {
    const tag = match[0];
    if (first && match.index !== start) return undefined;
    first = false;
    if (tag.startsWith('</')) depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(start, tagRe.lastIndex);
  }
  return undefined;
}

function headlineFromNarrationText(text: string): string {
  const first = text
    .split(/(?<=[，,、：:；;。！？!?])\s*/)
    .map((s) => s.trim())
    .find(Boolean) ?? text.trim();
  return first.length > 22 ? `${first.slice(0, 20)}…` : first;
}

function splitFrameSentences(text: string, max: number): string[] {
  const parts = text
    .split(/(?<=[。！？!?；;。.])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const source = parts.length > 0 ? parts : [text.trim()].filter(Boolean);
  return source.slice(0, max).map((s) => (s.length > 54 ? `${s.slice(0, 52)}…` : s));
}

function selectedTemplateStructureBrief(templateHtml: string): string {
  if (!isRenderableHtmlTemplate(templateHtml)) return '';
  const frames = extractTemplateFrameBlocks(templateHtml).slice(0, 8);
  if (frames.length === 0) return '';
  return frames.map((frame, i) => {
    const profile = templateFrameProfileFromHtml(frame);
    return `  ${i + 1}. ${profile.kind}: ${profile.guidance}`;
  }).join('\n');
}

function templateFrameProfileFromHtml(frameHtml: string): { kind: string; guidance: string } {
  const count = (re: RegExp) => Array.from(frameHtml.matchAll(re)).length;
  const ledgerRows = count(/class=(["'])[^"']*\b(?:r|lrow)\b[^"']*\1/gi);
  const metricCards = count(/class=(["'])[^"']*\bc\b[^"']*\1/gi);
  const barRows = count(/class=(["'])[^"']*\brow\b[^"']*\1/gi);
  const tiles = count(/class=(["'])[^"']*\bt\b[^"']*\1/gi);
  if (/class=(["'])[^"']*\b(?:steps?|timeline|process)\b[^"']*\1/i.test(frameHtml)) return { kind: 'process/timeline frame', guidance: 'needs 3-5 ordered phases with short action labels and outcomes' };
  if (/before\s*\/\s*during\s*\/\s*after|\bbefore\b[\s\S]{0,300}\bafter\b|\bcomparison\b|\bversus\b|\bvs\.?\b/i.test(frameHtml)) return { kind: 'comparison frame', guidance: 'needs two comparable states, values, or approaches using the same unit and framing' };
  if (/flowchart|decision|branching|node[- ]graph|system[- ]diagram|service[- ]map/i.test(frameHtml)) return { kind: 'flow/diagram frame', guidance: 'needs named nodes and explicit relationships or directional steps' };
  if (/<code\b|<pre\b|terminal|editor-pane|workbench/i.test(frameHtml)) return { kind: 'code/terminal frame', guidance: 'needs a compact code, command, or developer-workflow example' };
  if (ledgerRows >= 2) return { kind: 'ledger/list frame', guidance: 'needs 3-4 short item titles plus short descriptions; avoid long paragraphs' };
  if (/class=(["'])[^"']*\b(?:bars?|chart|track|fill|st|pstack)\b[^"']*\1/i.test(frameHtml) || barRows >= 2) return { kind: 'bar/ranking frame', guidance: 'needs ranked labels and numeric values that can map to bar lengths or heights' };
  if (metricCards >= 2 || /dashboard|metrics?|\bkpi\b/i.test(frameHtml)) return { kind: 'metric-card frame', guidance: 'needs 2-4 metric values, labels, and one-line explanations' };
  if (/class=(["'])[^"']*\bfig\b[^"']*\1/i.test(frameHtml)) return { kind: 'big-stat frame', guidance: 'needs one large number or short punchline plus a supporting sentence' };
  if (tiles >= 2) return { kind: 'topic-tile frame', guidance: 'needs 2-4 compact topic labels' };
  if (/class=(["'])[^"']*\bq\b[^"']*\1|blockquote/i.test(frameHtml)) return { kind: 'quote frame', guidance: 'needs one memorable sentence, not a list' };
  return { kind: 'hero/title frame', guidance: 'needs one strong headline and one short supporting line' };
}

function selectTemplateFrameBlock(frameBlocks: string[], args: Pick<LocalTemplateFrameArgs, 'index' | 'total' | 'text' | 'contentKind'>): string | undefined {
  if (frameBlocks.length === 0) return undefined;
  const fallbackIndex = args.index % frameBlocks.length;
  const text = args.text.toLowerCase();
  const numericValues = Array.from(text.matchAll(/(?<![\p{L}\p{N}])\d+(?:\.\d+)?%?/gu));
  const wantsData = args.contentKind === 'data' || numericValues.length >= 2;
  const wantsProcess = /步骤|流程|阶段|先.+再|首先|其次|最后|step|process|phase|timeline|workflow/i.test(text);
  const wantsComparison = /对比|比较|相比|从.+到|原来.+现在|之前.+之后|提升|下降|增长|减少|before|after|versus|\bvs\.?\b/i.test(text);
  const wantsQuote = /金句|观点|认为|表示|quote|“|”|「|」/.test(text);
  const wantsCode = /代码|命令|终端|编辑器|开发者|code|terminal|command|developer|vscode/i.test(text);
  const wantsDiagram = /关系|系统|网络|节点|决策|分支|调度|链路|flow|system|network|decision|dispatch/i.test(text);

  let bestIndex = fallbackIndex;
  let bestScore = 0;
  frameBlocks.forEach((frame, i) => {
    const kind = templateFrameProfileFromHtml(frame).kind;
    let score = 0;
    if (wantsData && /metric|bar|stat|ledger/.test(kind)) score += 50;
    if (wantsComparison && /comparison|bar|metric/.test(kind)) score += 36;
    if (wantsProcess && /process|timeline|ledger|list/.test(kind)) score += 42;
    if (wantsDiagram && /flow|diagram|process/.test(kind)) score += 42;
    if (wantsCode && /code|terminal/.test(kind)) score += 48;
    if (wantsQuote && /quote/.test(kind)) score += 36;
    if (args.index === 0 && /hero|title/.test(kind)) score += 18;
    if (args.index === args.total - 1 && /quote|hero|title/.test(kind)) score += 12;
    // Prefer different equally suitable compositions as the storyboard moves.
    score -= Math.abs(i - fallbackIndex) * 0.1;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  });
  return frameBlocks[bestIndex] ?? frameBlocks[0];
}

function templateTextFromGraphNode(node: unknown, fallback: string): string {
  const n = node as {
    text?: unknown;
    label?: unknown;
    data?: { title?: unknown; unit?: unknown; items?: Array<{ label?: unknown; value?: unknown }> };
  };
  const parts: string[] = [];
  const text = String(n.text ?? n.label ?? '').trim();
  if (text) parts.push(text);
  const title = String(n.data?.title ?? '').trim();
  if (title && title !== text) parts.push(title);
  const unit = String(n.data?.unit ?? '').trim();
  if (Array.isArray(n.data?.items)) {
    for (const item of n.data.items) {
      const label = String(item.label ?? '').trim();
      const value = item.value == null ? '' : String(item.value).trim();
      const pair = [label, value ? `${value}${unit}` : ''].filter(Boolean).join(' ');
      if (pair) parts.push(pair);
    }
  }
  return parts.length > 0 ? parts.join('。') : fallback;
}

export function buildLocalTemplateAdaptedGraph(args: {
  frameCount: number;
  perFrameDurationSec: number;
  contentTurns: string[];
  openingTopic?: string;
  sourceTexts: string[];
  frameTexts?: string[];
  templateHtml: string;
  fallbackSynopsis: string;
}): import('@html-video/content-graph').ContentGraph {
  const exactFrameTexts = (args.frameTexts ?? []).map((text) => text.trim()).filter(Boolean);
  const source = exactFrameTexts.length === args.frameCount
    ? exactFrameTexts.join(' ')
    : [
        ...(args.contentTurns ?? []),
        ...(args.sourceTexts ?? []),
        args.openingTopic ?? '',
      ].join('\n').replace(/\s+/g, ' ').trim();
  const segments = exactFrameTexts.length === args.frameCount
    ? exactFrameTexts
    : splitStoryboardSourceIntoFrames(source || args.fallbackSynopsis, args.frameCount);
  const frameBlocks = isRenderableHtmlTemplate(args.templateHtml)
    ? extractTemplateFrameBlocks(args.templateHtml)
    : [];
  const nodes = Array.from({ length: args.frameCount }, (_, i) => {
    const text = segments[i] || segments[segments.length - 1] || args.fallbackSynopsis;
    const realNumbers = Array.from(text.matchAll(/(?<![\p{L}\p{N}])\d+(?:\.\d+)?%?/gu))
      .map((match) => Number.parseFloat(match[0]))
      .filter(Number.isFinite);
    const selectedFrame = selectTemplateFrameBlock(frameBlocks, {
      index: i,
      total: args.frameCount,
      text,
      contentKind: realNumbers.length >= 2 ? 'data' : 'text',
    });
    const profile = templateFrameProfileFromHtml(selectedFrame ?? '');
    const id = `frame_${i + 1}`;
    const label = headlineFromNarrationText(text);
    const base = {
      id,
      label,
      frameIntent: profile.kind,
      durationSec: args.perFrameDurationSec,
    };
    if (/metric|bar|stat|ledger|list|tile/i.test(profile.kind)) {
      // Never invent chart values merely because the selected template contains
      // a metric composition. Without at least two real figures, keep the node
      // as grounded text and let the renderer adapt the template structure.
      if (realNumbers.length < 2) {
        return {
          ...base,
          kind: 'text' as const,
          text,
        };
      }
      const titles = templateFrameItemTitles(text, i);
      return {
        ...base,
        kind: 'data' as const,
        text: label,
        data: {
          title: label,
          items: titles.map((title, idx) => ({
            label: title,
            value: realNumbers[idx % realNumbers.length]!,
            note: templateFrameItemDescriptions(text, titles, i)[idx],
          })),
        },
      };
    }
    if (/quote|hero|title/i.test(profile.kind) && i === args.frameCount - 1) {
      return {
        ...base,
        kind: 'entity' as const,
        props: { headline: label, text },
      };
    }
    return {
      ...base,
      kind: 'text' as const,
      text,
    };
  });
  return {
    schemaVersion: 1,
    intent: 'explainer',
    synopsis: shortFrameContext(source || args.fallbackSynopsis) || args.fallbackSynopsis,
    nodes,
    edges: nodes.slice(1).map((node, i) => ({
      from: nodes[i]!.id,
      to: node.id,
      kind: 'sequence' as const,
      reason: 'local template-adapted fallback',
    })),
  };
}

function splitStoryboardSourceIntoFrames(text: string, frameCount: number): string[] {
  const sentences = text
    .split(/(?<=[。！？!?；;])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const source = sentences.length > 0 ? sentences : splitDisplayClauses(text);
  if (source.length === 0) return Array.from({ length: frameCount }, () => text.trim()).filter(Boolean);
  if (source.length <= frameCount) {
    const out = [...source];
    while (out.length < frameCount) out.push(source[source.length - 1] ?? text);
    return out.slice(0, frameCount);
  }
  const per = Math.ceil(source.length / frameCount);
  const out: string[] = [];
  for (let i = 0; i < source.length && out.length < frameCount; i += per) {
    out.push(source.slice(i, i + per).join(' '));
  }
  return out;
}

function shortFrameContext(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const firstSentence = compact.split(/(?<=[。！？!?；;])\s*/).find(Boolean) ?? compact;
  return truncateZh(firstSentence, 44);
}

function templateFrameItemTitles(text: string, frameIndex: number): string[] {
  const clauses = splitDisplayClauses(text)
    .map((s) => titlePhraseForTemplateItem(s))
    .filter(Boolean);
  const fallback = genericFallbackTitles(frameIndex);
  return fillTemplateItems(clauses, fallback, 4, 18);
}

function templateFrameItemDescriptions(text: string, titles: string[], frameIndex: number): string[] {
  const clauses = splitDisplayClauses(text);
  const fallback = genericFallbackDescriptions(frameIndex);
  const descs = titles.map((title, i) => descriptionPhraseForTemplateItem(clauses[i + 1] || clauses[i] || title));
  return fillTemplateItems(descs, fallback, 4, 22);
}

function templateFrameMetricValues(text: string, frameIndex: number): string[] {
  const found = Array.from(text.matchAll(/[+-]?\d+(?:\.\d+)?\s*(?:%|倍|分钟|小时|天|元|万|亿|年|次)?/g))
    .map((m) => m[0].replace(/\s+/g, ''))
    .filter(Boolean);
  const fallback = [
    ['01', '02', '03', '04'],
    ['24', '68', '92', '100'],
    ['88', '64', '42', '27'],
    ['3x', '5x', '8x', '10x'],
  ][frameIndex % 4]!;
  return fillTemplateItems(found, fallback, 4, 8);
}

function splitDisplayClauses(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？!?；;，,、：:])\s*/)
    .map((s) => s.replace(/[。！？!?；;，,、：:]+$/g, '').trim())
    .filter((s) => s.length >= 2);
}

function titlePhraseForTemplateItem(text: string): string {
  const compact = text.replace(/^(比如|例如|如果|但是|而且|然后|所以|真正|最近|原来|现在)\s*/u, '').trim();
  const beforeVerb = compact.split(/(，|,|会|能|把|让|是|不是|已经|开始|直接|自动|不用|可以)/u)[0]?.trim();
  const candidate = beforeVerb && beforeVerb.length >= 3 ? beforeVerb : compact;
  return truncateZh(candidate, 18);
}

function descriptionPhraseForTemplateItem(text: string): string {
  return truncateZh(text, 22);
}

function genericFallbackTitles(frameIndex: number): string[] {
  const groups = [
    ['核心观点', '关键变化', '主要价值', '下一步'],
    ['问题', '转折', '方法', '结果'],
    ['输入', '处理', '判断', '输出'],
    ['过去', '现在', '效率', '收益'],
    ['场景', '能力', '证据', '结论'],
    ['提醒', '行动', '人群', '金句'],
  ];
  return groups[frameIndex % groups.length] ?? groups[0]!;
}

function genericFallbackDescriptions(frameIndex: number): string[] {
  const groups = [
    ['当前帧的重点', '信息发生变化', '带来具体好处', '引向后续动作'],
    ['先指出痛点', '再给出反差', '说明解决路径', '落到可见结果'],
    ['素材或数据进入', '系统完成整理', '形成判断依据', '输出可用内容'],
    ['原本耗时费力', '现在流程缩短', '减少重复劳动', '留下判断空间'],
    ['对应真实场景', '展示核心能力', '给出可信依据', '收束为结论'],
    ['不遗漏关键点', '提示下一步', '点名适用对象', '留下记忆句'],
  ];
  return groups[frameIndex % groups.length] ?? groups[0]!;
}

function fillTemplateItems(source: string[], fallback: string[], count: number, maxLen: number): string[] {
  const out: string[] = [];
  for (const item of source) {
    const cleaned = item.trim();
    if (cleaned && !out.includes(cleaned)) out.push(truncateZh(cleaned, maxLen));
    if (out.length >= count) break;
  }
  for (const item of fallback) {
    const cleaned = item.trim();
    if (cleaned && !out.includes(cleaned)) out.push(truncateZh(cleaned, maxLen));
    if (out.length >= count) break;
  }
  return out.slice(0, count);
}

function truncateZh(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, Math.max(1, max - 1))}…` : compact;
}

function withTemplateBaseHref(html: string, templateDir?: string): string {
  if (!templateDir) return html;
  const href = templateDirectoryFileUrl(templateDir);
  const baseTag = `<base href="${escapeHtmlAttr(href)}">`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (head) => `${head}\n  ${baseTag}`);
  }
  return `${baseTag}\n${html}`;
}

function templateDirectoryFileUrl(templateDir: string): string {
  const href = pathToFileURL(resolve(templateDir)).href;
  return href.endsWith('/') ? href : `${href}/`;
}

function isRenderableHtmlTemplate(source: string): boolean {
  return /<!doctype\s+html|<html\b|<body\b/i.test(source);
}

function templatePosterFileUrl(tmpl?: { __dir?: string; preview?: { poster?: string } } | null): string {
  if (!tmpl?.__dir || !tmpl.preview?.poster) return '';
  const posterPath = join(tmpl.__dir, tmpl.preview.poster);
  return existsSync(posterPath) ? pathToFileURL(posterPath).href : '';
}

function localWechatAiDispatchTranscriptFrameHtml(args: LocalTemplateFrameArgs): string {
  const safeText = escapeHtml(args.text);
  const safeSynopsis = escapeHtml(args.synopsis);
  const safeType = escapeHtml(args.type ?? '口播字幕');
  const section = args.index === 0
    ? '01 / OPENING'
    : args.index === args.total - 1
      ? '99 / TAKEAWAY'
      : `${String(args.index + 1).padStart(2, '0')} / AI DISPATCH`;
  const phase = args.index === 0
    ? 'INTENT'
    : args.index === args.total - 1
      ? 'OUTPUT'
      : 'CONTEXT';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WeChat AI Dispatch transcript frame</title>
  <style>
    :root {
      --paper: #f5f7f1;
      --ink: #202521;
      --muted: #7c837d;
      --line: rgba(32,37,33,.16);
      --green: #159c63;
      --green-soft: rgba(21,156,99,.12);
      --blue: #315f9f;
      --blue-soft: rgba(49,95,159,.14);
      --sans: "Inter", "SF Pro Display", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
      --mono: "SF Mono", "Roboto Mono", "Cascadia Mono", ui-monospace, monospace;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: var(--paper); }
    body {
      color: var(--ink);
      font-family: var(--sans);
      background:
        linear-gradient(90deg, rgba(32,37,33,.055) 1px, transparent 1px),
        linear-gradient(0deg, rgba(32,37,33,.055) 1px, transparent 1px),
        radial-gradient(circle at 68% 46%, rgba(49,95,159,.08), transparent 22%),
        var(--paper);
      background-size: 72px 72px, 72px 72px, auto, auto;
    }
    .stage { position: absolute; inset: 58px 94px 76px; }
    .rule { position: absolute; left: 0; right: 0; height: 3px; background: var(--ink); transform-origin: left; animation: rule .8s cubic-bezier(.16,1,.3,1) forwards; }
    .top { top: 0; }
    .bottom { bottom: 72px; animation-delay: .2s; }
    .header { position: absolute; top: 36px; left: 0; right: 0; display: flex; justify-content: space-between; align-items: baseline; opacity: 0; transform: translateY(14px); animation: in .55s ease-out .35s forwards; }
    .brand { font-size: 34px; font-weight: 760; }
    .system { color: var(--muted); font: 19px var(--mono); letter-spacing: .12em; }
    .panel { position: absolute; left: 0; right: 0; top: 132px; bottom: 148px; border: 2px solid rgba(32,37,33,.15); background: rgba(247,249,245,.42); opacity: 0; transform: translateY(18px); animation: in .65s ease-out .55s forwards; }
    .panel::before { content: ""; position: absolute; top: 0; bottom: 0; left: 610px; width: 2px; background: rgba(32,37,33,.12); transform-origin: top; transform: scaleY(0); animation: lineY .75s ease-out .8s forwards; }
    .copy { position: absolute; left: 32px; top: 54px; width: 520px; }
    .mark { display: flex; align-items: center; gap: 14px; color: var(--green); font: 800 20px var(--mono); letter-spacing: .08em; opacity: 0; transform: translateY(16px); animation: in .52s ease-out .85s forwards; }
    .mark::before { content: ""; width: 34px; height: 4px; background: currentColor; }
    h1 { margin: 32px 0 0; font-size: 64px; line-height: 1.08; font-weight: 820; letter-spacing: 0; text-wrap: balance; opacity: 0; transform: translateY(28px); animation: in .7s cubic-bezier(.16,1,.3,1) 1s forwards; }
    .lede { margin-top: 24px; color: #4f5751; font-size: 23px; line-height: 1.44; opacity: 0; transform: translateY(18px); animation: in .55s ease-out 1.18s forwards; }
    .pill { margin-top: 30px; width: 430px; min-height: 78px; display: flex; align-items: center; padding: 0 30px; border: 3px solid var(--ink); border-radius: 16px; background: rgba(255,255,255,.5); font-size: 25px; font-weight: 760; opacity: 0; transform: translateY(18px); animation: in .55s ease-out 1.35s forwards; }
    .network { position: absolute; left: 690px; right: 58px; top: 74px; bottom: 64px; }
    .map-title { position: absolute; left: 0; top: 0; color: var(--muted); font: 800 18px var(--mono); letter-spacing: .1em; }
    .hub { position: absolute; left: 46%; top: 48%; width: 214px; height: 214px; border-radius: 50%; border: 5px solid var(--blue); background: #edf6ff; display: grid; place-items: center; color: var(--blue); box-shadow: 0 0 0 18px var(--blue-soft); transform: translate(-50%,-50%) scale(.86); opacity: 0; animation: hub .75s cubic-bezier(.16,1,.3,1) 1s forwards, pulse 2.6s ease-in-out 2s 2; }
    .hub small { display: block; text-align: center; font-size: 22px; margin-bottom: 8px; }
    .hub b { display: block; font-size: 60px; line-height: 1; }
    .node { position: absolute; width: 205px; height: 118px; padding: 22px 26px; border: 3px solid rgba(32,37,33,.22); background: rgba(255,255,255,.5); opacity: 0; transform: translateY(18px); animation: in .52s ease-out forwards; }
    .node .label { display: block; color: var(--muted); font: 17px var(--mono); letter-spacing: .09em; margin-bottom: 10px; }
    .node .name { font-size: 36px; font-weight: 820; }
    .n1 { left: 74px; top: 54px; animation-delay: 1.18s; }
    .n2 { right: 74px; top: 46px; animation-delay: 1.26s; }
    .match { right: 26px; top: 288px; border-color: var(--green); background: var(--green-soft); animation-delay: 1.42s; }
    .connector { position: absolute; height: 3px; background: var(--line); transform-origin: left; transform: scaleX(0) rotate(var(--rot)); animation: connect .72s cubic-bezier(.16,1,.3,1) forwards; }
    .c1 { left: 276px; top: 186px; width: 270px; --rot: 34deg; animation-delay: 1.22s; }
    .c2 { left: 590px; top: 186px; width: 294px; --rot: -35deg; animation-delay: 1.3s; }
    .c3 { left: 602px; top: 342px; width: 316px; height: 5px; background: var(--green); --rot: 3deg; animation-delay: 1.55s; }
    .metrics { position: absolute; left: 0; right: 338px; bottom: 0; height: 76px; display: grid; grid-template-columns: repeat(3,1fr); border-top: 2px solid rgba(32,37,33,.16); border-bottom: 2px solid rgba(32,37,33,.16); opacity: 0; transform: translateY(18px); animation: in .55s ease-out 1.65s forwards; }
    .metric { display: flex; align-items: center; gap: 14px; padding: 0 22px; border-right: 2px solid rgba(32,37,33,.12); }
    .metric:last-child { border-right: 0; }
    .metric b { color: var(--green); font: 800 28px var(--mono); }
    .metric span { color: var(--muted); font-size: 16px; font-weight: 720; }
    .caption { position: absolute; left: 0; right: 0; bottom: 0; height: 72px; display: flex; align-items: flex-end; justify-content: center; gap: 32px; font-size: 50px; font-weight: 820; color: var(--muted); opacity: 0; animation: in .6s ease-out 1.75s forwards; }
    .caption .accent { color: var(--green); }
    @keyframes in { to { opacity: 1; transform: translateY(0); } }
    @keyframes rule { to { transform: scaleX(1); } }
    @keyframes lineY { to { transform: scaleY(1); } }
    @keyframes hub { to { opacity: 1; transform: translate(-50%,-50%) scale(1); } }
    @keyframes pulse { 50% { box-shadow: 0 0 0 28px rgba(49,95,159,.05); } }
    @keyframes connect { to { transform: scaleX(1) rotate(var(--rot)); } }
  </style>
</head>
<body>
  <main class="stage">
    <div class="rule top"></div>
    <div class="rule bottom"></div>
    <header class="header">
      <div class="brand">AI 观点 / 口播分镜</div>
      <div class="system">DISTRIBUTION SYSTEM · FRAME ${String(args.index + 1).padStart(2, '0')}</div>
    </header>
    <section class="panel">
      <div class="copy">
        <div class="mark">${section}</div>
        <h1 data-hv-text="headline">${safeText}</h1>
        <div class="lede" data-hv-text="context">${safeSynopsis}</div>
        <div class="pill">“${phase} / ${safeType}”</div>
      </div>
      <div class="network">
        <div class="map-title">VOICE ROUTER / MATCH SCORE</div>
        <span class="connector c1"></span>
        <span class="connector c2"></span>
        <span class="connector c3"></span>
        <div class="hub"><div><small>观点</small><b>AI</b></div></div>
        <div class="node n1"><span class="label">FRAME</span><span class="name">${String(args.index + 1).padStart(2, '0')}</span></div>
        <div class="node n2"><span class="label">MODE</span><span class="name">口播</span></div>
        <div class="node match"><span class="label">MATCHED</span><span class="name">字幕</span></div>
        <div class="metrics">
          <div class="metric"><b>${String(args.index + 1).padStart(2, '0')}</b><span>Current frame</span></div>
          <div class="metric"><b>${String(args.total).padStart(2, '0')}</b><span>Total frames</span></div>
          <div class="metric"><b>AI</b><span>Template route</span></div>
        </div>
      </div>
    </section>
    <footer class="caption"><span>口播文案</span><span>→</span><span>AI <span class="accent">调度帧</span></span></footer>
  </main>
</body>
</html>`;
}

function localFramePalette(style: string): {
  bgA: string;
  bgB: string;
  bgC: string;
  text: string;
  muted: string;
  accent: string;
  accentSoft: string;
  glow: string;
} {
  if (/生活|温暖/.test(style)) {
    return {
      bgA: '#12231d',
      bgB: '#315446',
      bgC: '#f4c36f',
      text: '#fffaf0',
      muted: 'rgba(255,250,240,.72)',
      accent: '#f4a261',
      accentSoft: '#ffd59b',
      glow: 'rgba(244, 162, 97, .28)',
    };
  }
  if (/数据|大字报/.test(style)) {
    return {
      bgA: '#101114',
      bgB: '#263238',
      bgC: '#e9f5ff',
      text: '#f7fbff',
      muted: 'rgba(247,251,255,.70)',
      accent: '#00bcd4',
      accentSoft: '#9be7f2',
      glow: 'rgba(0, 188, 212, .25)',
    };
  }
  if (/社媒|快闪/.test(style)) {
    return {
      bgA: '#141217',
      bgB: '#342344',
      bgC: '#ffcf5c',
      text: '#fff8ec',
      muted: 'rgba(255,248,236,.72)',
      accent: '#ff4d6d',
      accentSoft: '#ffc2cd',
      glow: 'rgba(255, 77, 109, .25)',
    };
  }
  return {
    bgA: '#101114',
    bgB: '#20252a',
    bgC: '#f1e8dc',
    text: '#fff8ef',
    muted: 'rgba(255,248,239,.72)',
    accent: '#ff7043',
    accentSoft: '#ffd0b8',
    glow: 'rgba(255, 112, 67, .22)',
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHtmlAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

function wantsLocalTranscriptFallback(text: string): boolean {
  return /字幕|口播|transcript|talking[- ]?head|本地/i.test(text);
}

/** Spawn the agent, collect all stdout text, return when done. */
async function awaitAgentDone(
  handle: ReturnType<typeof spawnAgent>,
  timeoutMs = 120_000,
): Promise<{ exitCode: number; signal: NodeJS.Signals | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handle.done,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          handle.stop();
          reject(new Error(`Agent timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const AGENT_COMPATIBILITY_MODEL_CACHE = new Map<string, string>();

async function callAgentSimple(
  def: import('@html-video/runtime').AgentDef,
  prompt: string,
  cwd: string,
  model?: string,
  timeoutMs = 120_000,
): Promise<string> {
  const compatibilityKey = `${def.id}\u0000${model ?? '(config default)'}`;
  const effectiveModel = AGENT_COMPATIBILITY_MODEL_CACHE.get(compatibilityKey) ?? model;
  const invoke = async (selectedModel?: string): Promise<string> => {
    let buf = '';
    let agentError = '';
    const handle = spawnAgent({
      def,
      prompt,
      context: { cwd, ...(selectedModel && { model: selectedModel }) },
      onEvent: (ev) => {
        if (ev.type === 'text') buf += ev.chunk;
        else if (ev.type === 'error') agentError = ev.message;
      },
    });
    const exit = await awaitAgentDone(handle, timeoutMs);
    if (exit.exitCode !== 0) {
      throw new Error(agentError || `${def.name} exited with code ${exit.exitCode}`);
    }
    if (!buf.trim()) {
      throw new Error(`${def.name} exited successfully but returned no output`);
    }
    return buf;
  };

  try {
    return await invoke(effectiveModel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallbackModel = compatibleAgentModelForError(def.id, effectiveModel, message);
    if (!fallbackModel) throw error;
    AGENT_COMPATIBILITY_MODEL_CACHE.set(compatibilityKey, fallbackModel);
    process.stderr.write(
      `[studio:agent] ${def.id} model ${effectiveModel || '(config default)'} is incompatible with this CLI; retrying with ${fallbackModel}\n`,
    );
    return invoke(fallbackModel);
  }
}

export function compatibleAgentModelForError(
  agentId: string,
  requestedModel: string | undefined,
  errorMessage: string,
): string | undefined {
  const fallback = 'gpt-5.4';
  if (
    agentId === 'codex'
    && requestedModel !== fallback
    && /requires a newer version of Codex/i.test(errorMessage)
  ) {
    return fallback;
  }
  return undefined;
}

export function summarizeAgentFailure(errorMessage: string): string {
  const messages = Array.from(errorMessage.matchAll(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/g));
  const encoded = messages[messages.length - 1]?.[1];
  if (encoded) {
    try {
      const decoded = JSON.parse(`"${encoded}"`) as string;
      if (decoded.trim()) return decoded.trim().slice(0, 240);
    } catch {
      // Fall through to a plain-text summary.
    }
  }
  const meaningful = errorMessage
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^\d{4}-\d{2}-\d{2}T.*\bWARN\b/.test(line));
  return (meaningful[meaningful.length - 1] || errorMessage || 'unknown agent error').slice(0, 240);
}
