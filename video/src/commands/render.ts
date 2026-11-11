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
import { PageCaptureMetadataSchema, type PageCaptureMetadata } from '../domain/pageCapture.ts';
import { ScriptSchema, type Script } from '../domain/script.ts';
import {
  buildVideoTimeline,
  CaptionChunkSchema,
  DEFAULT_SITE_URL,
  extractHostname,
  resolveStoryFallbackMode,
  StorySceneCueSchema,
  THUMBNAIL_FRAME,
  VIDEO_FPS,
  WEEKLY_VIDEO_COMPOSITION_ID,
  type StoryFallbackMode,
  type StorySceneCue,
  type StorySceneItem,
  type VideoTimeline,
  type WeeklyVideoProps,
} from '../domain/timeline.ts';
import {
  fileExists,
  getWeekPaths,
  isValidIsoWeek,
  readJson,
  writeBytesAtomic,
} from '../lib/paths.ts';
import {
  createWorkerClient,
  type WeeklyItem,
  type WorkerClient,
} from '../lib/workerClient.ts';
import { assertSafeHttpUrl, type DnsLookupAllFn } from '../lib/ssrf.ts';
import { assertEditionApproved } from './approve.ts';
import { loadCachedPageCapture, runCaptureCommand } from './capture.ts';
import { buildVoiceSegments } from './voice.ts';

export const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGE_REDIRECTS = 5;

const ALLOWED_IMAGE_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

/**
 * Checks whether the leading magic bytes of `bytes` match the claimed `mimeType`.
 */
export function matchesImageMagicBytes(bytes: Uint8Array, mimeType: string): boolean {
  switch (mimeType) {
    case 'image/jpeg':
    case 'image/jpg':
      // FF D8 FF
      return (
        bytes.byteLength >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
      );

    case 'image/png':
      // 89 50 4E 47 0D 0A 1A 0A (\x89PNG\r\n\x1a\n)
      return (
        bytes.byteLength >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );

    case 'image/gif':
      // "GIF87a" (47 49 46 38 37 61) or "GIF89a" (47 49 46 38 39 61)
      return (
        bytes.byteLength >= 6 &&
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38 &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) &&
        bytes[5] === 0x61
      );

    case 'image/webp':
      // "RIFF" .... "WEBP"
      return (
        bytes.byteLength >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );

    case 'image/avif':
      // ISO BMFF ftyp box at bytes 4..7 ("ftyp") with major brand "avif" or "avis" at bytes 8..11
      return (
        bytes.byteLength >= 12 &&
        bytes[4] === 0x66 &&
        bytes[5] === 0x74 &&
        bytes[6] === 0x79 &&
        bytes[7] === 0x70 &&
        bytes[8] === 0x61 &&
        bytes[9] === 0x76 &&
        bytes[10] === 0x69 &&
        (bytes[11] === 0x66 || bytes[11] === 0x73)
      );

    default:
      return false;
  }
}

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
  week: z.string().refine(isValidIsoWeek, 'Invalid ISO week format'),
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
  maxBytes?: number;
  maxRedirects?: number;
  dnsLookup?: DnsLookupAllFn;
  fetchImpl?: typeof fetch;
  onWarn?: (msg: string) => void;
}

/**
 * Reads a `Response` body stream up to `maxBytes`. If the stream exceeds `maxBytes`,
 * cancels the reader and aborts `streamAbortController` immediately without buffering further.
 */
