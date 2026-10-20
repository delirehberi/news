import { describe, expect, it } from 'vitest';
import {
  alignmentToWords,
  chunkCaptions,
  getAlignmentDurationSeconds,
  type CharacterAlignment,
} from './captions.ts';

function buildCharAlignment(
  text: string,
  charStepSeconds: number = 0.05
): CharacterAlignment {
  const characters = Array.from(text);
  const starts: number[] = [];
  const ends: number[] = [];

  for (let i = 0; i < characters.length; i++) {
    const start = Number((i * charStepSeconds).toFixed(4));
    const end = Number(((i + 1) * charStepSeconds).toFixed(4));
    starts.push(start);
    ends.push(end);
  }

  return {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  };
}

describe('src/domain/captions.ts', () => {
  describe('alignmentToWords', () => {
    it('converts character timings into word timings with Turkish characters and punctuation', () => {
      const sentence = 'Çığlık, öbür şüpheli üreticiyi şaşırttı! İyi günler.';
      const alignment = buildCharAlignment(sentence, 0.1);

      const words = alignmentToWords(alignment);

      expect(words.map((w) => w.word)).toEqual([
        'Çığlık,',
        'öbür',
        'şüpheli',
        'üreticiyi',
        'şaşırttı!',
        'İyi',
        'günler.',
      ]);

      // First word "Çığlık," spans 7 characters (indices 0..6 -> 0.0 to 0.7)
      expect(words[0]).toEqual({
        word: 'Çığlık,',
        start: 0,
        end: 0.7,
      });

      // Second word "öbür" starts at index 8 (0.8) and spans 4 characters (0.8 to 1.2)
      expect(words[1]).toEqual({
        word: 'öbür',
        start: 0.8,
        end: 1.2,
      });

      // Last word "günler." spans 7 characters at the end of the 52-char string (4.5 to 5.2)
      expect(words[words.length - 1]).toEqual({
        word: 'günler.',
        start: 4.5,
        end: 5.2,
      });
    });

    it('collapses leading, trailing, and multiple consecutive spaces and newlines', () => {
      const text = '   Türkiye’de   चाğdaş\n\n  yazılım\t\tgeliştirme!   ';
      const alignment = buildCharAlignment(text, 0.05);

      const words = alignmentToWords(alignment);

      expect(words.map((w) => w.word)).toEqual([
        'Türkiye’de',
        'चाğdaş',
        'yazılım',
        'geliştirme!',
      ]);
      for (const w of words) {
        expect(w.end).toBeGreaterThan(w.start);
      }
    });

    it('returns an empty array for empty or whitespace-only alignment', () => {
      expect(
        alignmentToWords({
          characters: [],
          character_start_times_seconds: [],
          character_end_times_seconds: [],
        })
      ).toEqual([]);

      expect(alignmentToWords(buildCharAlignment('    \n\t  '))).toEqual([]);
    });

    it('throws a descriptive error when character and timing array lengths mismatch', () => {
      expect(() =>
        alignmentToWords({
          characters: ['a', 'b'],
          character_start_times_seconds: [0],
          character_end_times_seconds: [0.1, 0.2],
        })
      ).toThrowError(/Character alignment length mismatch/);
    });
  });

  describe('chunkCaptions', () => {
    it('groups words into caption chunks without exceeding maxChars', () => {
      const sentence =
        'Haftalık teknoloji özetimize hoş geldiniz, bu hafta yapay zeka dünyasında önemli gelişmeler yaşandı.';
      const alignment = buildCharAlignment(sentence, 0.04);
      const words = alignmentToWords(alignment);

      const chunks = chunkCaptions(words, 32);

      expect(chunks.length).toBeGreaterThan(2);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(32);
        expect(chunk.words.length).toBeGreaterThan(0);
        expect(chunk.start).toBe(chunk.words[0].start);
        expect(chunk.end).toBe(chunk.words[chunk.words.length - 1].end);
      }

      expect(chunks.map((c) => c.text).join(' ')).toBe(sentence);
    });

    it('places a single word longer than maxChars in its own chunk without dropping it', () => {
      const words = [
        { word: 'Kısa', start: 0, end: 0.3 },
        { word: 'Muvaffakiyetsizleştiricileştiriveremeyebileceklerimizdenmişsinizcesine', start: 0.4, end: 2.5 },
        { word: 'kelime.', start: 2.6, end: 3.0 },
      ];

      const chunks = chunkCaptions(words, 20);
      expect(chunks).toHaveLength(3);
      expect(chunks[0].text).toBe('Kısa');
      expect(chunks[1].text).toBe(
        'Muvaffakiyetsizleştiricileştiriveremeyebileceklerimizdenmişsinizcesine'
      );
      expect(chunks[2].text).toBe('kelime.');
    });

    it('returns an empty array for empty words and rejects invalid maxChars', () => {
      expect(chunkCaptions([])).toEqual([]);
      expect(() => chunkCaptions([], 0)).toThrowError(/Invalid maxChars/);
      expect(() => chunkCaptions([], -5)).toThrowError(/Invalid maxChars/);
    });
  });

  describe('getAlignmentDurationSeconds', () => {
    it('computes the maximum end timestamp', () => {
      const alignment = buildCharAlignment('Merhaba dünya!', 0.1);
      expect(getAlignmentDurationSeconds(alignment)).toBe(1.4);
    });
  });
});

