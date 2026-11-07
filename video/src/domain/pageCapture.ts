import { z } from 'zod';

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const totalLen = ((bytes.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(totalLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(totalLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let i = 0; i < totalLen; i += 64) {
    for (let j = 0; j < 16; j++) {
      w[j] = view.getUint32(i + j * 4, false);
    }
    for (let j = 16; j < 64; j++) {
      const s0 = rotr32(w[j - 15], 7) ^ rotr32(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rotr32(w[j - 2], 17) ^ rotr32(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let j = 0; j < 64; j++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[j] + w[j]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('');
}

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
  return sha256Hex(url.trim()).slice(0, 16);
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
