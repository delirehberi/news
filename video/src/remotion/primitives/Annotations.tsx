import { evolvePath } from '@remotion/paths';
import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import {
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  type CueBoundingBox,
  type ResolvedCue,
} from '../../domain/cues.ts';
import { seededJitter } from './seeded.ts';

export type AnnotationKind = 'circle' | 'underline' | 'arrow';

export interface HandDrawnAnnotationPaths {
  kind: AnnotationKind;
  paths: string[];
  progress: number;
  evolved: Array<{
    d: string;
    strokeDasharray: string;
    strokeDashoffset: number;
  }>;
}

function fmt(n: number): number {
  return Number(n.toFixed(2));
}

/**
 * Generates a sketched, slightly imperfect oval SVG path around `box` with deterministic
 * seeded jitter and a slight loop-past-the-start tail like a real hand-drawn circle.
 */
export function buildHandDrawnCirclePath(
  box: CueBoundingBox,
  seed: number | string = 0
): string {
  const padX = Math.max(12, Math.min(28, box.width * 0.06));
  const padY = Math.max(10, Math.min(24, box.height * 0.16));
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = box.width / 2 + padX;
  const ry = box.height / 2 + padY;

  const segments = 12;
  // Sweep slightly more than 360 deg (~385 deg) for a natural hand-drawn overlap tail
  const startAngle = -Math.PI * 0.65 + seededJitter(seed, 0, 0.12);
  const totalSweep = Math.PI * 2.14;

  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const angle = startAngle + t * totalSweep;
    const radialJitterX = seededJitter(seed, i * 2 + 1, Math.min(6, rx * 0.04));
    const radialJitterY = seededJitter(seed, i * 2 + 2, Math.min(5, ry * 0.08));
    points.push({
      x: fmt(cx + Math.cos(angle) * (rx + radialJitterX)),
      y: fmt(cy + Math.sin(angle) * (ry + radialJitterY)),
    });
  }

  const cmds: string[] = [`M ${points[0].x} ${points[0].y}`];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const midX = fmt((prev.x + curr.x) / 2 + seededJitter(seed, 50 + i, 2.5));
    const midY = fmt((prev.y + curr.y) / 2 + seededJitter(seed, 80 + i, 2.5));
    cmds.push(`Q ${prev.x} ${prev.y} ${midX} ${midY}`);
  }
  const last = points[points.length - 1];
  cmds.push(`L ${last.x} ${last.y}`);
  return cmds.join(' ');
}

/**
 * Generates a sketched hand-drawn underline SVG path beneath `box` with deterministic jitter.
 */
export function buildHandDrawnUnderlinePath(
  box: CueBoundingBox,
  seed: number | string = 0
): string {
  const startX = fmt(box.x + seededJitter(seed, 1, 4));
  const endX = fmt(box.x + box.width + seededJitter(seed, 2, 4));
  const baseY = box.y + box.height + 6;

  const mid1X = fmt(startX + (endX - startX) * 0.33);
  const mid1Y = fmt(baseY + seededJitter(seed, 3, 3.5) - 1.5);
  const mid2X = fmt(startX + (endX - startX) * 0.68);
  const mid2Y = fmt(baseY + seededJitter(seed, 4, 3.5) + 1.2);
  const startY = fmt(baseY + seededJitter(seed, 5, 2.5));
  const endY = fmt(baseY + seededJitter(seed, 6, 2.5) - 1);

  return `M ${startX} ${startY} C ${mid1X} ${mid1Y} ${mid2X} ${mid2Y} ${endX} ${endY}`;
}

/**
 * Generates a sketched curved arrow shaft + arrowhead pointing into `box`.
 * Returns two SVG paths `[shaftPath, headPath]` so the shaft draws first followed by the head.
 */
