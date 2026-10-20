import React from 'react';
import { Composition, registerRoot } from 'remotion';
import {
  calculateTotalDurationFrames,
  DEFAULT_WEEKLY_VIDEO_PROPS,
  VIDEO_FPS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  WEEKLY_VIDEO_COMPOSITION_ID,
  WeeklyVideoPropsSchema,
  type WeeklyVideoProps,
} from '../domain/timeline.ts';
import { WeeklyVideo } from './WeeklyVideo.tsx';

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id={WEEKLY_VIDEO_COMPOSITION_ID}
      component={WeeklyVideo}
      schema={WeeklyVideoPropsSchema}
      width={VIDEO_WIDTH}
      height={VIDEO_HEIGHT}
      fps={VIDEO_FPS}
      durationInFrames={calculateTotalDurationFrames(
        DEFAULT_WEEKLY_VIDEO_PROPS,
        VIDEO_FPS
      )}
      defaultProps={DEFAULT_WEEKLY_VIDEO_PROPS}
      calculateMetadata={({ props }) => {
        const typedProps: WeeklyVideoProps = props;
        return {
          durationInFrames: calculateTotalDurationFrames(typedProps, VIDEO_FPS),
          fps: VIDEO_FPS,
          width: VIDEO_WIDTH,
          height: VIDEO_HEIGHT,
          props: typedProps,
        };
      }}
    />
  );
};

registerRoot(RemotionRoot);
export {
  calculateTotalDurationFrames,
  DEFAULT_WEEKLY_VIDEO_PROPS,
  VIDEO_FPS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  WEEKLY_VIDEO_COMPOSITION_ID,
};

