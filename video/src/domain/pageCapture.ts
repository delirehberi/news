import crypto from 'node:crypto';
import { z } from 'zod';

export const CAPTURE_VIEWPORT_WIDTH = 1440;
export const CAPTURE_VIEWPORT_HEIGHT = 900;
export const CAPTURE_DEVICE_SCALE_FACTOR = 1;
export const CAPTURE_MAX_HEIGHT_PX = 12_000;
export const CAPTURE_EXCERPT_MAX_CHARS = 1500;
export const CAPTURE_ELEMENT_TEXT_MAX_CHARS = 280;
export const CAPTURE_MAX_ELEMENTS = 60;

export const PageElementKindSchema = z.enum([
  'h1',
  'heading',
  'paragraph',
  'figure',
  'code',
  'blockquote',
  'table',
]);

export type PageElementKind = z.infer<typeof PageElementKindSchema>;

export const BoundingBoxSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

export const PageElementSchema = z.object({
  id: z.string().min(1),
  kind: PageElementKindSchema,
  tagName: z.string().min(1),
  text: z.string(),
  box: BoundingBoxSchema,
});

export type PageElement = z.infer<typeof PageElementSchema>;

export const PageCaptureMetadataSchema = z.object({
  index: z.number().int().positive(),
  url: z.string().url(),
  url_hash: z.string().regex(/^[a-f0-9]{16,64}$/i, 'Invalid URL hash'),
  captured_at: z.string().min(1),
  screenshot_path: z.string().min(1),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    deviceScaleFactor: z.number().positive(),
  }),
  page_height: z.number().int().positive(),
  excerpt: z.string().max(CAPTURE_EXCERPT_MAX_CHARS + 50),
  elements: z.array(PageElementSchema),
});

export type PageCaptureMetadata = z.infer<typeof PageCaptureMetadataSchema>;

/**
 * Computes a deterministic 16-char SHA-256 hex digest of the normalized URL
 * for cache invalidation when a story URL changes or is re-captured.
 */
export function computeUrlHash(url: string): string {
  return crypto.createHash('sha256').update(url.trim(), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Collapses runs of whitespace into single spaces and trims, capping at `maxChars`.
 */
export function cleanCaptureText(raw: string, maxChars: number): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Validates and parses a raw JSON value into a `PageCaptureMetadata` object.
 * Throws a descriptive Error if validation fails.
 */
export function parsePageCaptureMetadata(raw: unknown, sourceLabel: string = 'page capture'): PageCaptureMetadata {
  const parsed = PageCaptureMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid ${sourceLabel} metadata: ${details}`);
  }
  return parsed.data;
}

/**
 * CSS injected into every captured article page before measuring and screenshotting
 * in order to hide cookie banners, GDPR/CMP consent dialogs, newsletter popups,
 * paywall modals, and sticky chat widgets, and disable smooth scrolling/animations.
 */
export const OVERLAY_DISMISS_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    scroll-behavior: auto !important;
  }

  #onetrust-consent-sdk,
  #onetrust-banner-sdk,
  #CybotCookiebotDialog,
  #CybotCookiebotDialogBodyUnderlay,
  #didomi-host,
  #didomi-popup,
  #usercentrics-root,
  #qc-cmp2-container,
  #truste-consent-track,
  #cookie-law-info-bar,
  #cookie-notice,
  #cookie-banner,
  #gdpr-cookie-message,
  .cc-window,
  .cc-banner,
  .cookie-banner,
  .cookie-consent,
  .cookie-notice,
  .gdpr-banner,
  .consent-banner,
  .fc-consent-root,
  .cmp-container,
  .osano-cm-window,
  .tp-modal,
  .tp-backdrop,
  .substack-popup,
  .subscribe-widget,
  .newsletter-popup,
  .newsletter-modal,
  .paywall-modal,
  [id*="cookie-banner" i],
  [id*="cookie-consent" i],
  [id*="cookie_banner" i],
  [id*="cookie_consent" i],
  [id*="gdpr" i][class*="banner" i],
  [class*="cookie-banner" i],
  [class*="cookie-consent" i],
  [class*="cookieBanner" i],
  [class*="cookieConsent" i],
  [class*="consent-banner" i],
  [class*="consentModal" i],
  [class*="newsletter-modal" i],
  [class*="newsletter-popup" i],
  [class*="subscribe-modal" i],
  [aria-label*="cookie" i][role="dialog"],
  [aria-label*="consent" i][role="dialog"],
  [aria-label*="privacy" i][role="dialog"],
  iframe[src*="consent" i],
  iframe[id*="sp_message_iframe" i] {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }

  html, body {
    overflow-y: visible !important;
    position: static !important;
  }
`;
