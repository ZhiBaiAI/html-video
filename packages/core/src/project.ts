/**
 * Project orchestrator: 单模板单视频工作流（RFC-05）。
 * - createProject
 * - addAsset / removeAsset
 * - setTemplate / setVariable / setVariables
 * - renderPreviewHtml: 调 EngineAdapter.renderToHtml() → HTML for iframe
 * - exportMp4: 调 EngineAdapter.render() → MP4 file
 */

import { randomUUID } from 'node:crypto';
import { join, basename } from 'node:path';
import type {
  Asset,
  EngineId,
  FrameRecord,
  Project,
  ProjectTalkingHeadAudioMode,
  ProjectStatus,
  TemplateMetadata,
  TemplateRef,
  TranscriptDocument,
} from './types/index.js';
import {
  type ContentGraph,
  validate as validateGraph,
  topoSort,
  DEFAULT_FRAME_DURATION_SEC,
} from '@html-video/content-graph';
import { HtmlVideoError } from './errors.js';
import type { AssetStore } from './asset-store.js';
import type { EngineRegistry, ProjectStore, TemplateRegistry } from './registry.js';

export interface CreateProjectInput {
  name: string;
  intent?: string;
  preferences?: Project['preferences'];
}

export interface ProjectOrchestratorDeps {
  projectRoot: string;
  engines: EngineRegistry;
  templates: TemplateRegistry;
  projects: ProjectStore;
  assets: AssetStore;
}

export class ProjectOrchestrator {
  constructor(private readonly deps: ProjectOrchestratorDeps) {}

  // ---------------- CRUD ----------------

