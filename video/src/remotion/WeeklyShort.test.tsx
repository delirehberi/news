import React from 'react';
import { expect, it, vi } from 'vitest';
import { useCurrentFrame } from 'remotion';
import { WeeklyShort } from './WeeklyShort.tsx';
import { DEFAULT_WEEKLY_SHORT_PROPS } from '../domain/shortComposition.ts';
import { SHORT_CTA, SHORT_INSTAGRAM_HANDLE, SHORT_YOUTUBE_HANDLE, SHORT_YOUTUBE_LABEL } from '../domain/shorts.ts';

vi.mock('remotion', async (importOriginal) => {
  const original = await importOriginal<typeof import('remotion')>();
  return { ...original, useCurrentFrame: vi.fn(() => 0) };
});
function visibleText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(visibleText).join(' ');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return visibleText(node.props.children);
  return '';
}
it('keeps the YouTube label across hook, topics and CTA, and displays both handles at the end', async () => {
  for (const frame of [0, 120, 330, 540, 750, 929]) {
    vi.mocked(useCurrentFrame).mockReturnValue(frame);
    const text = visibleText(await WeeklyShort(DEFAULT_WEEKLY_SHORT_PROPS));
    expect(text).toContain(SHORT_YOUTUBE_LABEL);
    if (frame >= 750) for (const value of [SHORT_CTA, SHORT_INSTAGRAM_HANDLE, SHORT_YOUTUBE_HANDLE]) expect(text).toContain(value);
  }
});
it('shows narration word by word from the aligned word timings', async () => {
  const words = ['Birinci', 'haber', 'geldi.', 'İkinci', 'haber', 'sürdü.'].map((word, index) => ({ word, start: index * 0.5, end: index * 0.5 + 0.4 }));
  const props = { ...DEFAULT_WEEKLY_SHORT_PROPS, words };
  vi.mocked(useCurrentFrame).mockReturnValue(Math.round(0.6 * 30));
  expect(visibleText(await WeeklyShort(props))).toContain('Birinci haber geldi.');
  expect(visibleText(await WeeklyShort(props))).not.toContain('İkinci');
  vi.mocked(useCurrentFrame).mockReturnValue(Math.round(1.6 * 30));
  expect(visibleText(await WeeklyShort(props))).toContain('İkinci haber sürdü.');
});
