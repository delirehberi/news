import React from 'react';
import { describe, expect, it } from 'vitest';
import {
  buildCameraTrack,
  defaultChoreography,
  resolveCueTarget,
  resolveCueTimes,
  type CueBoundingBox,
  type CuePageElement,
  type VisualCue,
} from '../../domain/cues.ts';
import {
  buildHandDrawnArrowPaths,
  buildHandDrawnCirclePath,
  buildHandDrawnUnderlinePath,
  calculateTransitionSeriesDuration,
  computeAnnotationPaths,
  computeHighlighterStrokes,
  computePageCameraTransform,
  computeQuoteCalloutState,
  computeSpotlightCutout,
  computeStatCalloutState,
  computeTypedUrlState,
  createSeededRandom,
  formatBrowserDisplayUrl,
  parseStatSpec,
  resolveStoryTransitionSpec,
  seededJitter,
  seededRange,
} from './index.ts';

const SAMPLE_ELEMENTS: CuePageElement[] = [
  {
    id: 'h1',
    kind: 'h1',
    tagName: 'h1',
    text: 'Rust Derleyicisi Yüzde 40 Daha Hızlı Çalışıyor',
    box: { x: 120, y: 140, width: 960, height: 96 },
  },
  {
    id: 'p1',
    kind: 'paragraph',
    tagName: 'p',
    text: 'Yeni paralel ön uç mimarisi büyük kod tabanlarında derleme sürelerini ciddi ölçüde düşürüyor.',
    box: { x: 120, y: 270, width: 880, height: 112 },
  },
  {
    id: 'fig1',
    kind: 'figure',
    tagName: 'figure',
    text: 'Benchmark karşılaştırma grafiği',
    box: { x: 140, y: 460, width: 920, height: 360 },
  },
];

describe('seeded deterministic PRNG & jitter', () => {
  it('produces identical sequences for identical seeds and distinct values for different seeds', () => {
    const rngA1 = createSeededRandom(3, 1);
    const rngA2 = createSeededRandom(3, 1);
    const rngB = createSeededRandom(4, 1);

    const seqA1 = [rngA1(), rngA1(), rngA1(), rngA1()];
    const seqA2 = [rngA2(), rngA2(), rngA2(), rngA2()];
    const seqB = [rngB(), rngB(), rngB(), rngB()];

    expect(seqA1).toEqual(seqA2);
    expect(seqA1).not.toEqual(seqB);

    for (const val of seqA1) {
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }

    expect(seededJitter('story-1', 2, 5)).toBe(seededJitter('story-1', 2, 5));
    expect(Math.abs(seededJitter('story-1', 2, 5))).toBeLessThanOrEqual(5);
    expect(seededRange('story-1', 2, 10, 20)).toBeGreaterThanOrEqual(10);
    expect(seededRange('story-1', 2, 10, 20)).toBeLessThanOrEqual(20);
  });
});

describe('BrowserFrame URL formatting & typewriter state', () => {
  it('strips protocol and www prefix while keeping clean path', () => {
    expect(formatBrowserDisplayUrl('https://www.rust-lang.org/blog/2026/compiler/')).toBe(
      'rust-lang.org/blog/2026/compiler'
    );
    expect(formatBrowserDisplayUrl('https://news.emre.xyz/')).toBe('news.emre.xyz');
    expect(formatBrowserDisplayUrl('')).toBe('news.emre.xyz');
  });

  it('reveals URL characters deterministically across frames', () => {
    const before = computeTypedUrlState('https://blog.rust-lang.org/fast', 0, {
      startFrame: 4,
      durationInFrames: 20,
    });
    expect(before.visibleText).toBe('');
    expect(before.progress).toBe(0);

    const mid = computeTypedUrlState('https://blog.rust-lang.org/fast', 14, {
      startFrame: 4,
      durationInFrames: 20,
    });
    expect(mid.progress).toBeCloseTo(0.5, 3);
    expect(mid.visibleText.length).toBeGreaterThan(0);
    expect(mid.visibleText.length).toBeLessThan(mid.fullText.length);
    expect(mid.isTyping).toBe(true);
    expect(mid.showCursor).toBe(true);

    const done = computeTypedUrlState('https://blog.rust-lang.org/fast', 50, {
      startFrame: 4,
      durationInFrames: 20,
    });
    expect(done.visibleText).toBe('blog.rust-lang.org/fast');
    expect(done.progress).toBe(1);
    expect(done.isTyping).toBe(false);
    expect(done.showCursor).toBe(false);
  });
});

