import { sampleShort } from '../testFixtures/shorts.ts';
import { describe, expect, it } from 'vitest';
import { SHORT_CTA, ShortsSchema, shortCount, shortNarration, shortsFromMarkdown, shortsToMarkdown } from './shorts.ts';
import { getShortsPaths } from '../lib/shortsPaths.ts';


describe('shorts scripts', () => {
  it('round trips editable Turkish Markdown', () => {
    expect(shortsFromMarkdown(shortsToMarkdown({ shorts: [sampleShort] }))).toEqual({ shorts: [sampleShort] });
  });
  it.each([[3, 1], [8, 2], [9, 3], [12, 4], [20, 4]])('groups %i eligible stories into %i shorts', (count, result) => {
    expect(shortCount(count)).toBe(result);
  });
  it('rejects too few stories and unsafe week paths', () => {
    expect(() => shortCount(2)).toThrow('at least 3');
    expect(() => getShortsPaths('../bad')).toThrow();
  });
  it('rejects repeated stories, even with tracking parameters', () => {
    const repeated = { ...sampleShort, topics: [...sampleShort.topics.slice(0, 2), { ...sampleShort.topics[0], item_url: sampleShort.topics[0].item_url + '?utm_source=foo' }] };
    expect(() => ShortsSchema.parse({ shorts: [repeated] })).toThrow('Story repeated');
  });
  it('rejects extra CTA fields, long narration and malformed Markdown', () => {
    expect(() => ShortsSchema.parse({ shorts: [{ ...sampleShort, cta: 'changed' }] })).toThrow();
    expect(() => ShortsSchema.parse({ shorts: [{ ...sampleShort, hook: 'word '.repeat(20) }] })).toThrow();
    expect(() => shortsFromMarkdown('## Short 2\n')).toThrow('sequential');
    expect(() => shortsFromMarkdown(shortsToMarkdown({ shorts: [sampleShort] }).replace('Hook:', 'Oops:'))).toThrow('expected');
  });
  it('always appends the exact CTA', () => {
    expect(shortNarration(sampleShort).split('\n').at(-1)).toBe(SHORT_CTA);
  });
  it('preserves editorial additions and reports over-budget topics with one-based locations', () => {
    const edited = { ...sampleShort, topics: sampleShort.topics.map((topic, index) => ({
      ...topic,
      line: index === 0
        ? 'Hacker News önerilerinden oluşan alternatif video kürasyon platformu HackerTube kısa sürede hayata geçirildi. HackerBooks ve HackerWiki gibi benzerleri de yapıldı.'
        : index === 2
          ? 'Google popüler tarayıcısı Chrome içerisinden XSLT desteğini kaldırma planlarını bugün resmen duyurdu. Lanet şirket webi bozmaya çalışıyor.'
          : topic.line,
    })) };
    expect(shortsFromMarkdown(shortsToMarkdown({ shorts: [edited] }))).toEqual({ shorts: [edited] });
    const markdown = shortsToMarkdown({ shorts: [sampleShort] }).replace(sampleShort.topics[0].line, 'word '.repeat(25).trim());
    expect(() => shortsFromMarkdown(markdown)).toThrow('Short 1, topic 1: Expected 1–24 words; found 25');
  });
});