export function buildHandDrawnArrowPaths(
  box: CueBoundingBox,
  seed: number | string = 0,
  viewportWidth: number = DEFAULT_VIEWPORT_WIDTH
): [string, string] {
  // Choose left or right margin approach based on available space
  const spaceLeft = box.x;
  const spaceRight = Math.max(0, viewportWidth - (box.x + box.width));
  const fromLeft = spaceLeft >= 90 || spaceLeft >= spaceRight;

  const targetX = fmt(
    fromLeft ? Math.max(16, box.x - 12) : Math.min(viewportWidth - 16, box.x + box.width + 12)
  );
  const targetY = fmt(
    box.y + Math.min(box.height * 0.5, 48) + seededJitter(seed, 1, 4)
  );

  const offsetX = (fromLeft ? -1 : 1) * (96 + seededJitter(seed, 2, 14));
  const offsetY = -44 + seededJitter(seed, 3, 12);

  const startX = fmt(targetX + offsetX);
  const startY = fmt(Math.max(16, targetY + offsetY));

  const ctrlX = fmt(
    (startX + targetX) / 2 + (fromLeft ? -14 : 14) + seededJitter(seed, 4, 6)
  );
  const ctrlY = fmt((startY + targetY) / 2 - 22 + seededJitter(seed, 5, 6));

  const shaftPath = `M ${startX} ${startY} Q ${ctrlX} ${ctrlY} ${targetX} ${targetY}`;

  // Tangent vector from control point to target tip for arrowhead orientation
  const dx = targetX - ctrlX;
  const dy = targetY - ctrlY;
  const angle = Math.atan2(dy, dx);
  const headLen = 18 + seededJitter(seed, 6, 2);
  const wingSpread = 0.48;

  const wing1X = fmt(
    targetX - Math.cos(angle - wingSpread) * headLen + seededJitter(seed, 7, 1.5)
  );
  const wing1Y = fmt(
    targetY - Math.sin(angle - wingSpread) * headLen + seededJitter(seed, 8, 1.5)
  );
  const wing2X = fmt(
    targetX - Math.cos(angle + wingSpread) * headLen + seededJitter(seed, 9, 1.5)
  );
  const wing2Y = fmt(
    targetY - Math.sin(angle + wingSpread) * headLen + seededJitter(seed, 10, 1.5)
  );

  const headPath = `M ${wing1X} ${wing1Y} L ${targetX} ${targetY} L ${wing2X} ${wing2Y}`;
  return [shaftPath, headPath];
}

/**
 * Frame-deterministic helper computing the evolved SVG paths (`strokeDasharray`, `strokeDashoffset`)
 * via `@remotion/paths`'s `evolvePath` for a `circle`, `underline`, or `arrow` annotation.
 */
export function computeAnnotationPaths(
  kind: AnnotationKind,
  targetBox: CueBoundingBox | null | undefined,
  frame: number,
  options?: {
    startFrame?: number;
    drawDurationInFrames?: number;
    storyIndex?: number;
    cueIndex?: number;
    viewportWidth?: number;
  }
): HandDrawnAnnotationPaths {
  if (!targetBox || targetBox.width <= 0 || targetBox.height <= 0) {
    return {
      kind,
      paths: [],
      progress: 0,
      evolved: [],
    };
  }

  const startFrame = options?.startFrame ?? 0;
  const drawDuration = Math.max(4, options?.drawDurationInFrames ?? 18);
  const storyIndex = options?.storyIndex ?? 0;
  const cueIndex = options?.cueIndex ?? 0;
  const seedKey = `${storyIndex}:${cueIndex}:${kind}`;

  const rawProgress = interpolate(
    frame,
    [startFrame, startFrame + drawDuration],
    [0, 1],
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }
  );

  // Smooth ease-out so the stroke starts briskly on the anchor word and settles cleanly
  const progress = Number((1 - Math.pow(1 - rawProgress, 2.6)).toFixed(4));

  let paths: string[];
  if (kind === 'circle') {
    paths = [buildHandDrawnCirclePath(targetBox, seedKey)];
  } else if (kind === 'underline') {
    paths = [buildHandDrawnUnderlinePath(targetBox, seedKey)];
  } else {
    paths = buildHandDrawnArrowPaths(
      targetBox,
      seedKey,
      options?.viewportWidth ?? DEFAULT_VIEWPORT_WIDTH
    );
  }

  const evolved = paths.map((d, idx) => {
    // For multi-part paths (arrow shaft + head), draw shaft over [0..0.72] and head over [0.68..1.0]
    let partProgress = progress;
    if (paths.length === 2) {
      partProgress =
        idx === 0
          ? interpolate(progress, [0, 0.72], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            })
          : interpolate(progress, [0.68, 1], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            });
    }
    const evo = evolvePath(partProgress, d);
    return {
      d,
      strokeDasharray: evo.strokeDasharray,
      strokeDashoffset: Number(evo.strokeDashoffset.toFixed(3)),
    };
  });

  return {
    kind,
    paths,
    progress,
    evolved,
  };
}

export interface AnnotationItemProps {
  kind: AnnotationKind;
  targetBox: CueBoundingBox | null | undefined;
  startFrame?: number;
  endFrame?: number;
  drawDurationInFrames?: number;
  storyIndex?: number;
  cueIndex?: number;
  color?: string;
  strokeWidth?: number;
  viewportWidth?: number;
}

