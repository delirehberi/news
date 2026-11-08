import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureBrowser } from '@remotion/renderer';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import type { CommandContext } from '../cli.ts';
import {
  CAPTURE_DEVICE_SCALE_FACTOR,
  CAPTURE_ELEMENT_TEXT_MAX_CHARS,
  CAPTURE_EXCERPT_MAX_CHARS,
  CAPTURE_MAX_ELEMENTS,
  CAPTURE_MAX_HEIGHT_PX,
  CAPTURE_VIEWPORT_HEIGHT,
  CAPTURE_VIEWPORT_WIDTH,
  cleanCaptureText,
  computeUrlHash,
  detectBlockedOrErrorPage,
  OVERLAY_DISMISS_CSS,
  PageCaptureMetadataSchema,
  type PageCaptureMetadata,
  type PageElement,
  type PageElementKind,
} from '../domain/pageCapture.ts';
import {
  fileExists,
  getWeekPaths,
  readJson,
  writeBytesAtomic,
  writeJsonAtomic,
} from '../lib/paths.ts';
import {
  assertSafeHttpUrl,
  defaultDnsLookupAll,
  type DnsLookupAllFn,
} from '../lib/ssrf.ts';
import type { WeeklySelection } from './select.ts';
import type { WeeklyTranslation } from './translate.ts';

export const DEFAULT_NAVIGATION_TIMEOUT_MS = 25_000;
export const DEFAULT_MAX_PAGE_BYTES = 15 * 1024 * 1024;
export const DEFAULT_SETTLE_DELAY_MS = 350;
const HTTP_ERROR_STATUS_MIN = 400;

export interface RawExtractedElement {
  kind: PageElementKind;
  tagName: string;
  text: string;
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface RawDomExtraction {
  pageHeight: number;
  excerpt: string;
  elements: RawExtractedElement[];
  /** Absolute `og:image` / `twitter:image` URL, or null when the page has none. */
  ogImageUrl?: string | null;
}

export interface CaptureBrowserSession {
  captureUrl: (options: {
    url: string;
    viewportWidth: number;
    viewportHeight: number;
    deviceScaleFactor: number;
    maxHeightPx: number;
    navigationTimeoutMs: number;
    maxPageBytes: number;
    dnsLookup: DnsLookupAllFn;
    signal: AbortSignal;
  }) => Promise<{
    screenshotPng: Uint8Array;
    extraction: RawDomExtraction;
  }>;
  close: () => Promise<void>;
}

export type CaptureBrowserFactory = (options: {
  signal: AbortSignal;
}) => Promise<CaptureBrowserSession>;

const OG_IMAGE_URL_MAX_LENGTH = 2048;

/**
 * Validates an `og:image` URL extracted from page DOM: keeps only absolute http(s) URLs
 * without embedded credentials and within a sane length; returns null otherwise.
 */
export function normalizeOgImageUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed || trimmed.length > OG_IMAGE_URL_MAX_LENGTH) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }
  return parsed.toString();
}

/**
 * Assigns stable, sequential per-kind IDs (`h1`, `h2_1`, `p1`, `fig1`, `code1`, `quote1`, `table1`)
 * and normalizes text and bounding boxes for extracted page elements.
 */
export function buildNumberedPageElements(
  rawElements: readonly RawExtractedElement[],
  maxPageHeight: number = CAPTURE_MAX_HEIGHT_PX
): PageElement[] {
  const counters: Record<PageElementKind, number> = {
    h1: 0,
    heading: 0,
    paragraph: 0,
    figure: 0,
    code: 0,
    blockquote: 0,
    table: 0,
  };

  const prefixByKind: Record<PageElementKind, string> = {
    h1: 'h1',
    heading: 'h',
    paragraph: 'p',
    figure: 'fig',
    code: 'code',
    blockquote: 'quote',
    table: 'table',
  };

  const result: PageElement[] = [];

  for (const raw of rawElements) {
    if (result.length >= CAPTURE_MAX_ELEMENTS) {
      break;
    }

    const x = Math.max(0, Math.round(raw.box.x));
    const y = Math.max(0, Math.round(raw.box.y));
    const width = Math.round(raw.box.width);
    const height = Math.round(raw.box.height);

    if (width < 20 || height < 10) {
      continue;
    }
    if (y >= maxPageHeight) {
      continue;
    }

    const clampedHeight = Math.min(height, Math.max(10, maxPageHeight - y));
    counters[raw.kind] += 1;
    const count = counters[raw.kind];
    const id =
      raw.kind === 'h1' && count === 1
        ? 'h1'
        : `${prefixByKind[raw.kind]}${count}`;

    result.push({
      id,
      kind: raw.kind,
      tagName: raw.tagName.toLowerCase(),
      text: cleanCaptureText(raw.text, CAPTURE_ELEMENT_TEXT_MAX_CHARS),
      box: {
        x,
        y,
        width,
        height: clampedHeight,
      },
    });
  }

  return result;
}

