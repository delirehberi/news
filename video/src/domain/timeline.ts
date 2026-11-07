import { z } from 'zod';
import type { CaptionChunk, WordTiming } from './captions.ts';
import {
  PageCaptureMetadataSchema,
  PageElementSchema,
  type PageElement,
} from './pageCapture.ts';

export const VIDEO_WIDTH = 1920;
export const VIDEO_HEIGHT = 1080;
export const VIDEO_FPS = 30;
export const SCENE_PADDING_SECONDS = 0.6;
export const MIN_SCENE_DURATION_SECONDS = 1.5;
export const STORY_TRANSITION_FRAMES = 15;
export const THUMBNAIL_FRAME = 15;
export const WEEKLY_VIDEO_COMPOSITION_ID = 'WeeklyVideo';
export const DEFAULT_SITE_URL = 'news.emre.xyz';

const KEN_BURNS_START_SCALE = 1.0;
const KEN_BURNS_END_SCALE = 1.08;
const KEN_BURNS_MAX_PAN_PX = 24;

export const WordTimingSchema: z.ZodType<WordTiming> = z.object({
  word: z.string().min(1),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});

export const CaptionChunkSchema: z.ZodType<CaptionChunk> = z.object({
  text: z.string().min(1),
  words: z.array(WordTimingSchema),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});

export const SceneAudioPropsSchema = z.object({
  audioSrc: z.string(),
  audioDurationSeconds: z.number().nonnegative(),
  captions: z.array(CaptionChunkSchema),
});

export type SceneAudioProps = z.infer<typeof SceneAudioPropsSchema>;

export const StorySceneCueKindSchema = z.enum([
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

export type StorySceneCueKind = z.infer<typeof StorySceneCueKindSchema>;

export const StorySceneCueSchema = z.object({
  kind: StorySceneCueKindSchema,
  anchor: z.string().trim().min(1),
  target: z.string().trim().min(1).optional(),
  value: z.string().trim().min(1).optional(),
  startFrame: z.number().nonnegative().optional(),
  endFrame: z.number().nonnegative().optional(),
  startSeconds: z.number().nonnegative().optional(),
  endSeconds: z.number().nonnegative().optional(),
  matched: z.boolean().optional(),
  box: z
    .object({
      x: z.number().nonnegative(),
      y: z.number().nonnegative(),
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .nullable()
    .optional(),
});

export type StorySceneCue = z.infer<typeof StorySceneCueSchema>;

const FlexiblePageCaptureSchema = z
  .object({
    screenshotSrc: z.string().min(1).optional(),
    screenshot_path: z.string().min(1).optional(),
    viewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        deviceScaleFactor: z.number().positive().optional(),
      })
      .optional(),
    page_height: z.number().int().positive().optional(),
    pageHeight: z.number().int().positive().optional(),
    elements: z.array(PageElementSchema).optional().default([]),
    index: z.number().int().positive().optional(),
    url: z.string().optional(),
    url_hash: z.string().optional(),
    captured_at: z.string().optional(),
    excerpt: z.string().optional(),
  })
  .refine(
    (val) => Boolean(val.screenshotSrc || val.screenshot_path),
    'StoryScenePage must define either screenshotSrc or screenshot_path'
  );

export const StoryScenePageSchema = z.union([
  PageCaptureMetadataSchema,
  FlexiblePageCaptureSchema,
]);

export type StoryScenePage = z.infer<typeof StoryScenePageSchema>;

export interface NormalizedStoryPage {
  screenshotSrc: string;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
  };
  page_height: number;
  elements: PageElement[];
}

export const StorySceneItemSchema = SceneAudioPropsSchema.extend({
  index: z.number().int().positive(),
  url: z.string().min(1),
  domain: z.string(),
  source: z.string().min(1),
  headline_tr: z.string().min(1),
  summary_tr: z.string().optional().default(''),
  imageSrc: z.string().nullable(),
  page: StoryScenePageSchema.nullable().optional(),
  cues: z.array(StorySceneCueSchema).optional(),
});

export type StorySceneItem = z.infer<typeof StorySceneItemSchema>;

export const WeeklyVideoPropsSchema = z.object({
  week: z.string().min(1),
  title_tr: z.string().min(1),
  siteUrl: z.string().min(1),
  intro: SceneAudioPropsSchema,
  stories: z.array(StorySceneItemSchema),
  outro: SceneAudioPropsSchema,
});

export type WeeklyVideoProps = z.infer<typeof WeeklyVideoPropsSchema>;

export type SceneKind = 'intro' | 'story' | 'outro';

export interface SceneTiming {
  index: number;
  kind: SceneKind;
  label: string;
  storyIndex?: number;
  startFrame: number;
  durationInFrames: number;
  startSeconds: number;
  durationSeconds: number;
}

export interface VideoTimeline {
  fps: number;
  scenes: SceneTiming[];
  transitionDurationInFrames: number;
  transitionOverlapCount: number;
  totalDurationInFrames: number;
  totalDurationSeconds: number;
}

export interface ActiveCaptionState {
  chunk: CaptionChunk | null;
  activeWordIndex: number;
  timeSeconds: number;
}

export interface KenBurnsTransform {
  scale: number;
  translateX: number;
  translateY: number;
}

export interface SourceBadgeTheme {
  label: string;
  backgroundColor: string;
  borderColor: string;
  textColor: string;
}

export const DEFAULT_WEEKLY_VIDEO_PROPS: WeeklyVideoProps = {
  week: '2026-W42',
  title_tr: 'Haftalık Teknoloji Özeti',
  siteUrl: DEFAULT_SITE_URL,
  intro: {
    audioSrc: '',
    audioDurationSeconds: 4,
    captions: [],
  },
  stories: [],
  outro: {
    audioSrc: '',
    audioDurationSeconds: 4,
    captions: [],
  },
};

/**
 * Pure function calculating a scene's frame count from its audio duration in seconds
 * plus `paddingSeconds` at `fps` frames per second.
 * When `audioDurationSeconds <= 0`, falls back to `MIN_SCENE_DURATION_SECONDS`.
 */
export function calculateSceneDurationFrames(
  audioDurationSeconds: number,
  fps: number = VIDEO_FPS,
  paddingSeconds: number = SCENE_PADDING_SECONDS
): number {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`Invalid fps (${fps}): must be a positive number.`);
  }
  if (!Number.isFinite(paddingSeconds) || paddingSeconds < 0) {
    throw new Error(`Invalid paddingSeconds (${paddingSeconds}): must be >= 0.`);
  }

  const cleanAudioSeconds =
    Number.isFinite(audioDurationSeconds) && audioDurationSeconds > 0
      ? audioDurationSeconds
      : 0;

  const totalSeconds =
    cleanAudioSeconds > 0
      ? cleanAudioSeconds + paddingSeconds
      : Math.max(MIN_SCENE_DURATION_SECONDS, paddingSeconds);

  return Math.max(1, Math.ceil(totalSeconds * fps));
}

