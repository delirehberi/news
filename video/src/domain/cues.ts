import { z } from 'zod';
import type { WordTiming } from './captions.ts';
import { VIDEO_FPS } from './timeline.ts';

export const DEFAULT_MIN_DWELL_FRAMES = 45; // 1.5s at 30fps
export const DEFAULT_TRANSITION_FRAMES = 24; // 0.8s at 30fps
export const DEFAULT_MIN_BACKWARD_JUMP_FRAMES = 60; // 2.0s at 30fps
export const DEFAULT_SCENE_DURATION_FRAMES = 180; // 6.0s at 30fps
export const DEFAULT_VIEWPORT_WIDTH = 1440;
export const DEFAULT_VIEWPORT_HEIGHT = 900;
export const DEFAULT_MAX_ZOOM_SCALE = 1.65;
export const DEFAULT_MIN_ZOOM_SCALE = 1.0;

export const VisualCueKindSchema = z.enum([
  'scroll',
  'focus',
  'highlight',
  'circle',
  'underline',
  'arrow',
  'stat',
  'quote',
  'image',
]);

export type VisualCueKind = z.infer<typeof VisualCueKindSchema>;

export const VisualCueSchema = z.object({
  kind: VisualCueKindSchema,
  anchor: z.string().trim().min(1, 'Cue anchor phrase must not be empty'),
  target: z.string().trim().min(1).optional(),
  value: z.string().trim().min(1).optional(),
});

export type VisualCue = z.infer<typeof VisualCueSchema>;

export const CueBoundingBoxSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export type CueBoundingBox = z.infer<typeof CueBoundingBoxSchema>;

export const CuePageElementKindSchema = z.enum([
  'h1',
  'heading',
  'paragraph',
  'figure',
  'code',
  'blockquote',
  'table',
]);

export type CuePageElementKind = z.infer<typeof CuePageElementKindSchema>;

export const CuePageElementSchema = z.object({
  id: z.string().min(1),
  kind: CuePageElementKindSchema,
  tagName: z.string().min(1),
  text: z.string(),
  box: CueBoundingBoxSchema,
});

export type CuePageElement = z.infer<typeof CuePageElementSchema>;

export type ElementMapInput =
  | readonly CuePageElement[]
  | {
      readonly elements: readonly CuePageElement[];
      readonly page_height?: number;
      readonly viewport?: {
        readonly width: number;
        readonly height: number;
        readonly deviceScaleFactor?: number;
      };
    }
  | ReadonlyMap<string, CuePageElement>
  | Readonly<Record<string, CuePageElement>>
  | null
  | undefined;

export interface ResolvedCue extends VisualCue {
  index: number;
  startFrame: number;
  endFrame: number;
  startSeconds: number;
  endSeconds: number;
  matched: boolean;
  box?: CueBoundingBox | null;
}

export interface ResolveCueTimesOptions {
  durationInFrames?: number;
  durationSeconds?: number;
}

export interface CameraViewport {
  width: number;
  height: number;
  pageHeight?: number;
  minDwellFrames?: number;
  minBackwardJumpFrames?: number;
  transitionFrames?: number;
  durationInFrames?: number;
  maxScale?: number;
  minScale?: number;
}

export interface CameraKeyframe {
  frame: number;
  y: number;
  scale: number;
  focusRect: CueBoundingBox | null;
  cueIndex?: number;
  kind?: VisualCueKind | 'choreography';
}

export interface CameraPose {
  y: number;
  scale: number;
  focusRect: CueBoundingBox | null;
}

export interface CameraTrack {
  keyframes: CameraKeyframe[];
  viewport: {
    width: number;
    height: number;
    pageHeight: number;
  };
  minDwellFrames: number;
  minBackwardJumpFrames: number;
  transitionFrames: number;
  durationInFrames: number;
  atFrame: (frame: number) => CameraPose;
}

/**
 * Normalizes a string for Turkish-aware, case/diacritics/punctuation-insensitive comparison:
 * 1. Turkish-specific case folding (`İ -> i`, `I -> i`, `ı -> i`, `Ğ/ğ -> g`, `Ü/ü -> u`, `Ş/ş -> s`, `Ö/ö -> o`, `Ç/ç -> c`).
 * 2. Unicode NFD decomposition + stripping of combining diacritical marks (`\u0300-\u036f`).
 * 3. Lowercasing remaining characters.
 * 4. Replacing non-alphanumeric characters with spaces and collapsing runs of whitespace.
 */
