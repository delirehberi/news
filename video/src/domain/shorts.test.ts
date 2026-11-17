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
  it('round trips emotion markers in hook and topic lines and keeps them out of spoken counts', () => {
    const tagged = {
      ...sampleShort,
      hook: '[excited] Bu hafta teknoloji dünyasında neler değişti yeni araçlar çıktı? [curious]',
      topics: sampleShort.topics.map((topic, index) => ({
        ...topic,
        line: index === 0 ? '[thoughtful] Bu hafta [short pause] geliştiriciler için yeni araçlar sunuldu.' : topic.line,
      })),
    };
    expect(ShortsSchema.parse({ shorts: [tagged] })).toEqual({ shorts: [tagged] });
    expect(shortsFromMarkdown(shortsToMarkdown({ shorts: [tagged] }))).toEqual({ shorts: [tagged] });
  });
  it('counts only spoken hook words, so markers never push a hook over budget', () => {
    const spokenNineWithMarkers = '[excited] Bu hafta [pause] teknoloji dünyasında neler değişti yeni araçlar çıktı? [curious]';
    expect(ShortsSchema.parse({ shorts: [{ ...sampleShort, hook: spokenNineWithMarkers }] }).shorts[0].hook).toBe(spokenNineWithMarkers);
    const spokenTenWithMarkers = '[excited] Bu hafta [pause] teknoloji dünyasında neler değişti ve yeni araçlar çıktı? [curious]';
    expect(() => ShortsSchema.parse({ shorts: [{ ...sampleShort, hook: spokenTenWithMarkers }] })).toThrow('Expected 5–9 words; found 10');
  });
  it.each([
    ['title', { title: 'Haftanın [excited] haberleri' }],
    ['caption', { caption: 'Tam video için [pause] izleyin.' }],
    ['hashtag', { hashtags: ['#teknoloji', '#[excited]'] }],
  ])('forbids emotion markers in %s', (_field, override) => {
    expect(() => ShortsSchema.parse({ shorts: [{ ...sampleShort, ...override }] })).toThrow();
  });
  it('reports the on-screen marker rule with the offending field', () => {
    expect(() => ShortsSchema.parse({ shorts: [{ ...sampleShort, title: 'Haftanın [excited] haberleri' }] })).toThrow(
      'Emotion markers are only allowed in hook and topic lines'
    );
  });
});
