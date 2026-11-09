import type { Short } from '../domain/shorts.ts';
export const sampleShort: Short = {
  title: 'Haftanın teknoloji haberleri',
  hook: 'Bu hafta teknoloji dünyasında neler değişti?',
  caption: 'Haftanın haberleri için tam videoyu izleyin.',
  hashtags: ['#teknoloji'],
  topics: [1, 2, 3].map((index) => ({
    item_url: `https://example.com/story-${index}`,
    line: 'Bu hafta geliştiriciler için yeni araçlar sunuldu ve teknoloji dünyasında önemli gelişmeler yaşandı.',
  })),
};
