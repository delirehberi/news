import { z } from 'zod';
import { WordTimingSchema } from './timeline.ts';
import { SHORT_CTA, SHORT_FPS, SHORT_MAX_SECONDS, SHORT_TOPICS, SHORT_TARGET_SECONDS, ShortSchema } from './shorts.ts';

const LocalAsset = z.string().regex(/^(audio|pages-mobile|images)\/[\w.-]+$/, 'Expected a local short asset');
const LocalMusic = z.string().regex(/^music\/[\w.-]+$/, 'Expected a local music asset');
export const ShortVisualSchema = z.object({
  source: z.string().min(1),
  headline: z.string().min(1),
  pageSrc: LocalAsset.optional(),
  imageSrc: LocalAsset.optional(),
  pageHeight: z.number().positive().optional(),
  focusY: z.number().nonnegative().optional(),
});
export const WeeklyShortPropsSchema = z.object({
  short: ShortSchema,
  audioSrc: LocalAsset.optional(),
  musicSrc: LocalMusic.optional(),
  visuals: z.array(ShortVisualSchema).length(SHORT_TOPICS),
  words: z.array(WordTimingSchema),
  timing: z.object({
    durationInFrames: z.number().int().positive().max(SHORT_MAX_SECONDS * SHORT_FPS),
    sections: z.array(z.object({ startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive(), text: z.string() })).length(SHORT_TOPICS + 2),
  }),
});
export type WeeklyShortProps = z.infer<typeof WeeklyShortPropsSchema>;
export type ShortVisual = z.infer<typeof ShortVisualSchema>;

export const DEFAULT_WEEKLY_SHORT_PROPS: WeeklyShortProps = {
  short: {
    title: 'Haftanın teknoloji haberleri',
    hook: 'Bu hafta teknoloji dünyasında neler değişti?',
    caption: 'Haftanın tamamı YouTube kanalında.',
    hashtags: ['#teknoloji'],
    topics: Array.from({ length: SHORT_TOPICS }, (_, index) => ({
      item_url: `https://example.com/story-${index + 1}`,
      line: 'Bu hafta geliştiriciler için yeni araçlar sunuldu ve teknoloji dünyasında önemli gelişmeler yaşandı.',
    })),
  },
  visuals: Array.from({ length: SHORT_TOPICS }, () => ({ source: 'news.emre.xyz', headline: 'Haftanın teknoloji haberleri' })),
  words: [],
  timing: {
    durationInFrames: SHORT_TARGET_SECONDS * SHORT_FPS,
    sections: [0, 4, 11, 18, 25].map((seconds, index, starts) => ({ startFrame: seconds * SHORT_FPS, endFrame: (starts[index + 1] ?? SHORT_TARGET_SECONDS) * SHORT_FPS, text: index === SHORT_TOPICS + 1 ? SHORT_CTA : 'Haftanın teknoloji haberleri' })),
  },
};
