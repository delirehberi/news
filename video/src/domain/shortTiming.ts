import type { WordTiming } from './captions.ts';
import { SHORT_CTA, SHORT_FPS, SHORT_MAX_SECONDS, SHORT_SECTION_SECONDS, SHORT_TARGET_SECONDS, type Short } from './shorts.ts';

export interface ShortSection { startFrame: number; endFrame: number; text: string }
export interface ShortTiming { sections: ShortSection[]; durationInFrames: number }
const normalizeWord = (word: string): string => word.toLocaleLowerCase('tr').replace(/[^\p{L}\p{N}]/gu, '');

/** Boundaries follow actual aligned words; the end card holds long enough to read both handles. */
export function buildShortTiming(short: Short, words: readonly WordTiming[], durationSeconds: number): ShortTiming {
  const texts = [short.hook, ...short.topics.map((topic) => topic.line), SHORT_CTA];
  const expected = texts.flatMap((text) => text.split(/\s+/));
  if (expected.length !== words.length || expected.some((word, index) => normalizeWord(word) !== normalizeWord(words[index].word))) {
    throw new Error('Short word alignment does not match narration. Regenerate voice with original-text timestamps.');
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || words.some((word, index) =>
    !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end < word.start || word.end > durationSeconds || (index > 0 && word.start < words[index - 1].start))) {
    throw new Error('Invalid short word timing or audio duration.');
  }
  let offset = 0;
  const starts = texts.map((text, index) => {
    const start = index === 0 ? 0 : Math.round(words[offset].start * SHORT_FPS);
    offset += text.split(/\s+/).length;
    return start;
  });
  const durationInFrames = Math.max(
    Math.ceil(durationSeconds * SHORT_FPS),
    Math.ceil(SHORT_TARGET_SECONDS * SHORT_FPS),
    starts[starts.length - 1] + Math.ceil(SHORT_SECTION_SECONDS.cta * SHORT_FPS),
  );
  if (durationInFrames > SHORT_MAX_SECONDS * SHORT_FPS) {
    throw new Error(`Short runs ${(durationInFrames / SHORT_FPS).toFixed(1)}s, exceeding ${SHORT_MAX_SECONDS}s. Shorten hook/topic lines and regenerate voice.`);
  }
  const sections = texts.map((text, index) => ({ text, startFrame: starts[index], endFrame: starts[index + 1] ?? durationInFrames }));
  if (sections.some((section) => section.endFrame <= section.startFrame)) throw new Error('Short sections must have positive durations.');
  return { sections, durationInFrames };
}
