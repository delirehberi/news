import path from 'node:path';
import { z } from 'zod';
import type { CommandContext } from '../cli.ts';
import { requireYouTubeUploadEnv, type YouTubePrivacy } from '../config/env.ts';
import { ScriptSchema, type Script } from '../domain/script.ts';
import {
  buildVideoTimeline,
  CaptionChunkSchema,
  DEFAULT_SITE_URL,
  extractHostname,
  VIDEO_FPS,
  type StorySceneItem,
  type VideoTimeline,
  type WeeklyVideoProps,
} from '../domain/timeline.ts';
import {
  fileExists,
  getWeekPaths,
  isValidIsoWeek,
  readJson,
  writeJsonAtomic,
  type WeekPaths,
} from '../lib/paths.ts';
import {
  createWorkerClient,
  type WeeklyEdition,
  type WeeklyItem,
  type WorkerClient,
} from '../lib/workerClient.ts';
import {
  exchangeRefreshTokenForAccessToken,
  setVideoThumbnail,
  uploadVideoResumable,
  type YouTubeVideoMetadata,
} from '../lib/youtube.ts';
import { assertEditionApproved } from './approve.ts';
import { buildVoiceSegments } from './voice.ts';

export const YOUTUBE_MAX_TITLE_LENGTH = 100;
export const YOUTUBE_MAX_DESCRIPTION_LENGTH = 5_000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;

export const DEFAULT_YOUTUBE_BASE_TAGS = [
  'teknoloji',
  'haberler',
  'haftalık özet',
  'yazılım',
  'yapay zeka',
  'news.emre.xyz',
] as const;

