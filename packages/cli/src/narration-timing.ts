export interface FrameMotionTiming {
  durationSec: number;
  enterStartSec: number;
  enterDurationSec: number;
  buildEndSec: number;
  breatheDurationSec: number;
  resolveStartSec: number;
  resolveDurationSec: number;
  staggerSec: number;
  ambientCycleSec: number;
  ambientIterations: number;
}

const round = (value: number, digits = 2): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

/**
 * A deterministic build → breathe → resolve plan for one video frame.
 * Entrances stay brisk on long shots; extra time is assigned to the readable
 * middle section instead of slowing every animation proportionally.
 */
export function planFrameMotionTiming(durationSec: number, cueCount = 4): FrameMotionTiming {
  const duration = Math.max(0.8, Number.isFinite(durationSec) ? durationSec : 3);
  const enterStart = clamp(duration * 0.035, 0.1, 0.28);
  const buildEnd = Math.min(
    duration * 0.36,
    enterStart + clamp(duration * 0.25, 0.6, 2.4),
  );
  const resolveDuration = clamp(duration * 0.16, 0.35, 1.4);
  const resolveStart = Math.max(buildEnd, duration - resolveDuration);
  const breatheDuration = Math.max(0, resolveStart - buildEnd);
  const enterDuration = clamp((buildEnd - enterStart) * 0.48, 0.32, 0.9);
  const cues = Math.max(1, Math.floor(cueCount));
  const stagger = cues <= 1
    ? 0
    : clamp((buildEnd - enterStart - enterDuration) / (cues - 1), 0.04, 0.18);
  const ambientIterations = breatheDuration >= 1.2
    ? Math.max(1, Math.min(4, Math.floor(breatheDuration / 2.2)))
    : 0;
  const ambientCycle = ambientIterations > 0
    ? breatheDuration / ambientIterations
    : 0;

  return {
    durationSec: round(duration),
    enterStartSec: round(enterStart),
    enterDurationSec: round(enterDuration),
    buildEndSec: round(buildEnd),
    breatheDurationSec: round(breatheDuration),
    resolveStartSec: round(resolveStart),
    resolveDurationSec: round(duration - resolveStart),
    staggerSec: round(stagger),
    ambientCycleSec: round(ambientCycle),
    ambientIterations,
  };
}

/** Estimated spoken time including punctuation pauses, used only without audio. */
export function estimateNarrationSeconds(text: string): number {
  const source = text.trim();
  if (!source) return 0;
  const cjk = (source.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).length;
  const latinWords = (source.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? []).length;
  const clausePauses = (source.match(/[，,、；;：:]/g) ?? []).length;
  const sentencePauses = (source.match(/[。！？!?]/g) ?? []).length;
  const other = source
    .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, '')
    .replace(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g, '')
    .replace(/\s|[，,、；;：:。！？!?]/g, '').length;
  return Math.max(0.5, cjk * 0.22 + latinWords * 0.38 + other * 0.16 + clausePauses * 0.18 + sentencePauses * 0.36);
}

/**
 * Split a known narration duration across frames at 0.1s precision. Natural
 * punctuation pauses are included, the rounded total is preserved exactly,
 * and a 2s floor is applied whenever the audio is long enough to support it.
 */
export function allocateNarrationDurations(
  segments: string[],
  totalDurationSec: number,
  minimumFrameSec = 2,
): number[] {
  if (segments.length === 0) return [];
  const weights = segments.map((segment) => Math.max(0.1, estimateNarrationSeconds(segment)));
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const requestedTotal = Number.isFinite(totalDurationSec) && totalDurationSec > 0
    ? totalDurationSec
    : Math.max(minimumFrameSec * segments.length, weightTotal);
  const targetTicks = Math.max(segments.length, Math.round(requestedTotal * 10));
  const minimumTicks = Math.min(
    Math.max(1, Math.round(minimumFrameSec * 10)),
    Math.floor(targetTicks / segments.length),
  );
  const remainingTicks = targetTicks - minimumTicks * segments.length;
  const rawExtras = weights.map((weight) => (weight / weightTotal) * remainingTicks);
  const extras = rawExtras.map(Math.floor);
  let unassigned = remainingTicks - extras.reduce((sum, value) => sum + value, 0);
  const order = rawExtras
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < unassigned; i++) extras[order[i % order.length]!.index]! += 1;
  return extras.map((extra) => round((minimumTicks + extra) / 10, 1));
}

export function renderFrameMotionTimingPrompt(durationSec: number, cueCount = 4): string {
  const t = planFrameMotionTiming(durationSec, cueCount);
  return [
    `FRAME TIMING (REQUIRED, ${t.durationSec.toFixed(2)}s total):`,
    `- Build ${t.enterStartSec.toFixed(2)}-${t.buildEndSec.toFixed(2)}s: reveal the hierarchy with brisk entrances (~${t.enterDurationSec.toFixed(2)}s each, max stagger ${t.staggerSec.toFixed(2)}s).`,
    `- Breathe ${t.buildEndSec.toFixed(2)}-${t.resolveStartSec.toFixed(2)}s: keep text readable; use at most ${t.ambientIterations} finite subtle ambient cycle(s), never an infinite loop.`,
    `- Resolve ${t.resolveStartSec.toFixed(2)}-${t.durationSec.toFixed(2)}s: settle emphasis or prepare the cut without hiding the key message early.`,
    `Use the injected CSS variables --hv-enter-start, --hv-enter-duration, --hv-build-end, --hv-breathe-duration, --hv-resolve-start, --hv-resolve-duration, --hv-stagger, and --hv-ambient-cycle for animation timing. Do not redeclare them.`,
    `Mark animation roles with data-hv-motion="entrance", "ambient", or "resolve". Long shots add readable dwell/finite ambient change; do not stretch entrance animations across the whole shot.`,
  ].join('\n');
}

/** Inject authoritative variables so a later narration re-fit can retime HTML. */
export function applyFrameMotionTiming(html: string, durationSec: number, cueCount = 4): string {
  const t = planFrameMotionTiming(durationSec, cueCount);
  const style = `<style id="hv-motion-timing">
:root {
  --hv-frame-duration: ${t.durationSec}s;
  --hv-enter-start: ${t.enterStartSec}s;
  --hv-enter-duration: ${t.enterDurationSec}s;
  --hv-build-end: ${t.buildEndSec}s;
  --hv-breathe-duration: ${t.breatheDurationSec}s;
  --hv-resolve-start: ${t.resolveStartSec}s;
  --hv-resolve-duration: ${t.resolveDurationSec}s;
  --hv-stagger: ${t.staggerSec}s;
  --hv-ambient-cycle: ${Math.max(0.01, t.ambientCycleSec)}s;
  --hv-ambient-iterations: ${t.ambientIterations};
}
</style>`;
  let output = html.replace(/<style\s+id=["']hv-motion-timing["'][^>]*>[\s\S]*?<\/style>\s*/i, '');
  output = output.replace(/<html([^>]*)>/i, (_match, attrs: string) => {
    const cleanAttrs = attrs.replace(/\sdata-hv-duration=["'][^"']*["']/i, '');
    return `<html${cleanAttrs} data-hv-duration="${t.durationSec}">`;
  });
  if (/<\/head>/i.test(output)) return output.replace(/<\/head>/i, `${style}\n</head>`);
  return `${style}\n${output}`;
}