/**
 * Pure function that builds the full ordered timeline (`intro`, `stories[0..N-1]`, `outro`)
 * with start frames, frame counts, and start/duration seconds for each scene.
 * Consecutive story scenes overlap by `transitionFrames` (default `STORY_TRANSITION_FRAMES = 15`),
 * matching `@remotion/transitions`'s `TransitionSeries` duration calculation.
 */
export function buildVideoTimeline(
  props: WeeklyVideoProps,
  fps: number = VIDEO_FPS,
  paddingSeconds: number = SCENE_PADDING_SECONDS,
  transitionFrames: number = STORY_TRANSITION_FRAMES
): VideoTimeline {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`Invalid fps (${fps}): must be a positive number.`);
  }
  const safeTransitionFrames =
    Number.isFinite(transitionFrames) && transitionFrames >= 0
      ? Math.round(transitionFrames)
      : STORY_TRANSITION_FRAMES;

  const scenes: SceneTiming[] = [];
  let cursorFrame = 0;

  const introFrames = calculateSceneDurationFrames(
    props.intro.audioDurationSeconds,
    fps,
    paddingSeconds
  );
  scenes.push({
    index: 0,
    kind: 'intro',
    label: 'Giriş',
    startFrame: cursorFrame,
    durationInFrames: introFrames,
    startSeconds: cursorFrame / fps,
    durationSeconds: introFrames / fps,
  });
  cursorFrame += introFrames;

  props.stories.forEach((story, idx) => {
    if (idx > 0 && safeTransitionFrames > 0) {
      cursorFrame = Math.max(0, cursorFrame - safeTransitionFrames);
    }
    const storyFrames = calculateSceneDurationFrames(
      story.audioDurationSeconds,
      fps,
      paddingSeconds
    );
    scenes.push({
      index: idx + 1,
      kind: 'story',
      label: story.headline_tr,
      storyIndex: idx,
      startFrame: cursorFrame,
      durationInFrames: storyFrames,
      startSeconds: cursorFrame / fps,
      durationSeconds: storyFrames / fps,
    });
    cursorFrame += storyFrames;
  });

  const outroFrames = calculateSceneDurationFrames(
    props.outro.audioDurationSeconds,
    fps,
    paddingSeconds
  );
  scenes.push({
    index: props.stories.length + 1,
    kind: 'outro',
    label: 'Kapanış',
    startFrame: cursorFrame,
    durationInFrames: outroFrames,
    startSeconds: cursorFrame / fps,
    durationSeconds: outroFrames / fps,
  });
  cursorFrame += outroFrames;

  const transitionOverlapCount = Math.max(0, props.stories.length - 1);
  const totalDurationInFrames = Math.max(1, cursorFrame);
  return {
    fps,
    scenes,
    transitionDurationInFrames: safeTransitionFrames,
    transitionOverlapCount,
    totalDurationInFrames,
    totalDurationSeconds: totalDurationInFrames / fps,
  };
}

