import { describe, expect, it } from 'vitest';
import {
  buildStoryFallbackUrl,
  convertEmailToStructuredMarkdown,
  decodeBase64Utf8,
  decodeEmailEntities,
  extractBalancedJsonObjects,
  extractEmailBodies,
  isOpaqueRedirectUrl,
  normalizeUrl,
  parseCuratedIds,
  parseDecomposedStories,
  resolveRedirectUrl,
  unwrapTrackingUrl,
} from './newsletter';

const HTTP_STATUS_FOUND = 302;
const HTTP_STATUS_MOVED_PERMANENTLY = 301;
const HTTP_STATUS_OK = 200;
const TEST_TIMEOUT_MS = 1000;

function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('unwrapTrackingUrl and normalizeUrl', () => {
  it('unwraps AWS SES /CL0/ click-tracking URLs used by TLDR newsletters', () => {
    const trackedUrl =
      'https://tracking.tldrnewsletter.com/CL0/https:%2F%2Fwww.theverge.com%2Ftech%2F914723%2Fapple-macbook-neo-3d-printed-accessories%3Futm_source=tldrdesign/1/0100019d9bd8da76/eb6d0692';
    expect(unwrapTrackingUrl(trackedUrl)).toBe(
      'https://www.theverge.com/tech/914723/apple-macbook-neo-3d-printed-accessories?utm_source=tldrdesign'
    );
    expect(normalizeUrl(trackedUrl)).toBe(
      'https://www.theverge.com/tech/914723/apple-macbook-neo-3d-printed-accessories'
    );
  });

  it('unwraps query-parameter redirect wrappers and strips tracking params while preserving functional query params', () => {
    const wrapped =
      'https://mail.example.com/click?url=https%3A%2F%2Fnews.ycombinator.com%2Fitem%3Fid%3D424242%26utm_source%3Dnewsletter%26fbclid%3Dabc123&mc_eid=xyz';
    expect(normalizeUrl(wrapped)).toBe('https://news.ycombinator.com/item?id=424242');
  });

  it('preserves #story-... fallback hashes while stripping regular URL fragments', () => {
    const fallbackStoryUrl =
      'https://aposto.com/s/gundem-19-ekim?utm_source=aposto#story-merkez-bankasi-faiz-karari-0';
    const standardFragmentUrl = 'https://example.com/articles/deep-dive/#section-3';

    expect(normalizeUrl(fallbackStoryUrl)).toBe(
      'https://aposto.com/s/gundem-19-ekim#story-merkez-bankasi-faiz-karari-0'
    );
    expect(normalizeUrl(standardFragmentUrl)).toBe('https://example.com/articles/deep-dive');
  });
});

describe('isOpaqueRedirectUrl and resolveRedirectUrl', () => {
  it('identifies opaque redirect domains and ignores direct destination URLs after /CL0/ unwrapping', () => {
    expect(isOpaqueRedirectUrl('https://link.apos.to/abc123')).toBe(true);
    expect(isOpaqueRedirectUrl('https://links.tldrnewsletter.com/xyz987')).toBe(true);
    expect(isOpaqueRedirectUrl('https://substack.com/redirect/2/eyJ1IjoiMTIzIn0')).toBe(true);
    expect(isOpaqueRedirectUrl('https://example.substack.com/p/regular-post')).toBe(false);
    expect(
      isOpaqueRedirectUrl(
        'https://tracking.tldrnewsletter.com/CL0/https:%2F%2Fgithub.com%2Fcloudflare%2Fworkerd/1/0100/ffff'
      )
    ).toBe(false);
  });

  it('resolves multi-hop opaque redirect URLs via Location headers and strips tracking parameters', async () => {
    const hopMap = new Map<string, { status: number; location?: string }>([
      [
        'https://link.apos.to/story-hop-1',
        { status: HTTP_STATUS_FOUND, location: 'https://bit.ly/story-hop-2' },
      ],
      [
        'https://bit.ly/story-hop-2',
        {
          status: HTTP_STATUS_MOVED_PERMANENTLY,
          location: 'https://www.reuters.com/world/middle-east/story-123/?utm_source=aposto&utm_medium=email',
        },
      ],
    ]);

    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const entry = hopMap.get(url);
      if (!entry) {
        return new Response(null, { status: HTTP_STATUS_OK });
      }
      return new Response(null, {
        status: entry.status,
        headers: entry.location ? { location: entry.location } : {},
      });
    };

    const resolved = await resolveRedirectUrl('https://link.apos.to/story-hop-1', TEST_TIMEOUT_MS, mockFetch);
    expect(resolved).toBe('https://www.reuters.com/world/middle-east/story-123');
  });

  it('gracefully returns normalized original URL if redirect lookup fails or times out', async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error('Network error');
    };

    const fallback = await resolveRedirectUrl('https://link.apos.to/unreachable', TEST_TIMEOUT_MS, failingFetch);
    expect(fallback).toBe('https://link.apos.to/unreachable');
  });
});

