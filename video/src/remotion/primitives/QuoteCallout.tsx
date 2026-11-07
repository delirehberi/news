import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

const FONT_SANS =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_MONO =
  '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

export interface QuoteCalloutFrameState {
  visible: boolean;
  fullQuote: string;
  visibleQuote: string;
  progress: number;
  showCursor: boolean;
  scale: number;
  translateY: number;
  opacity: number;
}

/**
 * Frame-deterministic helper computing the typewriter reveal and spring card entrance
 * for `QuoteCallout` at `frame`.
 */
export function computeQuoteCalloutState(
  quote: string,
  frame: number,
  options?: {
    startFrame?: number;
    endFrame?: number;
    typeDurationInFrames?: number;
    fps?: number;
  }
): QuoteCalloutFrameState {
  const fullQuote = quote.trim();
  const startFrame = options?.startFrame ?? 0;
  const endFrame = options?.endFrame;
  const fps = options?.fps && options.fps > 0 ? options.fps : 30;

  if (!fullQuote || frame < startFrame || (endFrame !== undefined && frame > endFrame + 12)) {
    return {
      visible: false,
      fullQuote,
      visibleQuote: '',
      progress: 0,
      showCursor: false,
      scale: 0.94,
      translateY: 20,
      opacity: 0,
    };
  }

  const defaultTypeDuration = Math.min(54, Math.max(18, Math.round(fullQuote.length * 0.45)));
  const typeDuration = Math.max(6, options?.typeDurationInFrames ?? defaultTypeDuration);
  const localFrame = Math.max(0, frame - startFrame);

  const entranceSpring = spring({
    frame: localFrame,
    fps,
    config: {
      damping: 20,
      stiffness: 170,
      mass: 0.85,
    },
  });

  const rawTypeProgress = interpolate(
    frame,
    [startFrame + 3, startFrame + 3 + typeDuration],
    [0, 1],
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }
  );

  const charCount = Math.round(rawTypeProgress * fullQuote.length);
  const visibleQuote = fullQuote.slice(0, charCount);
  const isTyping = rawTypeProgress > 0 && rawTypeProgress < 1;

  const exitOpacity =
    endFrame !== undefined && frame > endFrame
      ? interpolate(frame, [endFrame, endFrame + 10], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : 1;

  const entranceOpacity = interpolate(localFrame, [0, 8], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const opacity = Number((entranceOpacity * exitOpacity).toFixed(4));
  const scale = Number(interpolate(entranceSpring, [0, 1], [0.94, 1]).toFixed(4));
  const translateY = Number(interpolate(entranceSpring, [0, 1], [22, 0]).toFixed(2));

  return {
    visible: opacity > 0.01,
    fullQuote,
    visibleQuote,
    progress: Number(rawTypeProgress.toFixed(4)),
    showCursor: isTyping,
    scale,
    translateY,
    opacity,
  };
}

export interface QuoteCalloutProps {
  /** Pull-quote text to reveal with typewriter animation. */
  quote: string;
  /** Optional attribution / source domain label. */
  attribution?: string;
  /** Frame when the pull-quote card enters (default: 0). */
  startFrame?: number;
  /** Optional frame when the pull-quote card exits. */
  endFrame?: number;
  /** Optional duration in frames for the typewriter text reveal. */
  typeDurationInFrames?: number;
  /** Placement inside the viewport (default: `'bottom-left'`). */
  position?: 'bottom-left' | 'bottom-right' | 'center';
  style?: React.CSSProperties;
}

/**
 * QuoteCallout: pull-quote card with spring entrance and frame-deterministic typewriter reveal.
 */
export const QuoteCallout: React.FC<QuoteCalloutProps> = ({
  quote,
  attribution,
  startFrame = 0,
  endFrame,
  typeDurationInFrames,
  position = 'bottom-left',
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const state = computeQuoteCalloutState(quote, frame, {
    startFrame,
    endFrame,
    typeDurationInFrames,
    fps,
  });

  if (!state.visible) {
    return null;
  }

  const posStyle: React.CSSProperties =
    position === 'bottom-right'
      ? { bottom: 42, right: 42 }
      : position === 'center'
        ? {
            top: '50%',
            left: '50%',
            transform: `translate(-50%, calc(-50% + ${state.translateY}px)) scale(${state.scale})`,
          }
        : { bottom: 42, left: 42 };

  return (
    <div
      data-primitive="quote-callout"
      style={{
        position: 'absolute',
        zIndex: 20,
        maxWidth: 740,
        minWidth: 340,
        backgroundColor: 'rgba(15, 23, 42, 0.95)',
        border: '1px solid rgba(148, 163, 184, 0.3)',
        borderLeft: '6px solid #f59e0b',
        borderRadius: 18,
        padding: '24px 32px',
        boxShadow: '0 26px 64px rgba(0, 0, 0, 0.65)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        pointerEvents: 'none',
        opacity: state.opacity,
        transform:
          position === 'center'
            ? posStyle.transform
            : `translate3d(0, ${state.translateY}px, 0) scale(${state.scale})`,
        fontFamily: FONT_SANS,
        ...posStyle,
        ...style,
      }}
    >
      <div
        style={{
          fontSize: 28,
          fontWeight: 600,
          lineHeight: 1.42,
          color: '#f8fafc',
          letterSpacing: '-0.01em',
        }}
      >
        <span style={{ color: '#f59e0b', marginRight: 6, fontWeight: 800 }}>“</span>
        <span>{state.visibleQuote}</span>
        {state.showCursor ? (
          <span
            style={{
              display: 'inline-block',
              width: 3,
              height: 26,
              backgroundColor: '#f59e0b',
              marginLeft: 3,
              verticalAlign: 'text-bottom',
            }}
          />
        ) : (
          <span style={{ color: '#f59e0b', marginLeft: 4, fontWeight: 800 }}>”</span>
        )}
      </div>

      {attribution ? (
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 17,
            fontWeight: 600,
            color: '#94a3b8',
            letterSpacing: '0.02em',
          }}
        >
          — {attribution}
        </div>
      ) : null}
    </div>
  );
};
