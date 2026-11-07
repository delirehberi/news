import React from 'react';
import { Img, useCurrentFrame } from 'remotion';
import {
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  sampleCameraTrack,
  type CameraKeyframe,
  type CameraPose,
  type CameraTrack,
  type CueBoundingBox,
} from '../../domain/cues.ts';
import { resolveAssetSrc } from '../WeeklyVideo.tsx';

export interface PageCameraTransform {
  pose: CameraPose;
  scale: number;
  originX: number;
  originY: number;
  translateX: number;
  translateY: number;
  cssTransform: string;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Pure helper computing the 2D camera transform (`translate3d` + `scale`) in page-coordinate space
 * from a `CameraTrack`, `CameraKeyframe[]`, or explicit `CameraPose` at `frame`.
 *
 * When `pose.focusRect` is present and `pose.scale > 1`, the camera centers horizontally and
 * vertically toward the focus region while clamping to the `[0..viewportWidth, 0..pageHeight]`
 * bounds so the camera never exposes blank space outside the screenshot.
 */
export function computePageCameraTransform(
  trackOrPose: CameraTrack | readonly CameraKeyframe[] | CameraPose,
  frame: number,
  options?: {
    viewportWidth?: number;
    viewportHeight?: number;
    pageHeight?: number;
  }
): PageCameraTransform {
  const isTrackObject =
    typeof trackOrPose === 'object' &&
    trackOrPose !== null &&
    !Array.isArray(trackOrPose) &&
    'keyframes' in trackOrPose;

  const isKeyframesArray = Array.isArray(trackOrPose);

  const viewportWidth = Math.max(
    1,
    options?.viewportWidth ??
      (isTrackObject ? (trackOrPose as CameraTrack).viewport.width : DEFAULT_VIEWPORT_WIDTH)
  );
  const viewportHeight = Math.max(
    1,
    options?.viewportHeight ??
      (isTrackObject ? (trackOrPose as CameraTrack).viewport.height : DEFAULT_VIEWPORT_HEIGHT)
  );
  const pageHeight = Math.max(
    viewportHeight,
    options?.pageHeight ??
      (isTrackObject ? (trackOrPose as CameraTrack).viewport.pageHeight : viewportHeight * 2)
  );

  let pose: CameraPose;
  if (isTrackObject) {
    const track = trackOrPose as CameraTrack;
    pose =
      typeof track.atFrame === 'function'
        ? track.atFrame(frame)
        : sampleCameraTrack(track.keyframes, frame, {
            transitionFrames: track.transitionFrames,
            pageHeight,
            viewportHeight,
          });
  } else if (isKeyframesArray) {
    pose = sampleCameraTrack(trackOrPose as readonly CameraKeyframe[], frame, {
      pageHeight,
      viewportHeight,
    });
  } else {
    pose = trackOrPose as CameraPose;
  }

  const scale = Math.max(1, Number.isFinite(pose.scale) ? pose.scale : 1);
  const maxScrollY = Math.max(0, pageHeight - viewportHeight);
  const scrollY = clamp(Number.isFinite(pose.y) ? pose.y : 0, 0, maxScrollY);

  const focusRect: CueBoundingBox | null = pose.focusRect ?? null;
  const focusCenterX = focusRect
    ? clamp(focusRect.x + focusRect.width / 2, 0, viewportWidth)
    : viewportWidth / 2;
  const focusCenterY = focusRect
    ? clamp(focusRect.y + focusRect.height / 2, 0, pageHeight)
    : scrollY + viewportHeight / 2;

  // Compute the top-left of the zoomed camera window in page coordinates, clamped to page bounds
  const visibleWidth = viewportWidth / scale;
  const visibleHeight = viewportHeight / scale;

  const zoomRatio = clamp((scale - 1) / 0.35, 0, 1);
  const targetCenterX =
    (viewportWidth / 2) * (1 - zoomRatio) + focusCenterX * zoomRatio;
  const targetCenterY =
    (scrollY + viewportHeight / 2) * (1 - zoomRatio) + focusCenterY * zoomRatio;

  const cameraLeft = clamp(
    targetCenterX - visibleWidth / 2,
    0,
    Math.max(0, viewportWidth - visibleWidth)
  );
  const cameraTop = clamp(
    targetCenterY - visibleHeight / 2,
    0,
    Math.max(0, pageHeight - visibleHeight)
  );

  const translateX = Number((-cameraLeft * scale).toFixed(3));
  const translateY = Number((-cameraTop * scale).toFixed(3));
  const cleanScale = Number(scale.toFixed(5));

  return {
    pose: {
      y: scrollY,
      scale: cleanScale,
      focusRect,
    },
    scale: cleanScale,
    originX: Number(targetCenterX.toFixed(2)),
    originY: Number(targetCenterY.toFixed(2)),
    translateX,
    translateY,
    cssTransform: `translate3d(${translateX}px, ${translateY}px, 0) scale(${cleanScale})`,
  };
}

export interface PageCameraProps {
  /** Path or URL to the tall article page screenshot PNG. */
  screenshotSrc?: string | null;
  /** Camera track, keyframes array, or static pose driving scroll & zoom. */
  camera: CameraTrack | readonly CameraKeyframe[] | CameraPose;
  /** Optional explicit frame override (defaults to `useCurrentFrame()`). */
  frame?: number;
  /** Logical page capture width in px (default: 1440). */
  viewportWidth?: number;
  /** Logical page capture viewport height in px (default: 900). */
  viewportHeight?: number;
  /** Full captured page height in px. */
  pageHeight?: number;
  /** Callback if the screenshot image fails to load. */
  onImageError?: () => void;
  /** Optional overlays rendered in page-coordinate space (Spotlight, Highlighter, Annotations). */
  children?: React.ReactNode;
  /** Optional HUD/callouts rendered in screen/viewport space above the transformed page. */
  screenOverlay?: React.ReactNode;
  style?: React.CSSProperties;
}

/**
 * PageCamera: renders the tall captured page PNG inside a logical `viewportWidth x viewportHeight`
 * stage and translates/scales it smoothly from the `CameraTrack` (scroll + zoom to focus region).
 * Any `children` are placed in the same page coordinate system (`1440 x pageHeight`) so bounding boxes
 * from `pageCapture.ts` / `cues.ts` align 1:1 with the screenshot pixels.
 */
export const PageCamera: React.FC<PageCameraProps> = ({
  screenshotSrc,
  camera,
  frame: frameOverride,
  viewportWidth,
  viewportHeight,
  pageHeight,
  onImageError,
  children,
  screenOverlay,
  style,
}) => {
  const currentFrame = useCurrentFrame();
  const frame = frameOverride ?? currentFrame;

  const isTrackObject =
    typeof camera === 'object' &&
    camera !== null &&
    !Array.isArray(camera) &&
    'keyframes' in camera;

  const resolvedViewportWidth =
    viewportWidth ??
    (isTrackObject ? (camera as CameraTrack).viewport.width : DEFAULT_VIEWPORT_WIDTH);
  const resolvedViewportHeight =
    viewportHeight ??
    (isTrackObject ? (camera as CameraTrack).viewport.height : DEFAULT_VIEWPORT_HEIGHT);
  const resolvedPageHeight =
    pageHeight ??
    (isTrackObject ? (camera as CameraTrack).viewport.pageHeight : resolvedViewportHeight * 2);

  const transform = computePageCameraTransform(camera, frame, {
    viewportWidth: resolvedViewportWidth,
    viewportHeight: resolvedViewportHeight,
    pageHeight: resolvedPageHeight,
  });

  const resolvedSrc = screenshotSrc ? resolveAssetSrc(screenshotSrc) : '';

  return (
    <div
      data-primitive="page-camera"
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        backgroundColor: '#0f172a',
        ...style,
      }}
    >
      {/* Transformed Page Plane (1440 x pageHeight coordinate space) */}
      <div
        data-primitive="page-camera-stage"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: resolvedViewportWidth,
          height: resolvedPageHeight,
          transformOrigin: '0 0',
          transform: transform.cssTransform,
          willChange: 'transform',
        }}
      >
        {resolvedSrc ? (
          <Img
            src={resolvedSrc}
            onError={onImageError}
            style={{
              display: 'block',
              width: resolvedViewportWidth,
              height: 'auto',
              minHeight: resolvedViewportHeight,
              userSelect: 'none',
              pointerEvents: 'none',
            }}
          />
        ) : null}

        {/* Page-space overlays (Spotlight, Highlighter, Annotations) */}
        {children}
      </div>

      {/* Screen-space overlays (StatCallout, QuoteCallout, HUD) */}
      {screenOverlay}
    </div>
  );
};
