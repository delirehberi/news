import type { CommandContext } from '../cli.ts';
import { SHORT_INSTAGRAM_HANDLE, SHORT_YOUTUBE_HANDLE, type Shorts } from '../domain/shorts.ts';
import { fileExists, isoWeek, writeTextAtomic } from '../lib/paths.ts';
import { loadShortsDraft, type ShortsCommandDeps } from './shorts-script.ts';
import { requireShortsUpload } from './shorts-voice.ts';
import path from 'node:path';

const DAYS_PER_WEEK = 7;
const POST_INTERVAL_DAYS = 2;
const ISO_ANCHOR_DAY = 4;
export function shortPostingDates(week: string, count: number): string[] {
  if (!/^\d{4}-W\d{2}$/.test(week)) throw new Error('Invalid posting week');
  const year = Number(week.slice(0, 4));
  const weekNumber = Number(week.slice(6));
  const monday = new Date(Date.UTC(year, 0, ISO_ANCHOR_DAY));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK) + (weekNumber - 1) * DAYS_PER_WEEK);
  if (isoWeek(monday) !== week) throw new Error(`Invalid ISO posting week: ${week}`);
  // Promote the completed edition in the following week, Monday/Wednesday/Friday/Sunday.
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(monday);
    date.setUTCDate(date.getUTCDate() + DAYS_PER_WEEK + index * POST_INTERVAL_DAYS);
    return date.toISOString().slice(0, 10);
  });
}

export function buildShortsPosting(week: string, draft: Shorts, videoId: string, mock: boolean): string {
  const url = `https://youtu.be/${videoId}`;
  const dates = shortPostingDates(week, draft.shorts.length);
  const header = [
    `# ${week} — Shorts / Reels`,
    mock ? '**MOCK AUDIO — verification only; do not post these files.**' : 'Manual posting only. Use the same MP4 on both platforms.',
    `Full weekly video: ${url}`,
    `YouTube: @${SHORT_YOUTUBE_HANDLE} · Instagram: @${SHORT_INSTAGRAM_HANDLE}`,
    'Dates below are suggested calendar dates in the week following the edition; choose your local posting time.',
    'YouTube Shorts description/comment URLs are not clickable. After uploading, open YouTube Studio → Content → select the Short → Related video → select the full weekly video → Save. This requires advanced feature access; the full video must be public or unlisted.',
    `Instagram: set Profile → Edit profile → Links → Add external link to ${url}. Tell viewers “Tam video profilimdeki bağlantıda.” Do not rely on Reel caption URLs being clickable; caption links have been tested for some Meta Verified accounts and are not universally available.`,
    'Use the supplied PNG as the Instagram cover. For YouTube Shorts, select a frame from the opening hook using the mobile app where available; the PNG is also a reference.',
    'Link behavior checked 2026-11-09:',
    '- https://support.google.com/youtube/answer/13748639',
    '- https://support.google.com/youtube/answer/14075157',
    '- https://www.socialmediatoday.com/news/instagram-tests-links-in-post-captions-for-paying-users/814763/',
  ].join('\n\n');
  return header + '\n\n' + draft.shorts.map((short, index) => [
    `## ${index + 1} — ${dates[index]}`,
    `Video: ${index + 1}.mp4 · Cover: ${index + 1}-cover.png`,
    `Title: ${short.title}`,
    `YouTube description:\n${short.caption}\nTam video: ${url}\n${short.hashtags.join(' ')}`,
    `Instagram caption:\n${short.caption}\nTam video profilimdeki bağlantıda. YouTube: @${SHORT_YOUTUBE_HANDLE}\n${short.hashtags.join(' ')}`,
    `Stories:\n${short.topics.map((topic) => `- ${topic.item_url}`).join('\n')}`,
  ].join('\n\n')).join('\n\n') + '\n';
}

export async function runShortsPostingCommand(ctx: CommandContext, deps: ShortsCommandDeps = {}): Promise<void> {
  const { draft, paths } = await loadShortsDraft(ctx, deps);
  const videoId = await requireShortsUpload(ctx.week, deps.outRoot);
  for (const index of draft.shorts.keys()) {
    if (!await fileExists(path.join(paths.dir, `${index + 1}.mp4`)) || !await fileExists(path.join(paths.dir, `${index + 1}-cover.png`))) throw new Error(`Short ${index + 1} video/cover missing; render before generating posting notes.`);
  }
  await writeTextAtomic(paths.posting, buildShortsPosting(ctx.week, draft, videoId, Boolean(ctx.mock)));
  (deps.stdout ?? console.log)(`Posting notes -> ${paths.posting}`);
}