const StoredAudioSegmentSchema = z.object({
  index: z.number().int().nonnegative(),
  duration_seconds: z.number().nonnegative(),
  captions: z.array(CaptionChunkSchema).optional().default([]),
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

export interface YouTubeChapter {
  timestamp: string;
  startSeconds: number;
  label: string;
}

export interface DescriptionStoryLink {
  headline_tr: string;
  url: string;
  source?: string;
}

export interface BuildYouTubeDescriptionOptions {
  week: string;
  introTr: string;
  chapters: readonly YouTubeChapter[];
  items: readonly DescriptionStoryLink[];
  siteBaseUrl?: string;
}

/**
 * Pure function formatting a non-negative timestamp in seconds as `MM:SS`
 * (or `HH:MM:SS` if 1 hour or longer) for YouTube video chapters.
 */
export function formatChapterTimestamp(seconds: number): string {
  const totalSeconds =
    Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;

  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const secs = totalSeconds % SECONDS_PER_MINUTE;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');

  if (hours > 0) {
    const hh = String(hours).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  return `${mm}:${ss}`;
}

function sanitizeSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Pure function building YouTube chapters from a `VideoTimeline`.
 * Guarantees that the first chapter starts at `00:00`.
 */
export function buildYouTubeChapters(timeline: VideoTimeline): YouTubeChapter[] {
  return timeline.scenes.map((scene, index) => {
    const startSeconds = index === 0 ? 0 : Math.max(0, Math.floor(scene.startSeconds));
    const label = sanitizeSingleLine(scene.label) || `Bölüm ${index + 1}`;
    return {
      timestamp: index === 0 ? '00:00' : formatChapterTimestamp(startSeconds),
      startSeconds,
      label,
    };
  });
}

/**
 * Pure function formatting a list of chapters into multi-line `MM:SS Label` text.
 */
export function formatYouTubeChapters(chapters: readonly YouTubeChapter[]): string {
  return chapters.map((ch) => `${ch.timestamp} ${ch.label}`).join('\n');
}

/**
 * Pure function building a Turkish YouTube video title within the 100-character limit.
 */
export function buildYouTubeTitle(week: string, titleTr: string): string {
  const cleanTitle = sanitizeSingleLine(titleTr);
  const cleanWeek = sanitizeSingleLine(week);
  const fullCandidate = `${cleanTitle} | Haftalık Teknoloji Özeti (${cleanWeek})`;
  if (fullCandidate.length <= YOUTUBE_MAX_TITLE_LENGTH) {
    return fullCandidate;
  }

  const shortSuffix = ` (${cleanWeek})`;
  const shortCandidate = `${cleanTitle}${shortSuffix}`;
  if (shortCandidate.length <= YOUTUBE_MAX_TITLE_LENGTH) {
    return shortCandidate;
  }

  const maxTitleChars = Math.max(1, YOUTUBE_MAX_TITLE_LENGTH - shortSuffix.length - 1);
  return `${cleanTitle.slice(0, maxTitleChars).trimEnd()}…${shortSuffix}`;
}

/**
 * Pure function building deduplicated Turkish and source tags for YouTube.
 */
export function buildYouTubeTags(
  week: string,
  items: readonly { source: string }[]
): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];

  const pushTag = (raw: string): void => {
    const cleaned = sanitizeSingleLine(raw);
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(cleaned);
  };

  for (const tag of DEFAULT_YOUTUBE_BASE_TAGS) {
    pushTag(tag);
  }
  pushTag(week);

  for (const item of items) {
    pushTag(item.source);
  }

  return tags;
}

/**
 * Pure function building the Turkish YouTube video description including:
 * - Intro paragraph
 * - `/weekly/<week>` URL
 * - Chapters (`00:00` first)
 * - Source links for every story
 */
export function buildYouTubeDescription(
  options: BuildYouTubeDescriptionOptions
): string {
  const {
    week,
    introTr,
    chapters,
    items,
    siteBaseUrl = `https://${DEFAULT_SITE_URL}`,
  } = options;

  const normalizedBaseUrl = siteBaseUrl.replace(/\/+$/, '');
  const weeklyUrl = `${normalizedBaseUrl}/weekly/${week}`;

  const normalizedChapters: YouTubeChapter[] =
    chapters.length > 0
      ? chapters.map((ch, idx) =>
          idx === 0 ? { ...ch, timestamp: '00:00', startSeconds: 0 } : ch
        )
      : [{ timestamp: '00:00', startSeconds: 0, label: 'Giriş' }];

  const chapterLines = formatYouTubeChapters(normalizedChapters);
  const sourceLines = items
    .map((item, idx) => `${idx + 1}. ${sanitizeSingleLine(item.headline_tr)}\n${item.url.trim()}`)
    .join('\n\n');

  const sections = [
    sanitizeSingleLine(introTr),
    `Haftalık Türkçe bülten ve tüm bağlantılar: ${weeklyUrl}`,
    `Bölümler:\n${chapterLines}`,
    ...(sourceLines ? [`Kaynaklar:\n${sourceLines}`] : []),
  ].filter((section) => section.length > 0);

  const description = sections.join('\n\n');
  if (description.length <= YOUTUBE_MAX_DESCRIPTION_LENGTH) {
    return description;
  }

  return `${description.slice(0, YOUTUBE_MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

async function loadAudioSegmentsForTimeline(
  audioDir: string,
  script: Script
): Promise<Map<number, StoredAudioSegment>> {
  const specs = buildVoiceSegments(script);
  const segments = new Map<number, StoredAudioSegment>();

  for (const spec of specs) {
    const jsonPath = path.join(audioDir, `${spec.index}.json`);
    const hasJson = await fileExists(jsonPath);
    if (!hasJson) {
      throw new Error(
        `Missing audio alignment metadata for segment ${spec.index} (${spec.kind}) at ${jsonPath}. Run "voice" first.`
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

/**
 * Local record of a finished YouTube upload (`out/<week>/upload.json`). It is written
 * before any Worker call, so the video ID survives a failed PUT or an aborted run.
 */
const UploadReceiptSchema = z.object({
  video_id: z.string().trim().min(1),
  uploaded_at: z.string().min(1),
  thumbnail_set: z.boolean(),
});

export type UploadReceipt = z.infer<typeof UploadReceiptSchema>;

async function readUploadReceipt(filePath: string): Promise<UploadReceipt | null> {
  if (!(await fileExists(filePath))) {
    return null;
  }

  const raw = await readJson<unknown>(filePath);
  const parsed = UploadReceiptSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    // Ignoring a corrupt receipt could upload a duplicate video, so stop instead.
    throw new Error(
      `Invalid upload receipt in ${filePath}: ${details}. Check YouTube Studio for an existing upload of this week before fixing or removing the file.`
    );
  }

  return parsed.data;
}

/**
 * Picks the video ID of a previous upload from the Worker edition or the local receipt.
 * Throws if both exist and disagree, because guessing could publish the wrong video.
 */
function resolveExistingVideoId(
  editionVideoId: string | null,
  receipt: UploadReceipt | null,
  receiptPath: string
): string | null {
  const receiptVideoId = receipt?.video_id ?? null;
  if (editionVideoId && receiptVideoId && editionVideoId !== receiptVideoId) {
    throw new Error(
      `YouTube video ID mismatch: the Worker edition has "${editionVideoId}" but ${receiptPath} has "${receiptVideoId}". Resolve it by hand before running "upload" again.`
    );
  }
  return editionVideoId ?? receiptVideoId;
}

interface FinishUploadOptions {
  ctx: CommandContext;
  paths: WeekPaths;
  workerClient: WorkerClient;
  stdout: (msg: string) => void;
  edition: WeeklyEdition;
  videoId: string;
  receipt: UploadReceipt;
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

interface FinishUploadResult {
  edition: WeeklyEdition;
  thumbnailSet: boolean;
}

async function putEditionOrExplain(
  options: FinishUploadOptions,
  payload: { youtube_video_id?: string; status?: 'published' },
  action: string
): Promise<WeeklyEdition> {
  const { ctx, paths, workerClient, videoId } = options;
  try {
    return await workerClient.putEdition(ctx.week, payload, ctx.signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to ${action} for edition ${ctx.week}: ${message}. YouTube video ${videoId} is saved in ${paths.uploadJson}; run "upload" again to finish without uploading the video again.`,
      { cause: err }
    );
  }
}

