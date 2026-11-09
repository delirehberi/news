import type { WordTiming } from './captions.ts';
import { activeWordIndex } from './shortCaptions.ts';

export type MouthShape = 'open' | 'wide' | 'round';
export interface MouthState { openness: number; shape: MouthShape }

const SYLLABLES_PER_SECOND = 5;
const MOUTH_MIN_OPEN = 0.3;
const MOUTH_ATTACK_SECONDS = 0.05;
const MOUTH_RELEASE_SECONDS = 0.06;
const BLINK_PERIOD_FRAMES = 100;
const BLINK_FRAMES = 8;
const IDLE_BOB_PERIOD_FRAMES = 84;
const IDLE_SWAY_PERIOD_FRAMES = 140;
const IDLE_BOB_PX = 4;
const SPEAKING_BOB_BOOST = 1.2;
const IDLE_SWAY_DEGREES = 1.6;
const SECTION_FADE_FRAMES = 18;
const VOWEL_SHAPES: Record<string, MouthShape> = { a: 'open', â: 'open', e: 'wide', i: 'wide', î: 'wide', ı: 'wide', o: 'round', ö: 'round', u: 'round', ü: 'round', û: 'round' };
const VOWELS = /[aâeiîıoöuüû]/gu;

/** Mouth follows the aligned words: shut in pauses, opening in syllable-rate pulses with a vowel-based shape. */
export function mouthAt(words: readonly WordTiming[], seconds: number): MouthState {
  const closed: MouthState = { openness: 0, shape: 'open' };
  const index = activeWordIndex(words, seconds);
  if (index < 0) return closed;
  const word = words[index];
  if (seconds >= word.end) return closed;
  const elapsed = seconds - word.start;
  const pulse = MOUTH_MIN_OPEN + (1 - MOUTH_MIN_OPEN) * Math.abs(Math.sin(Math.PI * elapsed * SYLLABLES_PER_SECOND));
  const attack = Math.min(1, elapsed / MOUTH_ATTACK_SECONDS);
  const release = Math.min(1, (word.end - seconds) / MOUTH_RELEASE_SECONDS);
  const vowels = word.word.toLocaleLowerCase('tr').match(VOWELS) ?? [];
  const progress = elapsed / Math.max(word.end - word.start, Number.EPSILON);
  const vowel = vowels[Math.min(vowels.length - 1, Math.floor(progress * vowels.length))];
  return { openness: pulse * attack * release, shape: (vowel && VOWEL_SHAPES[vowel]) || 'open' };
}

/** 0 = eyes open, 1 = fully closed; a short triangular blink once per period. */
export function blinkAmount(frame: number): number {
  const phase = ((frame % BLINK_PERIOD_FRAMES) + BLINK_PERIOD_FRAMES) % BLINK_PERIOD_FRAMES;
  if (phase >= BLINK_FRAMES) return 0;
  const half = BLINK_FRAMES / 2;
  return 1 - Math.abs(phase - half) / half;
}

/** Gentle head bob and sway; the bob grows while speaking. */
export function idleMotion(frame: number, speaking: number): { bob: number; sway: number } {
  return {
    bob: Math.sin((frame * 2 * Math.PI) / IDLE_BOB_PERIOD_FRAMES) * IDLE_BOB_PX * (1 + SPEAKING_BOB_BOOST * speaking),
    sway: Math.sin((frame * 2 * Math.PI) / IDLE_SWAY_PERIOD_FRAMES) * IDLE_SWAY_DEGREES,
  };
}

/** Frames/colours for interpolateColors: each section holds its colour and fades in just before it starts. */
export function sectionColorStops(startFrames: readonly number[], colors: readonly string[]): { frames: number[]; colors: string[] } {
  if (startFrames.length === 0 || colors.length === 0) throw new Error('At least one section and colour are required.');
  const frames: number[] = [];
  const stops: string[] = [];
  startFrames.forEach((start, index) => {
    const color = colors[index % colors.length];
    if (index > 0) {
      frames.push(Math.max(frames[frames.length - 1] + 1, start - SECTION_FADE_FRAMES));
      stops.push(stops[stops.length - 1]);
    }
    frames.push(Math.max(index === 0 ? 0 : frames[frames.length - 1] + 1, start));
    stops.push(color);
  });
  return { frames, colors: stops };
}