/**
 * In-page DOM inspection function executed inside headless Chrome via `page.evaluate()`.
 * Self-contained so Puppeteer can serialize it cleanly without external closures.
 */
function extractPageDomInBrowser(params: {
  maxHeightPx: number;
  viewportWidth: number;
  excerptMaxChars: number;
}): RawDomExtraction {
  // Remove fixed/sticky overlays that cover large parts of the viewport
  const allCandidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'div, section, aside, dialog, header, footer, nav, form, iframe'
    )
  );
  const vh = window.innerHeight || 900;
  const vw = window.innerWidth || params.viewportWidth;

  for (const el of allCandidates) {
    const style = window.getComputedStyle(el);
    if (style.position === 'fixed' || style.position === 'sticky') {
      const rect = el.getBoundingClientRect();
      const textAndAttrs = `${el.id} ${el.className} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('role') ?? ''}`.toLowerCase();
      const isConsentOrModal =
        /cookie|consent|gdpr|privacy|newsletter|subscribe|paywall|popup|modal|banner/.test(
          textAndAttrs
        ) ||
        el.getAttribute('role') === 'dialog' ||
        el.getAttribute('aria-modal') === 'true';
      const coversViewport = rect.height > vh * 0.25 && rect.width > vw * 0.4;
      if (isConsentOrModal || coversViewport) {
        el.style.setProperty('display', 'none', 'important');
      }
    }
  }

  const root =
    document.querySelector<HTMLElement>('article, main, [role="main"], .post-content, .article-body, .entry-content') ??
    document.body;

  const isVisible = (el: HTMLElement): boolean => {
    const style = window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number.parseFloat(style.opacity || '1') < 0.05
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width >= 20 && rect.height >= 10;
  };

  const scrollX = window.scrollX || window.pageXOffset || 0;
  const scrollY = window.scrollY || window.pageYOffset || 0;

  const toDocBox = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.max(0, r.left + scrollX),
      y: Math.max(0, r.top + scrollY),
      width: Math.min(params.viewportWidth, r.width),
      height: r.height,
    };
  };

  const elements: RawExtractedElement[] = [];
  const seenNodes = new Set<HTMLElement>();

  const pushElement = (el: HTMLElement, kind: PageElementKind, fallbackText: string = '') => {
    if (seenNodes.has(el) || !isVisible(el)) {
      return;
    }
    const box = toDocBox(el);
    if (box.y >= params.maxHeightPx || box.width < 20 || box.height < 10) {
      return;
    }
    const rawText = (el.innerText || el.textContent || fallbackText || '').replace(/\s+/g, ' ').trim();
    if (kind !== 'figure' && rawText.length === 0) {
      return;
    }
    seenNodes.add(el);
    elements.push({
      kind,
      tagName: el.tagName.toLowerCase(),
      text: rawText,
      box,
    });
  };

  // 1. Primary H1 (check document-wide first in case header is outside <article>)
  const h1List = Array.from(document.querySelectorAll<HTMLElement>('h1'));
  for (const h1 of h1List) {
    pushElement(h1, 'h1');
  }

  // 2. Walk semantic elements inside root (and fallback to body if root had very few)
  const collectFromScope = (scope: HTMLElement) => {
    const nodes = Array.from(
      scope.querySelectorAll<HTMLElement>(
        'h1, h2, h3, p, figure, img, pre, blockquote, table'
      )
    );

    for (const node of nodes) {
      // Skip elements inside nav, footer, or aside
      if (node.closest('nav, footer, aside, [role="navigation"], [role="contentinfo"]')) {
        continue;
      }

      const tag = node.tagName.toLowerCase();
      if (tag === 'h1') {
        pushElement(node, 'h1');
      } else if (tag === 'h2' || tag === 'h3') {
        pushElement(node, 'heading');
      } else if (tag === 'p') {
        const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length >= 25) {
          pushElement(node, 'paragraph', text);
        }
      } else if (tag === 'figure') {
        const caption = node.querySelector('figcaption')?.textContent ?? '';
        const imgAlt = node.querySelector('img')?.getAttribute('alt') ?? '';
        pushElement(node, 'figure', caption || imgAlt || 'figure');
      } else if (tag === 'img') {
        if (node.closest('figure')) {
          continue;
        }
        const rect = node.getBoundingClientRect();
        if (rect.width >= 160 && rect.height >= 90) {
          pushElement(node, 'figure', node.getAttribute('alt') || 'image');
        }
      } else if (tag === 'pre') {
        pushElement(node, 'code');
      } else if (tag === 'blockquote') {
        pushElement(node, 'blockquote');
      } else if (tag === 'table') {
        pushElement(node, 'table');
      }
    }
  };

  collectFromScope(root);
  if (elements.length < 3 && root !== document.body) {
    collectFromScope(document.body);
  }

  elements.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);

  // Build plain-text excerpt (~1500 chars) from main content paragraphs and headings
  const textBlocks: string[] = [];
  let charCount = 0;
  for (const el of elements) {
    if (
      (el.kind === 'h1' || el.kind === 'heading' || el.kind === 'paragraph' || el.kind === 'blockquote') &&
      el.text.length > 0
    ) {
      textBlocks.push(el.text);
      charCount += el.text.length + 1;
      if (charCount >= params.excerptMaxChars * 1.2) {
        break;
      }
    }
  }

  let rawExcerpt = textBlocks.join('\n\n').trim();
  if (!rawExcerpt) {
    rawExcerpt = (root.innerText || document.body.innerText || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const excerpt =
    rawExcerpt.length > params.excerptMaxChars
      ? `${rawExcerpt.slice(0, params.excerptMaxChars - 1).trimEnd()}…`
      : rawExcerpt;

  const docHeight = Math.max(
    document.body?.scrollHeight ?? 0,
    document.documentElement?.scrollHeight ?? 0,
    document.body?.offsetHeight ?? 0,
    document.documentElement?.offsetHeight ?? 0,
    window.innerHeight || 900
  );

  const pageHeight = Math.min(params.maxHeightPx, Math.max(1, Math.round(docHeight)));

  // Social preview image, resolved to an absolute http(s) URL. This function is serialized
  // into the page by `page.evaluate`, so the selector list must stay inline.
  let ogImageUrl: string | null = null;
  const ogImageSelectors = [
    'meta[property="og:image:secure_url"]',
    'meta[property="og:image"]',
    'meta[name="og:image"]',
    'meta[name="twitter:image"]',
    'meta[property="twitter:image"]',
  ];
  for (const selector of ogImageSelectors) {
    const content = document.querySelector<HTMLMetaElement>(selector)?.content?.trim() ?? '';
    if (!content) {
      continue;
    }
    try {
      const resolved = new URL(content, window.location.href);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        ogImageUrl = resolved.toString();
        break;
      }
    } catch {
      // Malformed meta content: try the next selector.
      continue;
    }
  }

  return {
    pageHeight,
    excerpt,
    elements,
    ogImageUrl,
  };
}

