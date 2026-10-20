import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import {
  makeCancelSignal,
  renderMedia,
  renderStill,
  selectComposition,
} from '@remotion/renderer';
import { z } from 'zod';
import type { CommandContext } from '../cli.ts';
import { ScriptSchema, type Script } from '../domain/script.ts';
import {
  buildVideoTimeline,
  CaptionChunkSchema,
  DEFAULT_SITE_URL,
  extractHostname,
  THUMBNAIL_FRAME,
  VIDEO_FPS,
  WEEKLY_VIDEO_COMPOSITION_ID,
  type StorySceneItem,
  type VideoTimeline,
  type WeeklyVideoProps,
} from '../domain/timeline.ts';
import {
  fileExists,
  getWeekPaths,
  readJson,
  writeBytesAtomic,
} from '../lib/paths.ts';
import {
  createWorkerClient,
  type WeeklyItem,
  type WorkerClient,
} from '../lib/workerClient.ts';
import { assertEditionApproved } from './approve.ts';
import { buildVoiceSegments } from './voice.ts';

export const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const ALLOWED_IMAGE_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REMOTION_ENTRY_POINT = path.resolve(
  __dirname,
  '..',
  'remotion',
  'Root.tsx'
);

const StoredAudioSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  duration_seconds: z.number().nonnegative(),
  captions: z.array(CaptionChunkSchema),
});

type StoredAudioSegment = z.infer<typeof StoredAudioSegmentSchema>;

const StoredTranslationSchema = z.object({
  week: z.string().min(1),
  title_tr: z.string().min(1),
  intro_tr: z.string().min(1),
  items: z
    .array(
      z.object({
        url: z.string().min(1),
        title_tr: z.string().min(1),
        summary_tr: z.string().min(1),
        source: z.string().min(1),
        image_url: z.string().nullable().optional(),
      })
    )
    .min(1),
});

export interface DownloadStoryImageOptions {
  imageUrl: string | null | undefined;
  storyIndex: number;
  imagesDir: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onWarn?: (msg: string) => void;
}

/**
 * Downloads a story's OG image to `out/<week>/images/<storyIndex>.<ext>` with a timeout,
 * HTTP status check, `Content-Type` validation (`image/*`), and byte size limit.
 * If the URL is missing or the download/validation fails, logs a warning and returns `null`
 * so `StoryScene` falls back to the branded card.
 */
export async function downloadStoryImage(
  options: DownloadStoryImageOptions
): Promise<string | null> {
  const {
    imageUrl,
    storyIndex,
    imagesDir,
    signal,
    timeoutMs = IMAGE_DOWNLOAD_TIMEOUT_MS,
    fetchImpl = fetch,
    onWarn,
  } = options;

  const trimmedUrl = imageUrl?.trim() ?? '';
  if (!trimmedUrl) {
    return null;
  }

  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedUrl);
  } catch {
    onWarn?.(
      `Story #${storyIndex}: invalid image_url "${trimmedUrl}", falling back to branded card.`
    );
    return null;
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    onWarn?.(
      `Story #${storyIndex}: unsupported image protocol "${parsedUrl.protocol}", falling back to branded card.`
    );
    return null;
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  try {
    const response = await fetchImpl(trimmedUrl, {
      method: 'GET',
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
      },
      signal: combinedSignal,
    });

    if (!response.ok) {
      onWarn?.(
        `Story #${storyIndex}: image download returned HTTP ${response.status} for ${trimmedUrl}, falling back to branded card.`
      );
      return null;
    }

    const rawContentType = response.headers.get('content-type') ?? '';
    const mimeType = rawContentType.split(';')[0]?.trim().toLowerCase() ?? '';
    const ext = ALLOWED_IMAGE_MIME_EXTENSIONS[mimeType];

    if (!ext) {
      onWarn?.(
        `Story #${storyIndex}: unsupported Content-Type "${rawContentType || 'none'}" for ${trimmedUrl}, falling back to branded card.`
      );
      return null;
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
      const declaredBytes = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_IMAGE_BYTES) {
        onWarn?.(
          `Story #${storyIndex}: image exceeds max size (${declaredBytes} bytes) for ${trimmedUrl}, falling back to branded card.`
        );
        return null;
      }
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    if (bytes.byteLength === 0) {
      onWarn?.(
        `Story #${storyIndex}: empty image body from ${trimmedUrl}, falling back to branded card.`
      );
      return null;
    }

    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      onWarn?.(
        `Story #${storyIndex}: downloaded image exceeds max size (${bytes.byteLength} bytes) for ${trimmedUrl}, falling back to branded card.`
      );
      return null;
    }

    const fileName = `${storyIndex}${ext}`;
    const destPath = path.join(imagesDir, fileName);
    await writeBytesAtomic(destPath, bytes);

    return `images/${fileName}`;
  } catch (err) {
    if (signal?.aborted) {
      throw signal.reason ?? err;
    }
    const reason = err instanceof Error ? err.message : String(err);
    onWarn?.(
      `Story #${storyIndex}: failed to download image from ${trimmedUrl} (${reason}), falling back to branded card.`
    );
    return null;
  }
}

