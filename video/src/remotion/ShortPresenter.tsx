import React from 'react';
import type { MouthState } from '../domain/shortPresenter.ts';

export interface ShortPresenterProps {
  mouth: MouthState;
  /** 0 = eyes open, 1 = closed. */
  blink: number;
  /** 0..1 eyebrow lift, used for emphasis at scene starts. */
  brows: number;
  bob: number;
  sway: number;
  /** Where the pupils look, -1 (left) .. 1 (right). */
  gaze: number;
  size: number;
}

const VIEWBOX = 300;
const HEAD = '#4cc9f0';
const HEAD_SHADE = '#2fa8d1';
const BODY = '#ff5c35';
const INK = '#101a22';
const EYE_Y = 130;
const EYE_X = { left: 105, right: 195 } as const;
const EYE_RADIUS = 24;
const PUPIL_RADIUS = 11;
const PUPIL_TRAVEL = 7;
const BROW_LIFT = 14;
const MOUTH = { x: 150, y: 190 } as const;
const MOUTH_RX = { open: 26, wide: 36, round: 17 } as const;
const MOUTH_RY = { base: { open: 6, wide: 4, round: 6 }, range: { open: 30, wide: 14, round: 24 } } as const;
const CLOSED_MOUTH_OPENNESS = 0.06;

/** Code-drawn robot presenter; pure props so every frame renders identically. */
export const ShortPresenter: React.FC<ShortPresenterProps> = ({ mouth, blink, brows, bob, sway, gaze, size }) => {
  const eyeRy = Math.max(2, EYE_RADIUS * (1 - blink * 0.92));
  const speaking = mouth.openness > CLOSED_MOUTH_OPENNESS;
  const mouthRy = MOUTH_RY.base[mouth.shape] + MOUTH_RY.range[mouth.shape] * mouth.openness;
  return <svg width={size} height={size} viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`} role="img" aria-label="Sunucu karakter">
    <g transform={`translate(0 ${bob}) rotate(${sway} 150 260)`}>
      <rect x="55" y="238" width="190" height="80" rx="38" fill={BODY} />
      <rect x="125" y="222" width="50" height="28" rx="8" fill={HEAD_SHADE} />
      <line x1="150" y1="42" x2="150" y2="22" stroke={INK} strokeWidth="6" strokeLinecap="round" />
      <circle cx="150" cy="16" r={speaking ? 11 : 9} fill={speaking ? BODY : '#ffd166'} />
      <rect x="40" y="42" width="220" height="190" rx="70" fill={HEAD} stroke={INK} strokeWidth="6" />
      <rect x="28" y="108" width="16" height="50" rx="8" fill={INK} />
      <rect x="256" y="108" width="16" height="50" rx="8" fill={INK} />
      {[EYE_X.left, EYE_X.right].map((x) => <g key={x}>
        <ellipse cx={x} cy={EYE_Y} rx={EYE_RADIUS} ry={eyeRy} fill="#ffffff" stroke={INK} strokeWidth="4" />
        <ellipse cx={x + gaze * PUPIL_TRAVEL} cy={EYE_Y} rx={PUPIL_RADIUS} ry={Math.min(PUPIL_RADIUS, eyeRy * 0.8)} fill={INK} />
        <line x1={x - 20} y1={EYE_Y - 38 - brows * BROW_LIFT} x2={x + 20} y2={EYE_Y - 42 - brows * BROW_LIFT} stroke={INK} strokeWidth="7" strokeLinecap="round" />
      </g>)}
      <circle cx="78" cy="176" r="12" fill="#ff8fa3" opacity="0.7" />
      <circle cx="222" cy="176" r="12" fill="#ff8fa3" opacity="0.7" />
      {speaking
        ? <g>
          <ellipse cx={MOUTH.x} cy={MOUTH.y} rx={MOUTH_RX[mouth.shape]} ry={mouthRy} fill="#5a1f2b" stroke={INK} strokeWidth="4" />
          <ellipse cx={MOUTH.x} cy={MOUTH.y + mouthRy * 0.5} rx={MOUTH_RX[mouth.shape] * 0.6} ry={mouthRy * 0.35} fill="#ff8fa3" />
        </g>
        : <path d={`M ${MOUTH.x - 30} ${MOUTH.y - 4} Q ${MOUTH.x} ${MOUTH.y + 20} ${MOUTH.x + 30} ${MOUTH.y - 4}`} fill="none" stroke={INK} strokeWidth="6" strokeLinecap="round" />}
    </g>
  </svg>;
};
