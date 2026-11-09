import React from 'react';
import { AbsoluteFill, Audio, Img, interpolate, spring, staticFile, useCurrentFrame } from 'remotion';
import type { WeeklyShortProps } from '../domain/shortComposition.ts';
import { captionAt } from '../domain/shortCaptions.ts';
import { musicVolume } from '../domain/shortMusic.ts';
import { blinkAmount, idleMotion, mouthAt } from '../domain/shortPresenter.ts';
import { SHORT_FPS, SHORT_INSTAGRAM_HANDLE, SHORT_MOBILE_WIDTH, SHORT_SAFE_AREA, SHORT_WIDTH, SHORT_YOUTUBE_HANDLE, SHORT_YOUTUBE_LABEL } from '../domain/shorts.ts';
import { ShortBackground } from './ShortBackground.tsx';
import { ShortPresenter } from './ShortPresenter.tsx';

const WHITE = '#ffffff';
const ACCENT = '#ff5c35';
const CONTENT_WIDTH = SHORT_WIDTH - SHORT_SAFE_AREA.left - SHORT_SAFE_AREA.right;
const PAGE_TOP = 410;
const PAGE_HEIGHT = 600;
const PRESENTER_TOP = 1030;
const PRESENTER_SIZE = 290;
// Hook and end card have no page card, so the presenter takes the free space.
const PRESENTER_FEATURE_TOP = 870;
const PRESENTER_FEATURE_SIZE = 440;
const FOCUS_MARGIN_PX = 70;
const CAPTION_TOP = 1335;
const PAN_DISTANCE = 120;
const LABEL_FONT = 32;
const CAPTION_FONT = 60;
const HEADLINE_FONT = 68;
const SPOKEN_OPACITY = 0.6;
const UPCOMING_OPACITY = 0.35;
const CAPTION_GAP = 30;
const ENTRANCE_SPRING = { damping: 13, stiffness: 110 } as const;
const ENTRANCE_RISE_PX = 140;
const ENTRANCE_TILT_DEGREES = -3;
const ENTRANCE_MIN_SCALE = 0.94;
const BROW_LIFT_FRAMES = 24;
const GAZE_PERIOD_FRAMES = 150;
const FADE_IN_FRAMES = 6;

/** Word-by-word caption page; plain function (not a component) so its text stays inspectable in tests. */
function renderCaption(words: WeeklyShortProps['words'], seconds: number, fallback: string, box: React.CSSProperties): React.ReactNode {
  // Without word timings (preview defaults) show the whole line instead of nothing.
  const page = words.length === 0 ? [{ text: fallback, state: 'active' as const, scale: 1 }] : captionAt(words, seconds);
  if (!page) return null;
  return <div style={{ ...box, top: CAPTION_TOP, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: `0 ${CAPTION_GAP}px`, fontSize: CAPTION_FONT, lineHeight: 1.2, fontWeight: 800, textAlign: 'center', color: WHITE, textShadow: '0 4px 18px #00000088' }}>
    {page.map((word, index) => <span key={`${index}-${word.text}`} style={{ display: 'inline-block', transform: `scale(${word.scale})`, color: word.state === 'active' ? ACCENT : WHITE, opacity: word.state === 'spoken' ? SPOKEN_OPACITY : word.state === 'upcoming' ? UPCOMING_OPACITY : 1 }}>{word.text}</span>)}
  </div>;
}