async function loadAudioSegments(
  audioDir: string,
  script: Script
): Promise<Map<number, StoredAudioSegment>> {
  const specs = buildVoiceSegments(script);
  const segments = new Map<number, StoredAudioSegment>();

  for (const spec of specs) {
    const mp3Path = path.join(audioDir, `${spec.index}.mp3`);
    const jsonPath = path.join(audioDir, `${spec.index}.json`);

    const [hasMp3, hasJson] = await Promise.all([
      fileExists(mp3Path),
      fileExists(jsonPath),
    ]);

    if (!hasMp3 || !hasJson) {
      throw new Error(
        `Missing synthesized audio or alignment for segment ${spec.index} (${spec.kind}) in ${audioDir}. Run "voice" first.`
      );
    }

    const raw = await readJson<unknown>(jsonPath);
    const parsed = StoredAudioSegmentSchema.safeParse(raw);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new Error(`Invalid audio metadata in ${jsonPath}: ${details}`);
    }

    segments.set(spec.index, parsed.data);
  }

  return segments;
}

export interface RemotionRendererAdapter {
  bundleComposition: (options: {
    entryPoint: string;
    publicDir: string;
  }) => Promise<string>;
  renderComposition: (options: {
    serveUrl: string;
    compositionId: string;
    inputProps: WeeklyVideoProps;
    videoOutputPath: string;
    thumbnailOutputPath: string;
    thumbnailFrame: number;
    signal: AbortSignal;
  }) => Promise<void>;
}

const defaultRemotionAdapter: RemotionRendererAdapter = {
  async bundleComposition({ entryPoint, publicDir }) {
    return bundle({
      entryPoint,
      publicDir,
    });
  },
  async renderComposition({
    serveUrl,
    compositionId,
    inputProps,
    videoOutputPath,
    thumbnailOutputPath,
    thumbnailFrame,
    signal,
  }) {
    const serializedProps: Record<string, unknown> = { ...inputProps };
    const composition = await selectComposition({
      serveUrl,
      id: compositionId,
      inputProps: serializedProps,
    });

    const { cancelSignal, cancel } = makeCancelSignal();
    const onAbort = (): void => {
      cancel();
    };

    if (signal.aborted) {
      cancel();
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }

    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await renderMedia({
        composition,
        serveUrl,
        codec: 'h264',
        outputLocation: videoOutputPath,
        inputProps: serializedProps,
        cancelSignal,
        overwrite: true,
      });

      const clampedFrame = Math.min(
        Math.max(0, thumbnailFrame),
        Math.max(0, composition.durationInFrames - 1)
      );

      await renderStill({
        composition,
        serveUrl,
        output: thumbnailOutputPath,
        frame: clampedFrame,
        imageFormat: 'png',
        inputProps: serializedProps,
        cancelSignal,
        overwrite: true,
      });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  },
};

export interface RenderCommandDeps {
  workerClient?: WorkerClient;
  outRoot?: string;
  stdout?: (msg: string) => void;
  fetchImpl?: typeof fetch;
  imageTimeoutMs?: number;
  entryPoint?: string;
  remotionAdapter?: RemotionRendererAdapter;
}

export interface RenderCommandResult {
  props: WeeklyVideoProps;
  timeline: VideoTimeline;
  videoPath: string;
  thumbnailPath: string;
  downloadedImagesCount: number;
  fallbackCardCount: number;
}

/**
 * Downloads story OG images to `out/<week>/images/` (with fallback to branded cards),
 * bundles the Remotion composition (`src/remotion/Root.tsx`), and renders
 * `out/<week>/video.mp4` (`renderMedia`) and `out/<week>/thumbnail.png` (`renderStill`).
 */
