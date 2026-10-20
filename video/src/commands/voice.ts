import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { CommandContext } from '../cli.ts';
import { requireElevenLabsEnv } from '../config/env.ts';
import {
  CharacterAlignmentSchema,
  alignmentToWords,
  chunkCaptions,
  getAlignmentDurationSeconds,
  type CaptionChunk,
  type CharacterAlignment,
  type WordTiming,
} from '../domain/captions.ts';
import { ScriptSchema, type Script } from '../domain/script.ts';
import {
  synthesizeMockWithTimestamps,
  synthesizeWithTimestamps,
} from '../lib/elevenlabs.ts';
import {
  fileExists,
  getWeekPaths,
  readJson,
  writeBytesAtomic,
  writeJsonAtomic,
} from '../lib/paths.ts';
import { createWorkerClient, type WorkerClient } from '../lib/workerClient.ts';
import { assertEditionApproved } from './approve.ts';

export type SegmentKind = 'intro' | 'story' | 'outro';

export interface VoiceSegmentSpec {
  index: number;
  kind: SegmentKind;
  narration_tr: string;
  item_url?: string;
  headline_tr?: string;
}

export interface SegmentAudioMetadata {
  index: number;
  kind: SegmentKind;
  item_url?: string;
  headline_tr?: string;
  narration_tr: string;
  narration_hash: string;
  mock: boolean;
  duration_seconds: number;
  alignment: CharacterAlignment;
  words: WordTiming[];
  captions: CaptionChunk[];
}

const CachedMetadataSchema = z.object({
  narration_hash: z.string().min(1),
  mock: z.boolean().optional(),
  alignment: CharacterAlignmentSchema,
  words: z.array(
    z.object({
      word: z.string(),
      start: z.number(),
      end: z.number(),
    })
  ),
  captions: z.array(
    z.object({
      text: z.string(),
      words: z.array(
        z.object({
          word: z.string(),
          start: z.number(),
          end: z.number(),
        })
      ),
      start: z.number(),
      end: z.number(),
    })
  ),
  duration_seconds: z.number().nonnegative(),
});

export interface VoiceCommandDeps {
  workerClient?: WorkerClient;
  outRoot?: string;
  stdout?: (msg: string) => void;
  fetchImpl?: typeof fetch;
  elevenLabsBaseUrl?: string;
  mock?: boolean;
}

export interface VoiceCommandResult {
  segments: SegmentAudioMetadata[];
  synthesizedCount: number;
  skippedCount: number;
  mock: boolean;
}

/**
 * Computes a deterministic SHA-256 hex digest for a segment's normalized narration text.
 */
export function computeNarrationHash(narration: string): string {
  return crypto.createHash('sha256').update(narration.trim(), 'utf8').digest('hex');
}

/**
 * Builds the ordered list of narration segments (`0`: intro, `1..N`: stories, `N+1`: outro)
 * from a validated `Script`.
 */
export function buildVoiceSegments(script: Script): VoiceSegmentSpec[] {
  const segments: VoiceSegmentSpec[] = [
    {
      index: 0,
      kind: 'intro',
      narration_tr: script.intro.trim(),
    },
  ];

  script.segments.forEach((story, idx) => {
    segments.push({
      index: idx + 1,
      kind: 'story',
      item_url: story.item_url,
      headline_tr: story.headline_tr,
      narration_tr: story.narration_tr.trim(),
    });
  });

  segments.push({
    index: script.segments.length + 1,
    kind: 'outro',
    narration_tr: script.outro.trim(),
  });

  return segments;
}

async function loadCachedSegmentMetadata(
  mp3Path: string,
  jsonPath: string,
  spec: VoiceSegmentSpec,
  expectedHash: string,
  expectedMock: boolean
): Promise<SegmentAudioMetadata | null> {
  const [hasMp3, hasJson] = await Promise.all([
    fileExists(mp3Path),
    fileExists(jsonPath),
  ]);

  if (!hasMp3 || !hasJson) {
    return null;
  }

  try {
    const raw = await readJson<unknown>(jsonPath);
    const parsed = CachedMetadataSchema.safeParse(raw);
    if (!parsed.success) {
      return null;
    }

    const cachedMock = parsed.data.mock ?? false;
    if (parsed.data.narration_hash !== expectedHash || cachedMock !== expectedMock) {
      return null;
    }

    return {
      index: spec.index,
      kind: spec.kind,
      ...(spec.item_url ? { item_url: spec.item_url } : {}),
      ...(spec.headline_tr ? { headline_tr: spec.headline_tr } : {}),
      narration_tr: spec.narration_tr,
      narration_hash: parsed.data.narration_hash,
      mock: cachedMock,
      duration_seconds: parsed.data.duration_seconds,
      alignment: parsed.data.alignment,
      words: parsed.data.words,
      captions: parsed.data.captions,
    };
  } catch {
    return null;
  }
}

