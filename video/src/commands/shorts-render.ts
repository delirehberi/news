import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { makeCancelSignal, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import type { CommandContext } from '../cli.ts';
import { WeeklyShortPropsSchema, type ShortVisual, type WeeklyShortProps } from '../domain/shortComposition.ts';
import { canonicalStoryUrl, SHORT_COMPOSITION_ID, SHORT_FPS, SHORT_MOBILE_WIDTH, SHORT_MOBILE_SCALE, SHORT_MOBILE_MAX_HEIGHT, SHORT_MOBILE_HEIGHT } from '../domain/shorts.ts';
import { buildShortTiming } from '../domain/shortTiming.ts';
import { loadCachedPageCapture } from './capture.ts';
import { DEFAULT_REMOTION_ENTRY_POINT, downloadStoryImage } from './render.ts';
import { loadShortsDraft, type ShortsCommandDeps } from './shorts-script.ts';
import { loadShortAudio, requireShortsUpload } from './shorts-voice.ts';
import { fileExists, writeJsonAtomic } from '../lib/paths.ts';
import { SHORTS_MUSIC_ASSET, SHORTS_MUSIC_FILE } from '../lib/shortsPaths.ts';
import { assertSafeHttpUrl } from '../lib/ssrf.ts';

const COVER_FRAME = SHORT_FPS;
const RENDER_CONCURRENCY = 2;
const MAX_IMAGE_REDIRECTS = 5;

/** Recheck every redirect before the image downloader touches a remote address. */
export function safeShortImageFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    let url = new URL(String(input));
    for (let redirects = 0; redirects <= MAX_IMAGE_REDIRECTS; redirects++) {
      init?.signal?.throwIfAborted();
      await assertSafeHttpUrl(url.toString());
      const response = await fetchImpl(url, { ...init, redirect: 'manual' });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Image redirect has no Location header');
      url = new URL(location, url);
    }
    throw new Error('Too many image redirects');
  };
}
export interface ShortsRenderer {
  bundle: (publicDir: string) => Promise<string>;
  render: (serveUrl: string, props: WeeklyShortProps, videoPath: string, coverPath: string, signal: AbortSignal) => Promise<void>;
}

const defaultRenderer: ShortsRenderer = {
  bundle: (publicDir) => bundle({ entryPoint: DEFAULT_REMOTION_ENTRY_POINT, publicDir }),
  async render(serveUrl, props, videoPath, coverPath, signal) {
    signal.throwIfAborted();
    const inputProps = { ...props };
    const composition = await selectComposition({ serveUrl, id: SHORT_COMPOSITION_ID, inputProps });
    const { cancelSignal, cancel } = makeCancelSignal();
    const onAbort = () => cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      signal.throwIfAborted();
      await renderMedia({ serveUrl, composition, inputProps, codec: 'h264', pixelFormat: 'yuv420p', outputLocation: videoPath, concurrency: RENDER_CONCURRENCY, cancelSignal, overwrite: true });
      await renderStill({ serveUrl, composition, inputProps, frame: COVER_FRAME, imageFormat: 'png', output: coverPath, cancelSignal, overwrite: true });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  },
};

export interface ShortsRenderDeps extends ShortsCommandDeps { renderer?: ShortsRenderer; musicFile?: string }

