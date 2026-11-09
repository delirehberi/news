import { expect, it } from 'vitest';
import { buildShortsPosting, shortPostingDates } from './shorts-posting.ts';
import { sampleShort } from '../testFixtures/shorts.ts';

it('schedules every other day across ISO year boundaries', () => {
  expect(shortPostingDates('2026-W45', 4)).toEqual(['2026-11-09', '2026-11-11', '2026-11-13', '2026-11-15']);
  expect(shortPostingDates('2026-W53', 1)).toEqual(['2027-01-04']);
  expect(() => shortPostingDates('2025-W53', 1)).toThrow('Invalid');
});
it('includes the full-video link, platform-specific steps, captions and mock warning', () => {
  const notes = buildShortsPosting('2026-W45', { shorts: [sampleShort] }, '4wAwR9J1Z4E', true);
  for (const value of ['https://youtu.be/4wAwR9J1Z4E', 'Related video', 'Add external link', 'not clickable', 'MOCK AUDIO', '1-cover.png', '#teknoloji']) expect(notes).toContain(value);
});
