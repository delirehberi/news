import React, { useMemo, useState } from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { CaptionChunk, WordTiming } from '../domain/captions.ts';
import {
  buildCameraTrack,
  defaultChoreography,
  resolveCueTarget,
  resolveCueTimes,
  type CameraTrack,
  type CueBoundingBox,
  type ResolvedCue,
} from '../domain/cues.ts';
import {
  buildVideoTimeline,
  computeHeadlineLowerThirdState,
  computeKenBurnsTransform,
  extractHeadlineKeywords,
  extractHostname,
  getActiveCaptionAtFrame,
  getSourceBadgeTheme,
  normalizeStoryPage,
  resolveStoryFallbackMode,
  STORY_TRANSITION_FRAMES,
  VIDEO_FPS,
  type NormalizedStoryPage,
  type SceneAudioProps,
  type StorySceneItem,
  type WeeklyVideoProps,
} from '../domain/timeline.ts';
import {
  Annotations,
  BrowserFrame,
  computePageCameraTransform,
  Highlighter,
  isDrawableBox,
  PageCamera,
  QuoteCallout,
  Spotlight,
  StatCallout,
  StoryTransitionSeries,
  type AnnotationItemProps,
  type SceneTransitionItem,
} from './primitives/index.ts';

const FONT_SANS =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_MONO =
  '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

const COLOR_BG_DEEP = '#090d16';
const COLOR_BG_CARD = '#111827';
const COLOR_BORDER = 'rgba(148, 163, 184, 0.22)';
const COLOR_ACCENT = '#f59e0b';
const COLOR_ACCENT_SOFT = 'rgba(245, 158, 11, 0.16)';
const COLOR_INK = '#f8fafc';
const COLOR_INK_MUTED = '#94a3b8';

/**
 * Resolves a relative asset path inside `out/<week>/` via Remotion's `staticFile()`,
 * or passes through remote `http(s)://` / `data:` URLs unchanged.
 */
export function resolveAssetSrc(assetPath: string): string {
  const trimmed = assetPath.trim();
  if (!trimmed) {
    return '';
  }
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:')
  ) {
    return trimmed;
  }
  if (
    typeof window !== 'undefined' &&
    typeof window.remotion_staticBase === 'string' &&
    window.remotion_staticBase.length > 0 &&
    trimmed.startsWith(window.remotion_staticBase)
  ) {
    return trimmed;
  }
  return staticFile(trimmed.replace(/^\/+/, ''));
}

/**
 * Flattens caption chunks into an ordered list of word timings for cue resolution.
 */
export function flattenCaptionWords(captions: readonly CaptionChunk[]): WordTiming[] {
  const words: WordTiming[] = [];
  for (const chunk of captions) {
    for (const word of chunk.words) {
      words.push(word);
    }
  }
  return words;
}

export interface KineticTitleWordState {
  word: string;
  index: number;
  delayFrames: number;
  progress: number;
  opacity: number;
  translateY: number;
  scale: number;
}

/**
 * Pure frame-deterministic helper computing word-by-word spring states for the Intro kinetic title.
 * Stagger is bounded so every word is readable by `THUMBNAIL_FRAME` (frame 15 at 30fps).
 */
export function computeKineticTitleWordStates(
  title: string,
  frame: number,
  fps: number = VIDEO_FPS
): KineticTitleWordState[] {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : VIDEO_FPS;
  const words = title
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length === 0) {
    return [];
  }

  const maxStaggerFrames = 6;
  const step =
    words.length > 1 ? Math.min(1.2, maxStaggerFrames / (words.length - 1)) : 0;

  return words.map((word, index) => {
    const delayFrames = Number((index * step).toFixed(2));
    const localFrame = Math.max(0, frame - delayFrames);
    const progress = spring({
      frame: localFrame,
      fps: safeFps,
      config: {
        damping: 16,
        stiffness: 220,
        mass: 0.65,
      },
    });

    const opacity = Number(
      interpolate(localFrame, [0, 5], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      }).toFixed(4)
    );
    const translateY = Number(interpolate(progress, [0, 1], [24, 0]).toFixed(2));
    const scale = Number(interpolate(progress, [0, 1], [0.92, 1]).toFixed(4));

    return {
      word,
      index,
      delayFrames,
      progress: Number(progress.toFixed(4)),
      opacity,
      translateY,
      scale,
    };
  });
}

export interface IntroCaptureCardState {
  storyIndex: number;
  domain: string;
  source: string;
  headline: string;
  screenshotSrc: string;
  delayFrames: number;
  progress: number;
  opacity: number;
  translateX: number;
  translateY: number;
  rotateDeg: number;
  scale: number;
}

const CARD_STACK_ROTATIONS_DEG = [-6, 4.5, -2.5, 2] as const;

/**
 * Pure frame-deterministic helper extracting the week's page captures and computing their
 * flying-in card stack transforms for the Intro montage. Returns `[]` when no stories have page captures.
 */
export function computeIntroCardStackStates(
  stories: readonly StorySceneItem[] | undefined,
  frame: number,
  fps: number = VIDEO_FPS,
  maxCards: number = 4
): IntroCaptureCardState[] {
  if (!stories || stories.length === 0) {
    return [];
  }

  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : VIDEO_FPS;
  const captured: Array<{
    story: StorySceneItem;
    page: NormalizedStoryPage;
  }> = [];

  for (const story of stories) {
    const normalized = normalizeStoryPage(story.page);
    if (normalized) {
      captured.push({ story, page: normalized });
    }
    if (captured.length >= Math.max(1, maxCards)) {
      break;
    }
  }

  if (captured.length === 0) {
    return [];
  }

  const total = captured.length;
  return captured.map(({ story, page }, idx) => {
    const delayFrames = idx * 2;
    const localFrame = Math.max(0, frame - delayFrames);
    const progress = spring({
      frame: localFrame,
      fps: safeFps,
      config: {
        damping: 17,
        stiffness: 190,
        mass: 0.75,
      },
    });

    const depthFromFront = total - 1 - idx;
    const targetX = -depthFromFront * 18;
    const targetY = -depthFromFront * 14;
    const targetRotate =
      total === 1
        ? -2
        : CARD_STACK_ROTATIONS_DEG[idx % CARD_STACK_ROTATIONS_DEG.length];
    const targetScale = Number((1 - depthFromFront * 0.045).toFixed(4));

    const translateX = Number(
      interpolate(progress, [0, 1], [140 + idx * 24, targetX]).toFixed(2)
    );
    const translateY = Number(
      interpolate(progress, [0, 1], [72 + idx * 16, targetY]).toFixed(2)
    );
    const rotateDeg = Number(
      interpolate(progress, [0, 1], [targetRotate + 10, targetRotate]).toFixed(2)
    );
    const scale = Number(
      interpolate(progress, [0, 1], [0.84, targetScale]).toFixed(4)
    );
    const opacity = Number(
      interpolate(localFrame, [0, 6], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      }).toFixed(4)
    );

    return {
      storyIndex: story.index,
      domain: story.domain || extractHostname(story.url),
      source: story.source,
      headline: story.headline_tr,
      screenshotSrc: page.screenshotSrc,
      delayFrames,
      progress: Number(progress.toFixed(4)),
      opacity,
      translateX,
      translateY,
      rotateDeg,
      scale,
    };
  });
}

