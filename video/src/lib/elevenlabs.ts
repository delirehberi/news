import { z } from 'zod';
import {
  CharacterAlignmentSchema,
  type CharacterAlignment,
} from '../domain/captions.ts';
import {
  EMOTION_MARKER_PATTERN,
  WORDS_PER_MINUTE,
} from '../domain/script.ts';
import { fetchJson } from './http.ts';

export const DEFAULT_ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';
export const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';
export const DEFAULT_TTS_TIMEOUT_MS = 60_000;

// Only the v3 and v4 model families interpret bracketed audio tags such as `[pause]`.
// Other models read them aloud literally, so they are stripped before synthesis.
const EMOTION_TAG_MODEL_PATTERN = /^eleven_v[34](?:_|$)/;
// Matches a bracketed marker of letters/spaces/hyphens (e.g. `[pause]`, `[thoughtful]`) plus surrounding whitespace.
const EMOTION_TAG_PATTERN = /\s*\[\s*[A-Za-z][A-Za-z -]*\]\s*/g;

// MPEG-1 Layer III, 44100 Hz, 128 kbps, Mono frame constants for deterministic silent MP3 generation
const MP3_SAMPLE_RATE_HZ = 44_100;
const MP3_SAMPLES_PER_FRAME = 1_152;
const MP3_FRAME_SIZE_BYTES = 417;
const MP3_HEADER_BYTES = [0xff, 0xfb, 0x90, 0xc4] as const;
const MOCK_SPACE_DURATION_SECONDS = 0.06;
const MOCK_MIN_WORD_DURATION_SECONDS = 0.18;
const MOCK_PAUSE_SECONDS = 0.6;
const MOCK_PAUSE_MARKER_PATTERN = /pause/i;
// Capturing variant of the shared marker pattern: odd indices of `split` are the markers themselves.
const MOCK_MARKER_SPLIT_PATTERN = new RegExp(`(${EMOTION_MARKER_PATTERN.source})`);
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

export function supportsEmotionTags(modelId: string): boolean {
  return EMOTION_TAG_MODEL_PATTERN.test(modelId.trim());
}

/**
 * Removes bracketed emotion markers when the configured model cannot interpret them,
 * so they are never spoken literally. Emits a warning whenever markers are stripped.
 */
function stripUnsupportedEmotionTags(text: string, modelId: string): string {
  if (supportsEmotionTags(modelId)) return text;

  const markers = text.match(EMOTION_TAG_PATTERN);
  if (!markers) return text;

  console.warn(
    `ElevenLabs model "${modelId}" does not support emotion audio tags; stripped ${markers.length} bracketed marker(s) before synthesis. Use eleven_v3 or eleven_v4 to keep them.`
  );
  return text.replace(EMOTION_TAG_PATTERN, ' ').trim();
}

/**
 * Calls ElevenLabs `POST /v1/text-to-speech/{voice_id}/with-timestamps` with `xi-api-key`,
 * `model_id`, and `output_format=mp3_44100_128`.
 * Bracketed emotion markers are stripped (with a warning) unless the model is v3 or v4,
 * so the returned alignment matches the text that was actually spoken.
 * Decodes `audio_base64` into raw MP3 bytes and validates character-level alignment.
 */
export async function synthesizeWithTimestamps(
  options: SynthesizeWithTimestampsOptions
): Promise<SynthesizedSpeechResult> {
  const trimmedText = options.text.trim();
  if (!trimmedText) {
    throw new Error('Cannot synthesize speech for empty narration text.');
  }

  const text = stripUnsupportedEmotionTags(trimmedText, options.modelId);
  if (!text) {
    throw new Error(
      'Cannot synthesize speech: narration text is empty after removing unsupported emotion tags.'
    );
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

  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];

  let cursor = 0;

  // Emotion markers are never spoken characters. A pause marker advances the clock by silence;
  // every other marker (e.g. `[thoughtful]`) contributes no time at all.
  const segments = trimmed.split(MOCK_MARKER_SPLIT_PATTERN);
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];
    const isMarker = segmentIndex % 2 === 1;
    if (isMarker) {
      if (MOCK_PAUSE_MARKER_PATTERN.test(segment)) {
        cursor += MOCK_PAUSE_SECONDS;
      }
      continue;
    }

    for (const token of segment.split(/(\s+)/)) {
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
  }

  if (characters.length === 0) {
    throw new Error(
      'Cannot synthesize mock speech: narration text is empty after removing emotion markers.'
    );
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