describe('PageCamera transform from CameraTrack', () => {
  it('translates and scales smoothly from a CameraTrack and clamps within page bounds', () => {
    const cues: VisualCue[] = [
      { kind: 'focus', anchor: 'Rust Derleyicisi', target: 'h1' },
      { kind: 'highlight', anchor: 'paralel ön uç', target: 'p1' },
      { kind: 'focus', anchor: 'Benchmark', target: 'fig1' },
    ];
    const resolved = resolveCueTimes(
      cues,
      [
        { word: 'Rust', start: 0.4, end: 0.7 },
        { word: 'Derleyicisi', start: 0.7, end: 1.2 },
        { word: 'paralel', start: 2.2, end: 2.5 },
        { word: 'ön', start: 2.5, end: 2.7 },
        { word: 'uç', start: 2.7, end: 3.0 },
        { word: 'Benchmark', start: 4.5, end: 5.0 },
      ],
      30,
      { durationInFrames: 210 }
    ).map((rc) => ({
      ...rc,
      box: resolveCueTarget(rc.target, SAMPLE_ELEMENTS) ?? null,
    }));

    const track = buildCameraTrack(resolved, SAMPLE_ELEMENTS, {
      width: 1440,
      height: 900,
      pageHeight: 2400,
      durationInFrames: 210,
    });

    const t0 = computePageCameraTransform(track, 0);
    const tMid = computePageCameraTransform(track, 75);
    const tLate = computePageCameraTransform(track, 150);

    expect(t0.scale).toBeGreaterThanOrEqual(1);
    expect(tMid.scale).toBeGreaterThan(1);
    expect(tLate.translateY).toBeLessThanOrEqual(0);
    expect(tLate.cssTransform).toContain('translate3d(');
    expect(tLate.cssTransform).toContain('scale(');

    // Heuristic choreography integration check
    const choreo = defaultChoreography(SAMPLE_ELEMENTS, 180, {
      pageHeight: 2400,
    });
    const choreoTransform = computePageCameraTransform(choreo, 90);
    expect(choreoTransform.scale).toBeGreaterThanOrEqual(1);
  });
});

describe('Spotlight cutout geometry', () => {
  it('builds an even-odd rounded SVG cutout path and fades cleanly outside active window', () => {
    const box: CueBoundingBox = { x: 120, y: 200, width: 600, height: 90 };

    const inactive = computeSpotlightCutout(box, 2, {
      startFrame: 10,
      endFrame: 60,
    });
    expect(inactive.visible).toBe(false);

    const active = computeSpotlightCutout(box, 25, {
      startFrame: 10,
      endFrame: 60,
      padding: 16,
      canvasWidth: 1440,
      canvasHeight: 2000,
    });
    expect(active.visible).toBe(true);
    expect(active.opacity).toBeGreaterThan(0.3);
    expect(active.rect).not.toBeNull();
    expect(active.svgPath).toContain('M 0 0 H 1440 V 2000 H 0 Z');
    expect(active.svgPath).toContain('A 16 16');

    const afterEnd = computeSpotlightCutout(box, 80, {
      startFrame: 10,
      endFrame: 60,
    });
    expect(afterEnd.visible).toBe(false);
  });
});

describe('Highlighter multi-line marker sweep', () => {
  it('sweeps line strips left-to-right sequentially with deterministic seeded rotation', () => {
    const paragraphBox: CueBoundingBox = { x: 120, y: 270, width: 840, height: 110 };

    const early = computeHighlighterStrokes(paragraphBox, 12, {
      startFrame: 10,
      sweepDurationInFrames: 24,
      storyIndex: 2,
      cueIndex: 1,
    });
    expect(early.length).toBe(3);
    expect(early[0].currentWidth).toBeGreaterThan(0);
    expect(early[2].currentWidth).toBe(0);

    const fullA = computeHighlighterStrokes(paragraphBox, 40, {
      startFrame: 10,
      sweepDurationInFrames: 24,
      storyIndex: 2,
      cueIndex: 1,
    });
    const fullB = computeHighlighterStrokes(paragraphBox, 40, {
      startFrame: 10,
      sweepDurationInFrames: 24,
      storyIndex: 2,
      cueIndex: 1,
    });

    expect(fullA).toEqual(fullB);
    for (const strip of fullA) {
      expect(strip.progress).toBe(1);
      expect(strip.currentWidth).toBeCloseTo(strip.maxWidth, 2);
      expect(Math.abs(strip.rotationDeg)).toBeLessThanOrEqual(0.85);
    }
  });
});

