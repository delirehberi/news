import { describe, expect, it } from 'vitest';
import type { WordTiming } from './captions.ts';
import {
  buildCameraTrack,
  defaultChoreography,
  DEFAULT_MIN_BACKWARD_JUMP_FRAMES,
  DEFAULT_MIN_DWELL_FRAMES,
  easeCameraProgress,
  normalizeCueText,
  resolveCueTarget,
  resolveCueTimes,
  sampleCameraTrack,
  tokenizeCueText,
  VisualCueSchema,
  type CueBoundingBox,
  type CuePageElement,
  type VisualCue,
} from './cues.ts';

const SAMPLE_ELEMENTS: CuePageElement[] = [
  {
    id: 'h1',
    kind: 'h1',
    tagName: 'h1',
    text: 'İnternet Çağında Yapay Zeka ve Açık Kaynak Modellerin Yükselişi',
    box: { x: 140, y: 120, width: 1160, height: 110 },
  },
  {
    id: 'p1',
    kind: 'paragraph',
    tagName: 'p',
    text: 'Yeni nesil dil modelleri artık kendi sunucularımızda yüzde 40 daha hızlı çalışıyor ve bellek tüketimini yarıya indiriyor.',
    box: { x: 140, y: 280, width: 1080, height: 140 },
  },
  {
    id: 'p2',
    kind: 'paragraph',
    tagName: 'p',
    text: 'Işık hızında çıkarım yapan bu mimari, özellikle kenar cihazlarda ve dizüstü bilgisayarlarda büyük fark yaratıyor.',
    box: { x: 140, y: 460, width: 1080, height: 130 },
  },
  {
    id: 'fig1',
    kind: 'figure',
    tagName: 'figure',
    text: 'Şekil 1: Bellek ve Gecikme Karşılaştırma Grafiği (2026)',
    box: { x: 180, y: 650, width: 1000, height: 420 },
  },
  {
    id: 'quote1',
    kind: 'blockquote',
    tagName: 'blockquote',
    text: 'Açık ağırlıklı modeller ekosistemin geleceğini belirleyecek.',
    box: { x: 160, y: 1140, width: 960, height: 150 },
  },
  {
    id: 'code1',
    kind: 'code',
    tagName: 'pre',
    text: 'cargo run --release -- --quant q4_k_m',
    box: { x: 140, y: 1360, width: 1080, height: 220 },
  },
];

const SAMPLE_WORD_TIMINGS: WordTiming[] = [
  { word: 'Bu', start: 0.0, end: 0.25 },
  { word: 'hafta', start: 0.28, end: 0.65 },
  { word: 'İnternet', start: 0.7, end: 1.2 },
  { word: 'çağında,', start: 1.25, end: 1.8 },
  { word: 'açık', start: 1.9, end: 2.2 },
  { word: 'kaynak', start: 2.25, end: 2.7 },
  { word: 'modeller', start: 2.75, end: 3.3 },
  { word: 'yüzde', start: 3.5, end: 3.9 },
  { word: '40!', start: 3.95, end: 4.35 },
  { word: 'daha', start: 4.4, end: 4.7 },
  { word: 'hızlı', start: 4.75, end: 5.2 },
  { word: 've', start: 5.3, end: 5.45 },
  { word: 'ışık', start: 5.5, end: 5.9 },
  { word: 'hızında', start: 5.95, end: 6.45 },
  { word: 'çalışıyor.', start: 6.5, end: 7.2 },
];

