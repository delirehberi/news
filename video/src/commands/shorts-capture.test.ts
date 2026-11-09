import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { captureStoryPage, type CaptureBrowserSession } from './capture.ts';

it('captures mobile pages at 3x, caps height, and invalidates different viewport caches', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-capture-'));
  const captureUrl = vi.fn<CaptureBrowserSession['captureUrl']>().mockResolvedValue({ screenshotPng: new Uint8Array([1]), extraction: { pageHeight: 5000, excerpt: 'Article content with meaningful information. '.repeat(8), elements: [] } });
  const options = { storyIndex: 1, url: 'https://example.com/story', pagesDir: path.join(dir, 'pages-mobile'), signal: new AbortController().signal, session: { captureUrl, close: async () => {} }, dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }], maxHeightPx: 2400, viewport: { width: 430, height: 900, deviceScaleFactor: 3 } };
  try {
    const first = await captureStoryPage(options);
    expect(first.status).toBe('captured');
    expect(first.metadata?.page_height).toBe(2400);
    expect(first.metadata?.screenshot_path).toBe('pages-mobile/1.png');
    expect(captureUrl.mock.calls[0][0]).toMatchObject({ viewportWidth: 430, deviceScaleFactor: 3 });
    expect((await captureStoryPage(options)).status).toBe('cached');
    await captureStoryPage({ ...options, viewport: { ...options.viewport, width: 1440 } });
    expect(captureUrl).toHaveBeenCalledTimes(2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
