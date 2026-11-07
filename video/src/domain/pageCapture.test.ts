import { describe, expect, it } from 'vitest';
import {
  CAPTURE_EXCERPT_MAX_CHARS,
  cleanCaptureText,
  computeUrlHash,
  OVERLAY_DISMISS_CSS,
  PageCaptureMetadataSchema,
  parsePageCaptureMetadata,
} from './pageCapture.ts';

describe('src/domain/pageCapture.ts', () => {
  it('computes deterministic 16-char hex URL hashes', () => {
    const hash1 = computeUrlHash('https://example.com/story-1');
    const hash2 = computeUrlHash('  https://example.com/story-1  ');
    const hash3 = computeUrlHash('https://example.com/story-2');

    expect(hash1).toMatch(/^[a-f0-9]{16}$/);
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });

  it('cleans whitespace and caps text at maxChars with ellipsis', () => {
    expect(cleanCaptureText('  Hello   \n\t  world  ', 100)).toBe('Hello world');
    const long = 'a'.repeat(50);
    const truncated = cleanCaptureText(long, 20);
    expect(truncated.length).toBe(20);
    expect(truncated.endsWith('…')).toBe(true);
  });

  it('validates and parses valid PageCaptureMetadata objects', () => {
    const valid = {
      index: 1,
      url: 'https://example.com/rust-kernel',
      url_hash: computeUrlHash('https://example.com/rust-kernel'),
      captured_at: '2026-10-20T15:00:00.000Z',
      screenshot_path: 'pages/1.png',
      viewport: {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
      },
      page_height: 4200,
      excerpt: 'Rust in the Linux Kernel reaches a major milestone with new PCI driver abstractions.',
      elements: [
        {
          id: 'h1',
          kind: 'h1',
          tagName: 'h1',
          text: 'Rust in the Linux Kernel',
          box: { x: 180, y: 120, width: 820, height: 64 },
        },
        {
          id: 'p1',
          kind: 'paragraph',
          tagName: 'p',
          text: 'New PCI driver abstractions allow memory-safe drivers in mainline Linux.',
          box: { x: 180, y: 210, width: 760, height: 48 },
        },
        {
          id: 'fig1',
          kind: 'figure',
          tagName: 'figure',
          text: 'Architecture diagram of Rust kernel bindings',
          box: { x: 180, y: 290, width: 760, height: 420 },
        },
        {
          id: 'code1',
          kind: 'code',
          tagName: 'pre',
          text: 'impl pci::Driver for MyRustDriver {}',
          box: { x: 180, y: 740, width: 760, height: 140 },
        },
        {
          id: 'quote1',
          kind: 'blockquote',
          tagName: 'blockquote',
          text: 'Memory safety in kernel space eliminates an entire class of privilege escalation bugs.',
          box: { x: 200, y: 910, width: 720, height: 80 },
        },
        {
          id: 'table1',
          kind: 'table',
          tagName: 'table',
          text: 'Subsystem Status 6.12 Ready',
          box: { x: 180, y: 1020, width: 760, height: 220 },
        },
      ],
    };

    const parsed = parsePageCaptureMetadata(valid);
    expect(parsed).toEqual(valid);
  });

  it('rejects malformed element-map schemas (invalid kind, negative box dimensions, overlong excerpt)', () => {
    expect(() =>
      parsePageCaptureMetadata({
        index: 0, // must be positive
        url: 'not-a-url',
      })
    ).toThrow(/Invalid page capture metadata/);

    const invalidElementKind = {
      index: 1,
      url: 'https://example.com/post',
      url_hash: computeUrlHash('https://example.com/post'),
      captured_at: '2026-10-20T15:00:00.000Z',
      screenshot_path: 'pages/1.png',
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      page_height: 1200,
      excerpt: 'Short excerpt',
      elements: [
        {
          id: 'bad1',
          kind: 'iframe', // unsupported kind
          tagName: 'iframe',
          text: '',
          box: { x: 0, y: 0, width: 100, height: 100 },
        },
      ],
    };

    expect(PageCaptureMetadataSchema.safeParse(invalidElementKind).success).toBe(false);

    const negativeWidthBox = {
      ...invalidElementKind,
      elements: [
        {
          id: 'p1',
          kind: 'paragraph',
          tagName: 'p',
          text: 'Hello',
          box: { x: 10, y: 20, width: 0, height: 40 },
        },
      ],
    };
    expect(PageCaptureMetadataSchema.safeParse(negativeWidthBox).success).toBe(false);

    const hugeExcerpt = {
      ...invalidElementKind,
      excerpt: 'x'.repeat(CAPTURE_EXCERPT_MAX_CHARS + 100),
      elements: [],
    };
    expect(PageCaptureMetadataSchema.safeParse(hugeExcerpt).success).toBe(false);
  });

  it('includes cookie/consent/newsletter selectors in OVERLAY_DISMISS_CSS', () => {
    expect(OVERLAY_DISMISS_CSS).toContain('#onetrust-consent-sdk');
    expect(OVERLAY_DISMISS_CSS).toContain('.cookie-banner');
    expect(OVERLAY_DISMISS_CSS).toContain('.newsletter-popup');
    expect(OVERLAY_DISMISS_CSS).toContain('display: none !important');
  });
});
