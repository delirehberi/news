import { z } from 'zod';
import { countWords } from './script.ts';

export const SHORT_WIDTH = 1080;
export const SHORT_HEIGHT = 1920;
export const SHORT_FPS = 30;
export const SHORT_TARGET_SECONDS = 31;
export const SHORT_MAX_SECONDS = 36;
export const SHORT_TOPICS = 3;
export const SHORT_MAX_COUNT = 4;
export const SHORT_HOOK_WORDS = { min: 5, max: 9 } as const;
export const SHORT_TOPIC_WORDS = { min: 12, max: 16 } as const;
// Generation stays concise; editorial additions are governed by the rendered duration too.
export const SHORT_EDITED_TOPIC_WORDS = { min: 1, max: 24 } as const;
export const SHORT_SECTION_SECONDS = { hook: 3.5, topic: 7, cta: 6 } as const;
export const SHORT_YOUTUBE_HANDLE = 'delirehberi';
export const SHORT_INSTAGRAM_HANDLE = 'delirehberi_ph';
export const SHORT_YOUTUBE_LABEL = "Tam video YouTube'da";
export const SHORT_CTA = "Devamı ve haftanın diğer haberleri YouTube'daki haftalık videomuzda. Beğen, takip et, abone ol!";
export const SHORT_MOBILE_WIDTH = 430;
export const SHORT_MOBILE_HEIGHT = 900;
export const SHORT_MOBILE_SCALE = 3;
export const SHORT_MOBILE_MAX_HEIGHT = 2400;
export const SHORT_SAFE_AREA = { top: 220, right: 180, bottom: 360, left: 90 } as const;
export const SHORT_COMPOSITION_ID = 'WeeklyShort';
const TITLE_MAX_CHARS = 100;
const CAPTION_MAX_CHARS = 1800;
const MAX_HASHTAGS = 8;

const singleLine = z.string().trim().min(1).refine((text) => !/[\r\n]/.test(text), 'Use a single line');
const spokenLine = (budget: { min: number; max: number }) => singleLine.refine(
  (text) => countWords(text) >= budget.min && countWords(text) <= budget.max,
  (text) => ({ message: `Expected ${budget.min}–${budget.max} words; found ${countWords(text)}` })
);
export const ShortTopicSchema = z.object({
  item_url: z.string().url().refine((value) => /^https?:\/\//.test(value), 'Expected HTTP(S) URL'),
  line: spokenLine(SHORT_EDITED_TOPIC_WORDS),
}).strict();
export const ShortSchema = z.object({
  title: singleLine.refine((text) => text.length <= TITLE_MAX_CHARS, 'Title is too long'),
  hook: spokenLine(SHORT_HOOK_WORDS),
  caption: singleLine.refine((text) => text.length <= CAPTION_MAX_CHARS, 'Caption is too long'),
  hashtags: z.array(z.string().regex(/^#[\p{L}\p{N}_]+$/u)).min(1).max(MAX_HASHTAGS),
  topics: z.array(ShortTopicSchema).length(SHORT_TOPICS),
}).strict();
export const ShortsSchema = z.object({ shorts: z.array(ShortSchema).min(1).max(SHORT_MAX_COUNT) }).strict()
  .superRefine(({ shorts }, ctx) => {
    const seen = new Set<string>();
    for (const short of shorts) for (const topic of short.topics) {
      const url = canonicalStoryUrl(topic.item_url);
      if (seen.has(url)) ctx.addIssue({ code: 'custom', message: `Story repeated: ${url}` });
      seen.add(url);
    }
  });
export type Short = z.infer<typeof ShortSchema>;
export type Shorts = z.infer<typeof ShortsSchema>;

export function canonicalStoryUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('utm_') || key === 'fbclid') url.searchParams.delete(key);
  }
  return url.toString().replace(/\/$/, '');
}

export function shortCount(eligibleCount: number): number {
  if (!Number.isInteger(eligibleCount) || eligibleCount < SHORT_TOPICS) {
    throw new Error('Shorts require at least 3 eligible stories in the approved edition.');
  }
  return Math.min(SHORT_MAX_COUNT, Math.floor(eligibleCount / SHORT_TOPICS));
}

export function shortNarration(short: Short): string {
  return [short.hook, ...short.topics.map((topic) => topic.line), SHORT_CTA].join('\n');
}

export function shortsToMarkdown(input: Shorts): string {
  const { shorts } = ShortsSchema.parse(input);
  return shorts.map((short, index) => [
    `## Short ${index + 1}`, `Title: ${short.title}`, `Hook: ${short.hook}`,
    `Caption: ${short.caption}`, `Hashtags: ${short.hashtags.join(' ')}`,
    ...short.topics.flatMap((topic, topicIndex) => [
      `### Topic ${topicIndex + 1}: ${topic.item_url}`, topic.line,
    ]),
  ].join('\n\n')).join('\n\n') + '\n';
}

export function shortsFromMarkdown(markdown: string): Shorts {
  const lines = markdown.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let cursor = 0;
  const take = (prefix: string): string => {
    const line = lines[cursor++];
    if (!line?.startsWith(prefix)) throw new Error(`Invalid shorts.md: expected "${prefix}" at nonempty line ${cursor}.`);
    return line.slice(prefix.length).trim();
  };
  const shorts: Short[] = [];
  while (cursor < lines.length) {
    const number = take('## Short ');
    if (number !== String(shorts.length + 1)) throw new Error('Short numbers must be sequential from 1.');
    const title = take('Title: ');
    const hook = take('Hook: ');
    const caption = take('Caption: ');
    const hashtags = take('Hashtags: ').split(/\s+/);
    const topics: Short['topics'] = [];
    for (let index = 0; index < SHORT_TOPICS; index++) {
      const item_url = take(`### Topic ${index + 1}: `);
      const line = lines[cursor++];
      if (!line || line.startsWith('#')) throw new Error('Each topic requires one spoken line.');
      topics.push({ item_url, line });
    }
    shorts.push({ title, hook, caption, hashtags, topics });
  }
  const parsed = ShortsSchema.safeParse({ shorts });
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => {
      const shortIndex = issue.path[1];
      const topicIndex = issue.path[3];
      const location = typeof shortIndex === 'number' ? `Short ${shortIndex + 1}` : 'Shorts';
      const field = issue.path[2] === 'topics' && typeof topicIndex === 'number'
        ? `topic ${topicIndex + 1}` : String(issue.path[2] ?? 'document');
      return `${location}, ${field}: ${issue.message}`;
    });
    throw new Error(`Invalid shorts.md:\n${details.join('\n')}`);
  }
  return parsed.data;
}