/**
 * Sets the custom thumbnail. A failure is only a warning: YouTube returns 403 for
 * channels that are not verified, and that must not block publishing the edition.
 * Cancellation is still propagated.
 */
async function trySetThumbnail(options: FinishUploadOptions): Promise<boolean> {
  const { ctx, paths, stdout, videoId } = options;
  const accessToken = await options.getAccessToken();

  stdout(`Setting custom thumbnail ${paths.thumbnailPng} on YouTube video ${videoId}...`);
  try {
    await setVideoThumbnail({
      accessToken,
      videoId,
      thumbnailPath: paths.thumbnailPng,
      signal: ctx.signal,
      fetchImpl: options.fetchImpl,
    });
    return true;
  } catch (err) {
    if (ctx.signal.aborted) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    stdout(
      `Warning: could not set the custom thumbnail on YouTube video ${videoId}: ${message}. Continuing without it.`
    );
    return false;
  }
}

/**
 * Finishes an upload whose video ID is already known: saves the ID on the Worker if it
 * is missing there, sets the thumbnail if it is not set yet, and publishes the edition last.
 */
async function finishUpload(options: FinishUploadOptions): Promise<FinishUploadResult> {
  const { paths, videoId } = options;
  let edition = options.edition;
  let receipt = options.receipt;

  if (edition.youtube_video_id?.trim() !== videoId) {
    edition = await putEditionOrExplain(
      options,
      { youtube_video_id: videoId },
      'save the YouTube video ID on the Worker'
    );
  }

  if (!receipt.thumbnail_set) {
    const thumbnailSet = await trySetThumbnail(options);
    receipt = { ...receipt, thumbnail_set: thumbnailSet };
    await writeJsonAtomic(paths.uploadJson, receipt);
  }

  edition = await putEditionOrExplain(options, { status: 'published' }, 'publish');

  return { edition, thumbnailSet: receipt.thumbnail_set };
}