describe('extractEmailBodies, convertEmailToStructuredMarkdown, and buildStoryFallbackUrl', () => {
  it('decodes nested multipart Gmail MIME payloads with UTF-8 Turkish characters', () => {
    const htmlSample = '<p>Türkiye Cumhuriyet Merkez Bankası faiz kararını açıkladı.</p>';
    const plainSample = 'Türkiye Cumhuriyet Merkez Bankası faiz kararını açıkladı.';

    const payload = {
      mimeType: 'multipart/alternative',
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: encodeBase64Url(plainSample) },
        },
        {
          mimeType: 'multipart/related',
          parts: [
            {
              mimeType: 'text/html',
              body: { data: encodeBase64Url(htmlSample) },
            },
          ],
        },
      ],
    };

    const extracted = extractEmailBodies(payload);
    expect(extracted.html).toContain('Türkiye Cumhuriyet Merkez Bankası');
    expect(extracted.plain).toBe(plainSample);
    expect(decodeBase64Utf8(encodeBase64Url('ğüşiöçĞÜŞİÖÇ'))).toBe('ğüşiöçĞÜŞİÖÇ');
  });

  it('strips zero-width preheader padding, extracts issueWebUrl, and unwraps inline tracking links in Markdown', () => {
    const html = `
      <html>
        <head><style>.hidden { display: none; }</style></head>
        <body>
          <div>&zwnj;&nbsp;&#8203;&zwnj;&#8204;&nbsp;</div>
          <a href="https://tracking.tldrnewsletter.com/CL0/https:%2F%2Fa.tldrnewsletter.com%2Fweb-version%3Fep%3D1/1/0100/abcd">View Online</a>
          <h2>Türkiye Ekonomi Gündemi</h2>
          <p>Detaylar için <a href="https://tracking.tldrnewsletter.com/CL0/https:%2F%2Fexample.com%2Frapor%3Futm_source%3Dtldr/1/0100/ef01">raporu inceleyin</a>.</p>
        </body>
      </html>
    `;

    const { markdown, issueWebUrl } = convertEmailToStructuredMarkdown(html);
    expect(issueWebUrl).toBe('https://a.tldrnewsletter.com/web-version?ep=1');
    expect(markdown).toContain('## Türkiye Ekonomi Gündemi');
    expect(markdown).toContain('[raporu inceleyin](https://example.com/rapor?utm_source=tldr)');
    expect(markdown).not.toContain('\u200C');
    expect(markdown).not.toContain('\u200B');
  });

  it('produces distinct normalized fallback URLs for multiple linkless stories in the same newsletter issue', () => {
    const baseIssueUrl = 'https://aposto.com/i/gundem-20-ekim';
    const firstUrl = normalizeUrl(buildStoryFallbackUrl(baseIssueUrl, 'Merkez Bankası Faiz Kararı', 0));
    const secondUrl = normalizeUrl(buildStoryFallbackUrl(baseIssueUrl, 'Avrupa Merkez Bankası Toplantısı', 1));

    expect(firstUrl).toBe('https://aposto.com/i/gundem-20-ekim#story-merkez-bankasi-faiz-karari-0');
    expect(secondUrl).toBe('https://aposto.com/i/gundem-20-ekim#story-avrupa-merkez-bankasi-toplantisi-1');
    expect(firstUrl).not.toBe(secondUrl);
  });

  it('decodes HTML entities and removes invisible formatting characters', () => {
    const raw = 'Aposto&nbsp;&bull;&nbsp;&ldquo;Gündem&rdquo;&zwnj;&#8203; &amp; Analiz';
    const cleaned = decodeEmailEntities(raw);
    expect(cleaned).toContain('Aposto •');
    expect(cleaned).toContain('& Analiz');
  });
});