/**
 * Pure helper returning the total composition duration in frames for `WeeklyVideoProps`.
 */
export function calculateTotalDurationFrames(
  props: WeeklyVideoProps,
  fps: number = VIDEO_FPS,
  paddingSeconds: number = SCENE_PADDING_SECONDS,
  transitionFrames: number = STORY_TRANSITION_FRAMES
): number {
  return buildVideoTimeline(props, fps, paddingSeconds, transitionFrames)
    .totalDurationInFrames;
}

/**
 * Pure function that finds the active caption chunk and active spoken word index
 * for a given `frameInScene` at `fps`.
 */
export function getActiveCaptionAtFrame(
  captions: readonly CaptionChunk[],
  frameInScene: number,
  fps: number = VIDEO_FPS
): ActiveCaptionState {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`Invalid fps (${fps}): must be a positive number.`);
  }

  const clampedFrame = Math.max(0, frameInScene);
  const timeSeconds = clampedFrame / fps;

  if (captions.length === 0) {
    return {
      chunk: null,
      activeWordIndex: -1,
      timeSeconds,
    };
  }

  let matchedChunk: CaptionChunk | null = null;
  for (let i = 0; i < captions.length; i++) {
    const chunk = captions[i];
    const nextChunk = captions[i + 1];
    // Hold caption chunk slightly across tiny inter-word pauses until next chunk starts
    const effectiveEnd = nextChunk
      ? Math.min(nextChunk.start, chunk.end + 0.25)
      : chunk.end + 0.25;

    if (timeSeconds >= chunk.start && timeSeconds <= effectiveEnd) {
      matchedChunk = chunk;
      break;
    }
  }

  if (!matchedChunk) {
    return {
      chunk: null,
      activeWordIndex: -1,
      timeSeconds,
    };
  }

  let activeWordIndex = 0;
  for (let i = 0; i < matchedChunk.words.length; i++) {
    const word = matchedChunk.words[i];
    if (timeSeconds >= word.start) {
      activeWordIndex = i;
    } else {
      break;
    }
  }

  return {
    chunk: matchedChunk,
    activeWordIndex,
    timeSeconds,
  };
}

/**
 * Pure function computing the Ken Burns zoom and subtle pan transform for a story image
 * at `frameInScene` over `durationInFrames`.
 */
export function computeKenBurnsTransform(
  frameInScene: number,
  durationInFrames: number,
  storyIndex: number = 0
): KenBurnsTransform {
  const safeDuration = Math.max(1, durationInFrames - 1);
  const rawProgress = Math.min(1, Math.max(0, frameInScene / safeDuration));

  const scale =
    KEN_BURNS_START_SCALE +
    (KEN_BURNS_END_SCALE - KEN_BURNS_START_SCALE) * rawProgress;

  const directionX = storyIndex % 2 === 0 ? -1 : 1;
  const directionY = storyIndex % 3 === 0 ? -0.5 : 0.5;

  const translateX = directionX * KEN_BURNS_MAX_PAN_PX * rawProgress;
  const translateY = directionY * KEN_BURNS_MAX_PAN_PX * rawProgress;

  return {
    scale: Number(scale.toFixed(5)),
    translateX: Number(translateX.toFixed(3)),
    translateY: Number(translateY.toFixed(3)),
  };
}

/**
 * Pure helper extracting a clean hostname (without `www.`) from an article URL.
 */
