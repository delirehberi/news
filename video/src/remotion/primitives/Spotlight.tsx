import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  type CueBoundingBox,
} from '../../domain/cues.ts';

export interface SpotlightCutoutGeometry {
  visible: boolean;
  opacity: number;
  rect: CueBoundingBox | null;
  borderRadius: number;
  svgPath: string;
}

function buildRoundedRectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): string {
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const x0 = Number(x.toFixed(2));
  const y0 = Number(y.toFixed(2));
  const x1 = Number((x + w).toFixed(2));
  const y1 = Number((y + h).toFixed(2));
  const rr = Number(r.toFixed(2));

  return [
    `M ${Number((x0 + rr).toFixed(2))} ${y0}`,
    `H ${Number((x1 - rr).toFixed(2))}`,
    `A ${rr} ${rr} 0 0 1 ${x1} ${Number((y0 + rr).toFixed(2))}`,
    `V ${Number((y1 - rr).toFixed(2))}`,
    `A ${rr} ${rr} 0 0 1 ${Number((x1 - rr).toFixed(2))} ${y1}`,
    `H ${Number((x0 + rr).toFixed(2))}`,
    `A ${rr} ${rr} 0 0 1 ${x0} ${Number((y1 - rr).toFixed(2))}`,
    `V ${Number((y0 + rr).toFixed(2))}`,
    `A ${rr} ${rr} 0 0 1 ${Number((x0 + rr).toFixed(2))} ${y0}`,
    'Z',
  ].join(' ');
}

/**
 * Frame-deterministic helper computing the Spotlight backdrop path and animated rounded cutout.
 */
