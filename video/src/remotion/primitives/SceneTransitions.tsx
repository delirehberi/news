import {
  linearTiming,
  springTiming,
  TransitionSeries,
  type TransitionPresentation,
  type TransitionTiming,
} from '@remotion/transitions';
import { slide } from '@remotion/transitions/slide';
import { wipe } from '@remotion/transitions/wipe';
import React from 'react';

export const DEFAULT_STORY_TRANSITION_FRAMES = 15; // 0.5s at 30fps

export type StoryTransitionKind = 'slide' | 'wipe';
export type StoryTransitionDirection =
  | 'from-right'
  | 'from-left'
  | 'from-bottom'
  | 'from-top';

export interface StoryTransitionSpec {
  kind: StoryTransitionKind;
  direction: StoryTransitionDirection;
  durationInFrames: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  presentation: TransitionPresentation<any>;
  timing: TransitionTiming;
}

const DIRECTIONS: readonly StoryTransitionDirection[] = [
  'from-right',
  'from-left',
  'from-bottom',
  'from-top',
];

/**
 * Deterministic selection of a `slide` or `wipe` transition between stories
 * seeded by `transitionIndex` (no `Math.random`).
 */
export function resolveStoryTransitionSpec(
  transitionIndex: number,
  options?: {
    kind?: StoryTransitionKind;
    direction?: StoryTransitionDirection;
    durationInFrames?: number;
    timingKind?: 'spring' | 'linear';
  }
): StoryTransitionSpec {
  const safeIndex = Math.max(0, Math.trunc(transitionIndex));
  const kind: StoryTransitionKind =
    options?.kind ?? (safeIndex % 2 === 0 ? 'slide' : 'wipe');

  // Default to horizontal slide/wipe ('from-right' / 'from-bottom' alternating cleanly)
  const direction: StoryTransitionDirection =
    options?.direction ??
    (safeIndex % 3 === 2 ? 'from-bottom' : DIRECTIONS[0]);

  const durationInFrames = Math.max(
    1,
    Math.round(options?.durationInFrames ?? DEFAULT_STORY_TRANSITION_FRAMES)
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const presentation: TransitionPresentation<any> =
    kind === 'slide'
      ? slide({ direction })
      : wipe({ direction });

  const timing: TransitionTiming =
    options?.timingKind === 'linear'
      ? linearTiming({ durationInFrames })
      : springTiming({
          config: { damping: 200 },
          durationInFrames,
        });

  return {
    kind,
    direction,
    durationInFrames,
    presentation,
    timing,
  };
}

/**
 * Pure helper calculating total composition duration in frames when `N` scenes
 * are joined with `@remotion/transitions`'s `TransitionSeries` (where each transition
 * overlaps consecutive scenes by `transitionDurationInFrames`).
 */
export function calculateTransitionSeriesDuration(
  sceneDurationsInFrames: readonly number[],
  transitionDurationInFrames: number = DEFAULT_STORY_TRANSITION_FRAMES
): number {
  if (sceneDurationsInFrames.length === 0) {
    return 1;
  }
  const sum = sceneDurationsInFrames.reduce(
    (acc, d) => acc + Math.max(1, Math.round(d)),
    0
  );
  const overlapCount = Math.max(0, sceneDurationsInFrames.length - 1);
  const overlapFrames = overlapCount * Math.max(0, Math.round(transitionDurationInFrames));
  return Math.max(1, sum - overlapFrames);
}

export interface SceneTransitionItem {
  id: string;
  durationInFrames: number;
  render: () => React.ReactNode;
  transitionAfter?: {
    kind?: StoryTransitionKind;
    direction?: StoryTransitionDirection;
    durationInFrames?: number;
  } | null;
}

export interface StoryTransitionSeriesProps {
  scenes: readonly SceneTransitionItem[];
  defaultTransitionFrames?: number;
}

/**
 * StoryTransitionSeries: renders a sequence of scenes connected with deterministic
 * `@remotion/transitions` `slide` / `wipe` transitions.
 */
export const StoryTransitionSeries: React.FC<StoryTransitionSeriesProps> = ({
  scenes,
  defaultTransitionFrames = DEFAULT_STORY_TRANSITION_FRAMES,
}) => {
  return (
    <TransitionSeries>
      {scenes.map((scene, idx) => {
        const isLast = idx === scenes.length - 1;
        const transitionConfig = scene.transitionAfter;
        const shouldRenderTransition =
          !isLast &&
          transitionConfig !== null &&
          (transitionConfig?.durationInFrames ?? defaultTransitionFrames) > 0;

        const spec = shouldRenderTransition
          ? resolveStoryTransitionSpec(idx, {
              kind: transitionConfig?.kind,
              direction: transitionConfig?.direction,
              durationInFrames:
                transitionConfig?.durationInFrames ?? defaultTransitionFrames,
            })
          : null;

        return (
          <React.Fragment key={scene.id}>
            <TransitionSeries.Sequence
              durationInFrames={Math.max(1, Math.round(scene.durationInFrames))}
            >
              {scene.render()}
            </TransitionSeries.Sequence>
            {spec ? (
              <TransitionSeries.Transition
                presentation={spec.presentation}
                timing={spec.timing}
              />
            ) : null}
          </React.Fragment>
        );
      })}
    </TransitionSeries>
  );
};

export { linearTiming, slide, springTiming, TransitionSeries, wipe };
