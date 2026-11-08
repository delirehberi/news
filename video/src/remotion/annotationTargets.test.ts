import { describe, expect, it } from 'vitest';
import {
  buildCameraTrack,
  defaultChoreography,
  type CueBoundingBox,
  type ResolvedCue,
} from '../domain/cues.ts';
import type { StorySceneItem } from '../domain/timeline.ts';
import { isDrawableBox } from './primitives/index.ts';
import {
  buildOgKeywordAnnotations,
  buildStoryWalkthroughPlan,
  dropOffscreenOverlayCues,
} from './WeeklyVideo.tsx';

const VIEWPORT = { viewportWidth: 1440, viewportHeight: 900, pageHeight: 6000 };
const SCENE_FRAMES = 300;

function makeCue(
  kind: ResolvedCue['kind'],
  box: CueBoundingBox | null,
  index: number,
  startFrame: number,
  endFrame: number
): ResolvedCue {
  return {
    kind,
    anchor: `anchor-${index}`,
    target: box ? `t${index}` : undefined,
    index,
    startFrame,
    endFrame,
    startSeconds: startFrame / 30,
    endSeconds: endFrame / 30,
    matched: true,
    box,
  };
}

function makeStory(overrides: Partial<StorySceneItem>): StorySceneItem {
  return {
    index: 1,
    url: 'https://example.com/post',
    domain: 'example.com',
    source: 'hn',
    headline_tr: 'Rust Derleyicisi Yüzde 40 Hızlandı',
    summary_tr: '',
    imageSrc: null,
    audioSrc: 'audio/1.mp3',
    audioDurationSeconds: 10,
    captions: [],
    ...overrides,
  };
}

describe('annotation targets', () => {
  it('isDrawableBox accepts only finite, positive-size boxes', () => {
    expect(isDrawableBox({ x: 0, y: 0, width: 10, height: 10 })).toBe(true);
    expect(isDrawableBox(null)).toBe(false);
    expect(isDrawableBox(undefined)).toBe(false);
    expect(isDrawableBox({ x: 0, y: 0, width: 0, height: 10 })).toBe(false);
    expect(isDrawableBox({ x: Number.NaN, y: 0, width: 10, height: 10 })).toBe(false);
  });

  it('keyword annotations target exactly the chip boxes and never use arrows', () => {
    const items = buildOgKeywordAnnotations(
      'Linux Çekirdeğinde Rust Sürücüleri ile %40 Daha Hızlı Performans',
      240,
      3,
      1280,
      96,
      { baseY: 16, align: 'left', startX: 8 }
    );
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.annotation.targetBox).toEqual(item.box);
      expect(['circle', 'underline']).toContain(item.annotation.kind);
      // Chips stay inside the fixed-size layer they are drawn in.
      expect(item.box.y).toBe(16);
      expect(item.box.x).toBeGreaterThanOrEqual(8);
      expect(item.box.x + item.box.width).toBeLessThanOrEqual(1280);
    }
  });

  it('drops overlay cues whose target is off screen or missing, and keeps camera-only cues', () => {
    const topCue = makeCue('scroll', { x: 0, y: 0, width: 1440, height: 900 }, 0, 0, SCENE_FRAMES);
    const track = buildCameraTrack([topCue], [topCue.box], {
      width: VIEWPORT.viewportWidth,
      height: VIEWPORT.viewportHeight,
      pageHeight: VIEWPORT.pageHeight,
      durationInFrames: SCENE_FRAMES,
    });

    const visibleCircle = makeCue('circle', { x: 200, y: 200, width: 300, height: 80 }, 1, 30, 120);
    const offscreenCircle = makeCue('circle', { x: 200, y: 5200, width: 300, height: 80 }, 2, 30, 120);
    const missingHighlight = makeCue('highlight', null, 3, 30, 120);
    const statCue = makeCue('stat', null, 4, 30, 120);

    const result = dropOffscreenOverlayCues(
      [topCue, visibleCircle, offscreenCircle, missingHighlight, statCue],
      track,
      VIEWPORT
    );

    expect(result[0]?.box).toEqual(topCue.box);
    expect(result[1]?.box).toEqual(visibleCircle.box);
    expect(result[2]?.box).toBeNull();
    expect(result[3]?.box).toBeNull();
    expect(result[4]).toEqual(statCue);
  });

  it('does not place a cue on the page by fuzzy-matching its anchor when it has no target', () => {
    const plan = buildStoryWalkthroughPlan(
      makeStory({
        page: {
          index: 1,
          url: 'https://example.com/post',
          url_hash: 'abcdef0123456789',
          captured_at: '2026-11-07T00:00:00.000Z',
          screenshot_path: 'pages/1.png',
          viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
          page_height: 3000,
          excerpt: 'Rust compiler is 40 percent faster',
          elements: [
            {
              id: 'p1',
              kind: 'paragraph',
              tagName: 'p',
              text: 'Rust compiler is 40 percent faster',
              box: { x: 100, y: 300, width: 900, height: 60 },
            },
          ],
        },
        cues: [
          { kind: 'circle', anchor: 'Rust compiler' },
          { kind: 'underline', anchor: 'yüzde 40', target: 'p1' },
        ],
      }),
      SCENE_FRAMES,
      30
    );

    expect(plan.cues[0]?.box).toBeNull();
    expect(plan.cues[1]?.box).toEqual({ x: 100, y: 300, width: 900, height: 60 });
  });

  it('default choreography never spotlights or highlights a synthesized region', () => {
    const fromEmpty = defaultChoreography([], 12);
    const overlayKinds = fromEmpty.cues
      .map((c) => c.kind)
      .filter((k) => k === 'focus' || k === 'highlight');
    expect(overlayKinds).toEqual([]);
    expect(fromEmpty.cues).toHaveLength(5);
  });
});