export function computeSpotlightCutout(
  focusRect: CueBoundingBox | null | undefined,
  frame: number,
  options?: {
    startFrame?: number;
    endFrame?: number;
    fps?: number;
    padding?: number;
    borderRadius?: number;
    dimOpacity?: number;
    canvasWidth?: number;
    canvasHeight?: number;
  }
): SpotlightCutoutGeometry {
  if (!focusRect || focusRect.width <= 0 || focusRect.height <= 0) {
    return {
      visible: false,
      opacity: 0,
      rect: null,
      borderRadius: 0,
      svgPath: '',
    };
  }

  const startFrame = options?.startFrame ?? 0;
  const endFrame = options?.endFrame;
  const fps = options?.fps && options.fps > 0 ? options.fps : 30;
  const padding = options?.padding ?? 18;
  const borderRadius = options?.borderRadius ?? 16;
  const dimOpacity = options?.dimOpacity ?? 0.58;
  const canvasWidth = Math.max(1, options?.canvasWidth ?? DEFAULT_VIEWPORT_WIDTH);
  const canvasHeight = Math.max(
    1,
    options?.canvasHeight ?? Math.max(DEFAULT_VIEWPORT_HEIGHT * 2, focusRect.y + focusRect.height + 400)
  );

  if (frame < startFrame || (endFrame !== undefined && frame > endFrame + 10)) {
    return {
      visible: false,
      opacity: 0,
      rect: null,
      borderRadius,
      svgPath: '',
    };
  }

  const localFrame = Math.max(0, frame - startFrame);
  const entrance = spring({
    frame: localFrame,
    fps,
    config: {
      damping: 22,
      stiffness: 180,
      mass: 0.8,
    },
  });

  const exitMultiplier =
    endFrame !== undefined && endFrame > startFrame
      ? interpolate(frame, [endFrame - 6, endFrame + 8], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : 1;

  const opacity = Number((dimOpacity * Math.min(1, entrance) * exitMultiplier).toFixed(4));
  if (opacity <= 0.005) {
    return {
      visible: false,
      opacity: 0,
      rect: null,
      borderRadius,
      svgPath: '',
    };
  }

  // Subtle breathing / expansion from 1.06x down to 1.0x as the cutout locks onto the element
  const scaleSpread = interpolate(entrance, [0, 1], [1.06, 1]);
  const baseX = focusRect.x - padding;
  const baseY = focusRect.y - padding;
  const baseW = focusRect.width + padding * 2;
  const baseH = focusRect.height + padding * 2;

  const centerX = baseX + baseW / 2;
  const centerY = baseY + baseH / 2;
  const animatedW = baseW * scaleSpread;
  const animatedH = baseH * scaleSpread;
  const animatedX = centerX - animatedW / 2;
  const animatedY = centerY - animatedH / 2;

  const rect: CueBoundingBox = {
    x: Number(animatedX.toFixed(2)),
    y: Number(animatedY.toFixed(2)),
    width: Number(animatedW.toFixed(2)),
    height: Number(animatedH.toFixed(2)),
  };

  const outerPath = `M 0 0 H ${canvasWidth} V ${canvasHeight} H 0 Z`;
  const innerPath = buildRoundedRectPath(
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    borderRadius
  );

  return {
    visible: true,
    opacity,
    rect,
    borderRadius,
    svgPath: `${outerPath} ${innerPath}`,
  };
}

export interface SpotlightProps {
  /** Target region in page coordinates to keep illuminated. */
  focusRect: CueBoundingBox | null | undefined;
  /** Optional frame when the spotlight activates (default: 0). */
  startFrame?: number;
  /** Optional frame when the spotlight fades out. */
  endFrame?: number;
  /** Extra padding around `focusRect` in px (default: 18). */
  padding?: number;
  /** Cutout corner radius in px (default: 16). */
  borderRadius?: number;
  /** Backdrop dim opacity in `[0, 1]` (default: 0.58). */
  dimOpacity?: number;
  /** Accent ring color around the cutout (default: amber `#f59e0b`). */
  ringColor?: string;
  /** Logical width of the page plane (default: 1440). */
  canvasWidth?: number;
  /** Logical height of the page plane (default: 2400 or inferred). */
  canvasHeight?: number;
}

/**
 * Spotlight: dims everything on the page except `focusRect` using an animated
 * rounded SVG even-odd cutout and a subtle highlight border ring.
 */
export const Spotlight: React.FC<SpotlightProps> = ({
  focusRect,
  startFrame = 0,
  endFrame,
  padding = 18,
  borderRadius = 16,
  dimOpacity = 0.58,
  ringColor = 'rgba(245, 158, 11, 0.78)',
  canvasWidth = DEFAULT_VIEWPORT_WIDTH,
  canvasHeight,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const resolvedHeight =
    canvasHeight ??
    Math.max(
      DEFAULT_VIEWPORT_HEIGHT * 2,
      focusRect ? Math.ceil(focusRect.y + focusRect.height + 600) : DEFAULT_VIEWPORT_HEIGHT * 2
    );

  const cutout = computeSpotlightCutout(focusRect, frame, {
    startFrame,
    endFrame,
    fps,
    padding,
    borderRadius,
    dimOpacity,
    canvasWidth,
    canvasHeight: resolvedHeight,
  });

  if (!cutout.visible || !cutout.rect) {
    return null;
  }

  return (
    <svg
      data-primitive="spotlight"
      width={canvasWidth}
      height={resolvedHeight}
      viewBox={`0 0 ${canvasWidth} ${resolvedHeight}`}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: canvasWidth,
        height: resolvedHeight,
        pointerEvents: 'none',
        overflow: 'visible',
      }}
    >
      <path
        d={cutout.svgPath}
        fill={`rgba(9, 13, 22, ${cutout.opacity})`}
        fillRule="evenodd"
      />
      <rect
        x={cutout.rect.x}
        y={cutout.rect.y}
        width={cutout.rect.width}
        height={cutout.rect.height}
        rx={cutout.borderRadius}
        ry={cutout.borderRadius}
        fill="none"
        stroke={ringColor}
        strokeWidth={2.5}
        opacity={Math.min(1, cutout.opacity * 1.4)}
      />
    </svg>
  );
};
