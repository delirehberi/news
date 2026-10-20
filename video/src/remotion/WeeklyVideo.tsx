import React, { useState } from 'react';
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
import type { CaptionChunk } from '../domain/captions.ts';
import {
  buildVideoTimeline,
  computeKenBurnsTransform,
  extractHostname,
  getActiveCaptionAtFrame,
  getSourceBadgeTheme,
  type SceneAudioProps,
  type StorySceneItem,
  type WeeklyVideoProps,
} from '../domain/timeline.ts';

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

interface CaptionOverlayProps {
  captions: readonly CaptionChunk[];
  frameInScene: number;
  fps: number;
}

export const CaptionOverlay: React.FC<CaptionOverlayProps> = ({
  captions,
  frameInScene,
  fps,
}) => {
  const active = getActiveCaptionAtFrame(captions, frameInScene, fps);
  if (!active.chunk) {
    return null;
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: 96,
        right: 96,
        bottom: 54,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          backgroundColor: 'rgba(9, 13, 22, 0.88)',
          border: `1px solid ${COLOR_BORDER}`,
          borderRadius: 18,
          padding: '18px 34px',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.55)',
          maxWidth: 1520,
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: '10px 14px',
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
                fontSize: 40,
                fontWeight: 700,
                lineHeight: 1.25,
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
}

const BrandedFallbackCard: React.FC<BrandedFallbackCardProps> = ({
  story,
  storyCount,
  week,
  siteUrl,
}) => {
  const badge = getSourceBadgeTheme(story.source);
  const domain = story.domain || extractHostname(story.url) || siteUrl;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: COLOR_BG_CARD,
        backgroundImage:
          'linear-gradient(135deg, rgba(245, 158, 11, 0.10) 0%, rgba(17, 24, 39, 0.96) 55%, rgba(30, 41, 59, 0.9) 100%)',
        border: `1px solid ${COLOR_BORDER}`,
        borderRadius: 24,
        padding: 48,
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

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 26,
            color: COLOR_ACCENT,
            letterSpacing: '0.02em',
          }}
        >
          {domain}
        </div>
        <div
          style={{
            fontSize: 34,
            fontWeight: 600,
            lineHeight: 1.38,
            color: '#e2e8f0',
            display: '-webkit-box',
            WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {story.summary_tr || story.headline_tr}
        </div>
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

export interface StorySceneProps {
  story: StorySceneItem;
  storyCount: number;
  durationInFrames: number;
  week: string;
  siteUrl: string;
}

export const StoryScene: React.FC<StorySceneProps> = ({
  story,
  storyCount,
  durationInFrames,
  week,
  siteUrl,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const [imageLoadFailed, setImageLoadFailed] = useState(false);

  const badge = getSourceBadgeTheme(story.source);
  const domain = story.domain || extractHostname(story.url);
  const resolvedAudio = resolveAssetSrc(story.audioSrc);
  const resolvedImage =
    story.imageSrc && !imageLoadFailed ? resolveAssetSrc(story.imageSrc) : '';

  const kenBurns = computeKenBurnsTransform(
    frame,
    durationInFrames,
    story.index - 1
  );

  const cardOpacity = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: COLOR_BG_DEEP,
        backgroundImage:
          'radial-gradient(circle at 85% 15%, rgba(245, 158, 11, 0.10), transparent 45%), radial-gradient(circle at 12% 85%, rgba(30, 64, 175, 0.14), transparent 50%)',
        color: COLOR_INK,
        fontFamily: FONT_SANS,
        padding: '64px 96px 168px 96px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}
    >
      {resolvedAudio ? <Audio src={resolvedAudio} /> : null}

      {/* Top Metadata Bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: `1px solid ${COLOR_BORDER}`,
          paddingBottom: 22,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 22,
              fontWeight: 700,
              color: COLOR_ACCENT,
              backgroundColor: COLOR_ACCENT_SOFT,
              border: '1px solid rgba(245, 158, 11, 0.4)',
              borderRadius: 8,
              padding: '6px 16px',
            }}
          >
            HABER {story.index} / {storyCount}
          </span>

          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 22,
              fontWeight: 700,
              color: badge.textColor,
              backgroundColor: badge.backgroundColor,
              border: `1px solid ${badge.borderColor}`,
              borderRadius: 8,
              padding: '6px 16px',
            }}
          >
            {badge.label}
          </span>

          {domain ? (
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 22,
                color: COLOR_INK_MUTED,
              }}
            >
              {domain}
            </span>
          ) : null}
        </div>

        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 22,
            color: COLOR_INK_MUTED,
          }}
        >
          {siteUrl} • {week}
        </span>
      </div>

      {/* Main Content Split: Headline + Visual (OG Image w/ Ken Burns or Branded Fallback Card) */}
      <div
        style={{
          opacity: cardOpacity,
          display: 'grid',
          gridTemplateColumns: '1.05fr 0.95fr',
          gap: 56,
          alignItems: 'center',
          flex: 1,
          marginTop: 32,
          marginBottom: 24,
        }}
      >
        {/* Left Column: Turkish Headline & Summary */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 28,
          }}
        >
          <h2
            style={{
              fontSize: 54,
              fontWeight: 800,
              lineHeight: 1.16,
              letterSpacing: '-0.02em',
              margin: 0,
              color: COLOR_INK,
            }}
          >
            {story.headline_tr}
          </h2>

          {story.summary_tr ? (
            <p
              style={{
                fontSize: 28,
                lineHeight: 1.48,
                color: COLOR_INK_MUTED,
                margin: 0,
                display: '-webkit-box',
                WebkitLineClamp: 4,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {story.summary_tr}
            </p>
          ) : null}
        </div>

        {/* Right Column: OG Image with Ken Burns effect or Branded Fallback Card */}
        <div
          style={{
            width: '100%',
            height: 520,
            borderRadius: 24,
            overflow: 'hidden',
            border: `1px solid ${COLOR_BORDER}`,
            boxShadow: '0 24px 60px rgba(0, 0, 0, 0.5)',
            backgroundColor: COLOR_BG_CARD,
            position: 'relative',
          }}
        >
          {resolvedImage ? (
            <Img
              src={resolvedImage}
              onError={() => setImageLoadFailed(true)}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                transform: `scale(${kenBurns.scale}) translate3d(${kenBurns.translateX}px, ${kenBurns.translateY}px, 0)`,
                transformOrigin: 'center center',
              }}
            />
          ) : (
            <BrandedFallbackCard
              story={story}
              storyCount={storyCount}
              week={week}
              siteUrl={siteUrl}
            />
          )}
        </div>
      </div>

      <CaptionOverlay captions={story.captions} frameInScene={frame} fps={fps} />
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

