/**
 * @html-video/core — Public API surface.
 */

export * from './types/index.js';
export { HtmlVideoError } from './errors.js';
export type { ErrorCode } from './errors.js';
export { AssetStore } from './asset-store.js';
export type { AssetStoreOptions } from './asset-store.js';
export { EngineRegistry, TemplateRegistry, ProjectStore } from './registry.js';
export { ProjectOrchestrator } from './project.js';
export { probeMediaDurationSec } from './project.js';
export type {
  CreateProjectInput,
  ProjectOrchestratorDeps,
} from './project.js';
export {
  resolveMinimaxCredentials,
  generateTts,
} from './minimax.js';
export type { MinimaxCredentials, MinimaxAudioResult } from './minimax.js';
export {
  BAILIAN_COSYVOICE_TTS_MODELS,
  cloneBailianCosyVoice,
  generateBailianTts,
  resolveBailianCredentials,
} from './bailian.js';
export type {
  BailianCosyVoiceTtsModel,
  BailianCredentials,
  BailianVoiceCloneResult,
} from './bailian.js';
