import { z } from 'zod';

export const DEFAULT_MAX_CAPTION_CHARS = 42;

const WHITESPACE_ONLY_REGEX = /^\s+$/;

export const CharacterAlignmentSchema = z
  .object({
    characters: z.array(z.string()),
    character_start_times_seconds: z.array(z.number().nonnegative()),
    character_end_times_seconds: z.array(z.number().nonnegative()),
  })
  .superRefine((alignment, ctx) => {
    const charLen = alignment.characters.length;
    const startLen = alignment.character_start_times_seconds.length;
    const endLen = alignment.character_end_times_seconds.length;
    if (charLen !== startLen || charLen !== endLen) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Character alignment length mismatch: characters=${charLen}, starts=${startLen}, ends=${endLen}.`,
      });
    }
  });

export type CharacterAlignment = z.infer<typeof CharacterAlignmentSchema>;

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface CaptionChunk {
  text: string;
  words: WordTiming[];
  start: number;
  end: number;
}

/**
 * Pure function that converts character-level ElevenLabs timings into word-level timings.
 * Preserves Turkish characters (`ç ğ ı İ ö ş ü Ç Ğ I Ö Ş Ü`) and attached punctuation,
 * and collapses leading, trailing, or consecutive whitespace characters.
 */
export function alignmentToWords(alignment: CharacterAlignment): WordTiming[] {
  const parsed = CharacterAlignmentSchema.safeParse(alignment);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => i.message).join('; ');
    throw new Error(`Invalid character alignment: ${details}`);
  }

  const { characters, character_start_times_seconds, character_end_times_seconds } =
    parsed.data;

  const words: WordTiming[] = [];
  let currentWordChars: string[] = [];
  let currentStart = 0;
  let currentEnd = 0;

  const flushCurrentWord = (): void => {
    if (currentWordChars.length === 0) {
      return;
    }
    words.push({
      word: currentWordChars.join(''),
      start: currentStart,
      end: Math.max(currentStart, currentEnd),
    });
    currentWordChars = [];
  };

  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    const start = character_start_times_seconds[i];
    const end = character_end_times_seconds[i];

    if (ch.length === 0) {
      continue;
    }

    if (WHITESPACE_ONLY_REGEX.test(ch)) {
      flushCurrentWord();
      continue;
    }

    // Handle multi-character entries that might contain internal whitespace
    if (/\s/.test(ch)) {
      const subParts = ch.split(/(\s+)/);
      for (const part of subParts) {
        if (!part) continue;
        if (WHITESPACE_ONLY_REGEX.test(part)) {
          flushCurrentWord();
        } else {
          if (currentWordChars.length === 0) {
            currentStart = start;
          }
          currentWordChars.push(part);
          currentEnd = end;
        }
      }
      continue;
    }

    if (currentWordChars.length === 0) {
      currentStart = start;
    }
    currentWordChars.push(ch);
    currentEnd = end;
  }

  flushCurrentWord();
  return words;
}

/**
 * Pure function that groups word timings into caption chunks whose joined text length
 * does not exceed `maxChars` characters.
 * A single word longer than `maxChars` is placed in its own chunk rather than dropped.
 */
export function chunkCaptions(
  words: readonly WordTiming[],
  maxChars: number = DEFAULT_MAX_CAPTION_CHARS
): CaptionChunk[] {
  if (!Number.isFinite(maxChars) || maxChars < 1) {
    throw new Error(`Invalid maxChars (${maxChars}): must be a positive number >= 1.`);
  }

  const maxLineChars = Math.floor(maxChars);
  const chunks: CaptionChunk[] = [];
  let currentWords: WordTiming[] = [];
  let currentLength = 0;

  const flushChunk = (): void => {
    if (currentWords.length === 0) {
      return;
    }
    const first = currentWords[0];
    const last = currentWords[currentWords.length - 1];
    chunks.push({
      text: currentWords.map((w) => w.word).join(' '),
      words: currentWords,
      start: first.start,
      end: Math.max(first.start, last.end),
    });
    currentWords = [];
    currentLength = 0;
  };

  for (const wordTiming of words) {
    const trimmedWord = wordTiming.word.trim();
    if (!trimmedWord) {
      continue;
    }

    const normalizedTiming: WordTiming =
      trimmedWord === wordTiming.word
        ? wordTiming
        : { ...wordTiming, word: trimmedWord };

    if (currentWords.length === 0) {
      currentWords.push(normalizedTiming);
      currentLength = normalizedTiming.word.length;
      continue;
    }

    const candidateLength = currentLength + 1 + normalizedTiming.word.length;
    if (candidateLength <= maxLineChars) {
      currentWords.push(normalizedTiming);
      currentLength = candidateLength;
    } else {
      flushChunk();
      currentWords.push(normalizedTiming);
      currentLength = normalizedTiming.word.length;
    }
  }

  flushChunk();
  return chunks;
}

/**
 * Computes the audio duration in seconds from character alignment timings.
 */
export function getAlignmentDurationSeconds(alignment: CharacterAlignment): number {
  let maxEnd = 0;
  for (const end of alignment.character_end_times_seconds) {
    if (end > maxEnd) {
      maxEnd = end;
    }
  }
  return maxEnd;
}

