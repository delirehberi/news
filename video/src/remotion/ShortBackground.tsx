import React from 'react';
import { AbsoluteFill, interpolateColors } from 'remotion';
import { sectionColorStops } from '../domain/shortPresenter.ts';
import { SHORT_HEIGHT, SHORT_WIDTH } from '../domain/shorts.ts';

export const SECTION_COLORS = ['#14213d', '#0b3c49', '#2d2a5e', '#4a1f3d', '#14213d'] as const;
const BLOBS = [
  { color: '#ff5c35', alpha: 0.32, radius: 520, x: 0.15, y: 0.2, ax: 120, ay: 160, speed: 0.011, phase: 0 },
  { color: '#2ec4b6', alpha: 0.28, radius: 600, x: 0.85, y: 0.45, ax: 140, ay: 110, speed: 0.008, phase: 2 },
  { color: '#7b6cf6', alpha: 0.26, radius: 560, x: 0.3, y: 0.8, ax: 170, ay: 130, speed: 0.009, phase: 4 },
  { color: '#ffd166', alpha: 0.18, radius: 380, x: 0.75, y: 0.1, ax: 90, ay: 200, speed: 0.013, phase: 1 },
] as const;
const GRID_SIZE = 90;
const GRID_SPEED_PX_PER_FRAME = 0.5;
const ALPHA_HEX_MAX = 255;

const alphaHex = (alpha: number): string => Math.round(alpha * ALPHA_HEX_MAX).toString(16).padStart(2, '0');

export interface ShortBackgroundProps { frame: number; sectionStarts: readonly number[] }

/** Drifting colour blobs over a slowly scrolling grid; the base colour changes per section. */
export const ShortBackground: React.FC<ShortBackgroundProps> = ({ frame, sectionStarts }) => {
  const stops = sectionColorStops(sectionStarts, SECTION_COLORS);
  const base = stops.frames.length > 1 ? interpolateColors(frame, stops.frames, stops.colors) : stops.colors[0];
  const gridShift = (frame * GRID_SPEED_PX_PER_FRAME) % GRID_SIZE;
  return <AbsoluteFill style={{ backgroundColor: base, overflow: 'hidden' }}>
    {BLOBS.map((blob, index) => <div key={index} style={{
      position: 'absolute',
      width: blob.radius * 2,
      height: blob.radius * 2,
      left: SHORT_WIDTH * blob.x - blob.radius + Math.sin(frame * blob.speed + blob.phase) * blob.ax,
      top: SHORT_HEIGHT * blob.y - blob.radius + Math.cos(frame * blob.speed * 0.8 + blob.phase) * blob.ay,
      borderRadius: '50%',
      background: `radial-gradient(circle, ${blob.color}${alphaHex(blob.alpha)} 0%, ${blob.color}00 70%)`,
    }} />)}
    <div style={{
      position: 'absolute',
      inset: -GRID_SIZE,
      transform: `translate(${gridShift}px, ${gridShift}px)`,
      backgroundImage: 'linear-gradient(#ffffff0d 2px, transparent 2px), linear-gradient(90deg, #ffffff0d 2px, transparent 2px)',
      backgroundSize: `${GRID_SIZE}px ${GRID_SIZE}px`,
    }} />
  </AbsoluteFill>;
};