  async create(input: CreateProjectInput): Promise<Project> {
    const id = `proj_${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    const project: Project = {
      id,
      name: input.name,
      ...(input.intent !== undefined && { intent: input.intent }),
      assets: [],
      templateId: null,
      variables: {},
      preferences: input.preferences ?? {},
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.projects.save(project);
    return project;
  }

  async list(): Promise<Project[]> {
    return this.deps.projects.list();
  }

  async load(id: string): Promise<Project> {
    return this.deps.projects.load(id);
  }

  async remove(id: string): Promise<void> {
    return this.deps.projects.remove(id);
  }

  // ---------------- Asset ops ----------------

  async addFileAsset(projectId: string, sourcePath: string, userCaption?: string): Promise<Project> {
    await this.deps.projects.ensureDir(projectId);
    const project = await this.deps.projects.load(projectId);
    const asset = await this.deps.assets.addFileAsset(projectId, sourcePath, [], userCaption);
    if (!project.assets.find((a) => a.id === asset.id)) {
      project.assets.push(asset);
    }
    project.status = downgradeStatus(project.status, 'draft');
    await this.deps.projects.save(project);
    return project;
  }

  async addInlineAsset(
    projectId: string,
    content: string,
    type: 'text' | 'data',
    userCaption?: string,
  ): Promise<Project> {
    await this.deps.projects.ensureDir(projectId);
    const project = await this.deps.projects.load(projectId);
    const asset = await this.deps.assets.addInlineAsset(projectId, content, type, [], userCaption);
    if (!project.assets.find((a) => a.id === asset.id)) {
      project.assets.push(asset);
    }
    project.status = downgradeStatus(project.status, 'draft');
    await this.deps.projects.save(project);
    return project;
  }

  /**
   * Store generated audio bytes (MP3 from MiniMax) as a project asset and
   * return the created Asset so the caller can reference it in `soundtrack`.
   * Unlike addFileAsset, this does NOT downgrade status — attaching a
   * soundtrack to an already-previewed video shouldn't invalidate the render.
   */
  async addBufferAsset(
    projectId: string,
    bytes: Buffer,
    ext: string,
    userCaption?: string,
  ): Promise<{ project: Project; asset: Asset }> {
    await this.deps.projects.ensureDir(projectId);
    const project = await this.deps.projects.load(projectId);
    const asset = await this.deps.assets.addBufferAsset(projectId, bytes, ext, [], userCaption);
    if (!project.assets.find((a) => a.id === asset.id)) {
      project.assets.push(asset);
    }
    await this.deps.projects.save(project);
    return { project, asset };
  }

  async removeAsset(projectId: string, assetId: string): Promise<Project> {
    const project = await this.deps.projects.load(projectId);
    project.assets = project.assets.filter((a) => a.id !== assetId);
    await this.deps.projects.save(project);
    return project;
  }

  async setTalkingHead(
    projectId: string,
    videoAssetId: string,
    opts: {
      enabled?: boolean;
      transcriptAssetId?: string;
      srtAssetId?: string;
      vttAssetId?: string;
      widthPct?: number;
      marginPx?: number;
      shape?: 'circle' | 'rounded-rect';
      radiusPx?: number;
      audioMode?: ProjectTalkingHeadAudioMode;
    } = {},
  ): Promise<Project> {
    const project = await this.deps.projects.load(projectId);
    const asset = project.assets.find((a) => a.id === videoAssetId);
    if (!asset || asset.type !== 'video') {
      throw new HtmlVideoError('invalid-input', `Video asset ${videoAssetId} not found`);
    }
    project.talkingHead = {
      enabled: opts.enabled ?? true,
      videoAssetId,
      ...(opts.transcriptAssetId !== undefined && { transcriptAssetId: opts.transcriptAssetId }),
      ...(opts.srtAssetId !== undefined && { srtAssetId: opts.srtAssetId }),
      ...(opts.vttAssetId !== undefined && { vttAssetId: opts.vttAssetId }),
      audioMode: opts.audioMode ?? project.talkingHead?.audioMode ?? 'synthetic',
      overlay: {
        position: 'bottom-right',
        widthPct: opts.widthPct ?? project.talkingHead?.overlay.widthPct ?? 15,
        marginPx: opts.marginPx ?? project.talkingHead?.overlay.marginPx ?? 72,
        shape: opts.shape ?? project.talkingHead?.overlay.shape ?? 'circle',
        radiusPx: opts.radiusPx ?? project.talkingHead?.overlay.radiusPx ?? 9999,
      },
    };
    await this.deps.projects.save(project);
    return project;
  }

  async setTalkingHeadAudioMode(projectId: string, audioMode: ProjectTalkingHeadAudioMode): Promise<Project> {
    const project = await this.deps.projects.load(projectId);
    if (!project.talkingHead) {
      throw new HtmlVideoError('invalid-input', 'Project has no talking-head video selected');
    }
    project.talkingHead.audioMode = audioMode;
    await this.deps.projects.save(project);
    return project;
  }

  async clearTalkingHead(projectId: string): Promise<Project> {
    const project = await this.deps.projects.load(projectId);
    delete project.talkingHead;
    await this.deps.projects.save(project);
    return project;
  }

  async transcribeTalkingHead(args: {
    projectId: string;
    videoAssetId: string;
    model?: string;
    language?: string;
  }): Promise<{
    project: Project;
    transcript: TranscriptDocument;
    transcriptPath: string;
    srtPath?: string;
    vttPath?: string;
  }> {
    let project = await this.setTalkingHead(args.projectId, args.videoAssetId);
    const video = project.assets.find((a) => a.id === args.videoAssetId);
    if (!video?.path) {
      throw new HtmlVideoError('asset-not-found', `Video asset ${args.videoAssetId} has no file path`);
    }
    const projectDir = await this.deps.projects.ensureDir(args.projectId);
    const out = await transcribeVideoWithLocalWhisper({
      videoPath: video.path,
      workDir: projectDir,
      videoAssetId: args.videoAssetId,
      model: args.model ?? 'tiny',
      ...(args.language !== undefined && { language: args.language }),
    });

    const transcriptAsset = await this.deps.assets.addFileAsset(
      args.projectId,
      out.transcriptPath,
      ['transcript'],
      'local Whisper transcript',
    );
    const srtAsset = out.srtPath
      ? await this.deps.assets.addFileAsset(args.projectId, out.srtPath, ['subtitle'], 'SRT subtitles')
      : undefined;
    const vttAsset = out.vttPath
      ? await this.deps.assets.addFileAsset(args.projectId, out.vttPath, ['subtitle'], 'VTT subtitles')
      : undefined;

    project = await this.deps.projects.load(args.projectId);
    for (const asset of [transcriptAsset, srtAsset, vttAsset].filter(Boolean) as Asset[]) {
      if (!project.assets.find((a) => a.id === asset.id)) project.assets.push(asset);
    }
    project.talkingHead = {
      ...(project.talkingHead ?? {
        enabled: true,
        videoAssetId: args.videoAssetId,
        audioMode: 'synthetic' as const,
        overlay: { position: 'bottom-right' as const, widthPct: 15, marginPx: 72, shape: 'circle' as const, radiusPx: 9999 },
      }),
      transcriptAssetId: transcriptAsset.id,
      ...(srtAsset !== undefined && { srtAssetId: srtAsset.id }),
      ...(vttAsset !== undefined && { vttAssetId: vttAsset.id }),
    };
    await this.deps.projects.save(project);
    return {
      project,
      transcript: out.transcript,
      transcriptPath: out.transcriptPath,
      ...(out.srtPath !== undefined && { srtPath: out.srtPath }),
      ...(out.vttPath !== undefined && { vttPath: out.vttPath }),
    };
  }

  // ---------------- Template / variables ----------------

  async setTemplate(projectId: string, templateId: string | null): Promise<Project> {
    const project = await this.deps.projects.load(projectId);
    if (templateId !== null && !this.deps.templates.has(templateId)) {
      throw new HtmlVideoError('template-not-found', `Template ${templateId} not found`);
    }
    project.templateId = templateId;
    // v0.3: variables are no longer the user-facing surface. Reset on every
    // template change so old keys don't bleed through into the new context.
    project.variables = {};
    project.status = downgradeStatus(project.status, 'draft');
    await this.deps.projects.save(project);
    return project;
  }

  async setVariables(projectId: string, vars: Record<string, unknown>): Promise<Project> {
    const project = await this.deps.projects.load(projectId);
    project.variables = vars;
    project.status = downgradeStatus(project.status, 'draft');
    await this.deps.projects.save(project);
    return project;
  }

  async setVariable(projectId: string, key: string, value: unknown): Promise<Project> {
    const project = await this.deps.projects.load(projectId);
    project.variables = { ...project.variables, [key]: value };
    project.status = downgradeStatus(project.status, 'draft');
    await this.deps.projects.save(project);
    return project;
  }

  async setAgent(projectId: string, agentId: string | null, agentModel?: string | null): Promise<Project> {
    const project = await this.deps.projects.load(projectId);
    project.agentId = agentId;
    // Only touch the model when explicitly provided; switching agent clears a
    // stale model unless a new one is given.
    if (agentModel !== undefined) project.agentModel = agentModel;
    else project.agentModel = null;
    await this.deps.projects.save(project);
    return project;
  }

  /**
   * v0.3 chat-to-HTML: write raw HTML produced by an agent into the project's preview slot.
   * Single-frame fast-path. Clears any prior multi-frame graph state.
   */
  async writePreviewHtmlRaw(projectId: string, html: string): Promise<{ project: Project; htmlPath: string }> {
    const project = await this.deps.projects.load(projectId);
    const projectDir = await this.deps.projects.ensureDir(projectId);
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const htmlPath = join(projectDir, 'preview.html');
    await writeFile(htmlPath, html, 'utf8');
    project.lastPreviewHtmlPath = htmlPath;
    // v0.8.2: only treat this as a "supersedes the storyboard" event for
    // truly fresh single-frame projects (no frames yet). For projects that
    // already have a storyboard, the single-frame raw write is treated as
    // an in-place inline edit on the active preview file — frames[] /
    // contentGraphPath are preserved so the user doesn't lose their
    // storyboard if they happen to use a single-frame iteration on a
    // multi-frame project. (Frame-specific in-place edits should go
    // through writeFrameHtml instead.)
    if ((project.frames?.length ?? 0) === 0) {
      project.frames = [];
      delete project.contentGraphPath;
    }
    if (project.status === 'draft') project.status = 'previewed';
    await this.deps.projects.save(project);
    return { project, htmlPath };
  }

  // ---------------- v0.8: ContentGraph + multi-frame ----------------

  /**
   * Persist a content graph alongside the project. Validates first, throws
   * on cycles / unknown edges / etc.
   */
  async writeContentGraph(
    projectId: string,
    graph: ContentGraph,
    opts: { preserveFrames?: boolean } = {},
  ): Promise<{ project: Project; graphPath: string }> {
    const result = validateGraph(graph);
    if (!result.ok) {
      throw new HtmlVideoError(
        'invalid-input',
        `ContentGraph invalid: ${result.errors.map((e) => e.message).join('; ')}`,
      );
    }
    const project = await this.deps.projects.load(projectId);
    const projectDir = await this.deps.projects.ensureDir(projectId);
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const graphPath = join(projectDir, 'content-graph.json');
    await writeFile(graphPath, JSON.stringify(graph, null, 2), 'utf8');
    project.contentGraphPath = graphPath;
    await mkdir(join(projectDir, 'frames'), { recursive: true });
    if (opts.preserveFrames) {
      // Editing an existing storyboard's metadata (e.g. re-pacing durations) —
      // keep the rendered frames, just sync each frame's durationSec from the
      // graph so export uses the new timing.
      const byId = new Map(graph.nodes.map((n) => [n.id, n.durationSec]));
      project.frames = (project.frames ?? []).map((f) => ({
        ...f,
        durationSec: byId.get(f.graphNodeId) ?? f.durationSec,
      }));
    } else {
      // Fresh graph → agent will re-emit per-frame HTML; drop stale frames.
      project.frames = [];
      if (project.status !== 'rendered') project.status = 'draft';
    }
    await this.deps.projects.save(project);
    return { project, graphPath };
  }

  /**
   * Read the persisted content graph. Returns null if none.
   */
  async readContentGraph(projectId: string): Promise<ContentGraph | null> {
    const project = await this.deps.projects.load(projectId);
    if (!project.contentGraphPath) return null;
    const { readFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    if (!existsSync(project.contentGraphPath)) return null;
    return JSON.parse(await readFile(project.contentGraphPath, 'utf8')) as ContentGraph;
  }

  /**
   * Write one frame's HTML to disk. Updates the project's frames[] list,
   * keeping play-order consistent with the graph's topo sort.
   *
   * Frame filenames follow `<order>-<nodeId>.html` for visual debuggability.
   */
  async writeFrameHtml(
    projectId: string,
    graphNodeId: string,
    html: string,
  ): Promise<{ project: Project; frame: FrameRecord }> {
    const project = await this.deps.projects.load(projectId);
    const graph = await this.readContentGraph(projectId);
    if (!graph) {
      throw new HtmlVideoError(
        'invalid-input',
        'Cannot write frame: project has no content graph yet',
      );
    }
    const order = topoSort(graph);
    const idx = order.indexOf(graphNodeId);
    if (idx === -1) {
      throw new HtmlVideoError(
        'invalid-input',
        `Graph node "${graphNodeId}" not found in content graph`,
      );
    }
    const node = graph.nodes.find((n) => n.id === graphNodeId)!;

    const projectDir = await this.deps.projects.ensureDir(projectId);
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const framesDir = join(projectDir, 'frames');
    await mkdir(framesDir, { recursive: true });
    const safeId = graphNodeId.replace(/[^a-z0-9_-]/gi, '_');
    const filename = `${String(idx + 1).padStart(2, '0')}-${safeId}.html`;
    const htmlPath = join(framesDir, filename);
    await writeFile(htmlPath, html, 'utf8');

    const frame: FrameRecord = {
      graphNodeId,
      htmlPath,
      durationSec: node.durationSec ?? DEFAULT_FRAME_DURATION_SEC,
      order: idx,
    };
    project.frames = (project.frames ?? []).filter((f) => f.graphNodeId !== graphNodeId);
    project.frames.push(frame);
    project.frames.sort((a, b) => a.order - b.order);
    // First frame becomes the project preview when no single-frame HTML exists.
    if (project.frames[0]?.graphNodeId === graphNodeId) {
      project.lastPreviewHtmlPath = htmlPath;
    }
    if (project.status === 'draft') project.status = 'previewed';
    await this.deps.projects.save(project);
    return { project, frame };
  }

  // ---------------- Render: preview HTML / export MP4 ----------------

  async renderPreviewHtml(projectId: string): Promise<{ project: Project; htmlPath: string }> {
    const project = await this.deps.projects.load(projectId);
    if (!project.templateId) {
      throw new HtmlVideoError('invalid-input', 'Project has no template selected');
    }
    const tmpl = this.deps.templates.get(project.templateId);
    const adapter = this.deps.engines.get(tmpl.engine);
    if (!adapter.renderToHtml) {
      throw new HtmlVideoError(
        'render-failed',
        `Engine ${tmpl.engine} adapter does not support renderToHtml()`,
      );
    }
    const projectDir = await this.deps.projects.ensureDir(projectId);

    const out = await adapter.renderToHtml(
      {
        template: templateRefFromMeta(tmpl),
        variables: project.variables,
        config: {
          format: 'mp4',
          resolution: project.preferences.resolution ?? { width: 1920, height: 1080 },
          fps: project.preferences.fps ?? 60,
          duration: 'auto',
          outputPath: join(projectDir, 'output.mp4'),
        },
      },
      { workDir: projectDir },
    );

    project.lastPreviewHtmlPath = out.htmlPath;
    project.lastPreviewPosterPath = out.posterPath;
    if (project.status === 'draft') project.status = 'previewed';
    await this.deps.projects.save(project);
    return { project, htmlPath: out.htmlPath };
  }

  async exportMp4(args: {
    projectId: string;
    outputPath?: string;
    onProgress?: (pct: number, stage: string) => void;
    signal?: AbortSignal;
  }): Promise<{ project: Project; outputPath: string }> {
    const project = await this.deps.projects.load(args.projectId);
    const projectDir = await this.deps.projects.ensureDir(project.id);
    // Unique per-export filename so repeated exports of the SAME project don't
    // overwrite each other (different projects already have separate dirs).
    // output.mp4 stays as a stable "latest" alias updated after each export.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const outputPath = args.outputPath ?? join(projectDir, `output-${stamp}.mp4`);

    // v0.8: multi-frame path. If the project has frames[] from a content graph,
    // render each frame's HTML to a per-frame MP4, then ffmpeg concat them.
    if (project.frames && project.frames.length > 0) {
      const ordered = [...project.frames].sort((a, b) => a.order - b.order);
      const tmpl = project.templateId ? this.deps.templates.get(project.templateId) : null;
      const projectEngine = tmpl?.engine ?? 'hyperframes';
      const frameMp4s: string[] = [];
      // Mixed engines across frames → the per-frame MP4s may carry different
      // h264 params (hyperframes' libx264 vs Remotion's encoder), so a stream
      // -c copy concat can stutter/corrupt. Re-encode the join in that case.
      const enginesUsed = new Set(ordered.map((f) => f.engine ?? projectEngine));
      const reencode = enginesUsed.size > 1;

      for (let i = 0; i < ordered.length; i++) {
        const f = ordered[i]!;
        const frameOut = join(projectDir, 'frames', `${String(i + 1).padStart(2, '0')}.mp4`);
        const { engine: frameEngine, templateRef } = this.resolveFrameTemplateRef(f, projectEngine);
        const adapter = this.deps.engines.get(frameEngine);
        await adapter.render(
          {
            template: templateRef,
            // Native data templates read `data` from variables; bridge/hyperframes
            // ignore it. Frame's own data (when enhanced) overrides project vars.
            variables: f.data !== undefined ? { ...project.variables, data: f.data } : project.variables,
            config: {
              format: 'mp4',
              resolution: project.preferences.resolution ?? { width: 1920, height: 1080 },
              fps: project.preferences.fps ?? 60,
              duration: f.durationSec,
              // The user set per-frame length on the format card — honor it as a
              // hard cap so one runaway animation can't stretch a 4s frame to ~30s.
              durationMode: 'explicit',
              outputPath: frameOut,
            },
          },
          {
            workDir: projectDir,
            ...(args.onProgress !== undefined && {
              onProgress: (pct, stage) =>
                args.onProgress!((i + pct / 100) / ordered.length * 100, `frame ${i + 1}/${ordered.length}: ${stage}`),
            }),
            ...(args.signal !== undefined && { signal: args.signal }),
          },
        );
        frameMp4s.push(frameOut);
      }

      await concatFramesWithFfmpeg(frameMp4s, outputPath, projectDir, {
        reencode,
        fps: project.preferences.fps ?? 60,
      });
      const totalDur = ordered.reduce((s, f) => s + (f.durationSec || 0), 0);
      if (project.talkingHead?.enabled) {
        await this.applyTalkingHead(project, outputPath, args.onProgress);
        if (resolveTalkingHeadAudioMode(project.talkingHead.audioMode) === 'original') {
          await this.applyTalkingHeadOriginalAudio(project, outputPath, args.onProgress);
        } else {
          await this.applySoundtrack(project, outputPath, totalDur, args.onProgress);
        }
      } else {
        await this.applySoundtrack(project, outputPath, totalDur, args.onProgress);
      }
      project.lastOutputMp4Path = outputPath;
      recordExport(project, outputPath);
      project.status = 'rendered';
      await this.deps.projects.save(project);
      return { project, outputPath };
    }

    // Single-frame fast path (v0.7 behaviour).
    if (!project.templateId) {
      throw new HtmlVideoError('invalid-input', 'Project has no template selected');
    }
    const tmpl = this.deps.templates.get(project.templateId);
    const adapter = this.deps.engines.get(tmpl.engine);

    await adapter.render(
      {
        template: templateRefFromMeta(tmpl),
        variables: project.variables,
        config: {
          format: 'mp4',
          resolution: project.preferences.resolution ?? { width: 1920, height: 1080 },
          fps: project.preferences.fps ?? 60,
          duration: 'auto',
          outputPath,
        },
      },
      {
        workDir: projectDir,
        ...(args.onProgress !== undefined && { onProgress: args.onProgress }),
        ...(args.signal !== undefined && { signal: args.signal }),
      },
    );
    if (project.talkingHead?.enabled) {
      await this.applyTalkingHead(project, outputPath, args.onProgress);
      if (resolveTalkingHeadAudioMode(project.talkingHead.audioMode) === 'original') {
        await this.applyTalkingHeadOriginalAudio(project, outputPath, args.onProgress);
      } else {
        await this.applySoundtrack(project, outputPath, undefined, args.onProgress);
      }
    } else {
      await this.applySoundtrack(project, outputPath, undefined, args.onProgress);
    }
    project.lastOutputMp4Path = outputPath;
    recordExport(project, outputPath);
    project.status = 'rendered';
    await this.deps.projects.save(project);
    return { project, outputPath };
  }

  /**
   * Resolve which engine + TemplateRef render a single frame. A frame that the
   * user has enhanced (engine='remotion' + nativeTemplateId) renders via the
   * native template's .tsx entry; otherwise it's the classic per-frame HTML on
   * the project's engine (hyperframes). The base `htmlPath` is always retained
   * on the frame so un-enhancing is non-destructive. (RFC-08/09)
   */
  private resolveFrameTemplateRef(
    f: FrameRecord,
    projectEngine: EngineId,
  ): { engine: EngineId; templateRef: TemplateRef } {
    if (f.engine === 'remotion' && f.nativeTemplateId) {
      const nt = this.deps.templates.get(f.nativeTemplateId);
      if (!nt.native?.compositionId) {
        throw new HtmlVideoError(
          'template-invalid',
          `Native template "${f.nativeTemplateId}" has no native.compositionId in its metadata`,
        );
      }
      if (!nt.__dir) {
        throw new HtmlVideoError(
          'template-invalid',
          `Native template "${f.nativeTemplateId}" has no __dir; was it loaded via TemplateRegistry?`,
        );
      }
      return {
        engine: 'remotion',
        templateRef: {
          id: `frame-${f.graphNodeId}`,
          engine: 'remotion',
          sourcePath: join(nt.__dir, nt.source_entry),
          mode: 'native',
          nativeCompositionId: nt.native.compositionId,
        },
      };
    }
    const engine = f.engine ?? projectEngine;
    return {
      engine,
      templateRef: { id: `frame-${f.graphNodeId}`, engine, sourcePath: f.htmlPath },
    };
  }

  /**
   * Enhance one data frame with a native engine template (the user-initiated
   * "motion enhancement" — RFC-08/09). Snapshots the source DataNode's `data`
   * onto the frame and points it at the native template. Asserts the node is a
   * `data` node and that its data fits the native template's expected shape, so
   * export doesn't later render NaN bars. The frame's `htmlPath` is untouched,
   * so {@link unenhanceFrame} fully reverts it.
   */
  async enhanceFrameNative(
    projectId: string,
    graphNodeId: string,
    nativeTemplateId: string,
  ): Promise<{ project: Project; frame: FrameRecord }> {
    const project = await this.deps.projects.load(projectId);
    const graph = await this.readContentGraph(projectId);
    if (!graph) {
      throw new HtmlVideoError('invalid-input', 'Project has no content graph');
    }
    const node = graph.nodes.find((n) => n.id === graphNodeId);
    if (!node) {
      throw new HtmlVideoError('invalid-input', `Graph node "${graphNodeId}" not found`);
    }
    if (node.kind !== 'data') {
      throw new HtmlVideoError(
        'invalid-input',
        `Frame "${graphNodeId}" is a ${node.kind} node; native data enhancement only applies to data frames`,
      );
    }
    const tmpl = this.deps.templates.get(nativeTemplateId); // throws if unknown
    if (tmpl.engine !== 'remotion' || !tmpl.native?.compositionId) {
      throw new HtmlVideoError(
        'invalid-input',
        `Template "${nativeTemplateId}" is not a native Remotion template`,
      );
    }
    const data = normalizeRollupData((node as { data?: unknown }).data);

    const frame = (project.frames ?? []).find((f) => f.graphNodeId === graphNodeId);
    if (!frame) {
      throw new HtmlVideoError(
        'invalid-input',
        `Frame "${graphNodeId}" has not been rendered yet (no FrameRecord)`,
      );
    }
    frame.engine = 'remotion';
    frame.nativeTemplateId = nativeTemplateId;
    frame.data = data;
    await this.deps.projects.save(project);
    return { project, frame };
  }

  /**
   * Revert a frame's native enhancement back to its base hyperframes HTML.
   * Clears the three enhance fields; `htmlPath` was never touched. (RFC-08/09)
   */
  async unenhanceFrame(
    projectId: string,
    graphNodeId: string,
  ): Promise<{ project: Project; frame: FrameRecord }> {
    const project = await this.deps.projects.load(projectId);
    const frame = (project.frames ?? []).find((f) => f.graphNodeId === graphNodeId);
    if (!frame) {
      throw new HtmlVideoError('invalid-input', `Frame "${graphNodeId}" not found`);
    }
    delete frame.engine;
    delete frame.nativeTemplateId;
    delete frame.data;
    delete frame.previewMp4Path; // stop advertising a now-stale preview video
    await this.deps.projects.save(project);
    return { project, frame };
  }

  /**
   * Render a single (enhanced) frame to a short MP4 for studio preview. A native
   * frame has no HTML to show in the iframe strip, so the studio renders it on
   * its own and plays the result as a <video>. Reuses {@link resolveFrameTemplateRef}
   * — the same per-frame engine/template resolution exportMp4 uses — so the
   * preview is pixel-identical to what the final export will stitch in.
   *
   * Writes to `frames/<order>.preview.mp4` (distinct from export's `frames/NN.mp4`
   * so the two never overwrite each other). No soundtrack mux — a per-frame
   * preview is silent and faster. Sets `frame.previewMp4Path` and saves (bumping
   * `updatedAt`, which the studio uses as the <video> cache-bust token).
   */
  async renderFrameNativePreview(args: {
    projectId: string;
    graphNodeId: string;
    onProgress?: (pct: number, stage: string) => void;
    signal?: AbortSignal;
  }): Promise<{ project: Project; frame: FrameRecord; previewPath: string }> {
    const project = await this.deps.projects.load(args.projectId);
    const projectDir = await this.deps.projects.ensureDir(project.id);
    const frame = (project.frames ?? []).find((f) => f.graphNodeId === args.graphNodeId);
    if (!frame) {
      throw new HtmlVideoError('invalid-input', `Frame "${args.graphNodeId}" not found`);
    }
    const tmpl = project.templateId ? this.deps.templates.get(project.templateId) : null;
    const projectEngine = tmpl?.engine ?? 'hyperframes';
    const { engine, templateRef } = this.resolveFrameTemplateRef(frame, projectEngine);
    const adapter = this.deps.engines.get(engine);

    const previewPath = join(projectDir, 'frames', `${String(frame.order + 1).padStart(2, '0')}.preview.mp4`);
    await adapter.render(
      {
        template: templateRef,
        variables: frame.data !== undefined ? { ...project.variables, data: frame.data } : project.variables,
        config: {
          format: 'mp4',
          resolution: project.preferences.resolution ?? { width: 1920, height: 1080 },
          fps: project.preferences.fps ?? 60,
          duration: frame.durationSec,
          durationMode: 'explicit',
          outputPath: previewPath,
        },
      },
      {
        workDir: projectDir,
        ...(args.onProgress !== undefined && { onProgress: args.onProgress }),
        ...(args.signal !== undefined && { signal: args.signal }),
      },
    );

    frame.previewMp4Path = previewPath;
    await this.deps.projects.save(project);
    return { project, frame, previewPath };
  }

  /**
   * If the project has synthesized narration, mux it into the
   * just-rendered video at `outputPath`. Renders to a temp file then renames
   * over the original. No-op when there's no narration. Audio generation
   * never depends on ffmpeg — only this export-time mux does.
   */
  private async applySoundtrack(
    project: Project,
    outputPath: string,
    videoDurationSec: number | undefined,
    onProgress?: (pct: number, stage: string) => void,
  ): Promise<void> {
    const st = project.soundtrack;
    if (!st?.narrationAssetId) return;

    const findPath = (id?: string): string | undefined =>
      id ? project.assets.find((a) => a.id === id)?.path : undefined;
    const narrationPath = findPath(st.narrationAssetId);
    if (!narrationPath) return; // referenced asset is gone

    onProgress?.(99, 'mixing audio');
    const { rename } = await import('node:fs/promises');
    const tmpOut = `${outputPath}.muxed.mp4`;
    await muxAudioWithFfmpeg({
      videoPath: outputPath,
      outputPath: tmpOut,
      narrationPath,
      ...(st.narrationVolumeDb !== undefined && { narrationVolumeDb: st.narrationVolumeDb }),
    });
    await rename(tmpOut, outputPath);
  }

  private async applyTalkingHeadOriginalAudio(
    project: Project,
    outputPath: string,
    onProgress?: (pct: number, stage: string) => void,
  ): Promise<void> {
    const th = project.talkingHead;
    if (!th?.enabled) return;
    const videoPath = project.assets.find((a) => a.id === th.videoAssetId)?.path;
    if (!videoPath) return;
    onProgress?.(99, 'using original talking-head audio');
    const { rename } = await import('node:fs/promises');
    const tmpOut = `${outputPath}.source-audio.mp4`;
    await muxOriginalAudioWithFfmpeg({
      videoPath: outputPath,
      audioSourcePath: videoPath,
      outputPath: tmpOut,
    });
    await rename(tmpOut, outputPath);
  }

  private async applyTalkingHead(
    project: Project,
    outputPath: string,
    onProgress?: (pct: number, stage: string) => void,
  ): Promise<void> {
    const th = project.talkingHead;
    if (!th?.enabled) return;
    const videoPath = project.assets.find((a) => a.id === th.videoAssetId)?.path;
    if (!videoPath) {
      throw new HtmlVideoError('asset-not-found', `Talking-head video asset ${th.videoAssetId} has no file path`);
    }
    onProgress?.(99, 'overlaying talking-head video');
    const { readFile, rename, writeFile } = await import('node:fs/promises');
    const tmpOut = `${outputPath}.talking-head.mp4`;
    const outputWidth = project.preferences.resolution?.width ?? 1920;
    const outputHeight = project.preferences.resolution?.height ?? 1080;
    const overlayWidthPct = th.overlay.widthPct ?? 15;
    const overlayMarginPx = th.overlay.marginPx ?? 72;
    let subtitlesPath: string | undefined;
    const transcriptPath = project.assets.find((a) => a.id === th.transcriptAssetId)?.path;
    if (transcriptPath && await ffmpegSupportsFilter('subtitles')) {
      try {
        const transcript = JSON.parse(await readFile(transcriptPath, 'utf8')) as TranscriptDocument;
        if (transcript.segments.length > 0) {
          subtitlesPath = `${outputPath}.talking-head.ass`;
          await writeFile(subtitlesPath, renderTalkingHeadAssSubtitles(transcript, {
            width: outputWidth,
            height: outputHeight,
            overlayWidth: Math.max(150, Math.round(outputWidth * (overlayWidthPct / 100))),
            marginPx: overlayMarginPx,
          }), 'utf8');
        }
      } catch {
        // Subtitle burn-in is best-effort; export should still succeed with PiP/audio.
      }
    }
    await overlayTalkingHeadWithFfmpeg({
      baseVideoPath: outputPath,
      talkingHeadPath: videoPath,
      outputPath: tmpOut,
      outputWidth,
      widthPct: overlayWidthPct,
      marginPx: overlayMarginPx,
      shape: th.overlay.shape ?? 'circle',
      ...(subtitlesPath !== undefined && { subtitlesPath }),
    });
    await rename(tmpOut, outputPath);
  }
}

// ---------------------------------------------------------------------------
// ffmpeg concat helper
// ---------------------------------------------------------------------------

/**
 * Coerce a content-graph DataNode's free-form `data` into the shape the native
 * frame-data-rollup template expects ({ title?, unit?, items: {label,value}[] }).
 * DataNode.data is `unknown`, so an enhanced frame could otherwise feed NaN bars
 * to the renderer. Accepts either the already-shaped object or a bare array of
 * {label,value}. Throws a clear error rather than rendering garbage.
 */
function normalizeRollupData(raw: unknown): { title?: string; unit?: string; items: { label: string; value: number }[] } {
  const asItems = (arr: unknown): { label: string; value: number }[] => {
    if (!Array.isArray(arr)) {
      throw new HtmlVideoError(
        'invalid-input',
        'Data frame has no `items` array to animate; expected {items:[{label,value}]}',
      );
    }
    const items = arr
      .map((it) => {
        const o = (it ?? {}) as Record<string, unknown>;
        const label = String(o.label ?? o.name ?? '');
        const value = Number(o.value ?? o.y ?? o.count);
        return { label, value };
      })
      .filter((it) => it.label !== '' && Number.isFinite(it.value));
    if (items.length === 0) {
      throw new HtmlVideoError(
        'invalid-input',
        'Data frame items had no usable {label, numeric value} pairs',
      );
    }
    return items;
  };

  if (Array.isArray(raw)) return { items: asItems(raw) };
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: { title?: string; unit?: string; items: { label: string; value: number }[] } = {
    items: asItems(o.items),
  };
  if (typeof o.title === 'string') out.title = o.title;
  if (typeof o.unit === 'string') out.unit = o.unit;
  return out;
}

/**
 * Concatenate per-frame MP4 files into a single output with ffmpeg.
 *
 * Two strategies:
 *  - Single-engine (default): the concat **demuxer** with `-c copy`. All frames
 *    came from one engine so their h264 streams are byte-compatible — fast, no
 *    re-encode.
 *  - Mixed-engine (`opts.reencode`): a hyperframes frame next to a native
 *    Remotion frame can differ in profile/GOP/**timebase**. The concat demuxer
 *    assumes continuous timestamps across segments and mis-accumulates the
 *    Remotion segment's PTS, ballooning the total duration. So we feed each
 *    segment as an independent input and join with the concat **filter**, which
 *    rebuilds a clean timeline, then re-encode to a uniform h264.
 *
 * Requires `ffmpeg` on PATH. Throws with a friendly hint if missing.
 */
async function concatFramesWithFfmpeg(
  frameMp4s: string[],
  outputPath: string,
  workDir: string,
  opts: { reencode?: boolean; fps?: number } = {},
): Promise<void> {
  if (frameMp4s.length === 0) {
    throw new HtmlVideoError('render-failed', 'No frames to concat');
  }
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');

  const fps = opts.fps ?? 60;
  let ffmpegArgs: string[];

  if (opts.reencode) {
    // concat FILTER: independent `-i` per segment + filter rebuilds the timeline.
    const n = frameMp4s.length;
    const inputs = frameMp4s.flatMap((p) => ['-i', p]);
    const filter = `${frameMp4s.map((_, i) => `[${i}:v]`).join('')}concat=n=${n}:v=1:a=0[v]`;
    ffmpegArgs = [
      '-y',
      ...inputs,
      '-filter_complex', filter,
      '-map', '[v]',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-r', String(fps),
      '-movflags', '+faststart',
      outputPath,
    ];
  } else {
    // concat DEMUXER + stream copy: needs the list file.
    const listPath = join(workDir, 'frames', 'concat.txt');
    const list = frameMp4s.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    await writeFile(listPath, list, 'utf8');
    ffmpegArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath];
  }

  await new Promise<void>((resolveFn, reject) => {
    const proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new HtmlVideoError(
            'render-failed',
            'ffmpeg not found on PATH. Install with `brew install ffmpeg` (macOS) or your platform equivalent.',
          ),
        );
      } else {
        reject(err);
      }
    });
    proc.on('exit', (code: number | null) => {
      if (code === 0) resolveFn();
      else
        reject(
          new HtmlVideoError(
            'render-failed',
            `ffmpeg concat exited with code ${code}: ${stderr.slice(-2000)}`,
          ),
        );
    });
  });
}

/**
 * Mix a synthesized narration track into a video file, writing the result to
 * `outputPath`. Video is stream-copied (no re-encode); audio is encoded to AAC.
 *
 * `videoPath` and `outputPath` must differ. Throws HtmlVideoError on ffmpeg
 * failure; a missing ffmpeg yields the same friendly hint as concat.
 */
async function muxAudioWithFfmpeg(args: {
  videoPath: string;
  outputPath: string;
  narrationPath: string;
  narrationVolumeDb?: number;
}): Promise<void> {
  const { spawn } = await import('node:child_process');
  const narrVol = args.narrationVolumeDb ?? 0;

  const ffArgs = [
    '-y',
    '-i', args.videoPath,
    '-i', args.narrationPath,
    '-filter_complex', `[1:a]volume=${narrVol}dB[aout]`,
    '-map', '0:v',
    '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    args.outputPath,
  ];

  await new Promise<void>((resolveFn, reject) => {
    const proc = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new HtmlVideoError(
          'render-failed',
          'ffmpeg not found on PATH. Install with `brew install ffmpeg` (macOS) or your platform equivalent.',
        ));
      } else {
        reject(err);
      }
    });
    proc.on('exit', (code: number | null) => {
      if (code === 0) resolveFn();
      else reject(new HtmlVideoError('render-failed', `ffmpeg audio mux exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

async function muxOriginalAudioWithFfmpeg(args: {
  videoPath: string;
  audioSourcePath: string;
  outputPath: string;
}): Promise<void> {
  await runFfmpeg([
    '-y',
    '-i', args.videoPath,
    '-i', args.audioSourcePath,
    '-map', '0:v',
    '-map', '1:a?',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    args.outputPath,
  ], 'talking-head original audio mux');
}

function resolveTalkingHeadAudioMode(mode: ProjectTalkingHeadAudioMode | undefined): 'synthetic' | 'original' {
  return mode === 'original' ? 'original' : 'synthetic';
}

async function overlayTalkingHeadWithFfmpeg(args: {
  baseVideoPath: string;
  talkingHeadPath: string;
  outputPath: string;
  outputWidth: number;
  widthPct: number;
  marginPx: number;
  shape: 'circle' | 'rounded-rect';
  subtitlesPath?: string;
}): Promise<void> {
  const runOverlay = (subtitlesPath?: string, label = 'talking-head overlay') => runFfmpeg([
    '-y',
    '-i', args.baseVideoPath,
    '-i', args.talkingHeadPath,
    '-filter_complex', buildTalkingHeadOverlayFilter({ ...args, subtitlesPath }),
    '-map', '[vout]',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    args.outputPath,
  ], label);

  try {
    await runOverlay(args.subtitlesPath);
  } catch (error) {
    if (!args.subtitlesPath || !isSubtitleFilterFailure(error)) throw error;
    await runOverlay(undefined, 'talking-head overlay without subtitles');
  }
}

function buildTalkingHeadOverlayFilter(args: {
  outputWidth: number;
  widthPct: number;
  marginPx: number;
  shape: 'circle' | 'rounded-rect';
  subtitlesPath?: string;
}): string {
  const overlayWidth = Math.max(150, Math.round(args.outputWidth * (args.widthPct / 100)));
  const margin = Math.max(0, Math.round(args.marginPx));
  const baseLabel = args.subtitlesPath ? 'baseSub' : '0:v';
  const subtitleFilter = args.subtitlesPath
    ? `[0:v]subtitles=filename='${escapeFfmpegFilterPath(args.subtitlesPath)}'[baseSub];`
    : '';
  const overlayFilter = args.shape === 'circle'
    ? [
        `[1:v]scale=${overlayWidth}:${overlayWidth}:force_original_aspect_ratio=increase,crop=${overlayWidth}:${overlayWidth},setsar=1,format=rgb24[th0]`,
        `nullsrc=s=${overlayWidth}x${overlayWidth},format=gray,geq=lum='if(lte((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2),(W/2)*(W/2)),255,0)'[mask]`,
        `[th0][mask]alphamerge[th]`,
        `[${baseLabel}][th]overlay=W-w-${margin}:H-h-${margin}:eof_action=pass[vout]`,
      ].join(';')
    : [
        `[1:v]scale=${overlayWidth}:-2,format=rgba[th]`,
        `[${baseLabel}][th]overlay=W-w-${margin}:H-h-${margin}:eof_action=pass[vout]`,
      ].join(';');
  return `${subtitleFilter}${overlayFilter}`;
}

function isSubtitleFilterFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("No such filter: 'subtitles'")
    || message.includes('No option name near')
    || message.includes('Error parsing filterchain')
    || message.includes('Error parsing a filter description');
}

function renderTalkingHeadAssSubtitles(
  transcript: TranscriptDocument,
  args: { width: number; height: number; overlayWidth: number; marginPx: number },
): string {
  const fontSize = Math.max(34, Math.round(args.width * 0.03));
  const marginL = Math.max(64, Math.round(args.width * 0.05));
  const marginR = Math.max(marginL, args.overlayWidth + args.marginPx + 56);
  const marginV = Math.max(72, Math.round(args.height * 0.075));
  const events = transcript.segments
    .filter((seg) => seg.text.trim().length > 0 && seg.endSec > seg.startSec)
    .map((seg) => `Dialogue: 0,${assTime(seg.startSec)},${assTime(seg.endSec)},Default,,0,0,0,,${escapeAssText(wrapSubtitleText(seg.text.trim()))}`)
    .join('\n');
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${args.width}
PlayResY: ${args.height}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&HCC000000,&H99000000,-1,0,0,0,100,100,0,0,1,4,1.5,2,${marginL},${marginR},${marginV},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
${events}
`;
}

function assTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const centis = Math.floor((safe - Math.floor(safe)) * 100);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}

function wrapSubtitleText(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= 24) return compact;
  const splitAt = Math.min(26, Math.max(16, Math.floor(compact.length / 2)));
  return `${compact.slice(0, splitAt)}\n${compact.slice(splitAt)}`;
}

function escapeAssText(text: string): string {
  return text
    .replace(/[{}]/g, '')
    .replace(/\n/g, '\\N');
}

function escapeFfmpegFilterPath(path: string): string {
  return path
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

const ffmpegFilterSupportCache = new Map<string, Promise<boolean>>();

function ffmpegSupportsFilter(name: string): Promise<boolean> {
  const cached = ffmpegFilterSupportCache.get(name);
  if (cached) return cached;
  const result = new Promise<boolean>((resolveFn) => {
    import('node:child_process')
      .then(({ spawn }) => {
        const proc = spawn('ffmpeg', ['-hide_banner', '-filters'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
        proc.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
        proc.on('error', () => resolveFn(false));
        proc.on('exit', (code: number | null) => {
          if (code !== 0) {
            resolveFn(false);
            return;
          }
          resolveFn(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(output));
        });
      })
      .catch(() => resolveFn(false));
  });
  ffmpegFilterSupportCache.set(name, result);
  return result;
}

async function transcribeVideoWithLocalWhisper(args: {
  videoPath: string;
  workDir: string;
  videoAssetId: string;
  model: string;
  language?: string;
}): Promise<{
  transcript: TranscriptDocument;
  transcriptPath: string;
  srtPath?: string;
  vttPath?: string;
}> {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');

  const outDir = join(args.workDir, 'transcripts');
  await mkdir(outDir, { recursive: true });
  const base = `talking-head-${args.videoAssetId.slice(0, 10)}`;
  const wavPath = join(outDir, `${base}.wav`);
  await runFfmpeg([
    '-y',
    '-i', args.videoPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    wavPath,
  ], 'extract audio for Whisper');

  const whisperArgs = [
    wavPath,
    '--model', args.model,
    '--output_dir', outDir,
    '--output_format', 'all',
    '--fp16', 'False',
  ];
  if (args.language) whisperArgs.push('--language', args.language);

  await new Promise<void>((resolveFn, reject) => {
    const proc = spawn('whisper', whisperArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new HtmlVideoError(
          'render-failed',
          'Local Whisper CLI not found on PATH. Install openai-whisper and make sure `whisper` is available.',
        ));
      } else {
        reject(err);
      }
    });
    proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) resolveFn();
      else {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        reject(new HtmlVideoError('render-failed', `whisper exited with ${reason}: ${stderr.slice(-2000)}`));
      }
    });
  });

  const rawJsonPath = join(outDir, `${base}.json`);
  if (!existsSync(rawJsonPath)) {
    throw new HtmlVideoError('render-failed', `Whisper did not produce JSON output at ${rawJsonPath}`);
  }
  const raw = JSON.parse(await readFile(rawJsonPath, 'utf8')) as {
    text?: string;
    language?: string;
    segments?: Array<{
      start?: number;
      end?: number;
      text?: string;
      words?: Array<{ start?: number; end?: number; word?: string; text?: string }>;
    }>;
  };
  const transcript: TranscriptDocument = {
    text: String(raw.text ?? '').trim(),
    ...(typeof raw.language === 'string' && { language: raw.language }),
    segments: (raw.segments ?? []).map((seg) => ({
      startSec: Number(seg.start ?? 0),
      endSec: Number(seg.end ?? 0),
      text: String(seg.text ?? '').trim(),
      ...(Array.isArray(seg.words) && {
        words: seg.words.map((w) => ({
          startSec: Number(w.start ?? 0),
          endSec: Number(w.end ?? 0),
          text: String(w.word ?? w.text ?? '').trim(),
        })),
      }),
    })),
    source: {
      kind: 'local-whisper',
      model: args.model,
      videoAssetId: args.videoAssetId,
    },
  };
  const transcriptPath = join(outDir, `${base}.transcript.json`);
  await writeFile(transcriptPath, JSON.stringify(transcript, null, 2), 'utf8');
  const srtPath = existsSync(join(outDir, `${base}.srt`)) ? join(outDir, `${base}.srt`) : undefined;
  const vttPath = existsSync(join(outDir, `${base}.vtt`)) ? join(outDir, `${base}.vtt`) : undefined;
  return {
    transcript,
    transcriptPath,
    ...(srtPath !== undefined && { srtPath }),
    ...(vttPath !== undefined && { vttPath }),
  };
}

async function runFfmpeg(args: string[], label: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolveFn, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new HtmlVideoError(
          'render-failed',
          'ffmpeg not found on PATH. Install with `brew install ffmpeg` (macOS) or your platform equivalent.',
        ));
      } else {
        reject(err);
      }
    });
    proc.on('exit', (code: number | null) => {
      if (code === 0) resolveFn();
      else reject(new HtmlVideoError('render-failed', `ffmpeg ${label} exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

/**
 * Probe the real playback duration (seconds) of an audio/video file with
 * ffprobe. Returns NaN if ffprobe is unavailable or the file has no duration,
 * so callers can fall back to a heuristic (e.g. chars-per-second) instead of
 * crashing. Mirrors {@link runFfmpeg}'s spawn + ENOENT handling.
 */
export async function probeMediaDurationSec(path: string): Promise<number> {
  const { spawn } = await import('node:child_process');
  const stdout = await new Promise<string>((resolveFn, reject) => {
    // ffprobe prints a key=duration=NN.NNNNNN line to stdout.
    const proc = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') resolveFn(''); // ffprobe missing → NaN downstream
      else reject(err);
    });
    proc.on('exit', (code: number | null) => {
      if (code === 0) resolveFn(out);
      else resolveFn(''); // treat any probe failure as "unknown" → fall back
    });
  });
  const n = Number.parseFloat(stdout.trim());
  return Number.isFinite(n) ? n : NaN;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Append this export to the project's history (newest last, de-duped by path,
 *  capped so it doesn't grow unbounded). */
function recordExport(project: Project, outputPath: string): void {
  const list = (project.exports ?? []).filter((e) => e.path !== outputPath);
  list.push({ path: outputPath, filename: basename(outputPath), createdAt: new Date().toISOString() });
  // Keep the most recent 20.
  project.exports = list.slice(-20);
}

function templateRefFromMeta(meta: TemplateMetadata) {
  if (!meta.__dir) {
    throw new HtmlVideoError(
      'template-invalid',
      `Template ${meta.id} has no __dir set; was it loaded via TemplateRegistry?`,
    );
  }
  return {
    id: meta.id,
    engine: meta.engine,
    sourcePath: join(meta.__dir, meta.source_entry),
  };
}

function downgradeStatus(current: ProjectStatus, target: ProjectStatus): ProjectStatus {
  // After any modification, status should not be more advanced than 'draft'/given target.
  // 'rendered' / 'previewed' get demoted back to 'draft' on any meaningful change.
  if (target === 'draft') return 'draft';
  return current;
}