describe('parseDecomposedStories and parseCuratedIds', () => {
  it('accepts pre-parsed Array or wrapper Object returned directly by Cloudflare Workers AI', () => {
    const directArray = [
      {
        title: 'Cloudflare Workers Support New SQLite Durable Objects',
        summary: 'Cloudflare announced general availability for SQLite-backed Durable Objects.',
        category: 'Cloud',
        url: 'https://blog.cloudflare.com/sqlite-do',
        is_sponsored: false,
      },
    ];

    const wrappedObject = {
      stories: directArray,
    };

    expect(parseDecomposedStories(directArray)).toHaveLength(1);
    expect(parseDecomposedStories(wrappedObject)).toHaveLength(1);
    expect(parseDecomposedStories(directArray)[0].title).toBe(
      'Cloudflare Workers Support New SQLite Durable Objects'
    );
  });

  it('recovers complete story objects from truncated JSON strings containing escaped quotes and Turkish text', () => {
    const truncatedJson = `\`\`\`json
[
  {
    "title": "Bakan Şimşek'ten \\"Enflasyonla Mücadele\\" Açıklaması",
    "summary": "Hazine ve Maliye Bakanı Mehmet Şimşek, dezenflasyon sürecinin hızlanacağını belirtti. Detaylar bültende yer aldı.",
    "category": "Economy",
    "url": "https://link.apos.to/ekonomi-1",
    "is_sponsored": false
  },
  {
    "title": "Avrupa Birliği Yeni Yapay Zekâ Yasasını Onayladı",
    "summary": "AB Konseyi, yüksek riskli yapay zekâ sistemlerine yönelik düzenlemeleri içeren yasayı yürürlüğe soktu.",
    "category": "Policy",
    "url": "https://link.apos.to/ab-ai-yasasi",
    "is_sponsored": false
  },
  {
    "title": "Yarım Kalan Haber Başlığı",
    "summary": "Bu haber token limiti nedeniyle kesildi ve kapanmadı`;

    const blocks = extractBalancedJsonObjects(truncatedJson);
    expect(blocks).toHaveLength(2);

    const stories = parseDecomposedStories(truncatedJson);
    expect(stories).toHaveLength(2);
    expect(stories[0].title).toBe('Bakan Şimşek\'ten "Enflasyonla Mücadele" Açıklaması');
    expect(stories[0].url).toBe('https://link.apos.to/ekonomi-1');
    expect(stories[1].category).toBe('Policy');
  });

  it('parses curated article IDs from pre-parsed objects, index arrays, and truncated JSON strings', () => {
    const candidates = [
      { id: 'newsletter-msg1-0' },
      { id: 'hn-41001' },
      { id: 'newsletter-msg2-1' },
    ];

    const fromObject = parseCuratedIds(
      { selected_ids: ['newsletter-msg1-0', 'newsletter-msg2-1'] },
      candidates
    );
    expect(Array.from(fromObject)).toEqual(['newsletter-msg1-0', 'newsletter-msg2-1']);

    const fromIndices = parseCuratedIds({ selected_indices: [1] }, candidates);
    expect(Array.from(fromIndices)).toEqual(['hn-41001']);

    const fromTruncatedString = parseCuratedIds(
      '{"selected_ids": ["newsletter-msg1-0", "hn-41001"',
      candidates
    );
    expect(Array.from(fromTruncatedString)).toEqual(['newsletter-msg1-0', 'hn-41001']);
  });
});