/**
 * Default browser session factory using `puppeteer-core` and Remotion's
 * `chrome-headless-shell` via `ensureBrowser()`, with an ephemeral profile directory
 * that is deleted on close.
 */
export const defaultCaptureBrowserFactory: CaptureBrowserFactory = async ({ signal }) => {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }

  const browserStatus = await ensureBrowser({ logLevel: 'error' });
  if (
    browserStatus.type !== 'local-puppeteer-browser' &&
    browserStatus.type !== 'user-defined-path'
  ) {
    throw new Error(
      `Failed to resolve headless Chrome via Remotion ensureBrowser() (status: ${browserStatus.type}).`
    );
  }

  const tempProfileDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'news-video-capture-profile-')
  );

  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({
      executablePath: browserStatus.path,
      headless: true,
      userDataDir: tempProfileDir,
      defaultViewport: {
        width: CAPTURE_VIEWPORT_WIDTH,
        height: CAPTURE_VIEWPORT_HEIGHT,
        deviceScaleFactor: CAPTURE_DEVICE_SCALE_FACTOR,
      },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-first-run',
      ],
    });
  } catch (err) {
    await fs.rm(tempProfileDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  const activeBrowser = browser;

  return {
    async captureUrl({
      url,
      viewportWidth,
      viewportHeight,
      deviceScaleFactor,
      maxHeightPx,
      navigationTimeoutMs,
      maxPageBytes,
      dnsLookup,
      signal: callSignal,
    }) {
      if (callSignal.aborted) {
        throw callSignal.reason ?? new DOMException('Aborted', 'AbortError');
      }

      const page: Page = await activeBrowser.newPage();
      const cdp = await page.createCDPSession();

      try {
        await page.setViewport({
          width: viewportWidth,
          height: viewportHeight,
          deviceScaleFactor,
        });

        // Block browser file downloads completely
        await cdp.send('Page.setDownloadBehavior', {
          behavior: 'deny',
        });

        let totalBytes = 0;
        let byteLimitExceededReason: string | null = null;
        let ssrfBlockedReason: string | null = null;

        await page.setRequestInterception(true);
        page.on('request', (req) => {
          void (async () => {
            try {
              const reqUrl = req.url();
              if (reqUrl.startsWith('data:') || reqUrl.startsWith('blob:')) {
                await req.continue();
                return;
              }

              // Block media/font/websocket flood or non-http(s) navigations
              const resourceType = req.resourceType();
              if (resourceType === 'media' || resourceType === 'eventsource' || resourceType === 'websocket') {
                await req.abort('blockedbyclient');
                return;
              }

              await assertSafeHttpUrl(reqUrl, { dnsLookup });
              await req.continue();
            } catch (err) {
              if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
                ssrfBlockedReason = err instanceof Error ? err.message : String(err);
              }
              await req.abort('accessdenied').catch(() => {});
            }
          })();
        });

        page.on('response', (res) => {
          const contentLength = res.headers()['content-length'];
          if (contentLength) {
            const parsed = Number.parseInt(contentLength, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
              totalBytes += parsed;
            }
          }
          if (res.frame() === page.mainFrame() && res.request().isNavigationRequest()) {
            const disposition = (res.headers()['content-disposition'] ?? '').toLowerCase();
            if (disposition.includes('attachment')) {
              byteLimitExceededReason = 'Main navigation triggered a file download attachment';
            }
          }
          if (totalBytes > maxPageBytes && !byteLimitExceededReason) {
            byteLimitExceededReason = `Page transfer size (${totalBytes} bytes) exceeded max limit (${maxPageBytes} bytes)`;
          }
        });

        const navigationResponse = await page.goto(url, {
          waitUntil: 'networkidle2',
          timeout: navigationTimeoutMs,
        });

        if (ssrfBlockedReason) {
          throw new Error(ssrfBlockedReason);
        }
        // An error status means we got an error or bot-block page, not the article.
        const navigationStatus = navigationResponse?.status() ?? 0;
        if (navigationStatus >= HTTP_ERROR_STATUS_MIN) {
          throw new Error(`Page responded with HTTP ${navigationStatus}`);
        }
        if (byteLimitExceededReason) {
          throw new Error(byteLimitExceededReason);
        }

        // Verify final main-frame URL after any HTTP redirects
        const finalUrl = page.url();
        await assertSafeHttpUrl(finalUrl, { dnsLookup });

        // Check HTML document size in DOM as well
        const htmlBytes = await page.evaluate(
          () => new Blob([document.documentElement?.outerHTML ?? '']).size
        );
        if (htmlBytes > maxPageBytes) {
          throw new Error(
            `Document HTML size (${htmlBytes} bytes) exceeded max limit (${maxPageBytes} bytes)`
          );
        }

        // Inject CSS to hide cookie/consent/newsletter overlays and freeze animations
        await page.addStyleTag({ content: OVERLAY_DISMISS_CSS });

        // Scroll back to top and allow layout to settle
        await page.evaluate(() => window.scrollTo(0, 0));
        await new Promise((r) => setTimeout(r, DEFAULT_SETTLE_DELAY_MS));

        const extraction = await page.evaluate(extractPageDomInBrowser, {
          maxHeightPx,
          viewportWidth,
          excerptMaxChars: CAPTURE_EXCERPT_MAX_CHARS,
        });

        const clipHeight = Math.min(
          maxHeightPx,
          Math.max(viewportHeight, extraction.pageHeight)
        );

        const screenshotBuffer = await page.screenshot({
          type: 'png',
          clip: {
            x: 0,
            y: 0,
            width: viewportWidth,
            height: clipHeight,
          },
        });

        return {
          screenshotPng: new Uint8Array(screenshotBuffer),
          extraction: {
            ...extraction,
            pageHeight: clipHeight,
          },
        };
      } finally {
        await cdp.detach().catch(() => {});
        await page.close().catch(() => {});
      }
    },
    async close() {
      try {
        await activeBrowser.close();
      } catch {
        // Ignore close errors
      } finally {
        await fs.rm(tempProfileDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
};

/**
 * Checks whether a fresh cached capture (`<n>.png` and `<n>.json`) already exists
 * in `pagesDir` with a matching `url_hash` for `url`.
 */
export async function loadCachedPageCapture(
  pagesDir: string,
  storyIndex: number,
  url: string
): Promise<PageCaptureMetadata | null> {
  const pngPath = path.join(pagesDir, `${storyIndex}.png`);
  const jsonPath = path.join(pagesDir, `${storyIndex}.json`);

  const [hasPng, hasJson] = await Promise.all([
    fileExists(pngPath),
    fileExists(jsonPath),
  ]);

  if (!hasPng || !hasJson) {
    return null;
  }

  try {
    const raw = await readJson<unknown>(jsonPath);
    const parsed = PageCaptureMetadataSchema.safeParse(raw);
    if (!parsed.success) {
      return null;
    }

    const expectedHash = computeUrlHash(url);
    if (parsed.data.url_hash !== expectedHash || parsed.data.index !== storyIndex) {
      return null;
    }

    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * Loads all valid `out/<week>/pages/<n>.json` captures keyed by normalized story URL.
 */
export async function loadWeekPageCapturesByUrl(
  pagesDir: string,
  storyUrls: readonly string[]
): Promise<Map<string, PageCaptureMetadata>> {
  const byUrl = new Map<string, PageCaptureMetadata>();

  for (let i = 0; i < storyUrls.length; i++) {
    const storyIndex = i + 1;
    const url = storyUrls[i].trim();
    const cached = await loadCachedPageCapture(pagesDir, storyIndex, url);
    if (cached) {
      byUrl.set(url, cached);
    }
  }

  return byUrl;
}

export interface CaptureStoryPageOptions {
  storyIndex: number;
  url: string;
  pagesDir: string;
  session: CaptureBrowserSession;
  signal: AbortSignal;
  dnsLookup?: DnsLookupAllFn;
  navigationTimeoutMs?: number;
  maxPageBytes?: number;
  maxHeightPx?: number;
  now?: () => Date;
  onWarn?: (msg: string) => void;
}

export interface CaptureStoryPageResult {
  status: 'captured' | 'cached' | 'failed';
  metadata: PageCaptureMetadata | null;
}

/**
 * Captures a single story URL into `pages/<storyIndex>.png` and `pages/<storyIndex>.json`.
 * - Skips if a fresh cached capture with matching `url_hash` exists on disk.
 * - Rejects private/loopback/link-local IPs via SSRF guard before launching navigation.
 * - Never throws on per-story failure (unless `signal` is aborted): logs a warning and returns
 *   `status: 'failed'` with `metadata: null` so the video pipeline falls back to the OG image.
 */
export async function captureStoryPage(
  options: CaptureStoryPageOptions
): Promise<CaptureStoryPageResult> {
  const {
    storyIndex,
    url,
    pagesDir,
    session,
    signal,
    dnsLookup = defaultDnsLookupAll,
    navigationTimeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS,
    maxPageBytes = DEFAULT_MAX_PAGE_BYTES,
    maxHeightPx = CAPTURE_MAX_HEIGHT_PX,
    now = () => new Date(),
    onWarn,
  } = options;

  if (signal.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  }

  const normalizedUrl = url.trim();
  const cached = await loadCachedPageCapture(pagesDir, storyIndex, normalizedUrl);
  if (cached) {
    return {
      status: 'cached',
      metadata: cached,
    };
  }

  const pngPath = path.join(pagesDir, `${storyIndex}.png`);
  const jsonPath = path.join(pagesDir, `${storyIndex}.json`);

  try {
    const validatedUrl = await assertSafeHttpUrl(normalizedUrl, { dnsLookup });

    const { screenshotPng, extraction } = await session.captureUrl({
      url: validatedUrl.toString(),
      viewportWidth: CAPTURE_VIEWPORT_WIDTH,
      viewportHeight: CAPTURE_VIEWPORT_HEIGHT,
      deviceScaleFactor: CAPTURE_DEVICE_SCALE_FACTOR,
      maxHeightPx,
      navigationTimeoutMs,
      maxPageBytes,
      dnsLookup,
      signal,
    });

    if (screenshotPng.byteLength === 0) {
      throw new Error('Captured screenshot PNG buffer is empty');
    }

    const blockedReason = detectBlockedOrErrorPage(extraction.excerpt);
    if (blockedReason) {
      throw new Error(blockedReason);
    }

    const elements = buildNumberedPageElements(extraction.elements, maxHeightPx);
    const metadata: PageCaptureMetadata = {
      index: storyIndex,
      url: normalizedUrl,
      url_hash: computeUrlHash(normalizedUrl),
      captured_at: now().toISOString(),
      screenshot_path: `pages/${storyIndex}.png`,
      viewport: {
        width: CAPTURE_VIEWPORT_WIDTH,
        height: CAPTURE_VIEWPORT_HEIGHT,
        deviceScaleFactor: CAPTURE_DEVICE_SCALE_FACTOR,
      },
      page_height: Math.min(maxHeightPx, Math.max(1, Math.round(extraction.pageHeight))),
      excerpt: cleanCaptureText(extraction.excerpt, CAPTURE_EXCERPT_MAX_CHARS),
      elements,
      og_image_url: normalizeOgImageUrl(extraction.ogImageUrl),
    };

    const validatedMetadata = PageCaptureMetadataSchema.parse(metadata);

    await writeBytesAtomic(pngPath, screenshotPng);
    await writeJsonAtomic(jsonPath, validatedMetadata);

    return {
      status: 'captured',
      metadata: validatedMetadata,
    };
  } catch (err) {
    if (signal.aborted) {
      throw signal.reason ?? err;
    }

    // Remove stale partial files if any existed for a different URL hash
    await Promise.all([
      fs.rm(pngPath, { force: true }).catch(() => {}),
      fs.rm(jsonPath, { force: true }).catch(() => {}),
    ]);

    const reason = err instanceof Error ? err.message : String(err);
    onWarn?.(
      `Story #${storyIndex}: page capture failed for ${normalizedUrl} (${reason}), falling back to OG image.`
    );

    return {
      status: 'failed',
      metadata: null,
    };
  }
}

export interface CaptureCommandDeps {
  outRoot?: string;
  stdout?: (msg: string) => void;
  now?: () => Date;
  dnsLookup?: DnsLookupAllFn;
  browserFactory?: CaptureBrowserFactory;
  navigationTimeoutMs?: number;
  maxPageBytes?: number;
  maxHeightPx?: number;
}

export interface CaptureCommandResult {
  week: string;
  capturedCount: number;
  cachedCount: number;
  failedCount: number;
  captures: Array<PageCaptureMetadata | null>;
}

async function resolveStoryUrlsForWeek(week: string, outRoot?: string): Promise<string[]> {
  const paths = getWeekPaths(week, outRoot);

  if (await fileExists(paths.translationJson)) {
    const translation = await readJson<WeeklyTranslation>(paths.translationJson);
    if (translation && Array.isArray(translation.items) && translation.items.length > 0) {
      return translation.items.map((item) => item.url.trim());
    }
  }

  if (await fileExists(paths.selectionJson)) {
    const selection = await readJson<WeeklySelection>(paths.selectionJson);
    if (selection && Array.isArray(selection.items) && selection.items.length > 0) {
      return selection.items.map((item) => item.url.trim());
    }
  }

  throw new Error(
    `No stories found in ${paths.translationJson} or ${paths.selectionJson} for week ${week}. Run "translate" (or "select") first.`
  );
}

/**
 * Runs the `capture` CLI stage for `ctx.week`:
 * Reads the week's story URLs from `translation.json` (or `selection.json`),
 * checks the URL-hash cache under `out/<week>/pages/`, and captures any missing or stale
 * story pages using headless Chrome (1440px wide, fixed DSF, overlay CSS hidden, height capped).
 * Per-story failures log a warning and never fail the command run.
 */
export async function runCaptureCommand(
  ctx: CommandContext,
  deps: CaptureCommandDeps = {}
): Promise<CaptureCommandResult> {
  const stdout = deps.stdout ?? ((msg: string) => console.log(msg));
  const paths = getWeekPaths(ctx.week, deps.outRoot);
  const storyUrls = await resolveStoryUrlsForWeek(ctx.week, deps.outRoot);

  const captures: Array<PageCaptureMetadata | null> = new Array(storyUrls.length).fill(null);
  let capturedCount = 0;
  let cachedCount = 0;
  let failedCount = 0;

  // Check cache upfront so we don't even launch Chrome if all story captures are fresh
  const pendingIndices: number[] = [];
  for (let i = 0; i < storyUrls.length; i++) {
    const cached = await loadCachedPageCapture(paths.pagesDir, i + 1, storyUrls[i]);
    if (cached) {
      captures[i] = cached;
      cachedCount++;
    } else {
      pendingIndices.push(i);
    }
  }

  if (pendingIndices.length > 0) {
    const browserFactory = deps.browserFactory ?? defaultCaptureBrowserFactory;
    let session: CaptureBrowserSession | null = null;

    try {
      session = await browserFactory({ signal: ctx.signal });
    } catch (err) {
      if (ctx.signal.aborted) {
        throw ctx.signal.reason ?? err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      stdout(
        `[warn] Failed to launch headless browser for page capture (${reason}); all ${pendingIndices.length} uncached story(ies) will fall back to OG images.`
      );
      failedCount = pendingIndices.length;
    }

    if (session) {
      try {
        for (const idx of pendingIndices) {
          if (ctx.signal.aborted) {
            throw ctx.signal.reason ?? new DOMException('Aborted', 'AbortError');
          }

          const storyIndex = idx + 1;
          const url = storyUrls[idx];
          const res = await captureStoryPage({
            storyIndex,
            url,
            pagesDir: paths.pagesDir,
            session,
            signal: ctx.signal,
            dnsLookup: deps.dnsLookup,
            navigationTimeoutMs: deps.navigationTimeoutMs,
            maxPageBytes: deps.maxPageBytes,
            maxHeightPx: deps.maxHeightPx,
            now: deps.now,
            onWarn: (msg) => stdout(`[warn] ${msg}`),
          });

          captures[idx] = res.metadata;
          if (res.status === 'captured') {
            capturedCount++;
          } else if (res.status === 'cached') {
            cachedCount++;
          } else {
            failedCount++;
          }
        }
      } finally {
        await session.close();
      }
    }
  }

  stdout(
    `Captured pages for ${ctx.week}: ${capturedCount} captured, ${cachedCount} cached, ${failedCount} failed (fallback to OG image) -> ${paths.pagesDir}`
  );

  return {
    week: ctx.week,
    capturedCount,
    cachedCount,
    failedCount,
    captures,
  };
}