export interface AnnotationsProps {
  /** Single annotation or list of annotations / resolved cues to render. */
  annotations?: ReadonlyArray<AnnotationItemProps>;
  /** Alternatively pass `ResolvedCue[]` directly; filters to `circle | underline | arrow` cues with a `box`. */
  cues?: ReadonlyArray<ResolvedCue>;
  /** Single-annotation shorthand props when used directly as `<Annotations kind="circle" targetBox={...} />`. */
  kind?: AnnotationKind;
  targetBox?: CueBoundingBox | null;
  startFrame?: number;
  endFrame?: number;
  drawDurationInFrames?: number;
  /** Story index for deterministic seeded jitter (default: 0). */
  storyIndex?: number;
  cueIndex?: number;
  /** Stroke color (default: coral-red `#f43f5e` for high contrast on light/dark pages). */
  color?: string;
  strokeWidth?: number;
  canvasWidth?: number;
  canvasHeight?: number;
}

/**
 * Annotations: renders hand-drawn `circle`, `underline`, and `arrow` SVG paths drawn with
 * `stroke-dashoffset` via `@remotion/paths`'s `evolvePath`, slightly jittered deterministically
 * by `storyIndex` for a sketched look and timed to the spoken anchor word (`startFrame`).
 */
export const Annotations: React.FC<AnnotationsProps> = ({
  annotations,
  cues,
  kind,
  targetBox,
  startFrame = 0,
  endFrame,
  drawDurationInFrames = 18,
  storyIndex = 0,
  cueIndex = 0,
  color = '#f43f5e',
  strokeWidth = 4.5,
  canvasWidth = DEFAULT_VIEWPORT_WIDTH,
  canvasHeight = DEFAULT_VIEWPORT_HEIGHT * 3,
}) => {
  const frame = useCurrentFrame();

  const items: AnnotationItemProps[] = [];

  if (annotations && annotations.length > 0) {
    items.push(...annotations);
  }

  if (cues && cues.length > 0) {
    for (const cue of cues) {
      if (
        (cue.kind === 'circle' || cue.kind === 'underline' || cue.kind === 'arrow') &&
        cue.box
      ) {
        items.push({
          kind: cue.kind,
          targetBox: cue.box,
          startFrame: cue.startFrame,
          endFrame: cue.endFrame,
          drawDurationInFrames,
          storyIndex,
          cueIndex: cue.index,
          color,
          strokeWidth,
          viewportWidth: canvasWidth,
        });
      }
    }
  }

  if (kind && targetBox) {
    items.push({
      kind,
      targetBox,
      startFrame,
      endFrame,
      drawDurationInFrames,
      storyIndex,
      cueIndex,
      color,
      strokeWidth,
      viewportWidth: canvasWidth,
    });
  }

  if (items.length === 0) {
    return null;
  }

  return (
    <svg
      data-primitive="annotations"
      width={canvasWidth}
      height={canvasHeight}
      viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: canvasWidth,
        height: canvasHeight,
        pointerEvents: 'none',
        overflow: 'visible',
      }}
    >
      {items.map((item, idx) => {
        const itemStart = item.startFrame ?? startFrame;
        const itemEnd = item.endFrame;
        if (frame < itemStart) {
          return null;
        }
        if (itemEnd !== undefined && frame > itemEnd + 16) {
          return null;
        }

        const computed = computeAnnotationPaths(
          item.kind,
          item.targetBox,
          frame,
          {
            startFrame: itemStart,
            drawDurationInFrames: item.drawDurationInFrames ?? drawDurationInFrames,
            storyIndex: item.storyIndex ?? storyIndex,
            cueIndex: item.cueIndex ?? idx,
            viewportWidth: item.viewportWidth ?? canvasWidth,
          }
        );

        if (computed.evolved.length === 0 || computed.progress <= 0) {
          return null;
        }

        const fadeOut =
          itemEnd !== undefined && frame > itemEnd
            ? interpolate(frame, [itemEnd, itemEnd + 12], [1, 0], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              })
            : 1;

        const itemColor = item.color ?? color;
        const itemStrokeWidth = item.strokeWidth ?? strokeWidth;

        return (
          <g
            key={`${item.kind}-${item.cueIndex ?? idx}-${itemStart}`}
            data-annotation-kind={item.kind}
            opacity={fadeOut}
          >
            {computed.evolved.map((part, partIdx) => (
              <path
                key={partIdx}
                d={part.d}
                fill="none"
                stroke={itemColor}
                strokeWidth={itemStrokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={part.strokeDasharray}
                strokeDashoffset={part.strokeDashoffset}
                style={{
                  filter: 'drop-shadow(0 3px 8px rgba(244, 63, 94, 0.35))',
                }}
              />
            ))}
          </g>
        );
      })}
    </svg>
  );
};
