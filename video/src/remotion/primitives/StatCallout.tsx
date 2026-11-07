import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

const FONT_MONO =
  '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
const FONT_SANS =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export interface ParsedStatValue {
  prefix: string;
  targetNumber: number | null;
  decimals: number;
  decimalSeparator: '.' | ',';
  suffix: string;
  label: string;
}

export interface StatCalloutFrameState {
  visible: boolean;
  displayValue: string;
  label: string;
  currentNumber: number | null;
  progress: number;
  scale: number;
  opacity: number;
}

/**
 * Parses a stat string (e.g. `"%40 daha hızlı"`, `"3.2x throughput"`, `"120ms latency"`, `"1,5M kullanıcı"`)
 * into its numeric component (prefix, number, decimal places, suffix) and optional trailing label.
 */
export function parseStatSpec(rawValue: string, explicitLabel?: string): ParsedStatValue {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return {
      prefix: '',
      targetNumber: null,
      decimals: 0,
      decimalSeparator: '.',
      suffix: '',
      label: explicitLabel?.trim() ?? '',
    };
  }

  // Match optional leading symbol (%, $, +, ~, #) + number + optional unit token + optional trailing label
  const match = /^([+$~#%€£¥-]?\s*)(\d+(?:[.,]\d+)?)([%xX×kKmMbBGBTBmsMSs+]*)(\s+.*)?$/u.exec(
    trimmed
  );

  if (!match) {
    return {
      prefix: '',
      targetNumber: null,
      decimals: 0,
      decimalSeparator: '.',
      suffix: trimmed,
      label: explicitLabel?.trim() ?? '',
    };
  }

  const prefix = match[1] ?? '';
  const numToken = match[2];
  const suffix = match[3] ?? '';
  const trailingLabel = (match[4] ?? '').trim();

  const decimalSeparator: '.' | ',' = numToken.includes(',') ? ',' : '.';
  const normalizedNumString = numToken.replace(',', '.');
  const parsedNum = Number.parseFloat(normalizedNumString);
  const dotIndex = normalizedNumString.indexOf('.');
  const decimals = dotIndex >= 0 ? normalizedNumString.length - dotIndex - 1 : 0;

  return {
    prefix,
    targetNumber: Number.isFinite(parsedNum) ? parsedNum : null,
    decimals,
    decimalSeparator,
    suffix,
    label: explicitLabel?.trim() || trailingLabel,
  };
}

/**
 * Frame-deterministic helper computing the counting number + spring pop state for `StatCallout`.
 */