export async function runRenderCommand(
  ctx: CommandContext,
  deps: RenderCommandDeps = {}
): Promise<RenderCommandResult> {
  const stdout = deps.stdout ?? ((msg: string) => console.log(msg));
  const paths = getWeekPaths(ctx.week, deps.outRoot);

  const workerClient =
    deps.workerClient ??
    createWorkerClient({
      baseUrl: ctx.env.NEWS_API_BASE_URL,
      ingestionSecret: ctx.env.INGESTION_SECRET,
      fetchImpl: deps.fetchImpl,
    });

  await assertEditionApproved(workerClient, ctx.week, 'render', ctx.signal);

  const rawTranslation = await readJson<unknown>(paths.translationJson);
  const parsedTranslation = StoredTranslationSchema.safeParse(rawTranslation);
  if (!parsedTranslation.success) {
    const details = parsedTranslation.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid translation in ${paths.translationJson}: ${details}`);
  }

  const rawScript = await readJson<unknown>(paths.scriptJson);
  const parsedScript = ScriptSchema.safeParse(rawScript);
  if (!parsedScript.success) {
    const details = parsedScript.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid script in ${paths.scriptJson}: ${details}`);
  }

  const translation = parsedTranslation.data;
  const script = parsedScript.data;
  const audioSegments = await loadAudioSegments(paths.audioDir, script);

  const translationByUrl = new Map<string, WeeklyItem>();
  for (const item of translation.items) {
    translationByUrl.set(item.url.trim(), {
      url: item.url.trim(),
      title_tr: item.title_tr,
      summary_tr: item.summary_tr,
      source: item.source,
      image_url: item.image_url ?? null,
    });
  }

  const stories: StorySceneItem[] = [];
  let downloadedImagesCount = 0;
  let fallbackCardCount = 0;

  for (let i = 0; i < script.segments.length; i++) {
    if (ctx.signal.aborted) {
      throw ctx.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }

    const segment = script.segments[i];
    const storyIndex = i + 1;
    const translatedItem = translationByUrl.get(segment.item_url.trim());
    const audioSegment = audioSegments.get(storyIndex);

    if (!audioSegment) {
      throw new Error(
        `Missing audio metadata for story segment #${storyIndex}. Run "voice" first.`
      );
    }

    const imageSrc = await downloadStoryImage({
      imageUrl: translatedItem?.image_url ?? null,
      storyIndex,
      imagesDir: paths.imagesDir,
      signal: ctx.signal,
      timeoutMs: deps.imageTimeoutMs,
      fetchImpl: deps.fetchImpl,
      onWarn: (msg) => stdout(`[warn] ${msg}`),
    });

    if (imageSrc) {
      downloadedImagesCount++;
    } else {
      fallbackCardCount++;
    }

    stories.push({
      index: storyIndex,
      url: segment.item_url.trim(),
      domain: extractHostname(segment.item_url.trim()),
      source: translatedItem?.source ?? 'news',
      headline_tr: segment.headline_tr,
      summary_tr: translatedItem?.summary_tr ?? '',
      imageSrc,
      audioSrc: `audio/${storyIndex}.mp3`,
      audioDurationSeconds: audioSegment.duration_seconds,
      captions: audioSegment.captions,
    });
  }

  const introAudio = audioSegments.get(0);
  const outroAudio = audioSegments.get(script.segments.length + 1);
  if (!introAudio || !outroAudio) {
    throw new Error(
      `Missing intro or outro audio segment metadata in ${paths.audioDir}. Run "voice" first.`
    );
  }

  const siteUrl = extractHostname(ctx.env.NEWS_API_BASE_URL) || DEFAULT_SITE_URL;
  const props: WeeklyVideoProps = {
    week: ctx.week,
    title_tr: translation.title_tr,
    siteUrl,
    intro: {
      audioSrc: 'audio/0.mp3',
      audioDurationSeconds: introAudio.duration_seconds,
      captions: introAudio.captions,
    },
    stories,
    outro: {
      audioSrc: `audio/${script.segments.length + 1}.mp3`,
      audioDurationSeconds: outroAudio.duration_seconds,
      captions: outroAudio.captions,
    },
  };

  const timeline = buildVideoTimeline(props, VIDEO_FPS);
  const adapter = deps.remotionAdapter ?? defaultRemotionAdapter;
  const entryPoint = deps.entryPoint ?? DEFAULT_REMOTION_ENTRY_POINT;

  stdout(
    `Bundling Remotion composition "${WEEKLY_VIDEO_COMPOSITION_ID}" for ${ctx.week} (${timeline.totalDurationInFrames} frames, ${timeline.totalDurationSeconds.toFixed(1)}s)...`
  );

  const serveUrl = await adapter.bundleComposition({
    entryPoint,
    publicDir: paths.dir,
  });

  try {
    stdout(
      `Rendering video to ${paths.videoMp4} and thumbnail to ${paths.thumbnailPng}...`
    );

    await adapter.renderComposition({
      serveUrl,
      compositionId: WEEKLY_VIDEO_COMPOSITION_ID,
      inputProps: props,
      videoOutputPath: paths.videoMp4,
      thumbnailOutputPath: paths.thumbnailPng,
      thumbnailFrame: THUMBNAIL_FRAME,
      signal: ctx.signal,
    });
  } finally {
    if (!deps.remotionAdapter && serveUrl && path.isAbsolute(serveUrl)) {
      await fs.rm(serveUrl, { recursive: true, force: true }).catch(() => {
        // Ignore cleanup failure for temporary bundle directory
      });
    }
  }

  stdout(
    `Completed render for ${ctx.week}: ${paths.videoMp4} (${timeline.totalDurationSeconds.toFixed(1)}s) & ${paths.thumbnailPng} (${downloadedImagesCount} image(s), ${fallbackCardCount} fallback card(s)).`
  );

  return {
    props,
    timeline,
    videoPath: paths.videoMp4,
    thumbnailPath: paths.thumbnailPng,
    downloadedImagesCount,
    fallbackCardCount,
  };
}