/**
 * Synthesizes Turkish audio (`out/<week>/audio/<n>.mp3`) and word/caption alignment
 * (`out/<week>/audio/<n>.json`) for each segment of the approved weekly script.
 * Skips any segment where both `<n>.mp3` and `<n>.json` exist with an unchanged `narration_hash`.
 */
export async function runVoiceCommand(
  ctx: CommandContext,
  deps: VoiceCommandDeps = {}
): Promise<VoiceCommandResult> {
  const stdout = deps.stdout ?? ((msg: string) => console.log(msg));
  const paths = getWeekPaths(ctx.week, deps.outRoot);

  const workerClient =
    deps.workerClient ??
    createWorkerClient({
      baseUrl: ctx.env.NEWS_API_BASE_URL,
      ingestionSecret: ctx.env.INGESTION_SECRET,
      fetchImpl: deps.fetchImpl,
    });

  await assertEditionApproved(workerClient, ctx.week, 'voice', ctx.signal);

  const hasApiKey = Boolean(ctx.env.ELEVENLABS_API_KEY);
  const hasVoiceId = Boolean(ctx.env.ELEVENLABS_VOICE_ID);
  const explicitMock = Boolean(deps.mock ?? ctx.mock);
  const useMock = explicitMock || (!hasApiKey && !hasVoiceId);

  const elevenLabsEnv = useMock ? null : requireElevenLabsEnv(ctx.env);

  if (useMock) {
    stdout(
      `[mock] Synthesizing mock voice audio and Turkish alignments for ${ctx.week} (no ElevenLabs credentials configured)...`
    );
  }

  const rawScript = await readJson<unknown>(paths.scriptJson);
  const parsedScript = ScriptSchema.safeParse(rawScript);
  if (!parsedScript.success) {
    const details = parsedScript.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid script in ${paths.scriptJson}: ${details}`);
  }

  const specs = buildVoiceSegments(parsedScript.data);
  const results: SegmentAudioMetadata[] = [];
  let synthesizedCount = 0;
  let skippedCount = 0;

  for (const spec of specs) {
    if (ctx.signal.aborted) {
      throw ctx.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }

    const mp3Path = path.join(paths.audioDir, `${spec.index}.mp3`);
    const jsonPath = path.join(paths.audioDir, `${spec.index}.json`);
    const narrationHash = computeNarrationHash(spec.narration_tr);

    const cached = await loadCachedSegmentMetadata(
      mp3Path,
      jsonPath,
      spec,
      narrationHash,
      useMock
    );

    if (cached) {
      skippedCount++;
      results.push(cached);
      stdout(
        `Skipped segment ${spec.index} (${spec.kind}): audio and alignment up to date (${narrationHash.slice(0, 8)}).`
      );
      continue;
    }

    const synthesized =
      useMock || !elevenLabsEnv
        ? synthesizeMockWithTimestamps(spec.narration_tr)
        : await synthesizeWithTimestamps({
            apiKey: elevenLabsEnv.ELEVENLABS_API_KEY,
            voiceId: elevenLabsEnv.ELEVENLABS_VOICE_ID,
            modelId: elevenLabsEnv.ELEVENLABS_MODEL_ID,
            text: spec.narration_tr,
            baseUrl: deps.elevenLabsBaseUrl,
            signal: ctx.signal,
            fetchImpl: deps.fetchImpl,
          });

    const words = alignmentToWords(synthesized.alignment);
    const captions = chunkCaptions(words);
    const durationSeconds = getAlignmentDurationSeconds(synthesized.alignment);

    const metadata: SegmentAudioMetadata = {
      index: spec.index,
      kind: spec.kind,
      ...(spec.item_url ? { item_url: spec.item_url } : {}),
      ...(spec.headline_tr ? { headline_tr: spec.headline_tr } : {}),
      narration_tr: spec.narration_tr,
      narration_hash: narrationHash,
      mock: useMock,
      duration_seconds: durationSeconds,
      alignment: synthesized.alignment,
      words,
      captions,
    };

    await writeBytesAtomic(mp3Path, synthesized.audioBytes);
    await writeJsonAtomic(jsonPath, metadata);

    synthesizedCount++;
    results.push(metadata);
    stdout(
      `Synthesized segment ${spec.index} (${spec.kind}): ${durationSeconds.toFixed(2)}s, ${words.length} word(s), ${captions.length} caption line(s).`
    );
  }

  stdout(
    `Completed voice step for ${ctx.week}: ${synthesizedCount} synthesized, ${skippedCount} skipped (total ${results.length} segment(s)).`
  );

  return {
    segments: results,
    synthesizedCount,
    skippedCount,
    mock: useMock,
  };
}

