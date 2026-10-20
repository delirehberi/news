import { z } from 'zod';
import {
  CharacterAlignmentSchema,
  type CharacterAlignment,
} from '../domain/captions.ts';
import { WORDS_PER_MINUTE } from '../domain/script.ts';
import { fetchJson } from './http.ts';

export const DEFAULT_ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';
export const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';
export const DEFAULT_TTS_TIMEOUT_MS = 60_000;

// MPEG-1 Layer III, 44100 Hz, 128 kbps, Mono frame constants for deterministic silent MP3 generation
const MP3_SAMPLE_RATE_HZ = 44_100;
const MP3_SAMPLES_PER_FRAME = 1_152;
const MP3_FRAME_SIZE_BYTES = 417;
const MP3_HEADER_BYTES = [0xff, 0xfb, 0x90, 0xc4] as const;
const MOCK_SPACE_DURATION_SECONDS = 0.06;
const MOCK_MIN_WORD_DURATION_SECONDS = 0.18;
const SECONDS_PER_MINUTE = 60;

export const ElevenLabsWithTimestampsResponseSchema = z.object({
  audio_base64: z.string().trim().min(1, 'audio_base64 must not be empty'),
  alignment: CharacterAlignmentSchema.nullable().optional(),
  normalized_alignment: CharacterAlignmentSchema.nullable().optional(),
});

export interface SynthesizeWithTimestampsOptions {
  apiKey: string;
  voiceId: string;
  modelId: string;
  text: string;
  baseUrl?: string;
  outputFormat?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SynthesizedSpeechResult {
  audioBytes: Uint8Array;
  alignment: CharacterAlignment;
}

function buildTtsWithTimestampsUrl(
  baseUrl: string,
  voiceId: string,
  outputFormat: string
): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const encodedVoiceId = encodeURIComponent(voiceId.trim());
  const encodedFormat = encodeURIComponent(outputFormat.trim());
  return `${trimmedBase}/v1/text-to-speech/${encodedVoiceId}/with-timestamps?output_format=${encodedFormat}`;
}

/**
 * Calls ElevenLabs `POST /v1/text-to-speech/{voice_id}/with-timestamps` with `xi-api-key`,
 * `model_id`, and `output_format=mp3_44100_128`.
 * Decodes `audio_base64` into raw MP3 bytes and validates character-level alignment.
 */
export async function synthesizeWithTimestamps(
  options: SynthesizeWithTimestampsOptions
): Promise<SynthesizedSpeechResult> {
  const text = options.text.trim();
  if (!text) {
    throw new Error('Cannot synthesize speech for empty narration text.');
  }

  const url = buildTtsWithTimestampsUrl(
    options.baseUrl ?? DEFAULT_ELEVENLABS_BASE_URL,
    options.voiceId,
    options.outputFormat ?? ELEVENLABS_OUTPUT_FORMAT
  );

  const rawResponse = await fetchJson<unknown>(url, {
    method: 'POST',
    headers: {
      'xi-api-key': options.apiKey,
    },
    body: {
      text,
      model_id: options.modelId,
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS,
    maxRetries: options.maxRetries,
    baseBackoffMs: options.baseBackoffMs,
    fetchImpl: options.fetchImpl,
  });

  const parsed = ElevenLabsWithTimestampsResponseSchema.safeParse(rawResponse);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid ElevenLabs TTS response from ${url}: ${details}`);
  }

  const alignment = parsed.data.alignment ?? parsed.data.normalized_alignment;
  if (!alignment) {
    throw new Error(
      `Invalid ElevenLabs TTS response from ${url}: missing character alignment object.`
    );
  }

  const audioBuffer = Buffer.from(parsed.data.audio_base64, 'base64');
  if (audioBuffer.byteLength === 0) {
    throw new Error(
      `Invalid ElevenLabs TTS response from ${url}: decoded audio_base64 is empty.`
    );
  }

  return {
    audioBytes: new Uint8Array(
      audioBuffer.buffer,
      audioBuffer.byteOffset,
      audioBuffer.byteLength
    ),
    alignment,
  };
}

/**
 * Generates a valid, playable silent MPEG-1 Layer III (44.1 kHz, 128 kbps, Mono) MP3 buffer
 * matching the requested `durationSeconds`.
 */
export function buildSilentMp3Bytes(durationSeconds: number): Uint8Array {
  const safeDuration = Math.max(0.1, durationSeconds);
  const frameCount = Math.max(
    1,
    Math.ceil((safeDuration * MP3_SAMPLE_RATE_HZ) / MP3_SAMPLES_PER_FRAME)
  );
  const totalBytes = frameCount * MP3_FRAME_SIZE_BYTES;
  const buffer = new Uint8Array(totalBytes);

  for (let frameIdx = 0; frameIdx < frameCount; frameIdx++) {
    const offset = frameIdx * MP3_FRAME_SIZE_BYTES;
    buffer[offset] = MP3_HEADER_BYTES[0];
    buffer[offset + 1] = MP3_HEADER_BYTES[1];
    buffer[offset + 2] = MP3_HEADER_BYTES[2];
    buffer[offset + 3] = MP3_HEADER_BYTES[3];
  }

  return buffer;
}

/**
 * Builds deterministic character-level timestamps for `text` at `wordsPerMinute` (default 140 WPM)
 * and a matching silent MP3 buffer for local testing and Remotion rendering without an ElevenLabs account.
 */
export function synthesizeMockWithTimestamps(
  text: string,
  wordsPerMinute: number = WORDS_PER_MINUTE
): SynthesizedSpeechResult {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Cannot synthesize mock speech for empty narration text.');
  }

  const targetSecondsPerWord = SECONDS_PER_MINUTE / wordsPerMinute;
  const effectiveWordDuration = Math.max(
    MOCK_MIN_WORD_DURATION_SECONDS,
    targetSecondsPerWord - MOCK_SPACE_DURATION_SECONDS
  );

  const tokens = trimmed.split(/(\s+)/);
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];

  let cursor = 0;

  for (const token of tokens) {
    if (!token) continue;
    const chars = Array.from(token);
    if (chars.length === 0) continue;

    if (/^\s+$/.test(token)) {
      const perSpace = MOCK_SPACE_DURATION_SECONDS / chars.length;
      for (const ch of chars) {
        const start = Number(cursor.toFixed(4));
        cursor += perSpace;
        const end = Number(cursor.toFixed(4));
        characters.push(ch);
        starts.push(start);
        ends.push(end);
      }
    } else {
      const perChar = effectiveWordDuration / chars.length;
      for (const ch of chars) {
        const start = Number(cursor.toFixed(4));
        cursor += perChar;
        const end = Number(cursor.toFixed(4));
        characters.push(ch);
        starts.push(start);
        ends.push(end);
      }
    }
  }

  const alignment: CharacterAlignment = {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  };

  const totalDuration = ends.length > 0 ? ends[ends.length - 1] : 0.5;
  const audioBytes = buildSilentMp3Bytes(totalDuration);

  return {
    audioBytes,
    alignment,
  };
}