export function computeStatCalloutState(
  value: string,
  frame: number,
  options?: {
    label?: string;
    startFrame?: number;
    endFrame?: number;
    countDurationInFrames?: number;
    fps?: number;
  }
): StatCalloutFrameState {
  const startFrame = options?.startFrame ?? 0;
  const endFrame = options?.endFrame;
  const fps = options?.fps && options.fps > 0 ? options.fps : 30;
  const countDuration = Math.max(6, options?.countDurationInFrames ?? 24);

  if (frame < startFrame || (endFrame !== undefined && frame > endFrame + 12)) {
    return {
      visible: false,
      displayValue: '',
      label: options?.label ?? '',
      currentNumber: null,
      progress: 0,
      scale: 0.85,
      opacity: 0,
    };
  }

  const parsed = parseStatSpec(value, options?.label);
  const localFrame = Math.max(0, frame - startFrame);

  const popSpring = spring({
    frame: localFrame,
    fps,
    config: {
      damping: 14,
      stiffness: 200,
      mass: 0.75,
    },
  });

  const rawCountProgress = interpolate(
    frame,
    [startFrame, startFrame + countDuration],
    [0, 1],
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }
  );
  // Ease-out cubic for the counting number
  const easedCountProgress = 1 - Math.pow(1 - rawCountProgress, 3);

  let currentNumber: number | null = null;
  let displayValue: string;

  if (parsed.targetNumber !== null) {
    currentNumber = parsed.targetNumber * easedCountProgress;
    const formattedNumber = currentNumber
      .toFixed(parsed.decimals)
      .replace('.', parsed.decimalSeparator);
    displayValue = `${parsed.prefix}${formattedNumber}${parsed.suffix}`;
  } else {
    displayValue = parsed.suffix;
  }

  const exitOpacity =
    endFrame !== undefined && frame > endFrame
      ? interpolate(frame, [endFrame, endFrame + 10], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : 1;

  const entranceOpacity = interpolate(localFrame, [0, 6], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const opacity = Number((entranceOpacity * exitOpacity).toFixed(4));
  const scale = Number(interpolate(popSpring, [0, 1], [0.78, 1]).toFixed(4));

  return {
    visible: opacity > 0.01,
    displayValue,
    label: parsed.label,
    currentNumber: currentNumber !== null ? Number(currentNumber.toFixed(4)) : null,
    progress: Number(easedCountProgress.toFixed(4)),
    scale,
    opacity,
  };
}

export interface StatCalloutProps {
  /** Stat value string (e.g. `"%40"`, `"3.5x daha hızlı"`, `"120ms"`). */
  value: string;
  /** Optional descriptive label below the counting number (or extracted from `value`). */
  label?: string;
  /** Frame when the stat callout pops in and starts counting (default: 0). */
  startFrame?: number;
  /** Optional frame when the stat callout exits. */
  endFrame?: number;
  /** Duration in frames for the number count-up (default: 24). */
  countDurationInFrames?: number;
  /** Screen anchor position inside the viewport (default: `'top-right'`). */
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'center';
  style?: React.CSSProperties;
}

/**
 * StatCallout: animated counting number + spring-popped label card for `stat` visual cues.
 */
export const StatCallout: React.FC<StatCalloutProps> = ({
  value,
  label,
  startFrame = 0,
  endFrame,
  countDurationInFrames = 24,
  position = 'top-right',
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const state = computeStatCalloutState(value, frame, {
    label,
    startFrame,
    endFrame,
    countDurationInFrames,
    fps,
  });

  if (!state.visible) {
    return null;
  }

  const posStyle: React.CSSProperties =
    position === 'top-left'
      ? { top: 36, left: 36 }
      : position === 'bottom-right'
        ? { bottom: 36, right: 36 }
        : position === 'bottom-left'
          ? { bottom: 36, left: 36 }
          : position === 'center'
            ? {
                top: '50%',
                left: '50%',
                transform: `translate(-50%, -50%) scale(${state.scale})`,
              }
            : { top: 36, right: 36 };

  return (
    <div
      data-primitive="stat-callout"
      style={{
        position: 'absolute',
        zIndex: 20,
        backgroundColor: 'rgba(15, 23, 42, 0.94)',
        border: '1px solid rgba(245, 158, 11, 0.55)',
        borderRadius: 20,
        padding: '22px 32px',
        boxShadow:
          '0 24px 60px rgba(0, 0, 0, 0.6), 0 0 28px rgba(245, 158, 11, 0.18)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 8,
        minWidth: 210,
        maxWidth: 420,
        pointerEvents: 'none',
        opacity: state.opacity,
        transform:
          position === 'center'
            ? posStyle.transform
            : `scale(${state.scale})`,
        transformOrigin:
          position.includes('right') ? 'top right' : 'top left',
        fontFamily: FONT_SANS,
        ...posStyle,
        ...style,
      }}
    >
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 64,
          fontWeight: 800,
          lineHeight: 1.05,
          letterSpacing: '-0.03em',
          color: '#f59e0b',
        }}
      >
        {state.displayValue}
      </div>

      {state.label ? (
        <div
          style={{
            fontSize: 22,
            fontWeight: 600,
            lineHeight: 1.3,
            color: '#f8fafc',
          }}
        >
          {state.label}
        </div>
      ) : null}
    </div>
  );
};