export interface UploadCommandDeps {
  workerClient?: WorkerClient;
  outRoot?: string;
  stdout?: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

export interface UploadCommandResult {
  skipped: boolean;
  videoId: string;
  privacyStatus: YouTubePrivacy;
  edition: WeeklyEdition;
  metadata?: YouTubeVideoMetadata;
  chapters?: YouTubeChapter[];
  thumbnailSet?: boolean;
}

/**
 * Uploads `out/<week>/video.mp4` (resumable upload) and `out/<week>/thumbnail.png`
 * to YouTube with Turkish title, tags, and description (chapters starting at `00:00`,
 * source links, and `/weekly/<week>` URL), then marks the weekly edition as `published`
 * with `youtube_video_id`.
 *
 * Steps, in order: upload the video, write `out/<week>/upload.json`, save
 * `youtube_video_id` on the Worker (status stays `approved`), set the thumbnail
 * (a failure only warns), and set `status: 'published'` last.
 *
 * Idempotent:
 * - A `published` edition with `youtube_video_id` exits without doing anything.
 * - If a video ID is known from the edition or from `upload.json`, the video is never
 *   uploaded again; only the missing steps (Worker ID, thumbnail, publish) are run.
 */
export async function runUploadCommand(
  ctx: CommandContext,
  deps: UploadCommandDeps = {}
): Promise<UploadCommandResult> {
  const stdout = deps.stdout ?? ((msg: string) => console.log(msg));
  const paths = getWeekPaths(ctx.week, deps.outRoot);

  const workerClient =
    deps.workerClient ??
    createWorkerClient({
      baseUrl: ctx.env.NEWS_API_BASE_URL,
      ingestionSecret: ctx.env.INGESTION_SECRET,
      fetchImpl: deps.fetchImpl,
    });

  const existingEdition = await assertEditionApproved(
    workerClient,
    ctx.week,
    'upload',
    ctx.signal
  );

  const editionVideoId = existingEdition.youtube_video_id?.trim() || null;
  if (editionVideoId && existingEdition.status === 'published') {
    stdout(
      `Edition ${ctx.week} already has YouTube video ID "${editionVideoId}" (status: "${existingEdition.status}"). Skipping upload.`
    );
    return {
      skipped: true,
      videoId: editionVideoId,
      privacyStatus: ctx.env.YOUTUBE_PRIVACY,
      edition: existingEdition,
    };
  }

  let cachedAccessToken: string | null = null;
  const getAccessToken = async (): Promise<string> => {
    if (cachedAccessToken) return cachedAccessToken;
    const env = requireYouTubeUploadEnv(ctx.env);
    stdout(`Exchanging YouTube OAuth refresh token for access token...`);
    cachedAccessToken = await exchangeRefreshTokenForAccessToken({
      clientId: env.YOUTUBE_CLIENT_ID,
      clientSecret: env.YOUTUBE_CLIENT_SECRET,
      refreshToken: env.YOUTUBE_REFRESH_TOKEN,
      signal: ctx.signal,
      fetchImpl: deps.fetchImpl,
    });
    return cachedAccessToken;
  };

  const existingReceipt = await readUploadReceipt(paths.uploadJson);
  const resumeVideoId = resolveExistingVideoId(
    editionVideoId,
    existingReceipt,
    paths.uploadJson
  );

  if (resumeVideoId) {
    stdout(
      `YouTube video "${resumeVideoId}" was already uploaded for ${ctx.week}. Finishing the remaining steps without uploading again.`
    );
    // No receipt means the ID came from the Worker only, so the thumbnail state is unknown and is retried.
    const receipt: UploadReceipt = existingReceipt ?? {
      video_id: resumeVideoId,
      uploaded_at: existingEdition.updated_at,
      thumbnail_set: false,
    };

    const finished = await finishUpload({
      ctx,
      paths,
      workerClient,
      stdout,
      edition: existingEdition,
      videoId: resumeVideoId,
      receipt,
      getAccessToken,
      fetchImpl: deps.fetchImpl,
    });

    stdout(`Published edition ${ctx.week} with YouTube video ${resumeVideoId} at /weekly/${ctx.week}.`);
    return {
      skipped: false,
      videoId: resumeVideoId,
      privacyStatus: ctx.env.YOUTUBE_PRIVACY,
      edition: finished.edition,
      thumbnailSet: finished.thumbnailSet,
    };
  }

  const uploadEnv = requireYouTubeUploadEnv(ctx.env);

  const [hasVideo, hasThumbnail] = await Promise.all([
    fileExists(paths.videoMp4),
    fileExists(paths.thumbnailPng),
  ]);

  if (!hasVideo) {
    throw new Error(
      `Missing rendered video at ${paths.videoMp4}. Run "render" first.`
    );
  }
  if (!hasThumbnail) {
    throw new Error(
      `Missing rendered thumbnail at ${paths.thumbnailPng}. Run "render" first.`
    );
  }

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
  const audioSegments = await loadAudioSegmentsForTimeline(paths.audioDir, script);

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

  const stories: StorySceneItem[] = script.segments.map((segment, idx) => {
    const storyIndex = idx + 1;
    const translatedItem = translationByUrl.get(segment.item_url.trim());
    const audioSegment = audioSegments.get(storyIndex);
    if (!audioSegment) {
      throw new Error(
        `Missing audio metadata for story segment #${storyIndex}. Run "voice" first.`
      );
    }

    return {
      index: storyIndex,
      url: segment.item_url.trim(),
      domain: extractHostname(segment.item_url.trim()),
      source: translatedItem?.source ?? 'news',
      headline_tr: segment.headline_tr,
      summary_tr: translatedItem?.summary_tr ?? '',
      imageSrc: null,
      audioSrc: `audio/${storyIndex}.mp3`,
      audioDurationSeconds: audioSegment.duration_seconds,
      captions: audioSegment.captions,
    };
  });

  const introAudio = audioSegments.get(0);
  const outroAudio = audioSegments.get(script.segments.length + 1);
  if (!introAudio || !outroAudio) {
    throw new Error(
      `Missing intro or outro audio segment metadata in ${paths.audioDir}. Run "voice" first.`
    );
  }

  const siteUrl = extractHostname(ctx.env.NEWS_API_BASE_URL) || DEFAULT_SITE_URL;
  const videoProps: WeeklyVideoProps = {
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

  const timeline = buildVideoTimeline(videoProps, VIDEO_FPS);
  const chapters = buildYouTubeChapters(timeline);
  const title = buildYouTubeTitle(ctx.week, translation.title_tr);
  const tags = buildYouTubeTags(ctx.week, stories);
  const description = buildYouTubeDescription({
    week: ctx.week,
    introTr: translation.intro_tr,
    chapters,
    items: stories.map((story) => ({
      headline_tr: story.headline_tr,
      url: story.url,
      source: story.source,
    })),
    siteBaseUrl: ctx.env.NEWS_API_BASE_URL,
  });

  const metadata: YouTubeVideoMetadata = {
    title,
    description,
    tags,
    privacyStatus: uploadEnv.YOUTUBE_PRIVACY,
  };

  const accessToken = await getAccessToken();

  stdout(
    `Uploading ${paths.videoMp4} to YouTube (privacy: ${metadata.privacyStatus}, ${chapters.length} chapter(s))...`
  );
  const videoId = await uploadVideoResumable({
    accessToken,
    videoPath: paths.videoMp4,
    metadata,
    signal: ctx.signal,
    fetchImpl: deps.fetchImpl,
  });

  // Save the ID locally before any other call, so no later failure can cause a duplicate upload.
  const receipt: UploadReceipt = {
    video_id: videoId,
    uploaded_at: new Date().toISOString(),
    thumbnail_set: false,
  };
  await writeJsonAtomic(paths.uploadJson, receipt);
  stdout(`Saved YouTube video ID ${videoId} to ${paths.uploadJson}.`);

  const finished = await finishUpload({
    ctx,
    paths,
    workerClient,
    stdout,
    edition: existingEdition,
    videoId,
    receipt,
    getAccessToken,
    fetchImpl: deps.fetchImpl,
  });

  stdout(
    `Uploaded YouTube video ${videoId} (${metadata.privacyStatus}) and published edition ${ctx.week} at /weekly/${ctx.week}.`
  );

  return {
    skipped: false,
    videoId,
    privacyStatus: metadata.privacyStatus,
    edition: finished.edition,
    metadata,
    chapters,
    thumbnailSet: finished.thumbnailSet,
  };
}