export function normalizeCueText(text: string): string {
  if (!text) {
    return '';
  }

  const turkishFolded = text
    .replace(/İ/g, 'i')
    .replace(/I/g, 'i')
    .replace(/ı/g, 'i')
    .replace(/Ğ/g, 'g')
    .replace(/ğ/g, 'g')
    .replace(/Ü/g, 'u')
    .replace(/ü/g, 'u')
    .replace(/Ş/g, 's')
    .replace(/ş/g, 's')
    .replace(/Ö/g, 'o')
    .replace(/ö/g, 'o')
    .replace(/Ç/g, 'c')
    .replace(/ç/g, 'c');

  return turkishFolded
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Splits normalized text into non-empty alphanumeric tokens.
 */
export function tokenizeCueText(text: string): string[] {
  const normalized = normalizeCueText(text);
  if (!normalized) {
    return [];
  }
  return normalized.split(' ');
}

interface IndexedWordToken {
  token: string;
  wordIndex: number;
  start: number;
  end: number;
}

function buildIndexedWordTokens(wordTimings: readonly WordTiming[]): IndexedWordToken[] {
  const tokens: IndexedWordToken[] = [];
  for (let i = 0; i < wordTimings.length; i++) {
    const timing = wordTimings[i];
    const subTokens = tokenizeCueText(timing.word);
    for (const token of subTokens) {
      tokens.push({
        token,
        wordIndex: i,
        start: timing.start,
        end: Math.max(timing.start, timing.end),
      });
    }
  }
  return tokens;
}

function tokensMatch(wordToken: string, anchorToken: string): boolean {
  if (wordToken === anchorToken) {
    return true;
  }
  // Allow Turkish suffix prefix match when anchor token is at least 3 chars
  // (e.g. anchor "model" matching spoken "modelin", or vice versa).
  if (anchorToken.length >= 3 && wordToken.startsWith(anchorToken)) {
    return true;
  }
  if (wordToken.length >= 3 && anchorToken.startsWith(wordToken)) {
    return true;
  }
  return false;
}

function findAnchorMatchInTokens(
  anchorTokens: readonly string[],
  wordTokens: readonly IndexedWordToken[]
): { startSeconds: number; endSeconds: number } | null {
  if (anchorTokens.length === 0 || wordTokens.length === 0) {
    return null;
  }

  // Pass 1: exact normalized token sequence match
  for (let i = 0; i <= wordTokens.length - anchorTokens.length; i++) {
    let allExact = true;
    for (let j = 0; j < anchorTokens.length; j++) {
      if (wordTokens[i + j].token !== anchorTokens[j]) {
        allExact = false;
        break;
      }
    }
    if (allExact) {
      const first = wordTokens[i];
      const last = wordTokens[i + anchorTokens.length - 1];
      return {
        startSeconds: first.start,
        endSeconds: Math.max(first.start, last.end),
      };
    }
  }

  // Pass 2: prefix/stem-tolerant contiguous sequence match
  for (let i = 0; i <= wordTokens.length - anchorTokens.length; i++) {
    let allPrefixMatch = true;
    for (let j = 0; j < anchorTokens.length; j++) {
      if (!tokensMatch(wordTokens[i + j].token, anchorTokens[j])) {
        allPrefixMatch = false;
        break;
      }
    }
    if (allPrefixMatch) {
      const first = wordTokens[i];
      const last = wordTokens[i + anchorTokens.length - 1];
      return {
        startSeconds: first.start,
        endSeconds: Math.max(first.start, last.end),
      };
    }
  }

  // Pass 3: joined substring match across token boundaries (handles compound words / numbers like "%40" vs "40")
  const joinedAnchor = anchorTokens.join('');
  if (joinedAnchor.length >= 2) {
    for (let i = 0; i < wordTokens.length; i++) {
      let acc = '';
      for (let k = i; k < Math.min(wordTokens.length, i + anchorTokens.length + 2); k++) {
        acc += wordTokens[k].token;
        if (acc === joinedAnchor || (joinedAnchor.length >= 4 && acc.includes(joinedAnchor))) {
          return {
            startSeconds: wordTokens[i].start,
            endSeconds: Math.max(wordTokens[i].start, wordTokens[k].end),
          };
        }
      }
    }
  }

  return null;
}

/**
 * Resolves each `VisualCue` anchor phrase against ElevenLabs `wordTimings` at `fps` frames per second.
 * - Normalizes case, diacritics, punctuation, and Turkish `İ/ı/I/ğ/ü/ş/ö/ç`.
 * - Matched anchors map to `Math.round(startSeconds * fps)`.
 * - Unresolved anchors fall back to even spacing across the scene duration.
 */
export function resolveCueTimes(
  cues: readonly VisualCue[],
  wordTimings: readonly WordTiming[],
  fps: number = VIDEO_FPS,
  options?: number | ResolveCueTimesOptions
): ResolvedCue[] {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`Invalid fps (${fps}): must be a positive number.`);
  }

  if (cues.length === 0) {
    return [];
  }

  const maxWordEndSeconds = wordTimings.reduce(
    (max, w) => (Number.isFinite(w.end) && w.end > max ? w.end : max),
    0
  );

  let explicitDurationFrames: number | undefined;
  if (typeof options === 'number') {
    explicitDurationFrames = options;
  } else if (options) {
    if (typeof options.durationInFrames === 'number' && options.durationInFrames > 0) {
      explicitDurationFrames = options.durationInFrames;
    } else if (typeof options.durationSeconds === 'number' && options.durationSeconds > 0) {
      explicitDurationFrames = Math.ceil(options.durationSeconds * fps);
    }
  }

  const sceneDurationFrames = Math.max(
    1,
    explicitDurationFrames ??
      (maxWordEndSeconds > 0
        ? Math.ceil(maxWordEndSeconds * fps)
        : Math.max(DEFAULT_SCENE_DURATION_FRAMES, cues.length * DEFAULT_MIN_DWELL_FRAMES))
  );

  const indexedTokens = buildIndexedWordTokens(wordTimings);
  const totalCues = cues.length;

  const rawResolved: ResolvedCue[] = cues.map((cue, index) => {
    const anchorTokens = tokenizeCueText(cue.anchor);
    const match = findAnchorMatchInTokens(anchorTokens, indexedTokens);

    if (match) {
      const startFrame = Math.max(
        0,
        Math.min(sceneDurationFrames - 1, Math.round(match.startSeconds * fps))
      );
      const matchedEndFrame = Math.max(
        startFrame + 1,
        Math.min(sceneDurationFrames, Math.round(match.endSeconds * fps))
      );
      return {
        ...cue,
        index,
        startFrame,
        endFrame: matchedEndFrame,
        startSeconds: startFrame / fps,
        endSeconds: matchedEndFrame / fps,
        matched: true,
      };
    }

    // Fallback: even spacing across the scene.
    // Dividing into (totalCues + 1) intervals places unresolved cues strictly inside the scene
    // and keeps multiple unresolved cues evenly distributed in order.
    const fallbackFrame = Math.max(
      0,
      Math.min(
        sceneDurationFrames - 1,
        Math.round(((index + 1) / (totalCues + 1)) * sceneDurationFrames)
      )
    );
    const defaultSpanFrames = Math.min(
      DEFAULT_MIN_DWELL_FRAMES,
      Math.max(1, Math.floor(sceneDurationFrames / (totalCues + 1)))
    );
    const endFrame = Math.min(sceneDurationFrames, fallbackFrame + defaultSpanFrames);

    return {
      ...cue,
      index,
      startFrame: fallbackFrame,
      endFrame: Math.max(fallbackFrame + 1, endFrame),
      startSeconds: fallbackFrame / fps,
      endSeconds: Math.max(fallbackFrame + 1, endFrame) / fps,
      matched: false,
    };
  });

  // Compute effective endFrame until the next cue in chronological order or scene end
  const sortedByStart = [...rawResolved].sort((a, b) =>
    a.startFrame !== b.startFrame ? a.startFrame - b.startFrame : a.index - b.index
  );

  const endByIndex = new Map<number, number>();
  for (let i = 0; i < sortedByStart.length; i++) {
    const current = sortedByStart[i];
    const next = sortedByStart[i + 1];
    const naturalEnd = next
      ? Math.max(current.endFrame, next.startFrame)
      : Math.max(current.endFrame, sceneDurationFrames);
    endByIndex.set(current.index, Math.min(sceneDurationFrames, Math.max(current.startFrame + 1, naturalEnd)));
  }

  return rawResolved.map((item) => {
    const finalEndFrame = endByIndex.get(item.index) ?? item.endFrame;
    return {
      ...item,
      endFrame: finalEndFrame,
      endSeconds: finalEndFrame / fps,
    };
  });
}

