import { z } from 'zod';
import type { CaptionChunk, WordTiming } from './captions.ts';

export const VIDEO_WIDTH = 1920;
export const VIDEO_HEIGHT = 1080;
export const VIDEO_FPS = 30;
export const SCENE_PADDING_SECONDS = 0.6;
export const MIN_SCENE_DURATION_SECONDS = 1.5;
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

export const StorySceneItemSchema = SceneAudioPropsSchema.extend({
  index: z.number().int().positive(),
  url: z.string().min(1),
  domain: z.string(),
  source: z.string().min(1),
  headline_tr: z.string().min(1),
  summary_tr: z.string(),
  imageSrc: z.string().nullable(),
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
 */
export function buildVideoTimeline(
  props: WeeklyVideoProps,
  fps: number = VIDEO_FPS,
  paddingSeconds: number = SCENE_PADDING_SECONDS
): VideoTimeline {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`Invalid fps (${fps}): must be a positive number.`);
  }

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

  const totalDurationInFrames = Math.max(1, cursorFrame);
  return {
    fps,
    scenes,
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
  paddingSeconds: number = SCENE_PADDING_SECONDS
): number {
  return buildVideoTimeline(props, fps, paddingSeconds).totalDurationInFrames;
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