export function extractHostname(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * Pure function mapping a source identifier to its badge label and colors matching `news.emre.xyz`.
 */
export function getSourceBadgeTheme(source: string): SourceBadgeTheme {
  const normalized = source.trim().toLowerCase();
  switch (normalized) {
    case 'hackernews':
    case 'hn':
      return {
        label: 'HN',
        backgroundColor: 'rgba(249, 115, 22, 0.16)',
        borderColor: 'rgba(249, 115, 22, 0.45)',
        textColor: '#fb923c',
      };
    case 'lobsters':
      return {
        label: 'Lobsters',
        backgroundColor: 'rgba(239, 68, 68, 0.16)',
        borderColor: 'rgba(239, 68, 68, 0.45)',
        textColor: '#f87171',
      };
    case 'reddit':
      return {
        label: 'Reddit',
        backgroundColor: 'rgba(234, 88, 12, 0.16)',
        borderColor: 'rgba(234, 88, 12, 0.45)',
        textColor: '#fdba74',
      };
    case 'stackernews':
    case 'stacker':
      return {
        label: 'Stacker',
        backgroundColor: 'rgba(234, 179, 8, 0.16)',
        borderColor: 'rgba(234, 179, 8, 0.45)',
        textColor: '#facc15',
      };
    case 'newsletter':
    case 'gmail':
      return {
        label: 'Newsletter',
        backgroundColor: 'rgba(59, 130, 246, 0.16)',
        borderColor: 'rgba(59, 130, 246, 0.45)',
        textColor: '#60a5fa',
      };
    default:
      return {
        label: source.trim() || 'News',
        backgroundColor: 'rgba(148, 163, 184, 0.16)',
        borderColor: 'rgba(148, 163, 184, 0.4)',
        textColor: '#cbd5e1',
      };
  }
}

export type StoryFallbackMode = 'page' | 'og' | 'card';

export const LOWER_THIRD_COLLAPSE_SECONDS = 3.0;
export const LOWER_THIRD_TRANSITION_FRAMES = 18;

export interface HeadlineLowerThirdState {
  collapsed: boolean;
  collapseProgress: number;
  entranceProgress: number;
  translateY: number;
  opacity: number;
}

const TURKISH_STOPWORDS = new Set([
  've',
  'ile',
  'bir',
  'bu',
  'da',
  'de',
  'mi',
  'mu',
  'm\u0131',
  'm\u00fc',
  'i\u00e7in',
  'icin',
  'gibi',
  'daha',
  'en',
  '\u00e7ok',
  'cok',
  'yeni',
  'olan',
  'olarak',
  '\u00fczerinde',
  'uzerinde',
  'sonra',
  '\u00f6nce',
  'once',
  'kadar',
  'g\u00f6re',
  'gore',
  'art\u0131k',
  'artik',
  'neden',
  'nas\u0131l',
  'nasil',
  'ne',
  'ya',
  'veya',
  'hem',
  'ama',
  'ancak',
  'fakat',
  'her',
  't\u00fcm',
  'tum',
]);

/**
 * Normalizes an optional `StoryScenePage` into a consistent `NormalizedStoryPage`
 * with `screenshotSrc`, `viewport`, `page_height`, and `elements`, or returns `null`
 * if no valid screenshot path is present.
 */
export function normalizeStoryPage(
  page: StoryScenePage | null | undefined
): NormalizedStoryPage | null {
  if (!page) {
    return null;
  }

  const rawScreenshot =
    ('screenshotSrc' in page && typeof page.screenshotSrc === 'string'
      ? page.screenshotSrc
      : '') ||
    ('screenshot_path' in page && typeof page.screenshot_path === 'string'
      ? page.screenshot_path
      : '');

  const screenshotSrc = rawScreenshot.trim();
  if (!screenshotSrc) {
    return null;
  }

  const width =
    page.viewport && typeof page.viewport.width === 'number' && page.viewport.width > 0
      ? page.viewport.width
      : 1440;
  const height =
    page.viewport && typeof page.viewport.height === 'number' && page.viewport.height > 0
      ? page.viewport.height
      : 900;
  const deviceScaleFactor =
    page.viewport &&
    typeof page.viewport.deviceScaleFactor === 'number' &&
    page.viewport.deviceScaleFactor > 0
      ? page.viewport.deviceScaleFactor
      : 1;

  const rawPageHeight =
    ('page_height' in page && typeof page.page_height === 'number' ? page.page_height : 0) ||
    ('pageHeight' in page && typeof page.pageHeight === 'number' ? page.pageHeight : 0);

  const elements = Array.isArray(page.elements) ? page.elements : [];
  let maxElementBottom = height;
  for (const el of elements) {
    if (el?.box) {
      maxElementBottom = Math.max(maxElementBottom, el.box.y + el.box.height + 120);
    }
  }

  const page_height = Math.max(
    height,
    rawPageHeight > 0 ? Math.round(rawPageHeight) : Math.round(maxElementBottom)
  );

  return {
    screenshotSrc,
    viewport: {
      width,
      height,
      deviceScaleFactor,
    },
    page_height,
    elements,
  };
}

/**
 * Resolves which stage of the StoryScene visual fallback ladder is active:
 * 1. `'page'` when a captured page screenshot exists and has not failed to load.
 * 2. `'og'` when an OG `imageSrc` exists and has not failed to load.
 * 3. `'card'` (branded fallback card) otherwise.
 */
export function resolveStoryFallbackMode(
  story: Pick<StorySceneItem, 'page' | 'imageSrc'>,
  options?: {
    pageLoadFailed?: boolean;
    imageLoadFailed?: boolean;
  }
): StoryFallbackMode {
  const normalizedPage = normalizeStoryPage(story.page);
  if (normalizedPage && !options?.pageLoadFailed) {
    return 'page';
  }

  const cleanImageSrc = story.imageSrc?.trim() ?? '';
  if (cleanImageSrc.length > 0 && !options?.imageLoadFailed) {
    return 'og';
  }

  return 'card';
}

/**
 * Pure frame-deterministic helper computing the animated lower-third headline state:
 * - Slides in over the first ~14 frames.
 * - Holds as a prominent lower-third banner until `collapseSeconds` (~3.0s, frame 90 at 30fps).
 * - Smoothly collapses into a compact chip (`collapseProgress: 0 -> 1`).
 */
export function computeHeadlineLowerThirdState(
  frameInScene: number,
  fps: number = VIDEO_FPS,
  options?: {
    collapseSeconds?: number;
    transitionFrames?: number;
  }
): HeadlineLowerThirdState {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : VIDEO_FPS;
  const collapseSeconds = options?.collapseSeconds ?? LOWER_THIRD_COLLAPSE_SECONDS;
  const transitionFrames = Math.max(
    1,
    Math.round(options?.transitionFrames ?? LOWER_THIRD_TRANSITION_FRAMES)
  );

  const clampedFrame = Math.max(0, frameInScene);
  const entranceRaw = Math.min(1, clampedFrame / 14);
  const entranceProgress = Number((1 - Math.pow(1 - entranceRaw, 3)).toFixed(4));
  const translateY = Number(((1 - entranceProgress) * 28).toFixed(2));
  const opacity = Number(Math.min(1, clampedFrame / 10).toFixed(4));

  const collapseStartFrame = Math.max(15, Math.round(collapseSeconds * safeFps));
  const rawCollapse = Math.min(
    1,
    Math.max(0, (clampedFrame - collapseStartFrame) / transitionFrames)
  );
  // Smooth Hermite easing for collapse transition
  const collapseProgress = Number(
    (rawCollapse * rawCollapse * (3 - 2 * rawCollapse)).toFixed(4)
  );

  return {
    collapsed: collapseProgress >= 0.99,
    collapseProgress,
    entranceProgress,
    translateY,
    opacity,
  };
}

/**
 * Extracts 1..maxKeywords salient keywords or numeric/technical tokens from a Turkish headline
 * so the OG-image fallback mode can highlight and hand-annotate headline keywords on screen.
 */
export function extractHeadlineKeywords(
  headline: string,
  maxKeywords: number = 3
): string[] {
  const cleaned = headline
    .replace(/[^\p{L}\p{N}%$.+-]+/gu, ' ')
    .trim();
  if (!cleaned) {
    return [];
  }

  const rawTokens = cleaned.split(/\s+/);
  const candidates: Array<{ token: string; score: number; index: number }> = [];
  const seen = new Set<string>();

  rawTokens.forEach((token, index) => {
    const lower = token.toLocaleLowerCase('tr-TR');
    if (lower.length < 2 || TURKISH_STOPWORDS.has(lower) || seen.has(lower)) {
      return;
    }
    seen.add(lower);

    let score = Math.min(10, token.length);
    // Boost numbers/percentages/metrics (e.g. %40, 3x, 2026) so stats always surface
    if (/\d/.test(token)) {
      score += 12;
    }
    // Boost acronyms / capitalized technical terms (e.g. Rust, SQLite, Linux, AI, GPU)
    if (/^[A-Z\u00c7\u011e\u0130\u00d6\u015e\u00dc]/.test(token) && index > 0) {
      score += 3;
    }
    if (/^[A-Z0-9]{2,}$/.test(token)) {
      score += 4;
    }

    candidates.push({ token, score, index });
  });

  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  return candidates
    .slice(0, Math.max(1, maxKeywords))
    .sort((a, b) => a.index - b.index)
    .map((c) => c.token);
}