export interface StoryWalkthroughPlan {
  track: CameraTrack;
  cues: ResolvedCue[];
  page: NormalizedStoryPage | null;
}

/**
 * Pure helper building the camera track and resolved cues for a `StoryScene`:
 * - When `story.cues` are provided, resolves phrase anchor timings (`resolveCueTimes`)
 *   and element bounding boxes (`resolveCueTarget`), then builds the camera track (`buildCameraTrack`).
 * - When `story.cues` are empty or omitted, generates the heuristic `defaultChoreography`
 *   (`top -> h1 focus -> lede highlight -> first figure -> slow scroll`).
 */
export function buildStoryWalkthroughPlan(
  story: StorySceneItem,
  durationInFrames: number,
  fps: number = VIDEO_FPS
): StoryWalkthroughPlan {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : VIDEO_FPS;
  const page = normalizeStoryPage(story.page);
  const viewportWidth = page?.viewport.width ?? 1440;
  const viewportHeight = page?.viewport.height ?? 900;
  const pageHeight = page?.page_height ?? viewportHeight * 2;
  const elements = page?.elements ?? [];

  const rawCues = story.cues ?? [];
  if (rawCues.length > 0) {
    const wordTimings = flattenCaptionWords(story.captions);
    const timedCues = resolveCueTimes(rawCues, wordTimings, safeFps, {
      durationInFrames,
    });

    const resolvedCues: ResolvedCue[] = timedCues.map((rc, idx) => {
      const explicitBox = rawCues[idx]?.box ?? null;
      // Only an explicit target may place a cue on the page. Fuzzy-matching the Turkish
      // anchor phrase against English page text produced loose boxes on unrelated regions.
      const matchedBox =
        explicitBox ??
        (rc.target
          ? resolveCueTarget(rc.target, {
              elements,
              page_height: pageHeight,
              viewport: { width: viewportWidth, height: viewportHeight },
            })
          : null);
      return {
        ...rc,
        value: rawCues[idx]?.value ?? rc.value,
        box: matchedBox,
      };
    });

    const track = buildCameraTrack(
      resolvedCues,
      resolvedCues.map((c) => c.box ?? null),
      {
        width: viewportWidth,
        height: viewportHeight,
        pageHeight,
        durationInFrames,
      }
    );

    return {
      track,
      cues: dropOffscreenOverlayCues(resolvedCues, track, {
        viewportWidth,
        viewportHeight,
        pageHeight,
      }),
      page,
    };
  }

  const choreo = defaultChoreography(
    {
      elements,
      page_height: pageHeight,
      viewport: { width: viewportWidth, height: viewportHeight },
    },
    durationInFrames,
    {
      fps: safeFps,
      viewportWidth,
      viewportHeight,
      pageHeight,
    }
  );

  return {
    track: choreo,
    cues: choreo.cues,
    page,
  };
}

/** Cue kinds drawn on top of the page screenshot; they need a box that is on screen. */
const PAGE_OVERLAY_CUE_KINDS: ReadonlySet<string> = new Set([
  'focus',
  'image',
  'highlight',
  'circle',
  'underline',
  'arrow',
]);
/** Frames after a cue starts at which its target must be on screen (camera has settled). */
export const CUE_VISIBILITY_CHECK_OFFSET_FRAMES = 15;
/** Minimum share of the target box that must lie inside the visible camera window. */
export const CUE_MIN_VISIBLE_RATIO = 0.6;

/**
 * Returns the share (0..1) of `box` inside the page region the camera shows at `frame`.
 */
export function computeBoxVisibleRatio(
  track: CameraTrack,
  box: CueBoundingBox,
  frame: number,
  viewport: { viewportWidth: number; viewportHeight: number; pageHeight: number }
): number {
  if (!isDrawableBox(box)) {
    return 0;
  }
  const transform = computePageCameraTransform(track, frame, viewport);
  const scale = transform.scale > 0 ? transform.scale : 1;
  const left = -transform.translateX / scale;
  const top = -transform.translateY / scale;
  const right = left + viewport.viewportWidth / scale;
  const bottom = top + viewport.viewportHeight / scale;

  const overlapWidth = Math.max(0, Math.min(right, box.x + box.width) - Math.max(left, box.x));
  const overlapHeight = Math.max(0, Math.min(bottom, box.y + box.height) - Math.max(top, box.y));
  return (overlapWidth * overlapHeight) / (box.width * box.height);
}

/**
 * Clears the box of overlay cues (spotlight, highlighter, circle, underline, arrow) whose
 * target is missing or mostly off screen when the cue fires, so nothing is drawn on empty
 * space. Camera-only and callout cues (`scroll`, `stat`, `quote`) pass through unchanged.
 */
export function dropOffscreenOverlayCues(
  cues: readonly ResolvedCue[],
  track: CameraTrack,
  viewport: { viewportWidth: number; viewportHeight: number; pageHeight: number }
): ResolvedCue[] {
  return cues.map((cue) => {
    if (!PAGE_OVERLAY_CUE_KINDS.has(cue.kind)) {
      return cue;
    }
    if (!isDrawableBox(cue.box)) {
      return { ...cue, box: null };
    }
    const checkFrame = Math.min(
      cue.startFrame + CUE_VISIBILITY_CHECK_OFFSET_FRAMES,
      Math.max(cue.startFrame, cue.endFrame - 1)
    );
    const ratio = computeBoxVisibleRatio(track, cue.box, checkFrame, viewport);
    return ratio >= CUE_MIN_VISIBLE_RATIO ? cue : { ...cue, box: null };
  });
}

