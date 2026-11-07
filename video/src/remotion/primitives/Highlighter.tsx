import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import type { CueBoundingBox } from '../../domain/cues.ts';
import { seededRange } from './seeded.ts';

export interface HighlighterLineStrip {
  lineIndex: number;
  x: number;
  y: number;
  maxWidth: number;
  currentWidth: number;
  height: number;
  rotationDeg: number;
  progress: number;
  borderRadius: number;
}

/**
 * Frame-deterministic helper computing the multi-line marker sweep strips across `targetBox`.
 * Breaks tall paragraph boxes into natural text line strips, sweeping each line left-to-right
 * sequentially with a slight seeded rotation for an authentic marker look.
 */
export function computeHighlighterStrokes(
  targetBox: CueBoundingBox | null | undefined,
  frame: number,
  options?: {
    startFrame?: number;
    endFrame?: number;
    sweepDurationInFrames?: number;
    storyIndex?: number;
    cueIndex?: number;
    lineHeightPx?: number;
    maxLines?: number;
  }
): HighlighterLineStrip[] {
  if (!targetBox || targetBox.width <= 0 || targetBox.height <= 0) {
    return [];
  }

  const startFrame = options?.startFrame ?? 0;
  const endFrame = options?.endFrame;
  if (frame < startFrame) {
    return [];
  }
  if (endFrame !== undefined && frame > endFrame + 30) {
    return [];
  }

  const storyIndex = options?.storyIndex ?? 0;
  const cueIndex = options?.cueIndex ?? 0;
  const seedKey = `${storyIndex}:${cueIndex}`;

  const lineHeightPx = Math.max(22, options?.lineHeightPx ?? 36);
  const maxLines = Math.max(1, options?.maxLines ?? 4);
  const rawLineCount = Math.max(1, Math.round(targetBox.height / lineHeightPx));
  const lineCount = Math.min(maxLines, rawLineCount);

  const sweepDuration = Math.max(
    6,
    options?.sweepDurationInFrames ?? Math.min(32, 12 + lineCount * 6)
  );

  const slotHeight = targetBox.height / lineCount;
  const stripHeight = Math.min(Math.max(18, slotHeight * 0.78), 44);

  const strips: HighlighterLineStrip[] = [];

  for (let i = 0; i < lineCount; i++) {
    const lineStartRatio = i / lineCount;
    const lineEndRatio = (i + 1) / lineCount;
    const lineStartFrame = startFrame + lineStartRatio * sweepDuration;
    const lineEndFrame = Math.max(lineStartFrame + 1, startFrame + lineEndRatio * sweepDuration);

    const rawProgress = interpolate(
      frame,
      [lineStartFrame, lineEndFrame],
      [0, 1],
      {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      }
    );

    // Smooth ease-out cubic for marker stroke speed
    const easedProgress = 1 - Math.pow(1 - rawProgress, 3);

    // Last line in multi-line blocks is slightly shorter (72% - 92% width) like real paragraphs
    const lastLineFactor =
      lineCount > 1 && i === lineCount - 1
        ? seededRange(seedKey, i + 10, 0.72, 0.92)
        : seededRange(seedKey, i + 10, 0.97, 1.0);

    const maxWidth = Number((targetBox.width * lastLineFactor).toFixed(2));
    const currentWidth = Number((maxWidth * easedProgress).toFixed(2));
    const jitterX = seededRange(seedKey, i * 3 + 1, -3, 3);
    const jitterY = seededRange(seedKey, i * 3 + 2, -1.5, 1.5);
    const rotationDeg = Number(
      seededRange(seedKey, i * 3 + 3, -0.85, 0.85).toFixed(3)
    );

    const x = Number((targetBox.x + jitterX).toFixed(2));
    const y = Number(
      (targetBox.y + i * slotHeight + (slotHeight - stripHeight) / 2 + jitterY).toFixed(2)
    );

    strips.push({
      lineIndex: i,
      x,
      y,
      maxWidth,
      currentWidth,
      height: Number(stripHeight.toFixed(2)),
      rotationDeg,
      progress: Number(easedProgress.toFixed(4)),
      borderRadius: Math.round(stripHeight * 0.24),
    });
  }

  return strips;
}

export interface HighlighterProps {
  /** Target bounding box in page coordinates. */
  targetBox: CueBoundingBox | null | undefined;
  /** Frame when the marker sweep begins (default: 0). */
  startFrame?: number;
  /** Optional frame when the highlight ends. */
  endFrame?: number;
  /** Total frames for the sweep reveal across all lines (default: auto 18..32). */
  sweepDurationInFrames?: number;
  /** Story index used for deterministic seeded jitter (default: 0). */
  storyIndex?: number;
  /** Cue index within the story for deterministic variation (default: 0). */
  cueIndex?: number;
  /** Marker color (default: warm yellow-amber `rgba(250, 204, 21, 0.46)`). */
  color?: string;
  /** Maximum text lines to sweep across (default: 4). */
  maxLines?: number;
}

/**
 * Highlighter: marker sweep across the target text lines with left-to-right width reveal,
 * slight seeded rotation, and `multiply` blend mode so the underlying dark text stays crisp.
 */
export const Highlighter: React.FC<HighlighterProps> = ({
  targetBox,
  startFrame = 0,
  endFrame,
  sweepDurationInFrames,
  storyIndex = 0,
  cueIndex = 0,
  color = 'rgba(250, 204, 21, 0.46)',
  maxLines = 4,
}) => {
  const frame = useCurrentFrame();

  const strips = computeHighlighterStrokes(targetBox, frame, {
    startFrame,
    endFrame,
    sweepDurationInFrames,
    storyIndex,
    cueIndex,
    maxLines,
  });

  if (strips.length === 0) {
    return null;
  }

  const fadeOut =
    endFrame !== undefined && frame > endFrame
      ? interpolate(frame, [endFrame, endFrame + 12], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : 1;

  return (
    <div
      data-primitive="highlighter"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        mixBlendMode: 'multiply',
        opacity: fadeOut,
      }}
    >
      {strips.map((strip) =>
        strip.currentWidth > 0.5 ? (
          <div
            key={strip.lineIndex}
            data-primitive="highlighter-line"
            style={{
              position: 'absolute',
              left: strip.x,
              top: strip.y,
              width: strip.currentWidth,
              height: strip.height,
              backgroundColor: color,
              borderRadius: strip.borderRadius,
              transform: `rotate(${strip.rotationDeg}deg)`,
              transformOrigin: 'left center',
              mixBlendMode: 'multiply',
              boxShadow: '0 1px 0 rgba(234, 179, 8, 0.22)',
            }}
          />
        ) : null
      )}
    </div>
  );
};
