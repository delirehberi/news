import { canonicalStoryUrl, SHORT_MOBILE_HEIGHT, SHORT_MOBILE_MAX_HEIGHT, SHORT_MOBILE_SCALE, SHORT_MOBILE_WIDTH } from '../domain/shorts.ts';
import type { CommandContext } from '../cli.ts';
import { captureStoryPage, defaultCaptureBrowserFactory, loadCachedPageCapture, type CaptureBrowserFactory } from './capture.ts';
import { loadShortsDraft, type ShortsCommandDeps } from './shorts-script.ts';
import type { DnsLookupAllFn } from '../lib/ssrf.ts';

export interface ShortsCaptureDeps extends ShortsCommandDeps {
  browserFactory?: CaptureBrowserFactory;
  dnsLookup?: DnsLookupAllFn;
}

export async function runShortsCaptureCommand(ctx: CommandContext, deps: ShortsCaptureDeps = {}): Promise<void> {
  const { draft, paths } = await loadShortsDraft(ctx, deps);
  const topics = draft.shorts.flatMap((short) => short.topics);
  const pending: number[] = [];
  for (let index = 0; index < topics.length; index++) {
    const cache = await loadCachedPageCapture(paths.pagesDir, index + 1, canonicalStoryUrl(topics[index].item_url));
    if (!cache || cache.viewport.width !== SHORT_MOBILE_WIDTH || cache.viewport.height !== SHORT_MOBILE_HEIGHT || cache.viewport.deviceScaleFactor !== SHORT_MOBILE_SCALE || cache.page_height > SHORT_MOBILE_MAX_HEIGHT) pending.push(index);
  }
  if (pending.length === 0) return;
  const session = await (deps.browserFactory ?? defaultCaptureBrowserFactory)({ signal: ctx.signal });
  try {
    for (const index of pending) {
      ctx.signal.throwIfAborted();
      await captureStoryPage({
        storyIndex: index + 1, url: canonicalStoryUrl(topics[index].item_url), pagesDir: paths.pagesDir,
        session, signal: ctx.signal, dnsLookup: deps.dnsLookup,
        viewport: { width: SHORT_MOBILE_WIDTH, height: SHORT_MOBILE_HEIGHT, deviceScaleFactor: SHORT_MOBILE_SCALE },
        maxHeightPx: SHORT_MOBILE_MAX_HEIGHT, onWarn: deps.stdout ?? console.warn,
      });
    }
  } finally {
    await session.close();
  }
  (deps.stdout ?? console.log)(`Mobile captures ready -> ${paths.pagesDir}`);
}