/**
 * Builds deterministic bounding boxes and hand-drawn annotations for headline keywords
 * when a story falls back to the OG image or branded card stage. The returned boxes are
 * the exact chip positions `KeywordChipLayer` renders, so each annotation lands on its chip.
 */
export function buildOgKeywordAnnotations(
  headline: string,
  durationInFrames: number,
  storyIndex: number = 1,
  canvasWidth: number = 1440,
  canvasHeight: number = 900,
  layout?: { baseY?: number; align?: 'center' | 'left'; startX?: number }
): Array<{
  keyword: string;
  box: CueBoundingBox;
  annotation: AnnotationItemProps;
}> {
  const keywords = extractHeadlineKeywords(headline, 3);
  if (keywords.length === 0) {
    return [];
  }

  // Arrows need a meaningful origin; around a chip only a circle or underline reads well.
  const kinds: Array<'circle' | 'underline'> = ['circle', 'underline'];

  const count = keywords.length;
  const gap = 32;
  const totalWidth = Math.min(canvasWidth - 160, count * 280 + (count - 1) * gap);
  const align = layout?.align ?? 'center';
  const startX =
    layout?.startX ??
    (align === 'left' ? 0 : Math.max(80, Math.round((canvasWidth - totalWidth) / 2)));
  const pillWidth = Math.max(180, Math.floor((totalWidth - (count - 1) * gap) / count));
  const pillHeight = 64;
  const baseY = layout?.baseY ?? Math.round(canvasHeight * 0.24);
  const staggerY = layout?.baseY !== undefined ? 0 : 18;

  return keywords.map((keyword, idx) => {
    const x = startX + idx * (pillWidth + gap);
    const y = baseY + (idx % 2 === 1 ? staggerY : 0);
    const box: CueBoundingBox = {
      x,
      y,
      width: pillWidth,
      height: pillHeight,
    };

    const startFrame = Math.min(
      Math.max(12, Math.round(((idx + 1) / (count + 2)) * durationInFrames)),
      Math.max(12, durationInFrames - 30)
    );
    const endFrame = Math.max(startFrame + 36, Math.round(durationInFrames * 0.92));
    const kind = kinds[(storyIndex + idx) % kinds.length];

    return {
      keyword,
      box,
      annotation: {
        kind,
        targetBox: box,
        startFrame,
        endFrame,
        drawDurationInFrames: 20,
        storyIndex,
        cueIndex: idx,
        viewportWidth: canvasWidth,
      },
    };
  });
}

interface CaptionOverlayProps {
  captions: readonly CaptionChunk[];
  frameInScene: number;
  fps: number;
  slim?: boolean;
}

export const CaptionOverlay: React.FC<CaptionOverlayProps> = ({
  captions,
  frameInScene,
  fps,
  slim = true,
}) => {
  const active = getActiveCaptionAtFrame(captions, frameInScene, fps);
  if (!active.chunk) {
    return null;
  }

  return (
    <div
      data-component="caption-overlay"
      data-slim={slim ? 'true' : 'false'}
      style={{
        position: 'absolute',
        left: 72,
        right: 72,
        bottom: slim ? 24 : 54,
        zIndex: 40,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          backgroundColor: slim ? 'rgba(9, 13, 22, 0.82)' : 'rgba(9, 13, 22, 0.88)',
          border: `1px solid ${COLOR_BORDER}`,
          borderRadius: slim ? 999 : 18,
          padding: slim ? '10px 26px' : '18px 34px',
          boxShadow: '0 14px 36px rgba(0, 0, 0, 0.5)',
          backdropFilter: 'blur(10px)',
          maxWidth: slim ? 1360 : 1520,
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: slim ? '6px 10px' : '10px 14px',
        }}
      >
        {active.chunk.words.map((wordTiming, idx) => {
          const isCurrent = idx === active.activeWordIndex;
          const isSpoken = idx < active.activeWordIndex;
          return (
            <span
              key={`${wordTiming.start}-${idx}`}
              style={{
                fontFamily: FONT_SANS,
                fontSize: slim ? 28 : 40,
                fontWeight: 700,
                lineHeight: 1.2,
                letterSpacing: '-0.01em',
                color: isCurrent
                  ? COLOR_ACCENT
                  : isSpoken
                    ? COLOR_INK
                    : 'rgba(248, 250, 252, 0.72)',
                transform: isCurrent ? 'scale(1.04)' : 'scale(1)',
                display: 'inline-block',
              }}
            >
              {wordTiming.word}
            </span>
          );
        })}
      </div>
    </div>
  );
};

export interface IntroProps {
  week: string;
  title_tr: string;
  siteUrl: string;
  storyCount: number;
  intro: SceneAudioProps;
  stories?: readonly StorySceneItem[];
}