function extractElementsList(elementMap: ElementMapInput): CuePageElement[] {
  if (!elementMap) {
    return [];
  }
  if (Array.isArray(elementMap)) {
    return elementMap;
  }
  if (elementMap instanceof Map) {
    return Array.from(elementMap.values());
  }
  if (
    typeof elementMap === 'object' &&
    'elements' in elementMap &&
    Array.isArray((elementMap as { elements: unknown }).elements)
  ) {
    return (elementMap as { readonly elements: CuePageElement[] }).elements;
  }
  if (typeof elementMap === 'object') {
    const values = Object.values(elementMap as Record<string, unknown>);
    return values.filter(
      (v): v is CuePageElement =>
        Boolean(v) &&
        typeof v === 'object' &&
        'id' in (v as Record<string, unknown>) &&
        'box' in (v as Record<string, unknown>)
    );
  }
  return [];
}

/**
 * Resolves a cue `target` (element ID or text snippet) against captured page elements:
 * 1. Exact ID match (case-insensitive, e.g. `"h1"`, `"p2"`, `"fig1"`).
 * 2. Fuzzy text match against captured element `text` (normalized substring containment,
 *    then token overlap / Jaccard + coverage score).
 * 3. Returns the matched element's `CueBoundingBox`, or `null` so the cue degrades cleanly
 *    to a non-page visual.
 */