describe('Annotations hand-drawn SVG paths (@remotion/paths evolvePath)', () => {
  const targetBox: CueBoundingBox = { x: 200, y: 300, width: 320, height: 64 };

  it('generates deterministic circle, underline, and arrow paths with evolvePath stroke-dashoffset', () => {
    const circleD1 = buildHandDrawnCirclePath(targetBox, 'story-1');
    const circleD2 = buildHandDrawnCirclePath(targetBox, 'story-1');
    const circleOther = buildHandDrawnCirclePath(targetBox, 'story-2');
    expect(circleD1).toBe(circleD2);
    expect(circleD1).not.toBe(circleOther);

    const underlineD = buildHandDrawnUnderlinePath(targetBox, 'story-1');
    expect(underlineD.startsWith('M ')).toBe(true);
    expect(underlineD).toContain(' C ');

    const [shaftD, headD] = buildHandDrawnArrowPaths(targetBox, 'story-1', 1440);
    expect(shaftD.startsWith('M ')).toBe(true);
    expect(headD.startsWith('M ')).toBe(true);

    const startState = computeAnnotationPaths('circle', targetBox, 10, {
      startFrame: 10,
      drawDurationInFrames: 20,
      storyIndex: 1,
    });
    expect(startState.progress).toBe(0);
    expect(startState.evolved).toHaveLength(1);
    expect(startState.evolved[0].strokeDashoffset).toBeGreaterThan(0);

    const midState = computeAnnotationPaths('circle', targetBox, 20, {
      startFrame: 10,
      drawDurationInFrames: 20,
      storyIndex: 1,
    });
    expect(midState.progress).toBeGreaterThan(0.4);
    expect(midState.progress).toBeLessThan(1);
    expect(midState.evolved[0].strokeDashoffset).toBeLessThan(
      startState.evolved[0].strokeDashoffset
    );

    const endState = computeAnnotationPaths('arrow', targetBox, 35, {
      startFrame: 10,
      drawDurationInFrames: 20,
      storyIndex: 1,
    });
    expect(endState.progress).toBe(1);
    expect(endState.evolved).toHaveLength(2);
    expect(endState.evolved[0].strokeDashoffset).toBeCloseTo(0, 2);
    expect(endState.evolved[1].strokeDashoffset).toBeCloseTo(0, 2);
  });
});

describe('StatCallout & QuoteCallout states', () => {
  it('parses Turkish & metric stat strings and counts up deterministically', () => {
    const parsedTr = parseStatSpec('%40 daha hızlı');
    expect(parsedTr.prefix).toBe('%');
    expect(parsedTr.targetNumber).toBe(40);
    expect(parsedTr.label).toBe('daha hızlı');

    const parsedDecimal = parseStatSpec('3,5x throughput artışı');
    expect(parsedDecimal.targetNumber).toBeCloseTo(3.5, 3);
    expect(parsedDecimal.decimals).toBe(1);
    expect(parsedDecimal.decimalSeparator).toBe(',');
    expect(parsedDecimal.suffix).toBe('x');
    expect(parsedDecimal.label).toBe('throughput artışı');

    const midStat = computeStatCalloutState('%40 daha hızlı', 22, {
      startFrame: 10,
      countDurationInFrames: 24,
      fps: 30,
    });
    expect(midStat.visible).toBe(true);
    expect(midStat.currentNumber).toBeGreaterThan(15);
    expect(midStat.currentNumber).toBeLessThan(40);

    const endStat = computeStatCalloutState('%40 daha hızlı', 40, {
      startFrame: 10,
      countDurationInFrames: 24,
      fps: 30,
    });
    expect(endStat.displayValue).toBe('%40');
    expect(endStat.label).toBe('daha hızlı');
    expect(endStat.progress).toBe(1);
  });

  it('reveals pull-quote text via typewriter progression', () => {
    const quoteText = 'Bellek güvenliğinden ödün vermeden sıfır maliyetli soyutlama.';
    const early = computeQuoteCalloutState(quoteText, 12, {
      startFrame: 5,
      typeDurationInFrames: 30,
      fps: 30,
    });
    expect(early.visible).toBe(true);
    expect(early.visibleQuote.length).toBeGreaterThan(0);
    expect(early.visibleQuote.length).toBeLessThan(quoteText.length);
    expect(early.showCursor).toBe(true);

    const complete = computeQuoteCalloutState(quoteText, 45, {
      startFrame: 5,
      typeDurationInFrames: 30,
      fps: 30,
    });
    expect(complete.visibleQuote).toBe(quoteText);
    expect(complete.progress).toBe(1);
    expect(complete.showCursor).toBe(false);
  });
});

describe('SceneTransitions (@remotion/transitions slide/wipe)', () => {
  it('selects deterministic slide/wipe transitions and computes overlap duration accurately', () => {
    const first = resolveStoryTransitionSpec(0, { durationInFrames: 15 });
    const second = resolveStoryTransitionSpec(1, { durationInFrames: 15 });

    expect(first.kind).toBe('slide');
    expect(second.kind).toBe('wipe');
    expect(first.timing.getDurationInFrames({ fps: 30 })).toBe(15);
    expect(typeof first.presentation.component).toBe('function');

    // 3 scenes of [120, 180, 150] frames with 15-frame transitions between them -> 450 - 2*15 = 420
    expect(calculateTransitionSeriesDuration([120, 180, 150], 15)).toBe(420);
    expect(calculateTransitionSeriesDuration([120], 15)).toBe(120);

    const element = React.createElement('div', null, 'transition-ready');
    expect(element.type).toBe('div');
  });
});