export const Intro: React.FC<IntroProps> = ({
  week,
  title_tr,
  siteUrl,
  storyCount,
  intro,
  stories,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const eyebrowOpacity = interpolate(frame, [0, 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const eyebrowTranslateY = interpolate(frame, [0, 12], [14, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const wordStates = useMemo(
    () => computeKineticTitleWordStates(title_tr, frame, fps),
    [title_tr, frame, fps]
  );

  const cardStack = useMemo(
    () => computeIntroCardStackStates(stories, frame, fps, 4),
    [stories, frame, fps]
  );
  const hasCardStack = cardStack.length > 0;

  const resolvedAudio = resolveAssetSrc(intro.audioSrc);

  return (
    <AbsoluteFill
      data-scene="intro"
      data-has-card-stack={hasCardStack ? 'true' : 'false'}
      style={{
        backgroundColor: COLOR_BG_DEEP,
        backgroundImage:
          'radial-gradient(circle at 20% 20%, rgba(245, 158, 11, 0.14), transparent 48%), radial-gradient(circle at 80% 80%, rgba(59, 130, 246, 0.12), transparent 52%)',
        color: COLOR_INK,
        fontFamily: FONT_SANS,
        padding: '88px 112px 160px 112px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}
    >
      {resolvedAudio ? <Audio src={resolvedAudio} /> : null}

      {/* Top Branding Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: `1px solid ${COLOR_BORDER}`,
          paddingBottom: 28,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <div
            style={{
              width: 16,
              height: 16,
              borderRadius: 999,
              backgroundColor: COLOR_ACCENT,
              boxShadow: `0 0 20px ${COLOR_ACCENT}`,
            }}
          />
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: '0.04em',
              color: COLOR_INK,
            }}
          >
            {siteUrl}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 24,
              fontWeight: 600,
              color: COLOR_ACCENT,
              backgroundColor: COLOR_ACCENT_SOFT,
              border: '1px solid rgba(245, 158, 11, 0.4)',
              borderRadius: 10,
              padding: '8px 20px',
            }}
          >
            {week}
          </span>
          {storyCount > 0 ? (
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 22,
                color: COLOR_INK_MUTED,
                border: `1px solid ${COLOR_BORDER}`,
                borderRadius: 10,
                padding: '8px 18px',
              }}
            >
              {storyCount} Öne Çıkan Haber
            </span>
          ) : null}
        </div>
      </div>

      {/* Center Hero: Kinetic Word-by-Word Title + Optional Page Capture Card Stack Montage */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 56,
          marginTop: 'auto',
          marginBottom: 'auto',
          width: '100%',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 28,
            maxWidth: hasCardStack ? 1040 : 1560,
            flex: 1,
          }}
        >
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 24,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.16em',
              color: COLOR_ACCENT,
              opacity: eyebrowOpacity,
              transform: `translateY(${eyebrowTranslateY.toFixed(2)}px)`,
            }}
          >
            Haftalık Teknoloji ve Yazılım Özeti
          </div>

          <h1
            data-component="intro-kinetic-title"
            style={{
              fontSize: hasCardStack ? 68 : 76,
              fontWeight: 800,
              lineHeight: 1.14,
              letterSpacing: '-0.025em',
              margin: 0,
              color: COLOR_INK,
              display: 'flex',
              flexWrap: 'wrap',
              gap: '8px 18px',
            }}
          >
            {wordStates.map((ws) => (
              <span
                key={`title-word-${ws.index}-${ws.word}`}
                data-word-index={ws.index}
                style={{
                  display: 'inline-block',
                  opacity: ws.opacity,
                  transform: `translate3d(0, ${ws.translateY}px, 0) scale(${ws.scale})`,
                  transformOrigin: 'center bottom',
                }}
              >
                {ws.word}
              </span>
            ))}
          </h1>
        </div>

        {hasCardStack ? (
          <div
            data-component="intro-card-stack"
            style={{
              position: 'relative',
              width: 560,
              height: 400,
              flexShrink: 0,
            }}
          >
            {cardStack.map((card, idx) => {
              const badge = getSourceBadgeTheme(card.source);
              const resolvedSrc = resolveAssetSrc(card.screenshotSrc);
              return (
                <div
                  key={`intro-card-${card.storyIndex}-${idx}`}
                  data-card-story-index={card.storyIndex}
                  style={{
                    position: 'absolute',
                    right: 12,
                    bottom: 12,
                    width: 500,
                    height: 336,
                    borderRadius: 16,
                    overflow: 'hidden',
                    backgroundColor: '#0f172a',
                    border: '1px solid rgba(248, 250, 252, 0.22)',
                    boxShadow:
                      '0 24px 60px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(245, 158, 11, 0.14)',
                    display: 'flex',
                    flexDirection: 'column',
                    opacity: card.opacity,
                    transform: `translate3d(${card.translateX}px, ${card.translateY}px, 0) rotate(${card.rotateDeg}deg) scale(${card.scale})`,
                    transformOrigin: 'center center',
                    zIndex: idx + 1,
                  }}
                >
                  {/* Mini Browser Header */}
                  <div
                    style={{
                      height: 34,
                      backgroundColor: '#111827',
                      borderBottom: '1px solid rgba(148, 163, 184, 0.2)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0 14px',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          backgroundColor: '#ef4444',
                        }}
                      />
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          backgroundColor: '#f59e0b',
                        }}
                      />
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          backgroundColor: '#10b981',
                        }}
                      />
                      <span
                        style={{
                          fontFamily: FONT_MONO,
                          fontSize: 12,
                          color: COLOR_INK_MUTED,
                          marginLeft: 6,
                          maxWidth: 240,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {card.domain}
                      </span>
                    </div>
                    <span
                      style={{
                        fontFamily: FONT_MONO,
                        fontSize: 11,
                        fontWeight: 700,
                        color: badge.textColor,
                        backgroundColor: badge.backgroundColor,
                        border: `1px solid ${badge.borderColor}`,
                        borderRadius: 999,
                        padding: '1px 8px',
                      }}
                    >
                      #{card.storyIndex} {badge.label}
                    </span>
                  </div>

                  {/* Page Capture Preview */}
                  <div
                    style={{
                      position: 'relative',
                      flex: 1,
                      width: '100%',
                      overflow: 'hidden',
                      backgroundColor: COLOR_BG_CARD,
                    }}
                  >
                    {resolvedSrc ? (
                      <Img
                        src={resolvedSrc}
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          objectPosition: 'top center',
                        }}
                      />
                    ) : null}
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        background:
                          'linear-gradient(180deg, rgba(9, 13, 22, 0.05) 0%, rgba(9, 13, 22, 0.86) 100%)',
                        display: 'flex',
                        alignItems: 'flex-end',
                        padding: '14px 16px',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: FONT_SANS,
                          fontSize: 16,
                          fontWeight: 700,
                          lineHeight: 1.25,
                          color: COLOR_INK,
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {card.headline}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <CaptionOverlay captions={intro.captions} frameInScene={frame} fps={fps} />
    </AbsoluteFill>
  );
};

const OG_KEYWORD_CANVAS_WIDTH = 1440;
const OG_KEYWORD_CANVAS_HEIGHT = 900;
const CARD_CHIP_ROW_WIDTH = 1280;
const CARD_CHIP_ROW_HEIGHT = 96;
const CARD_CHIP_ROW_PADDING_X = 8;
const CARD_CHIP_ROW_PADDING_Y = 16;
const KEYWORD_CHIP_FADE_FRAMES = 6;

interface KeywordChipLayerProps {
  items: ReadonlyArray<{ keyword: string; box: CueBoundingBox; annotation: AnnotationItemProps }>;
  frame: number;
  storyIndex: number;
  width: number;
  height: number;
  fontSize: number;
  prefix?: string;
}

/**
 * Renders keyword chips at the exact boxes from `buildOgKeywordAnnotations` and draws each
 * chip's annotation in the same fixed-size coordinate space, so a circle or underline always
 * sits on its chip instead of on empty space.
 */
const KeywordChipLayer: React.FC<KeywordChipLayerProps> = ({
  items,
  frame,
  storyIndex,
  width,
  height,
  fontSize,
  prefix = '',
}) => (
  <div
    data-component="keyword-chip-layer"
    style={{ position: 'absolute', left: 0, top: 0, width, height, pointerEvents: 'none' }}
  >
    {items.map((item, idx) => {
      const chipStart = item.annotation.startFrame ?? 0;
      const chipOpacity = interpolate(
        frame,
        [chipStart - KEYWORD_CHIP_FADE_FRAMES, chipStart + KEYWORD_CHIP_FADE_FRAMES],
        [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
      );
      return (
        <div
          key={`${item.keyword}-${idx}`}
          data-keyword-chip={item.keyword}
          style={{
            position: 'absolute',
            left: item.box.x,
            top: item.box.y,
            width: item.box.width,
            height: item.box.height,
            backgroundColor: 'rgba(15, 23, 42, 0.86)',
            border: '1px solid rgba(248, 250, 252, 0.28)',
            borderRadius: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 18px',
            boxSizing: 'border-box',
            boxShadow: '0 16px 36px rgba(0, 0, 0, 0.5)',
            opacity: chipOpacity,
          }}
        >
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize,
              fontWeight: 700,
              color: COLOR_INK,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {prefix}
            {item.keyword}
          </span>
        </div>
      );
    })}
    <Annotations
      annotations={items.map((k) => k.annotation)}
      storyIndex={storyIndex}
      canvasWidth={width}
      canvasHeight={height}
    />
  </div>
);

interface BrandedFallbackCardProps {
  story: StorySceneItem;
  storyCount: number;
  week: string;
  siteUrl: string;
  durationInFrames?: number;
  frame?: number;
}

/**
 * BrandedFallbackCard: level-3 fallback visual when neither page capture nor OG image is available.
 * Note: `summary_tr` is intentionally NOT rendered on screen (since it is already spoken);
 * displays the domain, headline, and keyword tags instead.
 */
export const BrandedFallbackCard: React.FC<BrandedFallbackCardProps> = ({
  story,
  storyCount,
  week,
  siteUrl,
  durationInFrames = 180,
  frame = 0,
}) => {
  const badge = getSourceBadgeTheme(story.source);
  const domain = story.domain || extractHostname(story.url) || siteUrl;
  const keywordItems = buildOgKeywordAnnotations(
    story.headline_tr,
    durationInFrames,
    story.index,
    CARD_CHIP_ROW_WIDTH,
    CARD_CHIP_ROW_HEIGHT,
    { baseY: CARD_CHIP_ROW_PADDING_Y, align: 'left', startX: CARD_CHIP_ROW_PADDING_X }
  );

  return (
    <div
      data-fallback-stage="card"
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: COLOR_BG_CARD,
        backgroundImage:
          'linear-gradient(135deg, rgba(245, 158, 11, 0.12) 0%, rgba(17, 24, 39, 0.96) 55%, rgba(30, 41, 59, 0.92) 100%)',
        padding: '56px 72px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        boxSizing: 'border-box',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 22,
            fontWeight: 700,
            color: badge.textColor,
            backgroundColor: badge.backgroundColor,
            border: `1px solid ${badge.borderColor}`,
            borderRadius: 10,
            padding: '8px 18px',
          }}
        >
          {badge.label}
        </span>
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 22,
            color: COLOR_INK_MUTED,
          }}
        >
          #{story.index} / {storyCount}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
          maxWidth: 1280,
          zIndex: 2,
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 28,
            color: COLOR_ACCENT,
            letterSpacing: '0.02em',
          }}
        >
          {domain}
        </div>
        <div
          style={{
            fontSize: 52,
            fontWeight: 800,
            lineHeight: 1.2,
            letterSpacing: '-0.02em',
            color: '#f8fafc',
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {story.headline_tr}
        </div>

        {keywordItems.length > 0 ? (
          // Fixed-size layer: chips and their annotations share one pixel coordinate space.
          <div
            style={{
              position: 'relative',
              width: CARD_CHIP_ROW_WIDTH,
              height: CARD_CHIP_ROW_HEIGHT,
              marginTop: 8,
            }}
          >
            <KeywordChipLayer
              items={keywordItems}
              frame={frame}
              storyIndex={story.index}
              width={CARD_CHIP_ROW_WIDTH}
              height={CARD_CHIP_ROW_HEIGHT}
              fontSize={22}
              prefix="#"
            />
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderTop: `1px solid ${COLOR_BORDER}`,
          paddingTop: 22,
          fontFamily: FONT_MONO,
          fontSize: 20,
          color: COLOR_INK_MUTED,
        }}
      >
        <span>{siteUrl}</span>
        <span>{week}</span>
      </div>
    </div>
  );
};

interface CornerBadgeChipProps {
  storyIndex: number;
  storyCount: number;
  source: string;
  domain: string;
}

/**
 * Compact corner chip displaying Story Counter + Source Badge (`#1/5 • HN • domain`).
 */
export const CornerBadgeChip: React.FC<CornerBadgeChipProps> = ({
  storyIndex,
  storyCount,
  source,
  domain,
}) => {
  const badge = getSourceBadgeTheme(source);

  return (
    <div
      data-component="story-corner-chip"
      style={{
        position: 'absolute',
        top: 84,
        right: 54,
        zIndex: 35,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        backgroundColor: 'rgba(9, 13, 22, 0.86)',
        border: `1px solid ${COLOR_BORDER}`,
        borderRadius: 999,
        padding: '8px 18px',
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.5)',
        backdropFilter: 'blur(10px)',
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: 18,
          fontWeight: 700,
          color: COLOR_ACCENT,
          letterSpacing: '0.03em',
        }}
      >
        #{storyIndex}/{storyCount}
      </span>

      <span
        style={{
          width: 4,
          height: 4,
          borderRadius: 999,
          backgroundColor: COLOR_INK_MUTED,
        }}
      />

      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: 17,
          fontWeight: 700,
          color: badge.textColor,
          backgroundColor: badge.backgroundColor,
          border: `1px solid ${badge.borderColor}`,
          borderRadius: 999,
          padding: '2px 12px',
        }}
      >
        {badge.label}
      </span>

      {domain ? (
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 16,
            color: COLOR_INK_MUTED,
            maxWidth: 240,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {domain}
        </span>
      ) : null}
    </div>
  );
};