export const WeeklyShort: React.FC<WeeklyShortProps> = ({ short, audioSrc, musicSrc, visuals, timing, words }) => {
  const frame = useCurrentFrame();
  const sectionIndex = timing.sections.findIndex((section) => frame >= section.startFrame && frame < section.endFrame);
  const section = timing.sections[sectionIndex] ?? timing.sections[0];
  const isTopic = sectionIndex >= 1 && sectionIndex <= visuals.length;
  const isEnd = sectionIndex === timing.sections.length - 1;
  const visual = isTopic ? visuals[sectionIndex - 1] : undefined;
  const seconds = frame / SHORT_FPS;
  const sectionFrame = Math.max(0, frame - section.startFrame);
  const progress = interpolate(frame, [section.startFrame, section.endFrame], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const entrance = spring({ frame: sectionFrame, fps: SHORT_FPS, config: ENTRANCE_SPRING });
  const entranceStyle: React.CSSProperties = {
    opacity: Math.min(1, sectionFrame / FADE_IN_FRAMES),
    transform: `translateY(${(1 - entrance) * ENTRANCE_RISE_PX}px) rotate(${(1 - entrance) * ENTRANCE_TILT_DEGREES}deg) scale(${ENTRANCE_MIN_SCALE + (1 - ENTRANCE_MIN_SCALE) * entrance})`,
  };
  const scale = CONTENT_WIDTH / SHORT_MOBILE_WIDTH;
  const maximumPan = Math.max(0, (visual?.pageHeight ?? SHORT_MOBILE_WIDTH) * scale - PAGE_HEIGHT);
  const pan = Math.min(maximumPan, Math.max(0, (visual?.focusY ?? 0) * scale - FOCUS_MARGIN_PX) + PAN_DISTANCE * progress);
  const box: React.CSSProperties = { position: 'absolute', left: SHORT_SAFE_AREA.left, width: CONTENT_WIDTH };
  const presenterSize = isTopic ? PRESENTER_SIZE : PRESENTER_FEATURE_SIZE;
  const mouth = mouthAt(words, seconds);
  const motion = idleMotion(frame, mouth.openness);

  return <AbsoluteFill style={{ color: WHITE, fontFamily: 'Arial, sans-serif' }}>
    <ShortBackground frame={frame} sectionStarts={timing.sections.map((candidate) => candidate.startFrame)} />
    {audioSrc && <Audio src={staticFile(audioSrc)} />}
    {musicSrc && <Audio src={staticFile(musicSrc)} loop loopVolumeCurveBehavior="extend" volume={(audioFrame) => musicVolume(audioFrame, timing.durationInFrames, words)} />}
    <div style={{ ...box, top: SHORT_SAFE_AREA.top, fontSize: LABEL_FONT, fontWeight: 700, borderTop: `6px solid ${ACCENT}`, paddingTop: 22 }}>
      {SHORT_YOUTUBE_LABEL}
    </div>
    {sectionIndex === 0 && <div style={{ ...box, top: PAGE_TOP, ...entranceStyle }}>
      <div style={{ color: ACCENT, fontSize: LABEL_FONT, fontWeight: 700, marginBottom: 36 }}>BU HAFTANIN GÜNDEMİ</div>
      <div style={{ fontSize: HEADLINE_FONT, lineHeight: 1.12, fontWeight: 800, overflowWrap: 'anywhere' }}>{short.title}</div>
    </div>}
    {visual && <>
      <div style={{ ...box, top: 335, display: 'flex', gap: 24, alignItems: 'center', fontSize: LABEL_FONT, fontWeight: 700, opacity: entranceStyle.opacity }}>
        <span style={{ color: ACCENT }}>{sectionIndex} / {visuals.length}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{visual.source}</span>
      </div>
      <div style={{ ...box, top: PAGE_TOP, height: PAGE_HEIGHT, overflow: 'hidden', backgroundColor: WHITE, color: '#101a22', borderRadius: 16, boxShadow: '0 18px 50px #00000066', ...entranceStyle }}>
        {visual.pageSrc ? <Img src={staticFile(visual.pageSrc)} style={{ width: CONTENT_WIDTH, display: 'block', transform: `translateY(-${pan}px)` }} /> : visual.imageSrc ? <Img src={staticFile(visual.imageSrc)} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <div style={{ padding: 55, fontSize: HEADLINE_FONT, fontWeight: 700, lineHeight: 1.18, overflowWrap: 'anywhere' }}>{visual.headline}</div>}
      </div>
    </>}
    {isEnd && <div style={{ ...box, top: PAGE_TOP, ...entranceStyle }}>
      <div style={{ fontSize: HEADLINE_FONT, fontWeight: 800, lineHeight: 1.12, marginBottom: 42 }}>Haftanın tamamını izle.</div>
      <div style={{ borderTop: `4px solid ${ACCENT}`, paddingTop: 32, fontSize: 42, lineHeight: 1.7, fontWeight: 700 }}>
        <div>YouTube · @{SHORT_YOUTUBE_HANDLE}</div>
        <div>Instagram · @{SHORT_INSTAGRAM_HANDLE}</div>
      </div>
    </div>}
    <div style={{ position: 'absolute', left: (SHORT_WIDTH - presenterSize) / 2, top: isTopic ? PRESENTER_TOP : PRESENTER_FEATURE_TOP }}>
      <ShortPresenter
        mouth={mouth}
        blink={blinkAmount(frame)}
        brows={Math.max(0, 1 - sectionFrame / BROW_LIFT_FRAMES)}
        bob={motion.bob}
        sway={motion.sway}
        gaze={Math.sin((frame * 2 * Math.PI) / GAZE_PERIOD_FRAMES)}
        size={presenterSize}
      />
    </div>
    {renderCaption(words, seconds, section.text, box)}
  </AbsoluteFill>;
};