describe('src/domain/cues.ts', () => {
  describe('VisualCueSchema', () => {
    it('validates all 9 supported visual cue kinds and optional target/value fields', () => {
      const kinds = [
        'scroll',
        'focus',
        'highlight',
        'circle',
        'underline',
        'arrow',
        'stat',
        'quote',
        'image',
      ] as const;

      for (const kind of kinds) {
        const parsed = VisualCueSchema.parse({
          kind,
          anchor: '  yüzde 40 daha hızlı  ',
          target: '  p1  ',
          value: '  +40%  ',
        });
        expect(parsed).toEqual({
          kind,
          anchor: 'yüzde 40 daha hızlı',
          target: 'p1',
          value: '+40%',
        });
      }

      const minimal = VisualCueSchema.parse({
        kind: 'stat',
        anchor: 'yüzde 40',
      });
      expect(minimal).toEqual({
        kind: 'stat',
        anchor: 'yüzde 40',
      });
    });

    it('rejects unknown cue kinds or empty anchor phrases', () => {
      expect(() =>
        VisualCueSchema.parse({
          kind: 'explode',
          anchor: 'yüzde 40',
        })
      ).toThrow();

      expect(() =>
        VisualCueSchema.parse({
          kind: 'focus',
          anchor: '   ',
        })
      ).toThrow(/anchor/i);
    });
  });

  describe('normalizeCueText & tokenizeCueText', () => {
    it('folds Turkish İ/ı/I and diacritics (ğ, ü, ş, ö, ç) case- and punctuation-insensitively', () => {
      expect(normalizeCueText('İSTANBUL ve Iğdır’da — "%40" artış!')).toBe(
        'istanbul ve igdir da 40 artis'
      );
      expect(normalizeCueText('istanbul ve ıgdır da 40 artıs')).toBe(
        'istanbul ve igdir da 40 artis'
      );
      expect(tokenizeCueText('  Çağdaş, Şüpheli & Öbür!  ')).toEqual([
        'cagdas',
        'supheli',
        'obur',
      ]);
      expect(normalizeCueText('')).toBe('');
      expect(tokenizeCueText('... ! ?')).toEqual([]);
    });
  });

  describe('resolveCueTimes', () => {
    it('resolves spoken phrases to exact start frames with Turkish İ/ı, diacritics, and punctuation normalization', () => {
      const cues: VisualCue[] = [
        {
          kind: 'focus',
          anchor: 'internet caginda', // matches "İnternet" (0.7s) + "çağında," (1.25s)
          target: 'h1',
        },
        {
          kind: 'circle',
          anchor: '"YÜZDE 40" daha HIZLI!', // matches "yüzde" (3.5s) .. "hızlı" (5.2s)
          target: 'p1',
          value: '40%',
        },
        {
          kind: 'underline',
          anchor: 'ISIK HIZINDA', // matches "ışık" (5.5s) + "hızında" (6.45s) with Turkish I/ı folding
          target: 'p2',
        },
      ];

      const resolved = resolveCueTimes(cues, SAMPLE_WORD_TIMINGS, 30);

      expect(resolved).toHaveLength(3);

      // "İnternet" starts at 0.7s -> frame 21
      expect(resolved[0].matched).toBe(true);
      expect(resolved[0].startFrame).toBe(21);
      expect(resolved[0].startSeconds).toBeCloseTo(0.7, 3);

      // "yüzde" starts at 3.5s -> frame 105
      expect(resolved[1].matched).toBe(true);
      expect(resolved[1].startFrame).toBe(105);
      expect(resolved[1].startSeconds).toBeCloseTo(3.5, 3);

      // "ışık" starts at 5.5s -> frame 165
      expect(resolved[2].matched).toBe(true);
      expect(resolved[2].startFrame).toBe(165);
      expect(resolved[2].startSeconds).toBeCloseTo(5.5, 3);

      // Each cue's endFrame reaches at least the next cue's startFrame (or scene end)
      expect(resolved[0].endFrame).toBeGreaterThanOrEqual(resolved[1].startFrame);
      expect(resolved[1].endFrame).toBeGreaterThanOrEqual(resolved[2].startFrame);
      expect(resolved[2].endFrame).toBe(Math.ceil(7.2 * 30));
    });

    it('matches inflected Turkish words via stem/prefix tolerance', () => {
      const cues: VisualCue[] = [
        {
          kind: 'highlight',
          anchor: 'açık kaynak model', // spoken text has "açık kaynak modeller"
          target: 'h1',
        },
      ];

      const resolved = resolveCueTimes(cues, SAMPLE_WORD_TIMINGS, 30);
      expect(resolved[0].matched).toBe(true);
      // "açık" starts at 1.9s -> 1.9 * 30 = 57
      expect(resolved[0].startFrame).toBe(57);
    });

    it('falls back to even spacing across the scene when anchors are unresolved or wordTimings are empty', () => {
      const cues: VisualCue[] = [
        { kind: 'focus', anchor: 'bulunmayan birinci ifade', target: 'h1' },
        { kind: 'highlight', anchor: 'bulunmayan ikinci ifade', target: 'p1' },
        { kind: 'circle', anchor: 'bulunmayan üçüncü ifade', target: 'fig1' },
      ];

      // Scene duration from SAMPLE_WORD_TIMINGS max end (7.2s * 30 = 216 frames)
      const resolved = resolveCueTimes(cues, SAMPLE_WORD_TIMINGS, 30);

      expect(resolved.every((c) => !c.matched)).toBe(true);
      // Even spacing across 216 frames at 1/4, 2/4, 3/4 -> 54, 108, 162
      expect(resolved.map((c) => c.startFrame)).toEqual([54, 108, 162]);

      // Also works when wordTimings is empty with explicit durationInFrames
      const emptyTimingsResolved = resolveCueTimes(cues, [], 30, {
        durationInFrames: 300,
      });
      expect(emptyTimingsResolved.map((c) => c.startFrame)).toEqual([75, 150, 225]);
    });

    it('returns an empty array for empty cues and throws on invalid fps', () => {
      expect(resolveCueTimes([], SAMPLE_WORD_TIMINGS, 30)).toEqual([]);
      expect(() => resolveCueTimes([], SAMPLE_WORD_TIMINGS, 0)).toThrow(/Invalid fps/);
      expect(() => resolveCueTimes([], SAMPLE_WORD_TIMINGS, -30)).toThrow(/Invalid fps/);
    });
  });

  describe('resolveCueTarget', () => {
    it('resolves exact element IDs case-insensitively (with or without leading #)', () => {
      expect(resolveCueTarget('h1', SAMPLE_ELEMENTS)).toEqual(SAMPLE_ELEMENTS[0].box);
      expect(resolveCueTarget('#FIG1', SAMPLE_ELEMENTS)).toEqual(SAMPLE_ELEMENTS[3].box);
      expect(resolveCueTarget('  quote1 ', { elements: SAMPLE_ELEMENTS })).toEqual(
        SAMPLE_ELEMENTS[4].box
      );
    });

    it('falls back to fuzzy text match against captured element text when target is a text snippet', () => {
      // Exact Turkish substring with diacritic/case differences
      const p1Box = resolveCueTarget('YÜZDE 40 DAHA HIZLI ÇALIŞIYOR', SAMPLE_ELEMENTS);
      expect(p1Box).toEqual(SAMPLE_ELEMENTS[1].box);

      // Turkish İ/ı/I insensitive fuzzy match ("ISIK HIZINDA CIKARIM" -> p2)
      const p2Box = resolveCueTarget('ISIK HIZINDA CIKARIM YAPAN', SAMPLE_ELEMENTS);
      expect(p2Box).toEqual(SAMPLE_ELEMENTS[2].box);

      // Token overlap match where words are non-adjacent in the element text
      const figBox = resolveCueTarget('Bellek Karşılaştırma Grafiği 2026', SAMPLE_ELEMENTS);
      expect(figBox).toEqual(SAMPLE_ELEMENTS[3].box);
    });

    it('returns null when target is missing, empty, or does not match any element (degrading to non-page visual)', () => {
      expect(resolveCueTarget(undefined, SAMPLE_ELEMENTS)).toBeNull();
      expect(resolveCueTarget('', SAMPLE_ELEMENTS)).toBeNull();
      expect(resolveCueTarget('   ', SAMPLE_ELEMENTS)).toBeNull();
      expect(resolveCueTarget('tamamen alakasiz kuantum kriptografi metni', SAMPLE_ELEMENTS)).toBeNull();
      expect(resolveCueTarget('h1', [])).toBeNull();
      expect(resolveCueTarget('h1', null)).toBeNull();
    });
  });

  describe('buildCameraTrack & sampleCameraTrack', () => {
    it('builds ordered keyframes with minimum dwell time, clamping to page bounds, and eased interpolation', () => {
      const cues = [
        {
          kind: 'focus' as const,
          anchor: 'başlık',
          target: 'h1',
          index: 0,
          startFrame: 0,
          endFrame: 20,
          startSeconds: 0,
          endSeconds: 20 / 30,
          matched: true,
        },
        {
          // Starts only 15 frames after cue 0 -> must be pushed out to satisfy minDwellFrames (45)
          kind: 'highlight' as const,
          anchor: 'yüzde 40',
          target: 'p1',
          index: 1,
          startFrame: 15,
          endFrame: 90,
          startSeconds: 0.5,
          endSeconds: 3,
          matched: true,
        },
        {
          // Near bottom of page -> scroll Y must clamp to pageHeight - viewport.height
          kind: 'focus' as const,
          anchor: 'kod',
          target: 'code1',
          index: 2,
          startFrame: 120,
          endFrame: 180,
          startSeconds: 4,
          endSeconds: 6,
          matched: true,
        },
      ];

      const boxes: Array<CueBoundingBox | null> = [
        SAMPLE_ELEMENTS[0].box, // y: 120, h: 110 -> center 175 -> y = 0
        SAMPLE_ELEMENTS[1].box, // y: 280, h: 140 -> center 350 -> y = 0
        { x: 140, y: 1850, width: 1000, height: 300 }, // exceeds pageHeight 2000 -> clamped
      ];

      const track = buildCameraTrack(cues, boxes, {
        width: 1440,
        height: 900,
        pageHeight: 2000,
        minDwellFrames: 45,
        minBackwardJumpFrames: 60,
        transitionFrames: 24,
      });

      expect(track.keyframes).toHaveLength(3);
      // Ordered frames with minimum dwell of 45 frames enforced on keyframe 1
      expect(track.keyframes[0].frame).toBe(0);
      expect(track.keyframes[1].frame).toBe(45);
      expect(track.keyframes[2].frame).toBe(120);

      // Clamped to maxScrollY = 2000 - 900 = 1100
      expect(track.keyframes[2].y).toBe(1100);
      expect(track.keyframes[2].focusRect).not.toBeNull();
      expect(
        track.keyframes[2].focusRect!.y + track.keyframes[2].focusRect!.height
      ).toBeLessThanOrEqual(2000);

      // Sample during dwell hold (before transition window starts at 120 - 24 = 96)
      const duringDwell = track.atFrame(70);
      expect(duringDwell.y).toBe(track.keyframes[1].y);

      // Sample mid-transition (frame 108 is halfway through [96, 120])
      const midTransition = track.atFrame(108);
      expect(midTransition.y).toBeGreaterThan(track.keyframes[1].y);
      expect(midTransition.y).toBeLessThan(track.keyframes[2].y);
      expect(midTransition.y).toBeCloseTo(550, 0);

      // Sample at/after final keyframe
      const atEnd = track.atFrame(150);
      expect(atEnd.y).toBe(1100);
    });

    it('suppresses backward scroll jumps shorter than minBackwardJumpFrames (avoids jitter) while allowing later backward scrolls', () => {
      const cues = [
        {
          kind: 'focus' as const,
          anchor: 'grafik',
          target: 'fig1',
          index: 0,
          startFrame: 0,
          endFrame: 45,
          startSeconds: 0,
          endSeconds: 1.5,
          matched: true,
        },
        {
          // 45 frames later (< minBackwardJumpFrames=75): tries to jump backward to top (y=120)
          kind: 'focus' as const,
          anchor: 'başlık',
          target: 'h1',
          index: 1,
          startFrame: 45,
          endFrame: 90,
          startSeconds: 1.5,
          endSeconds: 3.0,
          matched: true,
        },
        {
          // 90 frames after keyframe 1 (>= minBackwardJumpFrames=75): allowed to scroll back up
          kind: 'focus' as const,
          anchor: 'paragraf',
          target: 'p1',
          index: 2,
          startFrame: 135,
          endFrame: 180,
          startSeconds: 4.5,
          endSeconds: 6.0,
          matched: true,
        },
      ];

      const boxes: Array<CueBoundingBox | null> = [
        { x: 100, y: 1200, width: 800, height: 300 }, // center 1350 -> desiredY = 900
        { x: 100, y: 100, width: 800, height: 100 }, // center 150 -> desiredY = 0 (backward!)
        { x: 100, y: 100, width: 800, height: 100 }, // center 150 -> desiredY = 0 (backward after 90 frames)
      ];

      const track = buildCameraTrack(cues, boxes, {
        width: 1440,
        height: 900,
        pageHeight: 2400,
        minDwellFrames: DEFAULT_MIN_DWELL_FRAMES, // 45
        minBackwardJumpFrames: 75,
      });

      expect(track.keyframes).toHaveLength(3);
      expect(track.keyframes[0].y).toBe(900);
      // Keyframe 1 is at delta=45 (< 75), so backward jump to 0 is suppressed -> stays at 900
      expect(track.keyframes[1].y).toBe(900);
      // Keyframe 2 is at frame 135 (delta=90 >= 75 from keyframe 1 at 45), so backward jump to 0 is permitted
      expect(track.keyframes[2].y).toBe(0);
    });

    it('handles non-page cues (null box) and empty cue arrays gracefully', () => {
      const emptyTrack = buildCameraTrack([], [], { width: 1440, height: 900, pageHeight: 1800 });
      expect(emptyTrack.keyframes).toHaveLength(1);
      expect(emptyTrack.keyframes[0]).toEqual({
        frame: 0,
        y: 0,
        scale: 1,
        focusRect: null,
      });
      expect(sampleCameraTrack([], 20)).toEqual({ y: 0, scale: 1, focusRect: null });

      expect(easeCameraProgress(-1)).toBe(0);
      expect(easeCameraProgress(0)).toBe(0);
      expect(easeCameraProgress(0.5)).toBeCloseTo(0.5, 5);
      expect(easeCameraProgress(1)).toBe(1);
      expect(easeCameraProgress(2)).toBe(1);
    });
  });

  describe('defaultChoreography', () => {
    it('generates the 5-stage heuristic sequence (top -> h1 focus -> lede highlight -> first figure -> slow scroll)', () => {
      const choreography = defaultChoreography(
        {
          page_height: 2400,
          elements: SAMPLE_ELEMENTS,
        },
        300 // 10s at 30fps
      );

      expect(choreography.cues).toHaveLength(5);
      expect(choreography.cues.map((c) => c.kind)).toEqual([
        'scroll', // top
        'focus', // h1 focus
        'highlight', // lede highlight
        'focus', // first figure
        'scroll', // slow scroll
      ]);
      expect(choreography.cues[0].target).toBe('top');
      expect(choreography.cues[1].target).toBe('h1');
      expect(choreography.cues[2].target).toBe('p1');
      expect(choreography.cues[3].target).toBe('fig1');
      expect(choreography.cues[4].target).toBe('scroll');

      expect(choreography.keyframes).toHaveLength(5);
      // Starts at top of page (frame 0, y=0, scale=1, focusRect=null)
      expect(choreography.keyframes[0]).toMatchObject({
        frame: 0,
        y: 0,
        scale: 1,
        focusRect: null,
      });

      // Keyframes progress monotonically in time and never jump backward in y
      for (let i = 1; i < choreography.keyframes.length; i++) {
        expect(choreography.keyframes[i].frame).toBeGreaterThan(
          choreography.keyframes[i - 1].frame
        );
        expect(choreography.keyframes[i].y).toBeGreaterThanOrEqual(
          choreography.keyframes[i - 1].y
        );
      }

      // Final slow scroll reaches deeper down the page than the initial top frame
      expect(
        choreography.keyframes[choreography.keyframes.length - 1].y
      ).toBeGreaterThan(0);
    });

    it('synthesizes fallback boxes when elementMap is empty or missing figures/paragraphs and accepts duration in seconds', () => {
      const fromEmpty = defaultChoreography([], 12); // 12 seconds -> 360 frames
      expect(fromEmpty.cues).toHaveLength(5);
      expect(fromEmpty.keyframes).toHaveLength(5);
      expect(fromEmpty.durationInFrames).toBeGreaterThanOrEqual(360);

      const poseStart = fromEmpty.atFrame(0);
      const poseEnd = fromEmpty.atFrame(350);
      expect(poseStart.y).toBe(0);
      expect(poseEnd.y).toBeGreaterThan(poseStart.y);
      expect(DEFAULT_MIN_BACKWARD_JUMP_FRAMES).toBeGreaterThan(0);
    });
  });
});
