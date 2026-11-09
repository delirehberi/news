import { describe, expect, it } from 'vitest';
import type { WordTiming } from './captions.ts';
import { activeWordIndex, captionAt, CAPTION_END_HOLD_SECONDS, CAPTION_POP_SCALE, paginateWords } from './shortCaptions.ts';

const words = (...texts: string[]): WordTiming[] => texts.map((word, index) => ({ word, start: index * 0.5, end: index * 0.5 + 0.4 }));

describe('paginateWords', () => {
  it('limits pages by word count and never spans a sentence end', () => {
    const list = words('Bir', 'iki', 'üç.', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz');
    expect(paginateWords(list, 4, 100)).toEqual([{ start: 0, end: 3 }, { start: 3, end: 7 }, { start: 7, end: 9 }]);
  });
  it('limits pages by characters and keeps an over-long word alone', () => {
    const list = words('kısa', 'Use-After-Free-açığı-hakkında', 'son');
    expect(paginateWords(list, 4, 12)).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }]);
  });
  it('covers every word exactly once and handles empty input', () => {
    const list = words(...Array.from({ length: 23 }, (_, index) => (index % 7 === 6 ? `w${index}.` : `w${index}`)));
    const pages = paginateWords(list);
    expect(pages[0].start).toBe(0);
    expect(pages[pages.length - 1].end).toBe(23);
    pages.slice(1).forEach((page, index) => expect(page.start).toBe(pages[index].end));
    expect(paginateWords([])).toEqual([]);
  });
  it('rejects invalid limits', () => {
    expect(() => paginateWords(words('a'), 0, 10)).toThrow('positive integers');
  });
});

describe('activeWordIndex', () => {
  const list = words('a', 'b', 'c');
  it('follows word starts and holds through pauses', () => {
    expect(activeWordIndex(list, -0.1)).toBe(-1);
    expect(activeWordIndex(list, 0)).toBe(0);
    expect(activeWordIndex(list, 0.45)).toBe(0);
    expect(activeWordIndex(list, 0.5)).toBe(1);
    expect(activeWordIndex(list, 99)).toBe(2);
    expect(activeWordIndex([], 1)).toBe(-1);
  });
});

describe('captionAt', () => {
  const list = words('Bir', 'iki', 'üç.', 'dört', 'beş');
  it('marks spoken, active and upcoming words on the current page', () => {
    const page = captionAt(list, 0.6);
    expect(page?.map((word) => [word.text, word.state])).toEqual([['Bir', 'spoken'], ['iki', 'active'], ['üç.', 'upcoming']]);
  });
  it('pops the active word at its start and settles to normal size', () => {
    expect(captionAt(list, 0.5)?.[1].scale).toBeCloseTo(1 + CAPTION_POP_SCALE);
    expect(captionAt(list, 0.9)?.[1].scale).toBe(1);
    expect(captionAt(list, 0.9)?.[0].scale).toBe(1);
  });
  it('switches page exactly when the first word of the next page starts', () => {
    expect(captionAt(list, 0.99)?.[0].text).toBe('Bir');
    expect(captionAt(list, 1.5)?.map((word) => word.text)).toEqual(['dört', 'beş']);
  });
  it('shows nothing before narration or after the end hold', () => {
    expect(captionAt(list, -1)).toBeNull();
    expect(captionAt(list, 2.4 + CAPTION_END_HOLD_SECONDS + 0.01)).toBeNull();
    expect(captionAt(list, 2.4 + CAPTION_END_HOLD_SECONDS - 0.01)).not.toBeNull();
    expect(captionAt([], 0)).toBeNull();
  });
});