interface HeadlineLowerThirdProps {
  headline: string;
  domain: string;
  frameInScene: number;
  fps: number;
}

/**
 * Animated lower-third headline:
 * - Slides in cleanly at the start of the story scene.
 * - Collapses into a small compact chip after ~3s (`LOWER_THIRD_COLLAPSE_SECONDS`)
 *   so the article walkthrough remains unobstructed.
 */
export const HeadlineLowerThird: React.FC<HeadlineLowerThirdProps> = ({
  headline,
  domain,
  frameInScene,
  fps,
}) => {
  const state = computeHeadlineLowerThirdState(frameInScene, fps);
  const t = state.collapseProgress;

  const maxWidth = Math.round(interpolate(t, [0, 1], [1180, 560]));
  const paddingY = Math.round(interpolate(t, [0, 1], [22, 10]));
  const paddingX = Math.round(interpolate(t, [0, 1], [30, 18]));
  const fontSize = Number(interpolate(t, [0, 1], [38, 20]).toFixed(2));
  const borderRadius = Math.round(interpolate(t, [0, 1], [20, 999]));
  const bottomOffset = Math.round(interpolate(t, [0, 1], [108, 96]));

  return (
    <div
      data-component="headline-lower-third"
      data-collapsed={state.collapsed ? 'true' : 'false'}
      style={{
        position: 'absolute',
        left: 54,
        bottom: bottomOffset,
        zIndex: 35,
        maxWidth,
        backgroundColor: 'rgba(9, 13, 22, 0.90)',
        border: `1px solid rgba(245, 158, 11, ${Number(interpolate(t, [0, 1], [0.55, 0.35]).toFixed(2))})`,
        borderLeft: `${Math.round(interpolate(t, [0, 1], [6, 3]))}px solid ${COLOR_ACCENT}`,
        borderRadius,
        padding: `${paddingY}px ${paddingX}px`,
        boxShadow: '0 20px 48px rgba(0, 0, 0, 0.58)',
        backdropFilter: 'blur(12px)',
        opacity: state.opacity,
        transform: `translate3d(0, ${state.translateY}px, 0)`,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: t < 0.5 ? 6 : 0,
      }}
    >
      {t < 0.6 && domain ? (
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 15,
            fontWeight: 600,
            color: COLOR_ACCENT,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            opacity: Number(interpolate(t, [0, 0.5], [1, 0], { extrapolateRight: 'clamp' }).toFixed(2)),
          }}
        >
          {domain}
        </span>
      ) : null}

      <div
        style={{
          fontFamily: FONT_SANS,
          fontSize,
          fontWeight: 800,
          lineHeight: state.collapsed ? 1.2 : 1.22,
          letterSpacing: '-0.015em',
          color: COLOR_INK,
          whiteSpace: state.collapsed ? 'nowrap' : 'normal',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: state.collapsed ? 'block' : '-webkit-box',
          WebkitLineClamp: state.collapsed ? 1 : 2,
          WebkitBoxOrient: 'vertical',
        }}
      >
        {headline}
      </div>
    </div>
  );
};