export async function runShortsRenderCommand(ctx: CommandContext, deps: ShortsRenderDeps = {}): Promise<void> {
  const { draft, items, paths } = await loadShortsDraft(ctx, deps);
  await requireShortsUpload(ctx.week, deps.outRoot);
  const stdout = deps.stdout ?? console.log;
  const renderer = deps.renderer ?? defaultRenderer;
  const propsList: WeeklyShortProps[] = [];
  const musicFile = deps.musicFile ?? SHORTS_MUSIC_FILE;
  const hasMusic = await fileExists(musicFile);
  if (!hasMusic) stdout(`Warning: no background music at ${musicFile}; rendering without it. Run make shorts-music to create it.`);
  // Validate every audio file before bundling or rendering any output.
  for (const [offset, short] of draft.shorts.entries()) {
    const audio = await loadShortAudio(ctx, short, offset + 1, deps.outRoot);
    if (!audio) throw new Error(`Short ${offset + 1} audio is missing or stale. Run shorts-voice with the same --mock setting first.`);
    const timing = buildShortTiming(short, audio.words, audio.duration_seconds);
    const visuals: ShortVisual[] = [];
    for (const [topicOffset, topic] of short.topics.entries()) {
      const storyIndex = offset * short.topics.length + topicOffset + 1;
      const url = canonicalStoryUrl(topic.item_url);
      const item = items.find((candidate) => canonicalStoryUrl(candidate.url) === url);
      if (!item) throw new Error(`Short story no longer eligible: ${url}`);
      const page = await loadCachedPageCapture(paths.pagesDir, storyIndex, url);
      const validPage = page && page.viewport.width === SHORT_MOBILE_WIDTH && page.viewport.height === SHORT_MOBILE_HEIGHT && page.viewport.deviceScaleFactor === SHORT_MOBILE_SCALE && page.page_height <= SHORT_MOBILE_MAX_HEIGHT;
      if (validPage) {
        visuals.push({ source: item.source, headline: item.title_tr, pageSrc: `pages-mobile/${storyIndex}.png`, pageHeight: page.page_height, focusY: page.elements.find((element) => element.kind === 'h1')?.box.y ?? 0 });
      } else {
        const imageSrc = await downloadStoryImage({ imageUrl: page?.og_image_url ?? item.image_url, storyIndex, imagesDir: paths.imagesDir, signal: ctx.signal, fetchImpl: safeShortImageFetch(deps.fetchImpl), onWarn: stdout });
        visuals.push({ source: item.source, headline: item.title_tr, ...(imageSrc ? { imageSrc } : {}) });
      }
    }
    propsList.push(WeeklyShortPropsSchema.parse({ short, visuals, timing, audioSrc: `audio/${offset + 1}.mp3`, ...(hasMusic ? { musicSrc: SHORTS_MUSIC_ASSET } : {}), words: audio.words }));
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'news-shorts-'));
  await fs.rm(paths.posting, { force: true });
  let serveUrl: string | undefined;
  try {
    const publicDir = path.join(temporary, 'public');
    await fs.mkdir(publicDir, { recursive: true });
    // Copy only referenced media, never upload receipts, scripts, or unrelated weekly assets.
    const assets = new Set(propsList.flatMap((props) => [props.audioSrc, ...props.visuals.flatMap((visual) => [visual.pageSrc, visual.imageSrc])]).filter((asset): asset is string => Boolean(asset)));
    for (const asset of assets) {
      const destination = path.join(publicDir, asset);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(paths.dir, asset), destination);
    }
    if (hasMusic) {
      await fs.mkdir(path.join(publicDir, path.dirname(SHORTS_MUSIC_ASSET)), { recursive: true });
      await fs.copyFile(musicFile, path.join(publicDir, SHORTS_MUSIC_ASSET));
    }
    ctx.signal.throwIfAborted();
    serveUrl = await renderer.bundle(publicDir);
    for (const [offset, props] of propsList.entries()) {
      ctx.signal.throwIfAborted();
      const number = offset + 1;
      const videoPath = path.join(temporary, `${number}.mp4`);
      const coverPath = path.join(temporary, `${number}-cover.png`);
      await renderer.render(serveUrl, props, videoPath, coverPath, ctx.signal);
      await writeJsonAtomic(path.join(temporary, `${number}-render.json`), { ...props, mock: Boolean(ctx.mock) });
      stdout(`Short ${number}: ${(props.timing.durationInFrames / SHORT_FPS).toFixed(1)}s -> ${paths.dir}/${number}.mp4`);
    }
    // Only replace deliverables after every short in this batch has rendered successfully.
    for (const offset of propsList.keys()) {
      for (const suffix of ['.mp4', '-cover.png', '-render.json']) {
        const name = `${offset + 1}${suffix}`;
        await fs.copyFile(path.join(temporary, name), path.join(paths.dir, name));
      }
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
    if (serveUrl && !deps.renderer) await fs.rm(serveUrl, { recursive: true, force: true });
  }
}
