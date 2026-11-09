import { expect, it } from 'vitest';
import { buildShortTiming } from './shortTiming.ts';
import { sampleShort } from '../testFixtures/shorts.ts';
import { shortNarration, SHORT_CTA, SHORT_FPS } from './shorts.ts';
import { synthesizeMockWithTimestamps } from '../lib/elevenlabs.ts';
import { alignmentToWords, getAlignmentDurationSeconds } from './captions.ts';

it('derives five contiguous scenes from speech and holds the CTA for six seconds', () => {
  const audio = synthesizeMockWithTimestamps(shortNarration(sampleShort));
  const words = alignmentToWords(audio.alignment);
  const timing = buildShortTiming(sampleShort, words, getAlignmentDurationSeconds(audio.alignment));
  expect(timing.sections).toHaveLength(5);
  expect(timing.sections[4].text).toBe(SHORT_CTA);
  expect(timing.sections[4].endFrame - timing.sections[4].startFrame).toBeGreaterThanOrEqual(6 * SHORT_FPS);
  expect(timing.durationInFrames).toBe(31 * SHORT_FPS);
  expect(() => buildShortTiming(sampleShort, words.slice(1), 30)).toThrow('does not match');
  expect(() => buildShortTiming(sampleShort, words, 100)).toThrow('exceeding');
  expect(() => buildShortTiming(sampleShort, words.map((word) => ({ ...word, start: -1 })), 30)).toThrow('Invalid');
});
