import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { extractHostname } from '../../domain/timeline.ts';

const FONT_MONO =
  '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
const FONT_SANS =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const BROWSER_CHROME_HEIGHT = 56;

export interface TypedUrlState {
  fullText: string;
  visibleText: string;
  progress: number;
  isTyping: boolean;
  showCursor: boolean;
}

/**
 * Normalizes a domain or URL string for display in the browser URL bar.
 */
export function formatBrowserDisplayUrl(domainOrUrl: string): string {
  const trimmed = domainOrUrl.trim();
  if (!trimmed) {
    return 'news.emre.xyz';
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname.replace(/^www\./i, '');
      const path =
        parsed.pathname && parsed.pathname !== '/'
          ? parsed.pathname.replace(/\/+$/, '')
          : '';
      return `${host}${path}`;
    } catch {
      return extractHostname(trimmed) || trimmed.replace(/^https?:\/\//i, '');
    }
  }
  return trimmed.replace(/^www\./i, '');
}

/**
 * Frame-deterministic helper computing the typed URL bar text and cursor state at `frame`.
 */
export function computeTypedUrlState(
  domainOrUrl: string,
  frame: number,
  options?: {
    startFrame?: number;
    durationInFrames?: number;
    typewriter?: boolean;
  }
): TypedUrlState {
  const fullText = formatBrowserDisplayUrl(domainOrUrl);
  const typewriter = options?.typewriter ?? true;
  const startFrame = Math.max(0, Math.round(options?.startFrame ?? 2));
  const defaultDuration = Math.min(28, Math.max(10, fullText.length));
  const durationInFrames = Math.max(1, Math.round(options?.durationInFrames ?? defaultDuration));

  if (!typewriter || fullText.length === 0) {
    return {
      fullText,
      visibleText: fullText,
      progress: 1,
      isTyping: false,
      showCursor: false,
    };
  }

  const rawProgress = interpolate(
    frame,
    [startFrame, startFrame + durationInFrames],
    [0, 1],
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }
  );

  const charCount = Math.round(rawProgress * fullText.length);
  const visibleText = fullText.slice(0, charCount);
  const isTyping = frame >= startFrame && rawProgress < 1;
  // Hold blinking cursor briefly for 18 frames after typing completes
  const withinPostHold =
    frame >= startFrame + durationInFrames &&
    frame <= startFrame + durationInFrames + 18;
  const showCursor = isTyping || (withinPostHold && Math.floor(frame / 4) % 2 === 0);

  return {
    fullText,
    visibleText,
    progress: Number(rawProgress.toFixed(4)),
    isTyping,
    showCursor,
  };
}

export interface BrowserFrameProps {
  /** Domain or URL to type into the browser address bar. */
  domain?: string;
  url?: string;
  /** Optional frame when URL typing starts (default: 2). */
  typeStartFrame?: number;
  /** Optional number of frames URL typing takes (default: auto by length). */
  typeDurationInFrames?: number;
  /** Whether to animate typing the domain/URL into the bar (default: true). */
  typewriter?: boolean;
  /** Optional right-side badge or label inside the chrome bar. */
  badgeText?: string;
  /** Optional entrance spring animation toggle (default: true). */
  animateEntrance?: boolean;
  /** Optional custom width/height/style for the outer browser container. */
  width?: number | string;
  height?: number | string;
  borderRadius?: number;
  chromeHeight?: number;
  style?: React.CSSProperties;
  viewportStyle?: React.CSSProperties;
  children?: React.ReactNode;
}

/**
 * BrowserFrame: macOS-style browser chrome (traffic lights + lock icon + URL bar with domain typed in)
 * wrapping a clipped camera viewport for `PageCamera`.
 */
