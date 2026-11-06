import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GMAIL_MAX_MESSAGES_PER_RUN,
  GMAIL_MAX_PREVIEW_MESSAGES,
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
import { app, fetchGmailNewsletters, runDebugPipeline } from './index';

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

describe('fetchGmailNewsletters ingest vs preview mode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createNewsletterTestHarness(initialProcessedIds: string[] = []) {
    const processedEmails = new Set<string>(initialProcessedIds);
    const dbQueries: string[] = [];
    const decomposedMsgIds: string[] = [];

    const mockDb: any = {
      prepare(query: string) {
        dbQueries.push(query);
        const createRunner = (params: any[] = []) => ({
          async all() {
            if (query.includes('FROM processed_emails')) {
              const results = params
                .filter((id) => processedEmails.has(String(id)))
                .map((id) => ({ message_id: String(id) }));
              return { results };
            }
            return { results: [] };
          },
          async first() {
            return null;
          },
          async run() {
            if (query.includes('INSERT INTO processed_emails')) {
              for (const id of params) {
                processedEmails.add(String(id));
              }
            }
            return { success: true };
          },
        });

        return {
          ...createRunner([]),
          bind(...params: any[]) {
            return createRunner(params);
          },
        };
      },
    };

    const mockAi = {
      async run(model: string, input: any) {
        if (model.includes('bge-base-en')) {
          const texts: string[] = Array.isArray(input?.text) ? input.text : [];
          return {
            data: texts.map(() => [0.1, 0.2, 0.3]),
          };
        }

        const systemContent: string = input?.messages?.[0]?.content || '';
        const subjectMatch = systemContent.match(/Subject-([a-zA-Z0-9_-]+)/);
        const msgId = subjectMatch ? subjectMatch[1] : 'unknown';
        decomposedMsgIds.push(msgId);

        if (systemContent.includes('selected_ids')) {
          return {
            response: JSON.stringify({ selected_ids: [] }),
          };
        }

        return {
          response: JSON.stringify([
            {
              title: `Story from ${msgId}`,
              summary: `Detailed technical summary for ${msgId} covering distributed systems architecture.`,
              category: 'Engineering',
              url: `https://example.com/articles/${msgId}`,
              is_sponsored: false,
            },
          ]),
        };
      },
    };

    const env: any = {
      news_db: mockDb,
      AI: mockAi,
      GMAIL_CLIENT_ID: 'test-client-id',
      GMAIL_CLIENT_SECRET: 'test-client-secret',
      GMAIL_REFRESH_TOKEN: 'test-refresh-token',
    };

    function installFetchMock(messageIds: string[]) {
      const htmlBody = encodeBase64Url(
        '<html><body><h2>Newsletter Digest</h2><p>This newsletter issue contains more than fifty characters of technical content and analysis for developers.</p></body></html>'
      );

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

        if (url === 'https://oauth2.googleapis.com/token') {
          return new Response(JSON.stringify({ access_token: 'mock-access-token' }), {
            status: HTTP_STATUS_OK,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) {
          return new Response(
            JSON.stringify({
              messages: messageIds.map((id) => ({ id })),
            }),
            {
              status: HTTP_STATUS_OK,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const msgMatch = url.match(/\/messages\/([^?]+)\?format=full/);
        if (msgMatch) {
          const msgId = msgMatch[1];
          return new Response(
            JSON.stringify({
              id: msgId,
              payload: {
                headers: [
                  { name: 'Subject', value: `Subject-${msgId}` },
                  { name: 'From', value: 'Newsletter <digest@example.com>' },
                ],
                mimeType: 'text/html',
                body: { data: htmlBody },
              },
            }),
            {
              status: HTTP_STATUS_OK,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        return new Response('<html><head><title>Article</title></head><body><p>Content</p></body></html>', {
          status: HTTP_STATUS_OK,
        });
      });
    }

    return {
      env,
      processedEmails,
      dbQueries,
      decomposedMsgIds,
      installFetchMock,
    };
  }

  it('defaults to ingest mode: filters out processed_emails, caps at GMAIL_MAX_MESSAGES_PER_RUN, and inserts newly decomposed messages', async () => {
    const listedIds = Array.from({ length: 14 }, (_, i) => `msg-${i + 1}`);
    const alreadyProcessed = ['msg-1', 'msg-2'];
    const { env, processedEmails, dbQueries, decomposedMsgIds, installFetchMock } =
      createNewsletterTestHarness(alreadyProcessed);

    installFetchMock(listedIds);

    const articles = await fetchGmailNewsletters(env);

    // 14 listed - 2 already processed = 12 remaining -> capped at GMAIL_MAX_MESSAGES_PER_RUN (10)
    expect(decomposedMsgIds).toHaveLength(GMAIL_MAX_MESSAGES_PER_RUN);
    expect(decomposedMsgIds).not.toContain('msg-1');
    expect(decomposedMsgIds).not.toContain('msg-2');
    expect(decomposedMsgIds[0]).toBe('msg-3');
    expect(decomposedMsgIds[GMAIL_MAX_MESSAGES_PER_RUN - 1]).toBe('msg-12');
    expect(articles).toHaveLength(GMAIL_MAX_MESSAGES_PER_RUN);

    // All 10 decomposed messages should now be recorded in processed_emails (2 initial + 10 new = 12)
    expect(processedEmails.size).toBe(2 + GMAIL_MAX_MESSAGES_PER_RUN);
    for (const id of decomposedMsgIds) {
      expect(processedEmails.has(id)).toBe(true);
    }
    expect(dbQueries.some((q) => q.includes('SELECT message_id FROM processed_emails'))).toBe(true);
    expect(dbQueries.some((q) => q.includes('INSERT INTO processed_emails'))).toBe(true);
  });

  it('in preview mode: does not filter by processed_emails, never inserts into processed_emails, and caps at GMAIL_MAX_PREVIEW_MESSAGES', async () => {
    const listedIds = Array.from({ length: 12 }, (_, i) => `msg-${i + 1}`);
    // Even if all messages are already in processed_emails, preview mode still decomposes the top GMAIL_MAX_PREVIEW_MESSAGES
    const { env, processedEmails, dbQueries, decomposedMsgIds, installFetchMock } =
      createNewsletterTestHarness(['msg-1', 'msg-2', 'msg-3']);

    installFetchMock(listedIds);

    const articles = await fetchGmailNewsletters(env, { mode: 'preview' });

    expect(decomposedMsgIds).toHaveLength(GMAIL_MAX_PREVIEW_MESSAGES);
    expect(decomposedMsgIds).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5']);
    expect(articles).toHaveLength(GMAIL_MAX_PREVIEW_MESSAGES);

    // processed_emails row count and contents are completely unchanged
    expect(processedEmails.size).toBe(3);
    expect(Array.from(processedEmails)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(dbQueries.some((q) => q.includes('processed_emails'))).toBe(false);
  });

  it('runDebugPipeline and /debug?source=gmail use preview mode so processed emails are shown and unprocessed emails are not consumed', async () => {
    const listedIds = ['msg-processed-1', 'msg-unprocessed-2'];
    const { env, processedEmails, installFetchMock } = createNewsletterTestHarness(['msg-processed-1']);

    installFetchMock(listedIds);

    const report = await runDebugPipeline(env, 'gmail');
    expect(report.stats.total_raw).toBe(2);
    expect(report.items.map((item) => item.title)).toEqual([
      'Story from msg-processed-1',
      'Story from msg-unprocessed-2',
    ]);
    // processed_emails count remains 1 (msg-unprocessed-2 was NOT marked processed)
    expect(processedEmails.size).toBe(1);
    expect(processedEmails.has('msg-unprocessed-2')).toBe(false);

    const res = await app.request('http://localhost:8787/debug?source=gmail', {}, env);
    expect(res.status).toBe(HTTP_STATUS_OK);
    const html = await res.text();
    expect(html).toContain('Story from msg-processed-1');
    expect(html).toContain('Story from msg-unprocessed-2');
    expect(processedEmails.size).toBe(1);
  });
});


