import path from 'node:path';
import { z } from 'zod';
import type { CommandContext } from '../cli.ts';
import { requireElevenLabsEnv } from '../config/env.ts';
import { alignmentToWords, chunkCaptions, getAlignmentDurationSeconds } from '../domain/captions.ts';
import { shortNarration, type Short } from '../domain/shorts.ts';
import { buildShortTiming } from '../domain/shortTiming.ts';
import { synthesizeMockWithTimestamps, synthesizeWithTimestamps } from '../lib/elevenlabs.ts';
import { fileExists, readJson, writeBytesAtomic, writeJsonAtomic } from '../lib/paths.ts';
import { getShortsPaths } from '../lib/shortsPaths.ts';
import { loadShortsDraft, type ShortsCommandDeps } from './shorts-script.ts';
import { computeNarrationHash, loadCachedSegmentMetadata, type SegmentAudioMetadata, type VoiceSegmentSpec } from './voice.ts';

const ReceiptSchema = z.object({ video_id: z.string().regex(/^[\w-]{11}$/, 'Invalid YouTube video ID') });
export async function requireShortsUpload(week: string, outRoot?: string): Promise<string> {
  const paths = getShortsPaths(week, outRoot);
  if (!await fileExists(paths.weekly.uploadJson)) throw new Error(`Shorts production requires ${paths.weekly.uploadJson} before voice synthesis. Upload the approved full video first.`);
  return ReceiptSchema.parse(await readJson<unknown>(paths.weekly.uploadJson)).video_id;
}

export function shortVoiceSpec(short: Short, index: number): VoiceSegmentSpec {
  return { index, kind: 'intro', narration_tr: shortNarration(short) };
}

export function shortVoiceHash(ctx: CommandContext, narration: string): string {
  return computeNarrationHash(JSON.stringify({ narration, mock: Boolean(ctx.mock), voice: ctx.env.ELEVENLABS_VOICE_ID, model: ctx.env.ELEVENLABS_MODEL_ID }));
}

export async function loadShortAudio(ctx: CommandContext, short: Short, index: number, outRoot?: string): Promise<SegmentAudioMetadata | null> {
  const paths = getShortsPaths(ctx.week, outRoot);
  const spec = shortVoiceSpec(short, index);
  return loadCachedSegmentMetadata(path.join(paths.audioDir, `${index}.mp3`), path.join(paths.audioDir, `${index}.json`), spec, shortVoiceHash(ctx, spec.narration_tr), Boolean(ctx.mock));
}

export async function runShortsVoiceCommand(ctx: CommandContext, deps: ShortsCommandDeps = {}): Promise<void> {
  const { draft, paths } = await loadShortsDraft(ctx, deps);
  await requireShortsUpload(ctx.week, deps.outRoot);
  // Production never silently substitutes mock audio for missing credentials.
  const env = ctx.mock ? null : requireElevenLabsEnv(ctx.env);
  for (const [offset, short] of draft.shorts.entries()) {
    ctx.signal.throwIfAborted();
    const index = offset + 1;
    const spec = shortVoiceSpec(short, index);
    const cached = await loadShortAudio(ctx, short, index, deps.outRoot);
    if (cached) {
      buildShortTiming(short, cached.words, cached.duration_seconds);
      (deps.stdout ?? console.log)(`Short ${index}: voice cache hit`);
      continue;
    }
    const speech = env ? await synthesizeWithTimestamps({ apiKey: env.ELEVENLABS_API_KEY, voiceId: env.ELEVENLABS_VOICE_ID, modelId: env.ELEVENLABS_MODEL_ID, text: spec.narration_tr, signal: ctx.signal, fetchImpl: deps.fetchImpl }) : synthesizeMockWithTimestamps(spec.narration_tr);
    const words = alignmentToWords(speech.alignment);
    const duration = getAlignmentDurationSeconds(speech.alignment);
    buildShortTiming(short, words, duration);
    const metadata: SegmentAudioMetadata = { ...spec, narration_hash: shortVoiceHash(ctx, spec.narration_tr), mock: Boolean(ctx.mock), duration_seconds: duration, alignment: speech.alignment, words, captions: chunkCaptions(words) };
    await writeBytesAtomic(path.join(paths.audioDir, `${index}.mp3`), speech.audioBytes);
    await writeJsonAtomic(path.join(paths.audioDir, `${index}.json`), metadata);
    (deps.stdout ?? console.log)(`Short ${index}: ${duration.toFixed(1)}s narration with fixed CTA`);
  }
}