export const BrowserFrame: React.FC<BrowserFrameProps> = ({
  domain,
  url,
  typeStartFrame = 2,
  typeDurationInFrames,
  typewriter = true,
  badgeText,
  animateEntrance = true,
  width = '100%',
  height = '100%',
  borderRadius = 22,
  chromeHeight = BROWSER_CHROME_HEIGHT,
  style,
  viewportStyle,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const rawAddress = (url && url.trim()) || (domain && domain.trim()) || 'news.emre.xyz';
  const typed = computeTypedUrlState(rawAddress, frame, {
    startFrame: typeStartFrame,
    durationInFrames: typeDurationInFrames,
    typewriter,
  });

  const entranceSpring = animateEntrance
    ? spring({
        frame,
        fps,
        config: {
          damping: 22,
          stiffness: 160,
          mass: 0.85,
        },
      })
    : 1;

  const translateY = interpolate(entranceSpring, [0, 1], [18, 0]);
  const scale = interpolate(entranceSpring, [0, 1], [0.985, 1]);
  const opacity = interpolate(frame, [0, 8], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      data-primitive="browser-frame"
      style={{
        width,
        height,
        borderRadius,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#0b1120',
        border: '1px solid rgba(148, 163, 184, 0.28)',
        boxShadow:
          '0 30px 80px rgba(0, 0, 0, 0.62), 0 0 0 1px rgba(255, 255, 255, 0.04) inset',
        boxSizing: 'border-box',
        opacity: animateEntrance ? opacity : 1,
        transform: animateEntrance
          ? `translate3d(0, ${translateY.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`
          : undefined,
        fontFamily: FONT_SANS,
        ...style,
      }}
    >
      {/* Top Browser Chrome Bar */}
      <div
        style={{
          height: chromeHeight,
          minHeight: chromeHeight,
          backgroundColor: '#111827',
          borderBottom: '1px solid rgba(148, 163, 184, 0.2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 22px',
          gap: 18,
          boxSizing: 'border-box',
          userSelect: 'none',
        }}
      >
        {/* Traffic Lights */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            minWidth: 76,
          }}
        >
          <span
            style={{
              width: 13,
              height: 13,
              borderRadius: 999,
              backgroundColor: '#ef4444',
              boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.25)',
              display: 'inline-block',
            }}
          />
          <span
            style={{
              width: 13,
              height: 13,
              borderRadius: 999,
              backgroundColor: '#f59e0b',
              boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.25)',
              display: 'inline-block',
            }}
          />
          <span
            style={{
              width: 13,
              height: 13,
              borderRadius: 999,
              backgroundColor: '#10b981',
              boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.25)',
              display: 'inline-block',
            }}
          />
        </div>

        {/* Address / URL Bar */}
        <div
          style={{
            flex: 1,
            maxWidth: 880,
            height: 36,
            borderRadius: 10,
            backgroundColor: 'rgba(15, 23, 42, 0.92)',
            border: '1px solid rgba(148, 163, 184, 0.24)',
            display: 'flex',
            alignItems: 'center',
            padding: '0 16px',
            gap: 10,
            overflow: 'hidden',
            boxSizing: 'border-box',
          }}
        >
          {/* HTTPS Lock Icon */}
          <svg
            width={15}
            height={15}
            viewBox="0 0 24 24"
            fill="none"
            stroke="#34d399"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0 }}
          >
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>

          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 17,
              fontWeight: 600,
              color: '#e2e8f0',
              letterSpacing: '0.01em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <span style={{ color: '#64748b', marginRight: 2 }}>https://</span>
            <span>{typed.visibleText}</span>
            {typed.showCursor ? (
              <span
                style={{
                  display: 'inline-block',
                  width: 2,
                  height: 18,
                  backgroundColor: '#f59e0b',
                  marginLeft: 2,
                  verticalAlign: 'middle',
                }}
              />
            ) : null}
          </span>
        </div>

        {/* Right Chrome Spacer / Optional Badge */}
        <div
          style={{
            minWidth: 76,
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
          }}
        >
          {badgeText ? (
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 14,
                fontWeight: 600,
                color: '#94a3b8',
                backgroundColor: 'rgba(148, 163, 184, 0.12)',
                border: '1px solid rgba(148, 163, 184, 0.22)',
                borderRadius: 6,
                padding: '3px 10px',
                whiteSpace: 'nowrap',
              }}
            >
              {badgeText}
            </span>
          ) : null}
        </div>
      </div>

      {/* Clipped Camera Viewport */}
      <div
        data-primitive="browser-viewport"
        style={{
          position: 'relative',
          flex: 1,
          width: '100%',
          overflow: 'hidden',
          backgroundColor: '#0f172a',
          ...viewportStyle,
        }}
      >
        {children}
      </div>
    </div>
  );
};
