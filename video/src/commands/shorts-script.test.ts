import { describe, expect, it } from 'vitest';
import { eligibleShortStories, SHORTS_SYSTEM_PROMPT, shortsResponseSchema } from './shorts-script.ts';
import { sampleShort } from '../testFixtures/shorts.ts';
import type { WeeklyEdition } from '../lib/workerClient.ts';

const items = sampleShort.topics.map((topic) => ({ url: topic.item_url, title_tr: 'Başlık', summary_tr: 'Özet', source: 'Kaynak' }));
const edition: WeeklyEdition = { week: '2026-W45', status: 'approved', title_tr: null, intro_tr: null, items, script: { intro: 'Giriş', outro: 'Son', segments: items.map((item) => ({ item_url: item.url, headline_tr: item.title_tr, narration_tr: item.summary_tr })) }, youtube_video_id: null, published_at: null, updated_at: '' };

describe('approved short selection', () => {
  it('uses only narrated approved stories, deduplicating URLs and clusters', () => {
    expect(eligibleShortStories({ ...edition, items: [...items, items[0], { ...items[0], url: 'https://example.com/unapproved' }] })).toEqual(items);
    expect(eligibleShortStories({ ...edition, items: items.map((item) => ({ ...item, cluster_id: 'same' })) })).toHaveLength(1);
  });
  it('enforces membership and exact count after manual edits', () => {
    expect(shortsResponseSchema(items).parse({ shorts: [sampleShort] }).shorts).toHaveLength(1);
    expect(() => shortsResponseSchema(items).parse({ shorts: [{ ...sampleShort, topics: sampleShort.topics.map((topic) => ({ ...topic, item_url: topic.item_url + '/unknown' })) }] })).toThrow('not eligible');
    expect(() => shortsResponseSchema([...items, ...items, ...items]).parse({ shorts: [sampleShort] })).toThrow('exactly 3');
  });
  it('keeps generation concise while allowing bounded editorial changes in production', () => {
    const edited = { shorts: [{ ...sampleShort, topics: sampleShort.topics.map((topic) => ({ ...topic, line: 'kelime '.repeat(20).trim() })) }] };
    expect(shortsResponseSchema(items, false).parse(edited)).toEqual(edited);
    expect(() => shortsResponseSchema(items).parse(edited)).toThrow('Generated topics require 12–16 words');
    const unapproved = { shorts: [{ ...edited.shorts[0], topics: edited.shorts[0].topics.map((topic) => ({ ...topic, item_url: topic.item_url + '/unknown' })) }] };
    expect(() => shortsResponseSchema(items, false).parse(unapproved)).toThrow('not eligible');
  });
  it('applies the generation word budget to spoken words only', () => {
    // 13 spoken words plus 5 marker tokens: the generation budget (12–16) must see 13, not the raw token count.
    const taggedLine = '[thoughtful] Bu hafta [short pause] geliştiriciler için yeni araçlar sunuldu ve teknoloji dünyasında önemli gelişmeler yaşandı. [excited] [pause]';
    const tagged = { shorts: [{ ...sampleShort, hook: '[excited] Bu hafta [pause] teknoloji dünyasında neler değişti yeni araçlar çıktı? [curious]', topics: sampleShort.topics.map((topic) => ({ ...topic, line: taggedLine })) }] };
    expect(shortsResponseSchema(items).parse(tagged)).toEqual(tagged);
  });
  it('rejects emotion markers in on-screen fields of generated drafts', () => {
    expect(() => shortsResponseSchema(items).parse({ shorts: [{ ...sampleShort, caption: '[excited] Tam video.' }] })).toThrow('Emotion markers');
  });
  it('instructs the model to tag hook and topic lines but never on-screen fields', () => {
    expect(SHORTS_SYSTEM_PROMPT).toContain('[excited]');
    expect(SHORTS_SYSTEM_PROMPT).toContain('[short pause]');
    expect(SHORTS_SYSTEM_PROMPT).toContain('do not count toward word limits');
    expect(SHORTS_SYSTEM_PROMPT).toContain('Never write tags in title, caption, or hashtags');
  });
});
