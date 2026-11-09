import { describe, expect, it } from 'vitest';
import { eligibleShortStories, shortsResponseSchema } from './shorts-script.ts';
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
});
