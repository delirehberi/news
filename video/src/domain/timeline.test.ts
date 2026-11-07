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

      // Scene 2: Story 2 (overlaps Story 1 by 15 frames = 0.5s)
      expect(timeline.scenes[2]).toEqual({
        index: 2,
        kind: 'story',
        label: 'İkinci Haber Başlığı',
        storyIndex: 1,
        startFrame: 1755,
        durationInFrames: 1530,
        startSeconds: 58.5,
        durationSeconds: 51,
      });

      // Scene 3: Story 3 (overlaps Story 2 by 15 frames = 0.5s)
      expect(timeline.scenes[3]).toEqual({
        index: 3,
        kind: 'story',
        label: 'Üçüncü Haber Başlığı',
        storyIndex: 2,
        startFrame: 3270,
        durationInFrames: 1170,
        startSeconds: 109,
        durationSeconds: 39,
      });

      // Scene 4: Outro (starts when Story 3 ends)
      expect(timeline.scenes[4]).toEqual({
        index: 4,
        kind: 'outro',
        label: 'Kapanış',
        startFrame: 4440,
        durationInFrames: 330,
        startSeconds: 148,
        durationSeconds: 11,
      });

      // Total duration: 4800 raw frames - 2 story transitions * 15 frames = 4770 frames (159.0s)
      expect(timeline.transitionDurationInFrames).toBe(15);
      expect(timeline.transitionOverlapCount).toBe(2);
      expect(timeline.totalDurationInFrames).toBe(4770);
      expect(timeline.totalDurationSeconds).toBe(159);
      expect(calculateTotalDurationFrames(props)).toBe(4770);

      // With transitionFrames = 0, no overlap is subtracted
      expect(calculateTotalDurationFrames(props, VIDEO_FPS, SCENE_PADDING_SECONDS, 0)).toBe(
        4800
      );
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

  describe('StorySceneItemSchema backward compatibility & page/cues extension', () => {
    it('parses legacy StorySceneItem without page or cues and keeps THUMBNAIL_FRAME on intro', async () => {
      const {
        StorySceneItemSchema,
        WeeklyVideoPropsSchema,
        THUMBNAIL_FRAME,
      } = await import('./timeline.ts');

      const legacyStory = {
        index: 1,
        url: 'https://example.com/legacy-story',
        domain: 'example.com',
        source: 'hn',
        headline_tr: 'Eski Hafta Haberi',
        summary_tr: 'Eski hafta özeti.',
        imageSrc: 'images/1.jpg',
        audioSrc: 'audio/1.mp3',
        audioDurationSeconds: 30,
        captions: [],
      };

      const parsedLegacy = StorySceneItemSchema.parse(legacyStory);
      expect(parsedLegacy.page).toBeUndefined();
      expect(parsedLegacy.cues).toBeUndefined();
      expect(parsedLegacy.imageSrc).toBe('images/1.jpg');

      const props = WeeklyVideoPropsSchema.parse({
        week: '2026-W41',
        title_tr: 'Geçen Hafta Özeti',
        siteUrl: 'news.emre.xyz',
        intro: {
          audioSrc: 'audio/0.mp3',
          audioDurationSeconds: 8,
          captions: [],
        },
        stories: [legacyStory],
        outro: {
          audioSrc: 'audio/2.mp3',
          audioDurationSeconds: 6,
          captions: [],
        },
      });

      const timeline = buildVideoTimeline(props, VIDEO_FPS);
      const introScene = timeline.scenes[0];
      expect(introScene.kind).toBe('intro');
      expect(THUMBNAIL_FRAME).toBeGreaterThanOrEqual(introScene.startFrame);
      expect(THUMBNAIL_FRAME).toBeLessThan(
        introScene.startFrame + introScene.durationInFrames
      );
    });

    it('parses StorySceneItem with full PageCaptureMetadata or flexible page object and visual cues', async () => {
      const { StorySceneItemSchema, normalizeStoryPage } = await import(
        './timeline.ts'
      );

      const storyWithPageAndCues = StorySceneItemSchema.parse({
        index: 1,
        url: 'https://example.com/story-1',
        domain: 'example.com',
        source: 'hn',
        headline_tr: 'Rust Derleyicisi %40 Daha Hızlı',
        imageSrc: 'images/1.png',
        audioSrc: 'audio/1.mp3',
        audioDurationSeconds: 24,
        captions: [],
        page: {
          index: 1,
          url: 'https://example.com/story-1',
          url_hash: '0123456789abcdef',
          captured_at: '2026-10-20T12:00:00.000Z',
          screenshot_path: 'pages/1.png',
          viewport: {
            width: 1440,
            height: 900,
            deviceScaleFactor: 1,
          },
          page_height: 2600,
          excerpt: 'Rust compiler parallel frontend...',
          elements: [
            {
              id: 'h1',
              kind: 'h1',
              tagName: 'h1',
              text: 'Rust Compiler Is 40% Faster',
              box: { x: 120, y: 140, width: 920, height: 84 },
            },
          ],
        },
        cues: [
          {
            kind: 'focus',
            anchor: 'Rust Derleyicisi',
            target: 'h1',
          },
          {
            kind: 'stat',
            anchor: '%40 daha hızlı',
            value: '%40 daha hızlı',
          },
        ],
      });

      expect(storyWithPageAndCues.cues).toHaveLength(2);
      const normalized = normalizeStoryPage(storyWithPageAndCues.page);
      expect(normalized).not.toBeNull();
      expect(normalized?.screenshotSrc).toBe('pages/1.png');
      expect(normalized?.page_height).toBe(2600);
      expect(normalized?.elements).toHaveLength(1);
    });
  });

  describe('StoryScene fallback ladder, lower-third headline, and walkthrough helpers', () => {
    it('resolves the 3-level fallback ladder: page capture -> OG image -> branded card', async () => {
      const { resolveStoryFallbackMode } = await import('./timeline.ts');

      const fullStory = {
        page: {
          screenshot_path: 'pages/1.png',
          page_height: 2200,
          elements: [],
        },
        imageSrc: 'images/1.png',
      };

      // 1. Page capture present and healthy -> 'page'
      expect(resolveStoryFallbackMode(fullStory)).toBe('page');

      // 2. Page capture failed at load time -> falls back to 'og'
      expect(
        resolveStoryFallbackMode(fullStory, { pageLoadFailed: true })
      ).toBe('og');

      // 3. Both page and OG image failed or missing -> falls back to 'card'
      expect(
        resolveStoryFallbackMode(fullStory, {
          pageLoadFailed: true,
          imageLoadFailed: true,
        })
      ).toBe('card');
      expect(
        resolveStoryFallbackMode({ page: null, imageSrc: 'images/1.png' })
      ).toBe('og');
      expect(
        resolveStoryFallbackMode({ page: null, imageSrc: null })
      ).toBe('card');
    });

    it('slides in lower-third headline and collapses to a compact chip after ~3s (90 frames at 30fps)', async () => {
      const { computeHeadlineLowerThirdState } = await import('./timeline.ts');

      const atStart = computeHeadlineLowerThirdState(0, 30);
      expect(atStart.collapsed).toBe(false);
      expect(atStart.collapseProgress).toBe(0);
      expect(atStart.translateY).toBeGreaterThan(0);

      const atTwoSeconds = computeHeadlineLowerThirdState(60, 30);
      expect(atTwoSeconds.collapsed).toBe(false);
      expect(atTwoSeconds.collapseProgress).toBe(0);
      expect(atTwoSeconds.opacity).toBe(1);
      expect(atTwoSeconds.translateY).toBe(0);

      const midCollapse = computeHeadlineLowerThirdState(99, 30);
      expect(midCollapse.collapseProgress).toBeGreaterThan(0.2);
      expect(midCollapse.collapseProgress).toBeLessThan(0.8);

      const afterCollapse = computeHeadlineLowerThirdState(120, 30);
      expect(afterCollapse.collapsed).toBe(true);
      expect(afterCollapse.collapseProgress).toBe(1);
    });

    it('extracts salient headline keywords and builds walkthrough plan with heuristic or LLM cues', async () => {
      const { extractHeadlineKeywords } = await import('./timeline.ts');
      const {
        buildOgKeywordAnnotations,
        buildStoryWalkthroughPlan,
      } = await import('../remotion/WeeklyVideo.tsx');

      const keywords = extractHeadlineKeywords(
        'Linux Çekirdeğinde Rust Sürücüleri ile %40 Daha Hızlı Performans',
        3
      );
      expect(keywords).toContain('%40');
      expect(keywords.length).toBe(3);

      const ogAnnotations = buildOgKeywordAnnotations(
        'Linux Çekirdeğinde Rust Sürücüleri ile %40 Daha Hızlı Performans',
        240,
        1
      );
      expect(ogAnnotations).toHaveLength(3);
      expect(ogAnnotations[0]?.annotation.targetBox).toBeDefined();

      // Heuristic walkthrough when cues are absent
      const heuristicPlan = buildStoryWalkthroughPlan(
        {
          index: 1,
          url: 'https://example.com/rust',
          domain: 'example.com',
          source: 'hn',
          headline_tr: 'Rust Derleyicisi Hızlandı',
          summary_tr: 'Bu özet ekranda gösterilmez.',
          imageSrc: 'images/1.png',
          audioSrc: 'audio/1.mp3',
          audioDurationSeconds: 10,
          captions: [],
          page: {
            screenshot_path: 'pages/1.png',
            page_height: 2400,
            elements: [
              {
                id: 'h1',
                kind: 'h1',
                tagName: 'h1',
                text: 'Rust Compiler Speedup',
                box: { x: 100, y: 120, width: 900, height: 80 },
              },
            ],
          },
        },
        300,
        30
      );
      expect(heuristicPlan.cues.length).toBeGreaterThanOrEqual(4);
      expect(heuristicPlan.track.keyframes.length).toBeGreaterThanOrEqual(4);

      // Explicit LLM cues walkthrough
      const directedPlan = buildStoryWalkthroughPlan(
        {
          index: 1,
          url: 'https://example.com/rust',
          domain: 'example.com',
          source: 'hn',
          headline_tr: 'Rust Derleyicisi Hızlandı',
          summary_tr: '',
          imageSrc: 'images/1.png',
          audioSrc: 'audio/1.mp3',
          audioDurationSeconds: 10,
          captions: [
            {
              text: 'Rust derleyicisi yüzde 40 hızlandı',
              start: 0.5,
              end: 2.5,
              words: [
                { word: 'Rust', start: 0.5, end: 0.9 },
                { word: 'derleyicisi', start: 0.95, end: 1.4 },
                { word: 'yüzde', start: 1.5, end: 1.8 },
                { word: '40', start: 1.85, end: 2.1 },
                { word: 'hızlandı', start: 2.15, end: 2.5 },
              ],
            },
          ],
          page: {
            screenshot_path: 'pages/1.png',
            page_height: 2400,
            elements: [
              {
                id: 'h1',
                kind: 'h1',
                tagName: 'h1',
                text: 'Rust Compiler Speedup',
                box: { x: 100, y: 120, width: 900, height: 80 },
              },
            ],
          },
          cues: [
            { kind: 'focus', anchor: 'Rust derleyicisi', target: 'h1' },
            { kind: 'circle', anchor: 'yüzde 40', target: 'h1' },
          ],
        },
        300,
        30
      );
      expect(directedPlan.cues).toHaveLength(2);
      expect(directedPlan.cues[0]?.matched).toBe(true);
      expect(directedPlan.cues[0]?.box).toEqual({
        x: 100,
        y: 120,
        width: 900,
        height: 80,
      });
    });

    it('animates Intro kinetic title word-by-word, keeps THUMBNAIL_FRAME readable, and builds card stack with or without page captures', async () => {
      const { THUMBNAIL_FRAME } = await import('./timeline.ts');
      const {
        computeIntroCardStackStates,
        computeKineticTitleWordStates,
      } = await import('../remotion/WeeklyVideo.tsx');
      const {
        calculateTransitionSeriesDuration,
        resolveStoryTransitionSpec,
      } = await import('../remotion/primitives/index.ts');

      const title = 'Haftalık Teknoloji Özeti: Yapay Zeka ve Rust';
      const atZero = computeKineticTitleWordStates(title, 0, 30);
      const atThumb = computeKineticTitleWordStates(title, THUMBNAIL_FRAME, 30);

      expect(atZero).toHaveLength(7);
      expect(atZero[0]?.delayFrames).toBe(0);
      expect(atZero[6]?.delayFrames).toBeGreaterThan(0);
      expect(atZero[6]?.opacity).toBe(0);

      // Every word is fully opaque and settled near rest position at THUMBNAIL_FRAME (15)
      for (const wordState of atThumb) {
        expect(wordState.opacity).toBe(1);
        expect(wordState.progress).toBeGreaterThan(0.85);
        expect(Math.abs(wordState.translateY)).toBeLessThan(4);
      }

      // Intro works cleanly when no stories or no page captures exist
      expect(computeIntroCardStackStates(undefined, THUMBNAIL_FRAME, 30)).toEqual([]);
      expect(
        computeIntroCardStackStates(
          [
            {
              index: 1,
              url: 'https://example.com/1',
              domain: 'example.com',
              source: 'hn',
              headline_tr: 'Haber 1',
              summary_tr: '',
              imageSrc: null,
              audioSrc: 'audio/1.mp3',
              audioDurationSeconds: 10,
              captions: [],
            },
          ],
          THUMBNAIL_FRAME,
          30
        )
      ).toEqual([]);

      // When page captures exist, they fly in as a deterministic card stack and are visible at THUMBNAIL_FRAME
      const storiesWithCaptures = [
        {
          index: 1,
          url: 'https://example.com/1',
          domain: 'example.com',
          source: 'hn',
          headline_tr: 'Haber 1',
          summary_tr: '',
          imageSrc: null,
          audioSrc: 'audio/1.mp3',
          audioDurationSeconds: 10,
          captions: [],
          page: {
            screenshot_path: 'pages/1.png',
            page_height: 2000,
            elements: [],
          },
        },
        {
          index: 2,
          url: 'https://lobste.rs/s/2',
          domain: 'lobste.rs',
          source: 'lobsters',
          headline_tr: 'Haber 2',
          summary_tr: '',
          imageSrc: null,
          audioSrc: 'audio/2.mp3',
          audioDurationSeconds: 12,
          captions: [],
          page: {
            screenshot_path: 'pages/2.png',
            page_height: 2200,
            elements: [],
          },
        },
      ];

      const stackAtZero = computeIntroCardStackStates(storiesWithCaptures, 0, 30);
      const stackAtThumb = computeIntroCardStackStates(
        storiesWithCaptures,
        THUMBNAIL_FRAME,
        30
      );
      expect(stackAtZero).toHaveLength(2);
      expect(stackAtThumb).toHaveLength(2);
      expect(stackAtThumb[0]?.opacity).toBe(1);
      expect(stackAtThumb[1]?.opacity).toBe(1);
      expect(stackAtThumb[0]?.translateX).toBeLessThan(stackAtZero[0]!.translateX);

      // Deterministic transition choice seeded by story transition index
      const t0A = resolveStoryTransitionSpec(0);
      const t0B = resolveStoryTransitionSpec(0);
      const t1 = resolveStoryTransitionSpec(1);
      const t2 = resolveStoryTransitionSpec(2);
      expect(t0A.kind).toBe('slide');
      expect(t0B.kind).toBe('slide');
      expect(t0A.direction).toBe(t0B.direction);
      expect(t1.kind).toBe('wipe');
      expect(t2.kind).toBe('slide');
      expect(t2.direction).toBe('from-bottom');

      // Story transition series duration matches timeline story span
      const timeline = buildVideoTimeline({
        week: '2026-W42',
        title_tr: title,
        siteUrl: 'news.emre.xyz',
        intro: { audioSrc: '', audioDurationSeconds: 4, captions: [] },
        stories: storiesWithCaptures,
        outro: { audioSrc: '', audioDurationSeconds: 4, captions: [] },
      });
      const storyDurations = timeline.scenes
        .filter((s) => s.kind === 'story')
        .map((s) => s.durationInFrames);
      const seriesDuration = calculateTransitionSeriesDuration(
        storyDurations,
        timeline.transitionDurationInFrames
      );
      const introFrames = timeline.scenes[0]!.durationInFrames;
      const outroFrames = timeline.scenes[timeline.scenes.length - 1]!.durationInFrames;
      expect(introFrames + seriesDuration + outroFrames).toBe(
        timeline.totalDurationInFrames
      );
    });
  });
});