interface OgFallbackStageProps {
  story: StorySceneItem;
  resolvedImage: string;
  durationInFrames: number;
  frame: number;
  onImageError: () => void;
  cues: readonly ResolvedCue[];
}

/**
 * Level-2 fallback visual: OG image with Ken Burns zoom/pan + keyword pills & hand-drawn annotations.
 */
const OgFallbackStage: React.FC<OgFallbackStageProps> = ({
  story,
  resolvedImage,
  durationInFrames,
  frame,
  onImageError,
  cues,
}) => {
  const kenBurns = computeKenBurnsTransform(
    frame,
    durationInFrames,
    story.index - 1
  );

  const keywordItems = useMemo(
    () =>
      buildOgKeywordAnnotations(
        story.headline_tr,
        durationInFrames,
        story.index,
        OG_KEYWORD_CANVAS_WIDTH,
        OG_KEYWORD_CANVAS_HEIGHT
      ),
    [story.headline_tr, durationInFrames, story.index]
  );

  const statCues = cues.filter((c) => c.kind === 'stat');
  const quoteCues = cues.filter((c) => c.kind === 'quote');

  return (
    <div
      data-fallback-stage="og"
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        backgroundColor: COLOR_BG_CARD,
      }}
    >
      <Img
        src={resolvedImage}
        onError={onImageError}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `scale(${kenBurns.scale}) translate3d(${kenBurns.translateX}px, ${kenBurns.translateY}px, 0)`,
          transformOrigin: 'center center',
        }}
      />

      {/* Subtle dark vignette so keyword annotations and HUD pop against bright OG images */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'linear-gradient(180deg, rgba(9, 13, 22, 0.45) 0%, rgba(9, 13, 22, 0.18) 45%, rgba(9, 13, 22, 0.72) 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* Headline keyword callout pills + hand-drawn annotations */}
      {keywordItems.length > 0 ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
          }}
        >
          <KeywordChipLayer
            items={keywordItems}
            frame={frame}
            storyIndex={story.index}
            width={OG_KEYWORD_CANVAS_WIDTH}
            height={OG_KEYWORD_CANVAS_HEIGHT}
            fontSize={24}
          />
        </div>
      ) : null}

      {statCues.map((cue) => (
        <StatCallout
          key={`stat-${cue.index}`}
          value={cue.value || cue.target || cue.anchor}
          startFrame={cue.startFrame}
          endFrame={cue.endFrame}
          position="top-left"
        />
      ))}

      {quoteCues.map((cue) => (
        <QuoteCallout
          key={`quote-${cue.index}`}
          quote={cue.value || cue.target || cue.anchor}
          attribution={story.domain || extractHostname(story.url)}
          startFrame={cue.startFrame}
          endFrame={cue.endFrame}
          position="bottom-right"
        />
      ))}
    </div>
  );
};

export interface StorySceneProps {
  story: StorySceneItem;
  storyCount: number;
  durationInFrames: number;
  week: string;
  siteUrl: string;
}

/**
 * StoryScene: Full-bleed BrowserFrame + PageCamera walkthrough with:
 * - Camera track driven by LLM cues (`story.cues`) or heuristic `defaultChoreography`.
 * - Page-space motion primitives (`Spotlight`, `Highlighter`, hand-drawn `Annotations`) and
 *   screen-space callouts (`StatCallout`, `QuoteCallout`).
 * - Animated lower-third headline (`HeadlineLowerThird`) that slides in and collapses to a chip after ~3s.
 * - `summary_tr` removed from screen (already spoken).
 * - Compact corner chip (`CornerBadgeChip`) with story counter + source badge.
 * - Slimmer karaoke captions (`CaptionOverlay`).
 * - 3-level fallback ladder: `page capture -> OG image with Ken Burns + keyword annotations -> BrandedFallbackCard`.
 */
