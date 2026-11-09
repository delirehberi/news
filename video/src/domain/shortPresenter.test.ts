import { describe, expect, it } from 'vitest';
import type { WordTiming } from './captions.ts';
import { blinkAmount, idleMotion, mouthAt, sectionColorStops } from './shortPresenter.ts';

const words: WordTiming[] = [
  { word: 'Alo', start: 0, end: 0.4 },
  { word: 'Öğüt', start: 0.6, end: 1.2 },
  { word: 'str', start: 1.3, end: 1.5 },
];

describe('mouthAt', () => {
  it('stays closed before speech, in pauses and after the last word', () => {
    expect(mouthAt(words, -0.2).openness).toBe(0);
    expect(mouthAt(words, 0.5).openness).toBe(0);
    expect(mouthAt(words, 2).openness).toBe(0);
    expect(mouthAt([], 1).openness).toBe(0);
  });
  it('opens while a word is spoken and closes at the word edges', () => {
    expect(mouthAt(words, 0).openness).toBe(0);
    expect(mouthAt(words, 0.1).openness).toBeGreaterThan(0.2);
    expect(mouthAt(words, 0.1).openness).toBeLessThanOrEqual(1 + 1e-9);
    expect(mouthAt(words, 0.399).openness).toBeLessThan(0.1);
  });
  it('picks the mouth shape from the vowel being spoken', () => {
    expect(mouthAt(words, 0.05).shape).toBe('open');
    expect(mouthAt(words, 0.7).shape).toBe('round');
    expect(mouthAt(words, 1.1).shape).toBe('round');
    expect(mouthAt(words, 1.4).shape).toBe('open');
  });
});

describe('blinkAmount and idleMotion', () => {
  it('blinks briefly once per period', () => {
    expect(blinkAmount(0)).toBe(0);
    expect(blinkAmount(4)).toBe(1);
    expect(blinkAmount(8)).toBe(0);
    expect(blinkAmount(50)).toBe(0);
    expect(blinkAmount(104)).toBe(1);
    expect(blinkAmount(-96)).toBe(1);
  });
  it('bobs more while speaking and stays bounded', () => {
    const resting = Math.max(...Array.from({ length: 120 }, (_, frame) => Math.abs(idleMotion(frame, 0).bob)));
    const talking = Math.max(...Array.from({ length: 120 }, (_, frame) => Math.abs(idleMotion(frame, 1).bob)));
    expect(talking).toBeGreaterThan(resting);
    expect(talking).toBeLessThan(12);
  });
});

describe('sectionColorStops', () => {
  it('holds each colour and fades in before the next section, with strictly increasing frames', () => {
    const { frames, colors } = sectionColorStops([0, 100, 200], ['#111111', '#222222', '#333333']);
    expect(frames).toEqual([0, 82, 100, 182, 200]);
    expect(colors).toEqual(['#111111', '#111111', '#222222', '#222222', '#333333']);
  });
  it('stays increasing for very short sections and cycles colours', () => {
    const { frames, colors } = sectionColorStops([0, 5, 6], ['#111111', '#222222']);
    frames.slice(1).forEach((frame, index) => expect(frame).toBeGreaterThan(frames[index]));
    expect(colors[colors.length - 1]).toBe('#111111');
  });
  it('rejects empty input', () => {
    expect(() => sectionColorStops([], ['#111111'])).toThrow('At least one');
  });
});
