import type { WordTiming } from './captions.ts';
import { activeWordIndex } from './shortCaptions.ts';
import { SHORT_FPS } from './shorts.ts';

export const SHORT_MUSIC_VOLUME = 0.12;
export const SHORT_MUSIC_DUCKED_VOLUME = 0.06;
export const SHORT_MUSIC_FADE_IN_SECONDS = 1;
export const SHORT_MUSIC_FADE_OUT_SECONDS = 1.5;
const DUCK_ATTACK_SECONDS = 0.15;
const DUCK_RELEASE_SECONDS = 0.4;

/** 1 while speech is (about to be) audible, easing back to 0 in pauses. */
export function duckAmount(words: readonly WordTiming[], seconds: number): number {
  const index = activeWordIndex(words, seconds);
  const next = words[index + 1];
  const attack = next ? Math.max(0, 1 - (next.start - seconds) / DUCK_ATTACK_SECONDS) : 0;
  if (index < 0) return Math.min(1, attack);
  const release = Math.max(0, 1 - Math.max(0, seconds - words[index].end) / DUCK_RELEASE_SECONDS);
  return Math.min(1, Math.max(attack, release));
}

/** Music gain for a frame: quiet bed, ducked under narration, faded at both ends. */
export function musicVolume(frame: number, durationInFrames: number, words: readonly WordTiming[]): number {
  const seconds = frame / SHORT_FPS;
  const total = durationInFrames / SHORT_FPS;
  const fadeIn = Math.min(1, seconds / SHORT_MUSIC_FADE_IN_SECONDS);
  const fadeOut = Math.min(1, Math.max(0, total - seconds) / SHORT_MUSIC_FADE_OUT_SECONDS);
  const level = SHORT_MUSIC_VOLUME - (SHORT_MUSIC_VOLUME - SHORT_MUSIC_DUCKED_VOLUME) * duckAmount(words, seconds);
  return Math.max(0, level * fadeIn * fadeOut);
}