async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
  streamAbortController: AbortController
): Promise<{ bytes: Uint8Array; exceeded: false } | { totalBytes: number; exceeded: true }> {
  if (!response.body) {
    return { bytes: new Uint8Array(0), exceeded: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        streamAbortController.abort();
        return { totalBytes, exceeded: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: combined, exceeded: false };
}

/**
 * Downloads a story's OG image to `out/<week>/images/<storyIndex>.<ext>` with SSRF validation,
 * manual redirect hop checks, timeout, HTTP status check, `Content-Type` validation (`image/*`),
 * streaming byte size limit, and magic byte verification.
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
    maxBytes = MAX_IMAGE_BYTES,
    maxRedirects = MAX_IMAGE_REDIRECTS,
    dnsLookup,
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

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const streamAbortController = new AbortController();
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal, streamAbortController.signal])
    : AbortSignal.any([timeoutSignal, streamAbortController.signal]);

  try {
    let currentUrl = trimmedUrl;
    let response: Response | null = null;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }

      const safeUrl = await assertSafeHttpUrl(currentUrl, { dnsLookup });

      const hopResponse = await fetchImpl(safeUrl.toString(), {
        method: 'GET',
        headers: {
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
        },
        redirect: 'manual',
        signal: combinedSignal,
      });

      if (hopResponse.status >= 300 && hopResponse.status < 400) {
        await hopResponse.body?.cancel().catch(() => {});

        if (hop === maxRedirects) {
          onWarn?.(
            `Story #${storyIndex}: image download exceeded max redirects (${maxRedirects}) for ${trimmedUrl}, falling back to branded card.`
          );
          return null;
        }

        const location = hopResponse.headers.get('location')?.trim() ?? '';
        if (!location) {
          onWarn?.(
            `Story #${storyIndex}: image redirect HTTP ${hopResponse.status} missing Location header for ${safeUrl.toString()}, falling back to branded card.`
          );
          return null;
        }

        try {
          currentUrl = new URL(location, safeUrl).toString();
        } catch {
          onWarn?.(
            `Story #${storyIndex}: invalid redirect Location "${location}" for ${safeUrl.toString()}, falling back to branded card.`
          );
          return null;
        }
        continue;
      }

      response = hopResponse;
      break;
    }

    if (!response) {
      return null;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      onWarn?.(
        `Story #${storyIndex}: image download returned HTTP ${response.status} for ${trimmedUrl}, falling back to branded card.`
      );
      return null;
    }

    const rawContentType = response.headers.get('content-type') ?? '';
    const mimeType = rawContentType.split(';')[0]?.trim().toLowerCase() ?? '';
    const ext = ALLOWED_IMAGE_MIME_EXTENSIONS[mimeType];

    if (!ext) {
      await response.body?.cancel().catch(() => {});
      onWarn?.(
        `Story #${storyIndex}: unsupported Content-Type "${rawContentType || 'none'}" for ${trimmedUrl}, falling back to branded card.`
      );
      return null;
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
      const declaredBytes = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
        await response.body?.cancel().catch(() => {});
        streamAbortController.abort();
        onWarn?.(
          `Story #${storyIndex}: image exceeds max size (${declaredBytes} bytes) for ${trimmedUrl}, falling back to branded card.`
        );
        return null;
      }
    }

    const streamResult = await readBoundedResponseBytes(
      response,
      maxBytes,
      streamAbortController
    );

    if (streamResult.exceeded) {
      onWarn?.(
        `Story #${storyIndex}: downloaded image exceeds max size (${streamResult.totalBytes} bytes) for ${trimmedUrl}, falling back to branded card.`
      );
      return null;
    }

    const { bytes } = streamResult;

    if (bytes.byteLength === 0) {
      onWarn?.(
        `Story #${storyIndex}: empty image body from ${trimmedUrl}, falling back to branded card.`
      );
      return null;
    }

    if (!matchesImageMagicBytes(bytes, mimeType)) {
      onWarn?.(
        `Story #${storyIndex}: image magic bytes do not match Content-Type "${mimeType}" for ${trimmedUrl}, falling back to branded card.`
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

/**
 * Loads a captured page (`out/<week>/pages/<storyIndex>.png` + `<storyIndex>.json`)
 * if available on disk for the story. Checks URL-hash match first, and falls back
 * to index-matched valid capture metadata if present.
 */
export async function loadStoryPageCapture(options: {
  pagesDir: string;
  storyIndex: number;
  url: string;
}): Promise<PageCaptureMetadata | null> {
  const { pagesDir, storyIndex, url } = options;

  const exactCached = await loadCachedPageCapture(pagesDir, storyIndex, url);
  if (exactCached) {
    return {
      ...exactCached,
      screenshot_path: exactCached.screenshot_path || `pages/${storyIndex}.png`,
    };
  }

  const pngPath = path.join(pagesDir, `${storyIndex}.png`);
  const jsonPath = path.join(pagesDir, `${storyIndex}.json`);

  const [hasPng, hasJson] = await Promise.all([
    fileExists(pngPath),
    fileExists(jsonPath),
  ]);

  if (!hasPng || !hasJson) {
    return null;
  }

  try {
    const raw = await readJson<unknown>(jsonPath);
    const parsed = PageCaptureMetadataSchema.safeParse(raw);
    if (!parsed.success) {
      return null;
    }
    return {
      ...parsed.data,
      screenshot_path: parsed.data.screenshot_path || `pages/${storyIndex}.png`,
    };
  } catch {
    return null;
  }
}

/**
 * Counts stories whose `pages/<n>.png` + `<n>.json` capture is missing or stale for its URL.
 */
export async function countMissingPageCaptures(
  pagesDir: string,
  storyUrls: readonly string[]
): Promise<number> {
  let missing = 0;
  for (let i = 0; i < storyUrls.length; i++) {
    const capture = await loadStoryPageCapture({
      pagesDir,
      storyIndex: i + 1,
      url: storyUrls[i],
    });
    if (!capture) {
      missing++;
    }
  }
  return missing;
}

/**
 * Picks the story image URL: the translation's `image_url` first, then the `og:image`
 * found during page capture. The captured URL comes from third-party page markup, so it
 * must pass the SSRF guard (public http(s) host only) before render downloads it.
 */
export async function resolveStoryImageUrl(options: {
  translatedImageUrl: string | null;
  capturedOgImageUrl: string | null;
  storyIndex: number;
  dnsLookup?: DnsLookupAllFn;
  onWarn?: (msg: string) => void;
}): Promise<string | null> {
  const translated = options.translatedImageUrl?.trim() ?? '';
  if (translated) {
    return translated;
  }

  const captured = options.capturedOgImageUrl?.trim() ?? '';
  if (!captured) {
    return null;
  }

  try {
    const safe = await assertSafeHttpUrl(captured, { dnsLookup: options.dnsLookup });
    return safe.toString();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    options.onWarn?.(
      `Story #${options.storyIndex}: skipping captured og:image "${captured}" (${reason}).`
    );
    return null;
  }
}

function extractOptionalSegmentCues(rawSegment: unknown): StorySceneCue[] | undefined {
  if (!rawSegment || typeof rawSegment !== 'object') {
    return undefined;
  }
  const candidate =
    (rawSegment as { cues?: unknown; visuals?: unknown }).cues ??
    (rawSegment as { cues?: unknown; visuals?: unknown }).visuals;

  if (!Array.isArray(candidate) || candidate.length === 0) {
    return undefined;
  }

  const valid: StorySceneCue[] = [];
  for (const item of candidate) {
    const parsed = StorySceneCueSchema.safeParse(item);
    if (parsed.success) {
      valid.push(parsed.data);
    }
  }

  return valid.length > 0 ? valid : undefined;
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

/** Runs the `capture` stage for the week; injected in tests to avoid launching Chrome. */
export type RenderCaptureRunner = (ctx: CommandContext) => Promise<void>;

export interface RenderCommandDeps {
  workerClient?: WorkerClient;
  outRoot?: string;
  stdout?: (msg: string) => void;
  fetchImpl?: typeof fetch;
  imageTimeoutMs?: number;
  entryPoint?: string;
  remotionAdapter?: RemotionRendererAdapter;
  /** Defaults to `runCaptureCommand`; called only when some story has no page capture. */
  captureRunner?: RenderCaptureRunner;
  /** DNS resolver for the SSRF check on capture-derived `og:image` URLs. */
  dnsLookup?: DnsLookupAllFn;
}

export interface StoryVisualModeCounts {
  page: number;
  og: number;
  card: number;
}

/**
 * Counts which visual each story will use (`page` screenshot, `og` image, branded `card`).
 */
export function countStoryVisualModes(
  stories: ReadonlyArray<Pick<StorySceneItem, 'page' | 'imageSrc'>>
): StoryVisualModeCounts {
  const counts: StoryVisualModeCounts = { page: 0, og: 0, card: 0 };
  for (const story of stories) {
    const mode: StoryFallbackMode = resolveStoryFallbackMode(story);
    counts[mode]++;
  }
  return counts;
}

/**
 * Throws when every story would render as a plain branded card (no screenshot, no image),
 * unless explicitly allowed. A video made only of cards is almost always a broken pipeline
 * (capture never ran or every fetch failed), so it must not reach upload silently.
 */
export function assertNotAllCards(
  counts: StoryVisualModeCounts,
  week: string,
  allowCards: boolean
): void {
  const total = counts.page + counts.og + counts.card;
  if (allowCards || total === 0 || counts.card < total) {
    return;
  }
  throw new Error(
    `All ${total} stories for ${week} would render as branded cards (no page screenshots and no images). ` +
      `Run "capture" for the week (make video-capture WEEK=${week}) and check its warnings, ` +
      'or pass --allow-cards to render anyway.'
  );
}

export interface RenderCommandResult {
  props: WeeklyVideoProps;
  timeline: VideoTimeline;
  videoPath: string;
  thumbnailPath: string;
  downloadedImagesCount: number;
  fallbackCardCount: number;
  pageCapturesCount: number;
  visualModes: StoryVisualModeCounts;
}

/**
 * Downloads story OG images to `out/<week>/images/` (with fallback to branded cards),
 * loads captured article pages from `out/<week>/pages/<n>.png` + `<n>.json` when available,
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
  const rawScriptSegments =
    rawScript &&
    typeof rawScript === 'object' &&
    'segments' in rawScript &&
    Array.isArray((rawScript as { segments: unknown[] }).segments)
      ? (rawScript as { segments: unknown[] }).segments
      : [];

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

  const missingCaptureCount = await countMissingPageCaptures(
    paths.pagesDir,
    script.segments.map((segment) => segment.item_url.trim())
  );
  if (missingCaptureCount > 0) {
    stdout(
      `${missingCaptureCount} of ${script.segments.length} story page capture(s) missing in ${paths.pagesDir}; running capture first...`
    );
    const captureRunner: RenderCaptureRunner =
      deps.captureRunner ??
      (async (captureCtx) => {
        await runCaptureCommand(captureCtx, { outRoot: deps.outRoot, stdout });
      });
    try {
      await captureRunner(ctx);
    } catch (err) {
      if (ctx.signal.aborted) {
        throw ctx.signal.reason ?? err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      stdout(
        `[warn] Page capture failed (${reason}); stories without a capture will use the OG image or the branded card.`
      );
    }
  }

  const stories: StorySceneItem[] = [];
  let downloadedImagesCount = 0;
  let fallbackCardCount = 0;
  let pageCapturesCount = 0;

  for (let i = 0; i < script.segments.length; i++) {
    if (ctx.signal.aborted) {
      throw ctx.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }

    const segment = script.segments[i];
    const storyIndex = i + 1;
    const storyUrl = segment.item_url.trim();
    const translatedItem = translationByUrl.get(storyUrl);
    const audioSegment = audioSegments.get(storyIndex);

    if (!audioSegment) {
      throw new Error(
        `Missing audio metadata for story segment #${storyIndex}. Run "voice" first.`
      );
    }

    const pageCapture = await loadStoryPageCapture({
      pagesDir: paths.pagesDir,
      storyIndex,
      url: storyUrl,
    });

    const imageUrl = await resolveStoryImageUrl({
      translatedImageUrl: translatedItem?.image_url ?? null,
      capturedOgImageUrl: pageCapture?.og_image_url ?? null,
      storyIndex,
      dnsLookup: deps.dnsLookup,
      onWarn: (msg) => stdout(`[warn] ${msg}`),
    });

    const imageSrc = await downloadStoryImage({
      imageUrl,
      storyIndex,
      imagesDir: paths.imagesDir,
      signal: ctx.signal,
      timeoutMs: deps.imageTimeoutMs,
      dnsLookup: deps.dnsLookup,
      fetchImpl: deps.fetchImpl,
      onWarn: (msg) => stdout(`[warn] ${msg}`),
    });

    if (imageSrc) {
      downloadedImagesCount++;
    } else {
      fallbackCardCount++;
    }

    if (pageCapture) {
      pageCapturesCount++;
    }

    const segmentCues = extractOptionalSegmentCues(rawScriptSegments[i]);

    stories.push({
      index: storyIndex,
      url: storyUrl,
      domain: extractHostname(storyUrl),
      source: translatedItem?.source ?? 'news',
      headline_tr: segment.headline_tr,
      summary_tr: translatedItem?.summary_tr ?? '',
      imageSrc,
      audioSrc: `audio/${storyIndex}.mp3`,
      audioDurationSeconds: audioSegment.duration_seconds,
      captions: audioSegment.captions,
      ...(pageCapture ? { page: pageCapture } : {}),
      ...(segmentCues ? { cues: segmentCues } : {}),
    });
  }

  const visualModes = countStoryVisualModes(stories);
  stdout(
    `Story visuals for ${ctx.week}: page ${visualModes.page}, og ${visualModes.og}, card ${visualModes.card}.`
  );
  assertNotAllCards(visualModes, ctx.week, ctx.allowCards === true);

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
    `Completed render for ${ctx.week}: ${paths.videoMp4} (${timeline.totalDurationSeconds.toFixed(1)}s) & ${paths.thumbnailPng} (visuals: page ${visualModes.page}, og ${visualModes.og}, card ${visualModes.card}; ${downloadedImagesCount} image(s) downloaded).`
  );

  return {
    props,
    timeline,
    videoPath: paths.videoMp4,
    thumbnailPath: paths.thumbnailPng,
    downloadedImagesCount,
    fallbackCardCount,
    pageCapturesCount,
    visualModes,
  };
}


