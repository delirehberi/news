import { describe, expect, it } from 'vitest';
import type { WordTiming } from './captions.ts';
import { duckAmount, musicVolume, SHORT_MUSIC_DUCKED_VOLUME, SHORT_MUSIC_VOLUME } from './shortMusic.ts';
import { SHORT_FPS } from './shorts.ts';

const words: WordTiming[] = [
  { word: 'bir', start: 2, end: 2.5 },
  { word: 'iki', start: 5, end: 5.5 },
];
const DURATION = 12 * SHORT_FPS;

describe('duckAmount', () => {
  it('ducks fully during a word, eases off after it and ramps in before the next', () => {
    expect(duckAmount(words, 2.2)).toBe(1);
    expect(duckAmount(words, 2.7)).toBeCloseTo(0.5);
    expect(duckAmount(words, 3.5)).toBe(0);
    expect(duckAmount(words, 4.925)).toBeCloseTo(0.5);
    expect(duckAmount(words, 1.9)).toBeCloseTo(1 / 3);
  });
  it('does not duck without words', () => {
    expect(duckAmount([], 1)).toBe(0);
  });
});

describe('musicVolume', () => {
  it('fades in from silence and out to silence', () => {
    expect(musicVolume(0, DURATION, [])).toBe(0);
    expect(musicVolume(DURATION, DURATION, [])).toBe(0);
    expect(musicVolume(6 * SHORT_FPS, DURATION, [])).toBe(SHORT_MUSIC_VOLUME);
  });
  it('sits lower under speech but stays audible and quiet', () => {
    const speaking = musicVolume(Math.round(2.2 * SHORT_FPS), DURATION, words);
    expect(speaking).toBeCloseTo(SHORT_MUSIC_DUCKED_VOLUME, 5);
    expect(speaking).toBeLessThan(SHORT_MUSIC_VOLUME);
    expect(SHORT_MUSIC_VOLUME).toBeLessThanOrEqual(0.15);
  });
  it('never returns a negative gain past the end', () => {
    expect(musicVolume(DURATION + 30, DURATION, [])).toBe(0);
  });
});