export function resolveCueTarget(
  target: string | undefined | null,
  elementMap: ElementMapInput
): CueBoundingBox | null {
  if (!target) {
    return null;
  }

  const trimmedTarget = target.trim();
  if (!trimmedTarget) {
    return null;
  }

  const elements = extractElementsList(elementMap);
  if (elements.length === 0) {
    return null;
  }

  // 1. Exact ID match (case-insensitive, stripping optional leading '#')
  const cleanIdCandidate = trimmedTarget.replace(/^#/, '').toLowerCase();
  for (const el of elements) {
    if (el.id.toLowerCase() === cleanIdCandidate) {
      return { ...el.box };
    }
  }

  // 2. Fuzzy text match against captured element text
  const normalizedTarget = normalizeCueText(trimmedTarget);
  if (!normalizedTarget) {
    return null;
  }

  const targetTokens = tokenizeCueText(trimmedTarget);
  if (targetTokens.length === 0) {
    return null;
  }

  let bestBox: CueBoundingBox | null = null;
  let bestScore = 0;

  for (const el of elements) {
    const normalizedElText = normalizeCueText(el.text);
    if (!normalizedElText) {
      continue;
    }

    // Direct normalized substring match
    if (normalizedElText.includes(normalizedTarget)) {
      const lengthRatio = Math.min(1, normalizedTarget.length / Math.max(1, normalizedElText.length));
      const score = 0.85 + 0.15 * lengthRatio;
      if (score > bestScore) {
        bestScore = score;
        bestBox = el.box;
      }
      continue;
    }

    if (normalizedTarget.length >= 6 && normalizedTarget.includes(normalizedElText) && normalizedElText.length >= 4) {
      const lengthRatio = Math.min(1, normalizedElText.length / normalizedTarget.length);
      const score = 0.75 + 0.15 * lengthRatio;
      if (score > bestScore) {
        bestScore = score;
        bestBox = el.box;
      }
      continue;
    }

    // Token overlap score (handles word reordering or partial snippets)
    const elTokens = tokenizeCueText(el.text);
    if (elTokens.length === 0) {
      continue;
    }

    let matchedTargetTokens = 0;
    for (const tToken of targetTokens) {
      if (elTokens.some((eToken) => tokensMatch(eToken, tToken))) {
        matchedTargetTokens += 1;
      }
    }

    if (matchedTargetTokens === 0) {
      continue;
    }

    const recall = matchedTargetTokens / targetTokens.length;
    const precision = matchedTargetTokens / elTokens.length;
    const combinedScore = recall * 0.8 + precision * 0.2;

    // Require a meaningful overlap threshold so unrelated elements don't match by accident
    const minRequiredRecall = targetTokens.length === 1 ? 1.0 : 0.5;
    if (recall >= minRequiredRecall && combinedScore >= 0.45 && combinedScore > bestScore) {
      bestScore = combinedScore;
      bestBox = el.box;
    }
  }

  return bestBox ? { ...bestBox } : null;
}

/**
 * Smooth cubic-bezier / spring-like easing function on `[0, 1]`.
 * Uses cubic Hermite / smootherstep (`6t^5 - 15t^4 + 10t^3`) for zero-velocity,
 * zero-acceleration endpoints so camera motion starts and settles organically without jerk.
 */
export function easeCameraProgress(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveBoxForCue(
  cue: VisualCue | ResolvedCue,
  index: number,
  boxes:
    | ReadonlyArray<CueBoundingBox | null | undefined>
    | ReadonlyMap<string, CueBoundingBox | CuePageElement>
    | Readonly<Record<string, CueBoundingBox | CuePageElement>>
    | ElementMapInput
): CueBoundingBox | null {
  if ('box' in cue && cue.box) {
    return { ...cue.box };
  }

  if (!boxes) {
    return null;
  }

  // Case 1: parallel array of bounding boxes (`boxes[index]`)
  if (Array.isArray(boxes)) {
    const first = boxes[0];
    const isElementArray =
      Boolean(first) &&
      typeof first === 'object' &&
      'id' in (first as Record<string, unknown>) &&
      'box' in (first as Record<string, unknown>);

    if (isElementArray) {
      return resolveCueTarget(cue.target, boxes as readonly CuePageElement[]);
    }

    const candidate = (boxes as ReadonlyArray<CueBoundingBox | null | undefined>)[index];
    if (
      candidate &&
      typeof candidate === 'object' &&
      'y' in candidate &&
      'height' in candidate
    ) {
      return { ...candidate };
    }
    return null;
  }

  // Case 2: Map of id -> box or PageElement
  if (boxes instanceof Map) {
    if (!cue.target) return null;
    const direct =
      boxes.get(cue.target) ??
      boxes.get(cue.target.replace(/^#/, '')) ??
      boxes.get(cue.target.toLowerCase());
    if (direct) {
      if ('box' in direct) return { ...direct.box };
      if ('y' in direct && 'height' in direct) return { ...direct };
    }
    return resolveCueTarget(cue.target, boxes as ReadonlyMap<string, CuePageElement>);
  }

  // Case 3: PageCaptureMetadata-like object with `elements`
  if (typeof boxes === 'object' && 'elements' in boxes) {
    return resolveCueTarget(cue.target, boxes as ElementMapInput);
  }

  // Case 4: Record<string, CueBoundingBox | CuePageElement>
  if (typeof boxes === 'object' && cue.target) {
    const record = boxes as Readonly<Record<string, CueBoundingBox | CuePageElement>>;
    const direct =
      record[cue.target] ??
      record[cue.target.replace(/^#/, '')] ??
      record[cue.target.toLowerCase()];
    if (direct) {
      if ('box' in direct) return { ...direct.box };
      if ('y' in direct && 'height' in direct) return { ...direct };
    }
    return resolveCueTarget(cue.target, boxes as ElementMapInput);
  }

  return null;
}

function computeScaleForCue(
  kind: VisualCueKind | 'choreography',
  box: CueBoundingBox | null,
  viewportWidth: number,
  viewportHeight: number,
  minScale: number,
  maxScale: number
): number {
  if (!box) {
    return minScale;
  }

  switch (kind) {
    case 'scroll':
      return minScale;
    case 'focus':
    case 'circle':
    case 'underline':
    case 'arrow': {
      const targetWidthRatio = viewportWidth / Math.max(320, box.width * 1.35);
      const targetHeightRatio = viewportHeight / Math.max(220, box.height * 2.2);
      const ideal = Math.min(targetWidthRatio, targetHeightRatio, 1.32);
      return Number(clampNumber(Math.max(1.12, ideal), minScale, maxScale).toFixed(4));
    }
    case 'highlight': {
      const ideal = Math.min(viewportWidth / Math.max(400, box.width * 1.4), 1.22);
      return Number(clampNumber(Math.max(1.08, ideal), minScale, maxScale).toFixed(4));
    }
    case 'image':
    case 'stat':
    case 'quote': {
      return Number(clampNumber(1.1, minScale, maxScale).toFixed(4));
    }
    default:
      return minScale;
  }
}

function clampScrollY(y: number, maxScrollY: number): number {
  if (!Number.isFinite(y)) {
    return 0;
  }
  return Math.round(clampNumber(y, 0, Math.max(0, maxScrollY)));
}

function clampFocusRect(
  box: CueBoundingBox | null,
  viewportWidth: number,
  pageHeight: number
): CueBoundingBox | null {
  if (!box) {
    return null;
  }
  const x = clampNumber(box.x, 0, Math.max(0, viewportWidth - 1));
  const y = clampNumber(box.y, 0, Math.max(0, pageHeight - 1));
  const width = clampNumber(box.width, 1, Math.max(1, viewportWidth - x));
  const height = clampNumber(box.height, 1, Math.max(1, pageHeight - y));
  return { x, y, width, height };
}

function interpolateRect(
  a: CueBoundingBox | null,
  b: CueBoundingBox | null,
  t: number
): CueBoundingBox | null {
  if (!a && !b) return null;
  if (!a) return b ? { ...b } : null;
  if (!b) return a ? { ...a } : null;
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    width: a.width + (b.width - a.width) * t,
    height: a.height + (b.height - a.height) * t,
  };
}

/**
 * Evaluates a `CameraTrack` (or ordered `CameraKeyframe[]`) at `frame` using eased interpolation,
 * minimum dwell holds before transitioning to the next keyframe, and page-bound clamping.
 */
export function sampleCameraTrack(
  trackOrKeyframes: CameraTrack | readonly CameraKeyframe[],
  frame: number,
  options?: {
    transitionFrames?: number;
    pageHeight?: number;
    viewportHeight?: number;
  }
): CameraPose {
  const keyframes = Array.isArray(trackOrKeyframes)
    ? trackOrKeyframes
    : (trackOrKeyframes as CameraTrack).keyframes;

  const transitionFrames =
    options?.transitionFrames ??
    (!Array.isArray(trackOrKeyframes)
      ? (trackOrKeyframes as CameraTrack).transitionFrames
      : DEFAULT_TRANSITION_FRAMES);

  const viewportHeight =
    options?.viewportHeight ??
    (!Array.isArray(trackOrKeyframes)
      ? (trackOrKeyframes as CameraTrack).viewport.height
      : DEFAULT_VIEWPORT_HEIGHT);

  const pageHeight =
    options?.pageHeight ??
    (!Array.isArray(trackOrKeyframes)
      ? (trackOrKeyframes as CameraTrack).viewport.pageHeight
      : viewportHeight);

  const maxScrollY = Math.max(0, pageHeight - viewportHeight);

  if (keyframes.length === 0) {
    return { y: 0, scale: 1, focusRect: null };
  }

  const clampedFrame = Math.max(0, frame);
  if (clampedFrame <= keyframes[0].frame || keyframes.length === 1) {
    const first = keyframes[0];
    return {
      y: clampNumber(first.y, 0, maxScrollY),
      scale: first.scale,
      focusRect: first.focusRect ? { ...first.focusRect } : null,
    };
  }

  const last = keyframes[keyframes.length - 1];
  if (clampedFrame >= last.frame) {
    return {
      y: clampNumber(last.y, 0, maxScrollY),
      scale: last.scale,
      focusRect: last.focusRect ? { ...last.focusRect } : null,
    };
  }

  // Find active segment [prev, next] where prev.frame <= clampedFrame < next.frame
  let prevIdx = 0;
  for (let i = 0; i < keyframes.length - 1; i++) {
    if (clampedFrame >= keyframes[i].frame && clampedFrame < keyframes[i + 1].frame) {
      prevIdx = i;
      break;
    }
  }

  const prev = keyframes[prevIdx];
  const next = keyframes[prevIdx + 1];
  const span = Math.max(1, next.frame - prev.frame);

  // Transition leads into `next.frame` over `min(span, transitionFrames)` frames,
  // holding `prev` steady during its dwell period before smoothly easing into `next`.
  const effectiveTransition = Math.max(1, Math.min(span, transitionFrames));
  const transitionStartFrame = next.frame - effectiveTransition;

  if (clampedFrame <= transitionStartFrame) {
    return {
      y: clampNumber(prev.y, 0, maxScrollY),
      scale: prev.scale,
      focusRect: prev.focusRect ? { ...prev.focusRect } : null,
    };
  }

  const rawT = (clampedFrame - transitionStartFrame) / effectiveTransition;
  const easedT = easeCameraProgress(rawT);

  const y = clampNumber(prev.y + (next.y - prev.y) * easedT, 0, maxScrollY);
  const scale = Number((prev.scale + (next.scale - prev.scale) * easedT).toFixed(5));
  const focusRect = interpolateRect(
    prev.focusRect,
    next.focusRect,
    easedT >= 0.5 ? 1 : easedT * 2
  );

  return {
    y,
    scale,
    focusRect,
  };
}

/**
 * Builds an ordered camera track `{ keyframes, viewport, atFrame, ... }` from visual cues and their target boxes:
 * - Ordered keyframes `{ frame, y, scale, focusRect }`
 * - Enforces minimum dwell time (`minDwellFrames`) between consecutive keyframes
 * - Eased (spring/bezier) interpolation via `atFrame(frame)` / `sampleCameraTrack`
 * - Clamps scroll `y` and `focusRect` to `[0, pageHeight - viewport.height]` and page bounds
 * - Suppresses backward scroll jumps (`next.y < prev.y`) when the frame delta is shorter than `minBackwardJumpFrames` (avoids jitter)
 */
export function buildCameraTrack(
  cues: ReadonlyArray<VisualCue | ResolvedCue>,
  boxes:
    | ReadonlyArray<CueBoundingBox | null | undefined>
    | ReadonlyMap<string, CueBoundingBox | CuePageElement>
    | Readonly<Record<string, CueBoundingBox | CuePageElement>>
    | ElementMapInput,
  viewport: CameraViewport
): CameraTrack {
  const viewportWidth = Math.max(1, viewport.width || DEFAULT_VIEWPORT_WIDTH);
  const viewportHeight = Math.max(1, viewport.height || DEFAULT_VIEWPORT_HEIGHT);
  const minDwellFrames = Math.max(1, Math.round(viewport.minDwellFrames ?? DEFAULT_MIN_DWELL_FRAMES));
  const minBackwardJumpFrames = Math.max(
    1,
    Math.round(viewport.minBackwardJumpFrames ?? DEFAULT_MIN_BACKWARD_JUMP_FRAMES)
  );
  const transitionFrames = Math.max(
    1,
    Math.round(viewport.transitionFrames ?? DEFAULT_TRANSITION_FRAMES)
  );
  const minScale = viewport.minScale ?? DEFAULT_MIN_ZOOM_SCALE;
  const maxScale = Math.max(minScale, viewport.maxScale ?? DEFAULT_MAX_ZOOM_SCALE);

  // Determine effective page height from viewport.pageHeight, metadata, or bounding boxes
  let inferredMaxBoxBottom = viewportHeight;
  const resolvedBoxes: Array<CueBoundingBox | null> = cues.map((cue, idx) => {
    const box = resolveBoxForCue(cue, idx, boxes);
    if (box) {
      inferredMaxBoxBottom = Math.max(inferredMaxBoxBottom, box.y + box.height);
    }
    return box;
  });

  if (boxes && typeof boxes === 'object' && 'page_height' in boxes) {
    const metaHeight = (boxes as { page_height?: number }).page_height;
    if (typeof metaHeight === 'number' && metaHeight > 0) {
      inferredMaxBoxBottom = Math.max(inferredMaxBoxBottom, metaHeight);
    }
  }

  const pageHeight = Math.max(
    viewportHeight,
    Math.round(viewport.pageHeight ?? inferredMaxBoxBottom)
  );
  const maxScrollY = Math.max(0, pageHeight - viewportHeight);

  // Pair each cue with its start frame (or evenly spaced frame if plain VisualCue)
  const rawEntries = cues.map((cue, index) => {
    const hasStartFrame =
      'startFrame' in cue && typeof cue.startFrame === 'number' && Number.isFinite(cue.startFrame);
    const startFrame = hasStartFrame
      ? Math.max(0, Math.round((cue as ResolvedCue).startFrame))
      : index * minDwellFrames;
    return {
      cue,
      index,
      startFrame,
      box: resolvedBoxes[index],
    };
  });

  // Sort chronologically by startFrame, tie-breaking by original cue index
  rawEntries.sort((a, b) =>
    a.startFrame !== b.startFrame ? a.startFrame - b.startFrame : a.index - b.index
  );

  const keyframes: CameraKeyframe[] = [];

  for (const entry of rawEntries) {
    const clampedBox = clampFocusRect(entry.box, viewportWidth, pageHeight);
    const prev = keyframes[keyframes.length - 1];

    // If cue has no page target box, keep previous scroll Y (or 0 if first) and reset zoom to 1
    let desiredY: number;
    if (clampedBox) {
      const boxCenterY = clampedBox.y + clampedBox.height / 2;
      desiredY = clampScrollY(boxCenterY - viewportHeight / 2, maxScrollY);
    } else {
      desiredY = prev ? prev.y : 0;
    }

    const desiredScale = computeScaleForCue(
      entry.cue.kind,
      clampedBox,
      viewportWidth,
      viewportHeight,
      minScale,
      maxScale
    );

    if (!prev) {
      // Anchor an initial keyframe at frame 0 if the first cue starts later
      if (entry.startFrame >= minDwellFrames) {
        keyframes.push({
          frame: 0,
          y: 0,
          scale: minScale,
          focusRect: null,
        });
      }
      const prevAfterAnchor = keyframes[keyframes.length - 1];
      const frame = prevAfterAnchor
        ? Math.max(entry.startFrame, prevAfterAnchor.frame + minDwellFrames)
        : Math.max(0, entry.startFrame);

      let finalY = desiredY;
      if (prevAfterAnchor && finalY < prevAfterAnchor.y) {
        const deltaFrames = frame - prevAfterAnchor.frame;
        if (deltaFrames < minBackwardJumpFrames) {
          finalY = prevAfterAnchor.y;
        }
      }

      keyframes.push({
        frame,
        y: clampScrollY(finalY, maxScrollY),
        scale: desiredScale,
        focusRect: clampedBox,
        cueIndex: entry.index,
        kind: entry.cue.kind,
      });
      continue;
    }

    // Enforce minimum dwell time from previous keyframe
    const frame = Math.max(entry.startFrame, prev.frame + minDwellFrames);
    const deltaFrames = frame - prev.frame;

    // Suppress backward jumps shorter than N frames to avoid jitter
    let finalY = desiredY;
    if (finalY < prev.y && deltaFrames < minBackwardJumpFrames) {
      finalY = prev.y;
    }

    keyframes.push({
      frame,
      y: clampScrollY(finalY, maxScrollY),
      scale: desiredScale,
      focusRect: clampedBox,
      cueIndex: entry.index,
      kind: entry.cue.kind,
    });
  }

  // Fallback if no cues were provided: static top-of-page keyframe at frame 0
  if (keyframes.length === 0) {
    keyframes.push({
      frame: 0,
      y: 0,
      scale: minScale,
      focusRect: null,
    });
  }

  const lastKeyframeFrame = keyframes[keyframes.length - 1].frame;
  const durationInFrames = Math.max(
    viewport.durationInFrames ?? 0,
    lastKeyframeFrame + minDwellFrames,
    1
  );

  const track: CameraTrack = {
    keyframes,
    viewport: {
      width: viewportWidth,
      height: viewportHeight,
      pageHeight,
    },
    minDwellFrames,
    minBackwardJumpFrames,
    transitionFrames,
    durationInFrames,
    atFrame: (frame: number) =>
      sampleCameraTrack(keyframes, frame, {
        transitionFrames,
        pageHeight,
        viewportHeight,
      }),
  };

  return track;
}

/**
 * Generates a deterministic heuristic camera & cue sequence when no LLM cues exist:
 * `top -> h1 focus -> lede highlight -> first figure -> slow scroll`
 *
 * Works gracefully when any subset of elements (`h1`, `paragraph`, `figure`) is absent
 * by substituting synthetic/fallback regions and ending with a smooth slow scroll down the page.
 */
export function defaultChoreography(
  elementMap: ElementMapInput,
  duration: number,
  options?: {
    fps?: number;
    viewportWidth?: number;
    viewportHeight?: number;
    pageHeight?: number;
    minDwellFrames?: number;
    minBackwardJumpFrames?: number;
  }
): CameraTrack & { cues: ResolvedCue[] } {
  const fps = options?.fps && options.fps > 0 ? options.fps : VIDEO_FPS;
  const viewportWidth = options?.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH;
  const viewportHeight = options?.viewportHeight ?? DEFAULT_VIEWPORT_HEIGHT;

  // Interpret `duration`: values >= 30 are treated as durationInFrames (standard in Remotion),
  // whereas small positive values (< 30) are treated as duration in seconds and converted via `fps`.
  const totalFrames = Math.max(
    30,
    duration >= 30 ? Math.round(duration) : Math.max(30, Math.round(duration * fps))
  );

  const elements = extractElementsList(elementMap);

  let inferredPageHeight = options?.pageHeight ?? 0;
  if (
    !inferredPageHeight &&
    elementMap &&
    typeof elementMap === 'object' &&
    'page_height' in elementMap
  ) {
    const metaHeight = (elementMap as { page_height?: number }).page_height;
    if (typeof metaHeight === 'number' && metaHeight > 0) {
      inferredPageHeight = metaHeight;
    }
  }
  for (const el of elements) {
    inferredPageHeight = Math.max(inferredPageHeight, el.box.y + el.box.height + 120);
  }
  const pageHeight = Math.max(
    viewportHeight,
    inferredPageHeight > 0 ? Math.round(inferredPageHeight) : viewportHeight * 2
  );
  const maxScrollY = Math.max(0, pageHeight - viewportHeight);

  // Locate canonical elements in document order:
  // 1. h1 (or first heading)
  const h1El =
    elements.find((e) => e.kind === 'h1' || e.id === 'h1') ??
    elements.find((e) => e.kind === 'heading');

  // 2. lede paragraph (first paragraph at or below h1)
  const ledeEl =
    elements.find(
      (e) =>
        e.kind === 'paragraph' &&
        (!h1El || e.box.y >= h1El.box.y)
    ) ?? elements.find((e) => e.kind === 'paragraph');

  // 3. first figure (or code/blockquote/table visual block)
  const figureEl =
    elements.find(
      (e) =>
        e.kind === 'figure' &&
        (!ledeEl || e.box.y >= ledeEl.box.y)
    ) ??
    elements.find((e) => e.kind === 'figure') ??
    elements.find((e) => e.kind === 'code' || e.kind === 'blockquote' || e.kind === 'table');

  // Ensure monotonic vertical progression (`top -> h1 -> lede -> figure -> slow scroll`)
  const h1Box: CueBoundingBox = h1El
    ? { ...h1El.box }
    : {
        x: Math.round(viewportWidth * 0.1),
        y: Math.min(Math.round(viewportHeight * 0.14), Math.max(0, pageHeight - 140)),
        width: Math.round(viewportWidth * 0.8),
        height: 110,
      };

  const ledeBox: CueBoundingBox =
    ledeEl && ledeEl.box.y >= h1Box.y
      ? { ...ledeEl.box }
      : {
          x: h1Box.x,
          y: Math.min(h1Box.y + h1Box.height + 48, Math.max(0, pageHeight - 160)),
          width: h1Box.width,
          height: 130,
        };

  const figureBox: CueBoundingBox =
    figureEl && figureEl.box.y >= ledeBox.y
      ? { ...figureEl.box }
      : {
          x: Math.round(viewportWidth * 0.12),
          y: Math.min(ledeBox.y + ledeBox.height + 72, Math.max(0, pageHeight - 320)),
          width: Math.round(viewportWidth * 0.76),
          height: Math.min(340, Math.max(120, pageHeight - (ledeBox.y + ledeBox.height))),
        };

  const slowScrollTargetY = Math.max(
    figureBox.y + figureBox.height / 2,
    Math.min(pageHeight - viewportHeight / 2, viewportHeight + Math.round(maxScrollY * 0.75))
  );
  const slowScrollBox: CueBoundingBox = {
    x: Math.round(viewportWidth * 0.1),
    y: clampNumber(
      slowScrollTargetY - viewportHeight * 0.25,
      0,
      Math.max(0, pageHeight - Math.round(viewportHeight * 0.5))
    ),
    width: Math.round(viewportWidth * 0.8),
    height: Math.round(viewportHeight * 0.5),
  };

  // 5-stage beat timing across [0, totalFrames]:
  // 0: top (0%)
  // 1: h1 focus (~15%)
  // 2: lede highlight (~38%)
  // 3: first figure (~62%)
  // 4: slow scroll (~85%)
  const fractions = [0, 0.15, 0.38, 0.62, 0.85];
  const minDwellFrames = Math.max(
    1,
    Math.min(
      options?.minDwellFrames ?? DEFAULT_MIN_DWELL_FRAMES,
      Math.max(1, Math.floor(totalFrames / 5))
    )
  );

  const stageFrames: number[] = [];
  for (let i = 0; i < fractions.length; i++) {
    const rawFrame = Math.round(fractions[i] * totalFrames);
    if (i === 0) {
      stageFrames.push(0);
    } else {
      stageFrames.push(Math.max(rawFrame, stageFrames[i - 1] + minDwellFrames));
    }
  }

  const stageDefs: Array<{
    kind: VisualCueKind;
    anchor: string;
    target?: string;
    box: CueBoundingBox | null;
  }> = [
    {
      kind: 'scroll',
      anchor: 'top',
      target: 'top',
      box: {
        x: 0,
        y: 0,
        width: viewportWidth,
        height: Math.min(viewportHeight, pageHeight),
      },
    },
    {
      kind: 'focus',
      anchor: h1El?.text || 'h1',
      target: h1El?.id ?? 'h1',
      box: h1Box,
    },
    {
      kind: 'highlight',
      anchor: ledeEl?.text || 'lede',
      target: ledeEl?.id ?? 'p1',
      box: ledeBox,
    },
    {
      kind: 'focus',
      anchor: figureEl?.text || 'figure',
      target: figureEl?.id ?? 'fig1',
      box: figureBox,
    },
    {
      kind: 'scroll',
      anchor: 'slow scroll',
      target: 'scroll',
      box: slowScrollBox,
    },
  ];

  const cues: ResolvedCue[] = stageDefs.map((stage, index) => {
    const startFrame = stageFrames[index];
    const nextStart = stageFrames[index + 1] ?? Math.max(totalFrames, startFrame + minDwellFrames);
    const endFrame = Math.max(startFrame + 1, nextStart);
    return {
      kind: stage.kind,
      anchor: stage.anchor,
      target: stage.target,
      index,
      startFrame,
      endFrame,
      startSeconds: startFrame / fps,
      endSeconds: endFrame / fps,
      matched: false,
      box: stage.box,
    };
  });

  const track = buildCameraTrack(
    cues,
    cues.map((c) => c.box ?? null),
    {
      width: viewportWidth,
      height: viewportHeight,
      pageHeight,
      minDwellFrames,
      minBackwardJumpFrames: options?.minBackwardJumpFrames ?? DEFAULT_MIN_BACKWARD_JUMP_FRAMES,
      durationInFrames: Math.max(totalFrames, stageFrames[stageFrames.length - 1] + minDwellFrames),
    }
  );

  // Ensure stage 0 ('top') always starts cleanly at y=0, scale=1, focusRect=null
  if (track.keyframes.length > 0 && track.keyframes[0].frame === 0) {
    track.keyframes[0] = {
      ...track.keyframes[0],
      y: 0,
      scale: DEFAULT_MIN_ZOOM_SCALE,
      focusRect: null,
    };
  }

  return {
    ...track,
    cues,
  };
}
