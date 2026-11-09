import type { WordTiming } from './captions.ts';

export const CAPTION_PAGE_MAX_WORDS = 4;
export const CAPTION_PAGE_MAX_CHARS = 24;
// Keeps the last page visible briefly after the final word instead of cutting it off.
export const CAPTION_END_HOLD_SECONDS = 0.6;
export const CAPTION_POP_SECONDS = 0.18;
export const CAPTION_POP_SCALE = 0.12;
const SENTENCE_END = /[.!?…:]["')»”]*$/u;

export type CaptionWordState = 'spoken' | 'active' | 'upcoming';
export interface CaptionWord { text: string; state: CaptionWordState; scale: number }
interface CaptionPage { start: number; end: number }

/** Splits narration into short pages; a page never spans a sentence end. */
export function paginateWords(
  words: readonly WordTiming[],
  maxWords: number = CAPTION_PAGE_MAX_WORDS,
  maxChars: number = CAPTION_PAGE_MAX_CHARS,
): CaptionPage[] {
  if (!Number.isInteger(maxWords) || maxWords < 1 || !Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error('Caption page limits must be positive integers.');
  }
  const pages: CaptionPage[] = [];
  let start = 0;
  let length = 0;
  for (const [index, { word }] of words.entries()) {
    const count = index - start;
    const nextLength = count === 0 ? word.length : length + 1 + word.length;
    if (count > 0 && (count >= maxWords || nextLength > maxChars)) {
      pages.push({ start, end: index });
      start = index;
      length = word.length;
    } else {
      length = nextLength;
    }
    if (SENTENCE_END.test(word)) {
      pages.push({ start, end: index + 1 });
      start = index + 1;
      length = 0;
    }
  }
  if (start < words.length) pages.push({ start, end: words.length });
  return pages;
}

/** Index of the word being spoken (or last spoken, during a pause); -1 before narration starts. */
export function activeWordIndex(words: readonly WordTiming[], seconds: number): number {
  let low = 0;
  let high = words.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (words[middle].start <= seconds) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** Page of words to display at `seconds`, with the spoken word flagged; null when nothing should show. */
export function captionAt(words: readonly WordTiming[], seconds: number): CaptionWord[] | null {
  const active = activeWordIndex(words, seconds);
  if (active < 0) return null;
  if (active === words.length - 1 && seconds > words[active].end + CAPTION_END_HOLD_SECONDS) return null;
  const page = paginateWords(words).find((candidate) => active >= candidate.start && active < candidate.end);
  if (!page) return null;
  return words.slice(page.start, page.end).map((word, offset) => {
    const index = page.start + offset;
    const state: CaptionWordState = index < active ? 'spoken' : index === active ? 'active' : 'upcoming';
    const pop = state === 'active' ? Math.max(0, 1 - (seconds - word.start) / CAPTION_POP_SECONDS) : 0;
    return { text: word.word, state, scale: 1 + CAPTION_POP_SCALE * pop };
  });
}