export const StoryScene: React.FC<StorySceneProps> = ({
  story,
  storyCount,
  durationInFrames,
  week,
  siteUrl,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const [pageLoadFailed, setPageLoadFailed] = useState(false);
  const [imageLoadFailed, setImageLoadFailed] = useState(false);

  const domain = story.domain || extractHostname(story.url);
  const resolvedAudio = resolveAssetSrc(story.audioSrc);

  const plan = useMemo(
    () => buildStoryWalkthroughPlan(story, durationInFrames, fps),
    [story, durationInFrames, fps]
  );

  const fallbackMode = resolveStoryFallbackMode(story, {
    pageLoadFailed,
    imageLoadFailed,
  });

  const resolvedPageScreenshot =
    plan.page && !pageLoadFailed ? resolveAssetSrc(plan.page.screenshotSrc) : '';
  const resolvedOgImage =
    story.imageSrc && !imageLoadFailed ? resolveAssetSrc(story.imageSrc) : '';

  const focusCues = plan.cues.filter(
    (c) => (c.kind === 'focus' || c.kind === 'image') && c.box
  );
  const highlightCues = plan.cues.filter((c) => c.kind === 'highlight' && c.box);
  const annotationCues = plan.cues.filter(
    (c) =>
      (c.kind === 'circle' || c.kind === 'underline' || c.kind === 'arrow') &&
      c.box
  );
  const statCues = plan.cues.filter((c) => c.kind === 'stat');
  const quoteCues = plan.cues.filter((c) => c.kind === 'quote');

  const pageWidth = plan.page?.viewport.width ?? 1440;
  const pageHeight = plan.page?.page_height ?? 1800;
  const viewportHeight = plan.page?.viewport.height ?? 900;

  return (
    <AbsoluteFill
      data-scene="story"
      data-fallback-mode={fallbackMode}
      style={{
        backgroundColor: COLOR_BG_DEEP,
        backgroundImage:
          'radial-gradient(circle at 85% 15%, rgba(245, 158, 11, 0.10), transparent 45%), radial-gradient(circle at 12% 85%, rgba(30, 64, 175, 0.14), transparent 50%)',
        color: COLOR_INK,
        fontFamily: FONT_SANS,
        padding: '20px 28px 24px 28px',
        boxSizing: 'border-box',
      }}
    >
      {resolvedAudio ? <Audio src={resolvedAudio} /> : null}

      {/* Full-bleed BrowserFrame wrapping the active fallback ladder stage */}
      <BrowserFrame
        url={story.url}
        domain={domain}
        badgeText={`${week}`}
        width="100%"
        height="100%"
        borderRadius={20}
      >
        {fallbackMode === 'page' && resolvedPageScreenshot ? (
          <PageCamera
            screenshotSrc={resolvedPageScreenshot}
            camera={plan.track}
            frame={frame}
            viewportWidth={pageWidth}
            viewportHeight={viewportHeight}
            pageHeight={pageHeight}
            onImageError={() => setPageLoadFailed(true)}
            screenOverlay={
              <>
                {statCues.map((cue) => (
                  <StatCallout
                    key={`stat-${cue.index}`}
                    value={cue.value || cue.target || cue.anchor}
                    startFrame={cue.startFrame}
                    endFrame={cue.endFrame}
                    position="top-left"
                  />
                ))}
                {quoteCues.map((cue) => (
                  <QuoteCallout
                    key={`quote-${cue.index}`}
                    quote={cue.value || cue.target || cue.anchor}
                    attribution={domain}
                    startFrame={cue.startFrame}
                    endFrame={cue.endFrame}
                    position="bottom-right"
                  />
                ))}
              </>
            }
          >
            {focusCues.map((cue) => (
              <Spotlight
                key={`spotlight-${cue.index}`}
                focusRect={cue.box}
                startFrame={cue.startFrame}
                endFrame={cue.endFrame}
                canvasWidth={pageWidth}
                canvasHeight={pageHeight}
              />
            ))}

            {highlightCues.map((cue) => (
              <Highlighter
                key={`highlighter-${cue.index}`}
                targetBox={cue.box}
                startFrame={cue.startFrame}
                endFrame={cue.endFrame}
                storyIndex={story.index}
                cueIndex={cue.index}
              />
            ))}

            {annotationCues.length > 0 ? (
              <Annotations
                cues={annotationCues}
                storyIndex={story.index}
                canvasWidth={pageWidth}
                canvasHeight={pageHeight}
              />
            ) : null}
          </PageCamera>
        ) : fallbackMode === 'og' && resolvedOgImage ? (
          <OgFallbackStage
            story={story}
            resolvedImage={resolvedOgImage}
            durationInFrames={durationInFrames}
            frame={frame}
            onImageError={() => setImageLoadFailed(true)}
            cues={plan.cues}
          />
        ) : (
          <BrandedFallbackCard
            story={story}
            storyCount={storyCount}
            week={week}
            siteUrl={siteUrl}
            durationInFrames={durationInFrames}
            frame={frame}
          />
        )}
      </BrowserFrame>

      {/* Compact corner chip: Story Counter + Source Badge */}
      <CornerBadgeChip
        storyIndex={story.index}
        storyCount={storyCount}
        source={story.source}
        domain={domain}
      />

      {/* Animated Lower-Third Headline (slides in, collapses to a small chip after ~3s) */}
      <HeadlineLowerThird
        headline={story.headline_tr}
        domain={domain}
        frameInScene={frame}
        fps={fps}
      />

      {/* Slimmer Karaoke Captions */}
      <CaptionOverlay
        captions={story.captions}
        frameInScene={frame}
        fps={fps}
        slim={true}
      />
    </AbsoluteFill>
  );
};

export interface OutroProps {
  week: string;
  siteUrl: string;
  outro: SceneAudioProps;
  stories?: readonly StorySceneItem[];
}

export const Outro: React.FC<OutroProps> = ({
  week,
  siteUrl,
  outro,
  stories,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const resolvedAudio = resolveAssetSrc(outro.audioSrc);
  const cleanSiteUrl = siteUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const weeklyUrl = `${cleanSiteUrl}/weekly/${week}`;
  const fullWeeklyHref = `https://${weeklyUrl}`;

  const contentOpacity = interpolate(frame, [10, 26], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const contentTranslateY = interpolate(frame, [10, 28], [22, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const previewStories = (stories ?? []).slice(0, 4);

  return (
    <AbsoluteFill
      data-scene="outro"
      style={{
        backgroundColor: COLOR_BG_DEEP,
        backgroundImage:
          'radial-gradient(circle at 50% 35%, rgba(245, 158, 11, 0.16), transparent 55%)',
        color: COLOR_INK,
        fontFamily: FONT_SANS,
        padding: '36px 56px 112px 56px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {resolvedAudio ? <Audio src={resolvedAudio} /> : null}

      <BrowserFrame
        url={fullWeeklyHref}
        typeStartFrame={2}
        typeDurationInFrames={24}
        typewriter={true}
        badgeText={`Haftalık Bülten • ${week}`}
        width="100%"
        height="100%"
        borderRadius={22}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            padding: '48px 64px',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            background:
              'linear-gradient(180deg, rgba(15, 23, 42, 0.96) 0%, rgba(9, 13, 22, 0.98) 100%)',
            opacity: contentOpacity,
            transform: `translate3d(0, ${contentTranslateY.toFixed(2)}px, 0)`,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              textAlign: 'center',
              gap: 20,
              marginTop: 'auto',
              marginBottom: 'auto',
            }}
          >
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 20,
                color: COLOR_ACCENT,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
              }}
            >
              Haftalık Arşiv • {week}
            </div>

            <h2
              style={{
                fontSize: 56,
                fontWeight: 800,
                lineHeight: 1.15,
                margin: 0,
                letterSpacing: '-0.02em',
                maxWidth: 1240,
              }}
            >
              Tüm Haber Bağlantıları ve Türkçe Özetler
            </h2>

            <div
              data-component="outro-weekly-url-pill"
              style={{
                fontFamily: FONT_MONO,
                fontSize: 38,
                fontWeight: 700,
                color: COLOR_ACCENT,
                backgroundColor: COLOR_ACCENT_SOFT,
                border: '2px solid rgba(245, 158, 11, 0.45)',
                borderRadius: 16,
                padding: '16px 36px',
              }}
            >
              {weeklyUrl}
            </div>

            {previewStories.length > 0 ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns:
                    previewStories.length > 1 ? 'repeat(2, minmax(0, 1fr))' : '1fr',
                  gap: 14,
                  width: '100%',
                  maxWidth: 1240,
                  marginTop: 12,
                  textAlign: 'left',
                }}
              >
                {previewStories.map((story) => {
                  const badge = getSourceBadgeTheme(story.source);
                  return (
                    <div
                      key={`outro-story-${story.index}`}
                      style={{
                        backgroundColor: 'rgba(17, 24, 39, 0.88)',
                        border: `1px solid ${COLOR_BORDER}`,
                        borderRadius: 12,
                        padding: '12px 18px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: FONT_MONO,
                          fontSize: 13,
                          fontWeight: 700,
                          color: badge.textColor,
                          backgroundColor: badge.backgroundColor,
                          border: `1px solid ${badge.borderColor}`,
                          borderRadius: 999,
                          padding: '2px 10px',
                          flexShrink: 0,
                        }}
                      >
                        #{story.index} {badge.label}
                      </span>
                      <span
                        style={{
                          fontSize: 18,
                          fontWeight: 600,
                          color: COLOR_INK,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {story.headline_tr}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>

          <p
            style={{
              fontSize: 26,
              color: COLOR_INK_MUTED,
              margin: 0,
              textAlign: 'center',
              lineHeight: 1.4,
            }}
          >
            Kanala abone olmayı unutmayın • Canlı haber akışı için{' '}
            <strong style={{ color: COLOR_INK }}>{cleanSiteUrl}</strong>
          </p>
        </div>
      </BrowserFrame>

      <CaptionOverlay captions={outro.captions} frameInScene={frame} fps={fps} />
    </AbsoluteFill>
  );
};

export const WeeklyVideo: React.FC<WeeklyVideoProps> = (props) => {
  const { fps } = useVideoConfig();
  const timeline = buildVideoTimeline(props, fps);
  const introTiming = timeline.scenes[0];
  const outroTiming = timeline.scenes[timeline.scenes.length - 1];

  const storiesStartFrame =
    timeline.scenes.length > 2
      ? timeline.scenes[1].startFrame
      : introTiming.startFrame + introTiming.durationInFrames;
  const storiesTotalDurationInFrames = Math.max(
    0,
    outroTiming.startFrame - storiesStartFrame
  );

  const storyTransitionItems: SceneTransitionItem[] = props.stories.map(
    (story, idx) => {
      const sceneTiming = timeline.scenes[idx + 1];
      const isLastStory = idx === props.stories.length - 1;
      return {
        id: `story-${story.index}-${story.url}`,
        durationInFrames: sceneTiming.durationInFrames,
        transitionAfter: isLastStory
          ? null
          : { durationInFrames: STORY_TRANSITION_FRAMES },
        render: () => (
          <StoryScene
            story={story}
            storyCount={props.stories.length}
            durationInFrames={sceneTiming.durationInFrames}
            week={props.week}
            siteUrl={props.siteUrl}
          />
        ),
      };
    }
  );

  return (
    <AbsoluteFill style={{ backgroundColor: COLOR_BG_DEEP }}>
      <Sequence
        name="Intro"
        from={introTiming.startFrame}
        durationInFrames={introTiming.durationInFrames}
      >
        <Intro
          week={props.week}
          title_tr={props.title_tr}
          siteUrl={props.siteUrl}
          storyCount={props.stories.length}
          intro={props.intro}
          stories={props.stories}
        />
      </Sequence>

      {storyTransitionItems.length > 0 && storiesTotalDurationInFrames > 0 ? (
        <Sequence
          name="Stories"
          from={storiesStartFrame}
          durationInFrames={storiesTotalDurationInFrames}
        >
          <StoryTransitionSeries
            scenes={storyTransitionItems}
            defaultTransitionFrames={STORY_TRANSITION_FRAMES}
          />
        </Sequence>
      ) : null}

      <Sequence
        name="Outro"
        from={outroTiming.startFrame}
        durationInFrames={outroTiming.durationInFrames}
      >
        <Outro
          week={props.week}
          siteUrl={props.siteUrl}
          outro={props.outro}
          stories={props.stories}
        />
      </Sequence>
    </AbsoluteFill>
  );
};
