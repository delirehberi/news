import React, { useMemo, useState } from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
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
  VIDEO_FPS,
  type NormalizedStoryPage,
  type SceneAudioProps,
  type StorySceneItem,
  type WeeklyVideoProps,
} from '../domain/timeline.ts';
import {
  Annotations,
  BrowserFrame,
  Highlighter,
  PageCamera,
  QuoteCallout,
  Spotlight,
  StatCallout,
  type AnnotationItemProps,
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
      const matchedBox =
        explicitBox ??
        resolveCueTarget(rc.target ?? rc.anchor, {
          elements,
          page_height: pageHeight,
          viewport: { width: viewportWidth, height: viewportHeight },
        });
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
      cues: resolvedCues,
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

/**
 * Builds deterministic bounding boxes and hand-drawn annotations for headline keywords
 * when a story falls back to the OG image stage (`og` mode).
 */
export function buildOgKeywordAnnotations(
  headline: string,
  durationInFrames: number,
  storyIndex: number = 1,
  canvasWidth: number = 1440,
  canvasHeight: number = 900
): Array<{
  keyword: string;
  box: CueBoundingBox;
  annotation: AnnotationItemProps;
}> {
  const keywords = extractHeadlineKeywords(headline, 3);
  if (keywords.length === 0) {
    return [];
  }

  const kinds: Array<'circle' | 'underline' | 'arrow'> = [
    'circle',
    'underline',
    'arrow',
  ];

  const count = keywords.length;
  const totalWidth = Math.min(canvasWidth - 160, count * 280 + (count - 1) * 32);
  const startX = Math.max(80, Math.round((canvasWidth - totalWidth) / 2));
  const pillWidth = Math.max(180, Math.floor((totalWidth - (count - 1) * 32) / count));
  const pillHeight = 64;
  const baseY = Math.round(canvasHeight * 0.24);

  return keywords.map((keyword, idx) => {
    const x = startX + idx * (pillWidth + 32);
    const y = baseY + (idx % 2 === 1 ? 18 : 0);
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
}

export const Intro: React.FC<IntroProps> = ({
  week,
  title_tr,
  siteUrl,
  storyCount,
  intro,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entranceOpacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const entranceTranslateY = interpolate(frame, [0, 18], [28, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const resolvedAudio = resolveAssetSrc(intro.audioSrc);

  return (
    <AbsoluteFill
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

      {/* Center Hero Title */}
      <div
        style={{
          opacity: entranceOpacity,
          transform: `translateY(${entranceTranslateY}px)`,
          display: 'flex',
          flexDirection: 'column',
          gap: 28,
          maxWidth: 1560,
          marginTop: 'auto',
          marginBottom: 'auto',
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
          }}
        >
          Haftalık Teknoloji ve Yazılım Özeti
        </div>
        <h1
          style={{
            fontSize: 76,
            fontWeight: 800,
            lineHeight: 1.12,
            letterSpacing: '-0.025em',
            margin: 0,
            color: COLOR_INK,
          }}
        >
          {title_tr}
        </h1>
      </div>

      <CaptionOverlay captions={intro.captions} frameInScene={frame} fps={fps} />
    </AbsoluteFill>
  );
};

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
  const keywords = extractHeadlineKeywords(story.headline_tr, 3);
  const keywordAnnotations = buildOgKeywordAnnotations(
    story.headline_tr,
    durationInFrames,
    story.index,
    1440,
    820
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

        {keywords.length > 0 ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 16,
              marginTop: 8,
            }}
          >
            {keywords.map((kw, idx) => (
              <span
                key={`${kw}-${idx}`}
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 22,
                  fontWeight: 600,
                  color: COLOR_INK,
                  backgroundColor: 'rgba(15, 23, 42, 0.85)',
                  border: `1px solid ${COLOR_BORDER}`,
                  borderRadius: 12,
                  padding: '10px 22px',
                }}
              >
                #{kw}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {/* Subtle hand-drawn annotations on fallback card */}
      {keywordAnnotations.length > 0 && frame >= 0 ? (
        <Annotations
          annotations={keywordAnnotations.map((k) => k.annotation)}
          storyIndex={story.index}
          canvasWidth={1440}
          canvasHeight={820}
        />
      ) : null}

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
        1440,
        900
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
          {keywordItems.map((item, idx) => {
            const pillOpacity = interpolate(
              frame,
              [
                (item.annotation.startFrame ?? 12) - 6,
                (item.annotation.startFrame ?? 12) + 6,
              ],
              [0, 1],
              { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
            );
            return (
              <div
                key={`${item.keyword}-${idx}`}
                data-og-keyword={item.keyword}
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
                  opacity: pillOpacity,
                }}
              >
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 24,
                    fontWeight: 700,
                    color: COLOR_INK,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {item.keyword}
                </span>
              </div>
            );
          })}

          <Annotations
            annotations={keywordItems.map((k) => k.annotation)}
            storyIndex={story.index}
            canvasWidth={1440}
            canvasHeight={900}
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
}

export const Outro: React.FC<OutroProps> = ({ week, siteUrl, outro }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const resolvedAudio = resolveAssetSrc(outro.audioSrc);
  const weeklyUrl = `${siteUrl.replace(/\/+$/, '')}/weekly/${week}`;

  const entranceOpacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLOR_BG_DEEP,
        backgroundImage:
          'radial-gradient(circle at 50% 35%, rgba(245, 158, 11, 0.16), transparent 55%)',
        color: COLOR_INK,
        fontFamily: FONT_SANS,
        padding: '88px 112px 168px 112px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        alignItems: 'center',
        textAlign: 'center',
      }}
    >
      {resolvedAudio ? <Audio src={resolvedAudio} /> : null}

      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 24,
          color: COLOR_ACCENT,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
        }}
      >
        Haftalık Bülten • {week}
      </div>

      <div
        style={{
          opacity: entranceOpacity,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 32,
          maxWidth: 1380,
        }}
      >
        <h2
          style={{
            fontSize: 68,
            fontWeight: 800,
            lineHeight: 1.15,
            margin: 0,
            letterSpacing: '-0.02em',
          }}
        >
          Tüm Haber Bağlantıları ve Türkçe Özetler
        </h2>

        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 44,
            fontWeight: 700,
            color: COLOR_ACCENT,
            backgroundColor: COLOR_ACCENT_SOFT,
            border: '2px solid rgba(245, 158, 11, 0.45)',
            borderRadius: 18,
            padding: '20px 42px',
          }}
        >
          {weeklyUrl}
        </div>

        <p
          style={{
            fontSize: 32,
            color: COLOR_INK_MUTED,
            margin: 0,
            lineHeight: 1.45,
          }}
        >
          Kanala abone olmayı unutmayın • Canlı haber akışı için{' '}
          <strong style={{ color: COLOR_INK }}>{siteUrl}</strong>
        </p>
      </div>

      <CaptionOverlay captions={outro.captions} frameInScene={frame} fps={fps} />
    </AbsoluteFill>
  );
};

export const WeeklyVideo: React.FC<WeeklyVideoProps> = (props) => {
  const { fps } = useVideoConfig();
  const timeline = buildVideoTimeline(props, fps);
  const introTiming = timeline.scenes[0];
  const outroTiming = timeline.scenes[timeline.scenes.length - 1];

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
        />
      </Sequence>

      {props.stories.map((story, idx) => {
        const sceneTiming = timeline.scenes[idx + 1];
        return (
          <Sequence
            key={`story-${story.index}-${story.url}`}
            name={`Story ${story.index}`}
            from={sceneTiming.startFrame}
            durationInFrames={sceneTiming.durationInFrames}
          >
            <StoryScene
              story={story}
              storyCount={props.stories.length}
              durationInFrames={sceneTiming.durationInFrames}
              week={props.week}
              siteUrl={props.siteUrl}
            />
          </Sequence>
        );
      })}

      <Sequence
        name="Outro"
        from={outroTiming.startFrame}
        durationInFrames={outroTiming.durationInFrames}
      >
        <Outro week={props.week} siteUrl={props.siteUrl} outro={props.outro} />
      </Sequence>
    </AbsoluteFill>
  );
};
