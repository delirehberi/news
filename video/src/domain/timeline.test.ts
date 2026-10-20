import { describe, expect, it } from 'vitest';
import {
  buildVideoTimeline,
  calculateSceneDurationFrames,
  calculateTotalDurationFrames,
  computeKenBurnsTransform,
  extractHostname,
  getActiveCaptionAtFrame,
  getSourceBadgeTheme,
  MIN_SCENE_DURATION_SECONDS,
  SCENE_PADDING_SECONDS,
  VIDEO_FPS,
  type WeeklyVideoProps,
} from './timeline.ts';
import type { CaptionChunk } from './captions.ts';

describe('src/domain/timeline.ts', () => {
  describe('calculateSceneDurationFrames', () => {
    it('adds SCENE_PADDING_SECONDS to audioDurationSeconds and rounds up to whole frames at 30fps', () => {
      // 10.0s + 0.6s padding = 10.6s * 30fps = 318 frames
      expect(calculateSceneDurationFrames(10)).toBe(318);

      // 4.11s + 0.6s = 4.71s * 30fps = 141.3 -> 142 frames
      expect(calculateSceneDurationFrames(4.11)).toBe(142);
    });

    it('falls back to MIN_SCENE_DURATION_SECONDS when audioDurationSeconds is 0 or negative', () => {
      const expectedFallbackFrames = Math.ceil(
        MIN_SCENE_DURATION_SECONDS * VIDEO_FPS
      );
      expect(calculateSceneDurationFrames(0)).toBe(expectedFallbackFrames);
      expect(calculateSceneDurationFrames(-2)).toBe(expectedFallbackFrames);
    });

    it('supports custom fps and paddingSeconds and rejects invalid parameters', () => {
      // 5s + 1s padding at 60fps = 360 frames
      expect(calculateSceneDurationFrames(5, 60, 1)).toBe(360);

      expect(() => calculateSceneDurationFrames(5, 0)).toThrowError(/Invalid fps/);
      expect(() => calculateSceneDurationFrames(5, 30, -0.5)).toThrowError(
        /Invalid paddingSeconds/
      );
    });
  });

  describe('buildVideoTimeline & calculateTotalDurationFrames', () => {
    it('computes cumulative startFrame, durationInFrames, startSeconds, and total duration across intro, stories, and outro', () => {
      const props: WeeklyVideoProps = {
        week: '2026-W42',
        title_tr: 'Haftalık Teknoloji Özeti: Yapay Zeka ve Rust',
        siteUrl: 'news.emre.xyz',
        intro: {
          audioSrc: 'audio/0.mp3',
          audioDurationSeconds: 12.4, // + 0.6s = 13.0s = 390 frames
          captions: [],
        },
        stories: [
          {
            index: 1,
            url: 'https://example.com/story-1',
            domain: 'example.com',
            source: 'hn',
            headline_tr: 'Birinci Haber Başlığı',
            summary_tr: 'Birinci haber özeti.',
            imageSrc: 'images/1.jpg',
            audioSrc: 'audio/1.mp3',
            audioDurationSeconds: 45.4, // + 0.6s = 46.0s = 1380 frames
            captions: [],
          },
          {
            index: 2,
            url: 'https://lobste.rs/s/story-2',
            domain: 'lobste.rs',
            source: 'lobsters',
            headline_tr: 'İkinci Haber Başlığı',
            summary_tr: 'İkinci haber özeti.',
            imageSrc: null,
            audioSrc: 'audio/2.mp3',
            audioDurationSeconds: 50.4, // + 0.6s = 51.0s = 1530 frames
            captions: [],
          },
          {
            index: 3,
            url: 'https://reddit.com/r/rust/story-3',
            domain: 'reddit.com',
            source: 'reddit',
            headline_tr: 'Üçüncü Haber Başlığı',
            summary_tr: 'Üçüncü haber özeti.',
            imageSrc: 'images/3.png',
            audioSrc: 'audio/3.mp3',
            audioDurationSeconds: 38.4, // + 0.6s = 39.0s = 1170 frames
            captions: [],
          },
        ],
        outro: {
          audioSrc: 'audio/4.mp3',
          audioDurationSeconds: 10.4, // + 0.6s = 11.0s = 330 frames
          captions: [],
        },
      };

      const timeline = buildVideoTimeline(props, VIDEO_FPS, SCENE_PADDING_SECONDS);

      expect(timeline.scenes).toHaveLength(5);

      // Scene 0: Intro
      expect(timeline.scenes[0]).toEqual({
        index: 0,
        kind: 'intro',
        label: 'Giriş',
        startFrame: 0,
        durationInFrames: 390,
        startSeconds: 0,
        durationSeconds: 13,
      });

      // Scene 1: Story 1
      expect(timeline.scenes[1]).toEqual({
        index: 1,
        kind: 'story',
        label: 'Birinci Haber Başlığı',
        storyIndex: 0,
        startFrame: 390,
        durationInFrames: 1380,
        startSeconds: 13,
        durationSeconds: 46,
      });

      // Scene 2: Story 2
      expect(timeline.scenes[2]).toEqual({
        index: 2,
        kind: 'story',
        label: 'İkinci Haber Başlığı',
        storyIndex: 1,
        startFrame: 1770,
        durationInFrames: 1530,
        startSeconds: 59,
        durationSeconds: 51,
      });

      // Scene 3: Story 3
      expect(timeline.scenes[3]).toEqual({
        index: 3,
        kind: 'story',
        label: 'Üçüncü Haber Başlığı',
        storyIndex: 2,
        startFrame: 3300,
        durationInFrames: 1170,
        startSeconds: 110,
        durationSeconds: 39,
      });

      // Scene 4: Outro
      expect(timeline.scenes[4]).toEqual({
        index: 4,
        kind: 'outro',
        label: 'Kapanış',
        startFrame: 4470,
        durationInFrames: 330,
        startSeconds: 149,
        durationSeconds: 11,
      });

      // Total duration: 13 + 46 + 51 + 39 + 11 = 160s (2m 40s, within 2–5 min target) = 4800 frames
      expect(timeline.totalDurationInFrames).toBe(4800);
      expect(timeline.totalDurationSeconds).toBe(160);
      expect(calculateTotalDurationFrames(props)).toBe(4800);
    });
  });

  describe('getActiveCaptionAtFrame', () => {
    const sampleCaptions: CaptionChunk[] = [
      {
        text: 'Merhaba arkadaşlar, bu hafta',
        start: 0.2,
        end: 1.5,
        words: [
          { word: 'Merhaba', start: 0.2, end: 0.6 },
          { word: 'arkadaşlar,', start: 0.65, end: 1.05 },
          { word: 'bu', start: 1.1, end: 1.25 },
          { word: 'hafta', start: 1.28, end: 1.5 },
        ],
      },
      {
        text: 'önemli gelişmeler yaşanıyor.',
        start: 1.8,
        end: 3.0,
        words: [
          { word: 'önemli', start: 1.8, end: 2.15 },
          { word: 'gelişmeler', start: 2.2, end: 2.6 },
          { word: 'yaşanıyor.', start: 2.65, end: 3.0 },
        ],
      },
    ];

    it('returns null before the first caption chunk starts and after the last chunk ends', () => {
      // Frame 0 = 0.0s (before 0.2s)
      const before = getActiveCaptionAtFrame(sampleCaptions, 0, 30);
      expect(before.chunk).toBeNull();
      expect(before.activeWordIndex).toBe(-1);

      // Frame 120 = 4.0s (well after 3.0s)
      const after = getActiveCaptionAtFrame(sampleCaptions, 120, 30);
      expect(after.chunk).toBeNull();
      expect(after.activeWordIndex).toBe(-1);
    });

    it('synchronizes the active caption chunk and Turkish word index with the frame time', () => {
      // Frame 9 = 0.3s -> "Merhaba" (index 0)
      const atFrame9 = getActiveCaptionAtFrame(sampleCaptions, 9, 30);
      expect(atFrame9.chunk?.text).toBe('Merhaba arkadaşlar, bu hafta');
      expect(atFrame9.activeWordIndex).toBe(0);

      // Frame 24 = 0.8s -> "arkadaşlar," (index 1)
      const atFrame24 = getActiveCaptionAtFrame(sampleCaptions, 24, 30);
      expect(atFrame24.chunk?.text).toBe('Merhaba arkadaşlar, bu hafta');
      expect(atFrame24.activeWordIndex).toBe(1);

      // Frame 42 = 1.4s -> "hafta" (index 3)
      const atFrame42 = getActiveCaptionAtFrame(sampleCaptions, 42, 30);
      expect(atFrame42.chunk?.text).toBe('Merhaba arkadaşlar, bu hafta');
      expect(atFrame42.activeWordIndex).toBe(3);

      // Frame 72 = 2.4s -> second chunk, "gelişmeler" (index 1)
      const atFrame72 = getActiveCaptionAtFrame(sampleCaptions, 72, 30);
      expect(atFrame72.chunk?.text).toBe('önemli gelişmeler yaşanıyor.');
      expect(atFrame72.activeWordIndex).toBe(1);
    });
  });

  describe('computeKenBurnsTransform & helpers', () => {
    it('interpolates scale from 1.0 to 1.08 and alternates pan direction by storyIndex', () => {
      const startEven = computeKenBurnsTransform(0, 300, 0);
      expect(startEven.scale).toBe(1);
      expect(startEven.translateX).toBe(0);
      expect(startEven.translateY).toBe(0);

      const endEven = computeKenBurnsTransform(299, 300, 0);
      expect(endEven.scale).toBeCloseTo(1.08, 4);
      expect(endEven.translateX).toBeLessThan(0);

      const endOdd = computeKenBurnsTransform(299, 300, 1);
      expect(endOdd.scale).toBeCloseTo(1.08, 4);
      expect(endOdd.translateX).toBeGreaterThan(0);
    });

    it('extracts clean hostnames and resolves source badge themes', () => {
      expect(extractHostname('https://www.github.com/rust-lang/rust')).toBe(
        'github.com'
      );
      expect(extractHostname('not-a-url')).toBe('');

      expect(getSourceBadgeTheme('hn').label).toBe('HN');
      expect(getSourceBadgeTheme('lobsters').label).toBe('Lobsters');
      expect(getSourceBadgeTheme('newsletter').label).toBe('Newsletter');
    });
  });
});

