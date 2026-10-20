export const GMAIL_MAX_LIST_RESULTS = 50;
export const GMAIL_MAX_MESSAGES_PER_RUN = 10;
export const NEWSLETTER_MARKDOWN_MAX_CHARS = 18000;
export const NEWSLETTER_DECOMPOSE_MAX_TOKENS = 4096;
export const REDIRECT_RESOLVE_TIMEOUT_MS = 2500;
export const MAX_REDIRECT_HOPS = 3;
export const MAX_REDIRECT_RESOLVES_PER_RUN = 25;
export const CURATION_BATCH_SIZE = 20;
export const STORY_HASH_PREFIX = '#story-';

const TRACKING_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'ref',
  'ref_src',
  'fbclid',
  'gclid',
  'twclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  '_bhlid',
  'oly_enc_id',
  'oly_anon_id',
  'vero_id',
  'rb_clickid',
  's_cid',
]);

const REDIRECT_URL_QUERY_KEYS = [
  'url',
  'u',
  'target',
  'dest',
  'destination',
  'redirect',
  'redirect_url',
];

const OPAQUE_REDIRECT_HOSTS = new Set([
  'link.apos.to',
  'links.tldrnewsletter.com',
  'tracking.tldrnewsletter.com',
  'link.mail.beehiiv.com',
  'mail.beehiiv.com',
  't.co',
  'bit.ly',
  'buff.ly',
  'tinyurl.com',
  'ow.ly',
]);

const OPAQUE_REDIRECT_HOST_SUFFIXES = [
  '.list-manage.com',
  '.convertkit-mail.com',
  '.convertkit-mail2.com',
  '.convertkit-mail3.com',
  '.convertkit-mail4.com',
  '.customeriomail.com',
  '.substack.com',
];

export interface GmailMimeBody {
  data?: string;
  size?: number;
}

export interface GmailMimeHeader {
  name?: string;
  value?: string;
}

export interface GmailMimePart {
  mimeType?: string;
  headers?: GmailMimeHeader[];
  body?: GmailMimeBody;
  parts?: GmailMimePart[];
}

export interface DecomposedStory {
  title: string;
  summary: string;
  category?: string;
  url?: string;
  is_sponsored?: boolean;
}

export function decodeBase64Utf8(base64: string): string {
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
  const binaryString = atob(normalized);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export function decodeEmailEntities(text: string): string {
  return text
    .replace(/&zwnj;|&#8204;|&#x200c;/gi, '')
    .replace(/&zwj;|&#8205;|&#x200d;/gi, '')
    .replace(/&#8203;|&#x200b;|&#65279;|&#xfeff;/gi, '')
    .replace(/[\u200B-\u200F\uFEFF\u034F\u00AD]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&bull;/g, '•')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '...')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .trim();
}

/**
 * Synchronously unwraps inline-encoded click-tracking URLs such as AWS SES /CL0/ wrappers
 * (used by TLDR and others) and query-parameter redirect wrappers (?url=https://...).
 */
export function unwrapTrackingUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  let current = decodeEmailEntities(rawUrl.trim());

  for (let depth = 0; depth < MAX_REDIRECT_HOPS; depth++) {
    // 1. AWS SES / TLDR click-tracking pattern: /CL0/<percent-encoded-url>/<index>/<ses-id>/<sig>
    const cl0Match = current.match(/\/CL0\/(https?(?:%3A|:)%2F%2F[^/]+)/i);
    if (cl0Match && cl0Match[1]) {
      try {
        const decoded = decodeURIComponent(cl0Match[1]);
        if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
          current = decoded;
          continue;
        }
      } catch {
        // Ignore malformed percent-encoding and fall through
      }
    }

    // 2. Query parameter redirect pattern (?url=https://..., ?u=https://..., etc.)
    try {
      const parsed = new URL(current);
      let unwrappedFromQuery: string | null = null;
      for (const key of REDIRECT_URL_QUERY_KEYS) {
        const candidate = parsed.searchParams.get(key);
        if (candidate && (candidate.startsWith('http://') || candidate.startsWith('https://'))) {
          unwrappedFromQuery = candidate;
          break;
        }
      }
      if (unwrappedFromQuery && unwrappedFromQuery !== current) {
        current = unwrappedFromQuery;
        continue;
      }
    } catch {
      break;
    }

    break;
  }

  return current;
}

/**
 * Unwraps inline tracking URLs, removes tracking query parameters, and normalizes trailing slashes.
 * Preserves `#story-...` hashes used to distinguish linkless stories within the same newsletter issue.
 */
export function normalizeUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  const unwrapped = unwrapTrackingUrl(rawUrl);
  try {
    const parsed = new URL(unwrapped);
    const paramsToKeep: [string, string][] = [];

    parsed.searchParams.forEach((val, key) => {
      const lowerKey = key.toLowerCase();
      if (!TRACKING_QUERY_PARAMS.has(lowerKey) && !lowerKey.startsWith('utm_')) {
        paramsToKeep.push([key, val]);
      }
    });

    const preservedHash = parsed.hash.startsWith(STORY_HASH_PREFIX) ? parsed.hash : '';
    parsed.search = '';
    for (const [k, v] of paramsToKeep) {
      parsed.searchParams.append(k, v);
    }
    parsed.hash = preservedHash;

    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return unwrapped.trim();
  }
}

/**
 * Determines whether a URL points to an opaque redirect/shortener service that requires
 * an HTTP redirect lookup (Location header) to discover the canonical destination URL.
 */
export function isOpaqueRedirectUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  const unwrapped = unwrapTrackingUrl(rawUrl);
  try {
    const parsed = new URL(unwrapped);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname;

    if (OPAQUE_REDIRECT_HOSTS.has(host)) {
      return true;
    }

    for (const suffix of OPAQUE_REDIRECT_HOST_SUFFIXES) {
      if (host.endsWith(suffix)) {
        if (suffix === '.substack.com') {
          return path.startsWith('/redirect/');
        }
        return true;
      }
    }

    if (host === 'substack.com' && path.startsWith('/redirect/')) {
      return true;
    }

    if (path.startsWith('/CL0/') || path.includes('/track/click')) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchRedirectLocation(
  url: string,
  method: 'HEAD' | 'GET',
  timeoutMs: number,
  fetchFn: typeof fetch
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      method,
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsAggregator/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
    });

    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // Ignore stream cancellation errors
      }
    }

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get('location');
      if (location && location.trim().length > 0) {
        return new URL(location.trim(), url).toString();
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves opaque newsletter tracking/shortener URLs (e.g. link.apos.to, links.tldrnewsletter.com,
 * substack.com/redirect, beehiiv) by inspecting HTTP redirect Location headers up to MAX_REDIRECT_HOPS.
 */
export async function resolveRedirectUrl(
  rawUrl: string,
  timeoutMs: number = REDIRECT_RESOLVE_TIMEOUT_MS,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  let current = unwrapTrackingUrl(rawUrl);
  if (!current) return '';

  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    if (!isOpaqueRedirectUrl(current)) {
      break;
    }

    let nextLocation = await fetchRedirectLocation(current, 'HEAD', timeoutMs, fetchFn);
    if (!nextLocation) {
      nextLocation = await fetchRedirectLocation(current, 'GET', timeoutMs, fetchFn);
    }

    if (!nextLocation || nextLocation === current) {
      break;
    }

    current = unwrapTrackingUrl(nextLocation);
  }

  return normalizeUrl(current);
}

/**
 * Recursively extracts HTML and plain-text bodies from a Gmail message payload.
 */
export function extractEmailBodies(payload: GmailMimePart | undefined): { html: string; plain: string } {
  const htmlParts: string[] = [];
  const plainParts: string[] = [];

  function walk(part: GmailMimePart | undefined): void {
    if (!part) return;
    if (part.mimeType === 'text/html' && part.body?.data) {
      try {
        htmlParts.push(decodeBase64Utf8(part.body.data));
      } catch {
        // Ignore malformed base64 segment
      }
    } else if (part.mimeType === 'text/plain' && part.body?.data) {
      try {
        plainParts.push(decodeBase64Utf8(part.body.data));
      } catch {
        // Ignore malformed base64 segment
      }
    }
    if (Array.isArray(part.parts)) {
      for (const subPart of part.parts) {
        walk(subPart);
      }
    }
  }

  walk(payload);

  return {
    html: htmlParts.join('\n'),
    plain: plainParts.join('\n'),
  };
}

/**
 * Converts newsletter HTML/plain content into clean structured Markdown while:
 * 1. Extracting and unwrapping the "View in browser" / "Tarayıcıda oku" issue URL.
 * 2. Stripping email preheader invisible spacer padding (&zwnj;, &nbsp;, zero-width chars).
 * 3. Unwrapping inline-encoded tracking URLs inside <a href="..."> tags so prompt & output tokens stay compact.
 */
export function convertEmailToStructuredMarkdown(
  htmlContent: string,
  plainTextContent?: string
): { markdown: string; issueWebUrl: string | null } {
  let issueWebUrl: string | null = null;

  const webLinkMatch =
    htmlContent.match(
      /<a[^>]+href=["']([^"']+)["'][^>]*>(?:[\s\S]*?(?:Tarayıcıda oku|Web Version|View in browser|View online|Read in browser|View this issue|Web version)[\s\S]*?)<\/a>/i
    ) ||
    htmlContent.match(
      /<a[^>]+href=["']([^"']+)["'][^>]*>\s*(?:WEB VERSION|Tarayıcıda oku|View in browser)\s*<\/a>/i
    );

  if (webLinkMatch && webLinkMatch[1]) {
    issueWebUrl = unwrapTrackingUrl(decodeEmailEntities(webLinkMatch[1].trim()));
  }

  let text = htmlContent
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '');

  text = text.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n\n## $1\n\n');
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n• $1\n');
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n');
  text = text.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, '\n$1\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');

  text = text.replace(
    /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, rawHref: string, linkBody: string) => {
      const cleanLinkText = decodeEmailEntities(linkBody.replace(/<[^>]+>/g, '')).trim();
      const cleanedHref = unwrapTrackingUrl(decodeEmailEntities(rawHref));
      if (
        !cleanLinkText ||
        !cleanedHref ||
        cleanedHref.startsWith('mailto:') ||
        cleanedHref.startsWith('javascript:') ||
        cleanedHref.startsWith('#')
      ) {
        return cleanLinkText;
      }
      return `[${cleanLinkText}](${cleanedHref})`;
    }
  );

  text = text.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**');
  text = text.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEmailEntities(text);

  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1].length > 0))
    .join('\n');

  if (text.length < 50 && plainTextContent && plainTextContent.length > 50) {
    text = decodeEmailEntities(plainTextContent);
  }

  return { markdown: text, issueWebUrl };
}

/**
 * Generates a unique fallback URL with a `#story-<slug>` anchor when a newsletter item has no
 * distinct external article link (or when the LLM echoes the newsletter's own issueWebUrl).
 */
export function buildStoryFallbackUrl(
  fallbackIssueUrl: string,
  title: string,
  index: number
): string {
  const base = fallbackIssueUrl.split('#')[0];
  const asciiSlug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 36);

  const suffix = asciiSlug.length > 0 ? `${asciiSlug}-${index}` : `item-${index}`;
  return `${base}${STORY_HASH_PREFIX}${suffix}`;
}

function coerceStoryCandidate(value: unknown): DecomposedStory | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  if (!title || !summary) return null;

  const category = typeof record.category === 'string' ? record.category.trim() : undefined;
  const url = typeof record.url === 'string' ? record.url.trim() : undefined;
  const isSponsored =
    record.is_sponsored === true ||
    record.is_sponsored === 'true' ||
    record.isSponsored === true;

  return {
    title,
    summary,
    category,
    url,
    is_sponsored: isSponsored,
  };
}

/**
 * Extracts balanced top-level `{ ... }` JSON object substrings from a potentially truncated
 * JSON array string, properly handling quoted strings and backslash escapes (`\"`).
 */
export function extractBalancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let startIdx = -1;
  let inString = false;
  let isEscaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (ch === '\\') {
        isEscaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) {
        startIdx = i;
      }
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && startIdx !== -1) {
          objects.push(text.slice(startIdx, i + 1));
          startIdx = -1;
        }
      }
    }
  }

  return objects;
}

function stripMarkdownCodeFences(raw: string): string {
  let trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i);
  if (fenceMatch && fenceMatch[1] && (fenceMatch[1].trim().startsWith('[') || fenceMatch[1].trim().startsWith('{'))) {
    trimmed = fenceMatch[1].trim();
  }
  return trimmed;
}

/**
 * Parses LLM newsletter decomposition output resiliently across:
 * 1. Pre-parsed Array or wrapper Object returned directly by Cloudflare Workers AI.
 * 2. Valid JSON string (with or without markdown fences).
 * 3. Truncated JSON array string (recovering every complete `{ ... }` story object before the cutoff).
 */
export function parseDecomposedStories(rawResponse: unknown): DecomposedStory[] {
  if (!rawResponse) return [];

  if (Array.isArray(rawResponse)) {
    return rawResponse
      .map(coerceStoryCandidate)
      .filter((item): item is DecomposedStory => item !== null);
  }

  if (typeof rawResponse === 'object') {
    const record = rawResponse as Record<string, unknown>;
    const nestedArray =
      (Array.isArray(record.stories) && record.stories) ||
      (Array.isArray(record.items) && record.items) ||
      (Array.isArray(record.articles) && record.articles) ||
      (Array.isArray(record.data) && record.data);

    if (nestedArray) {
      return nestedArray
        .map(coerceStoryCandidate)
        .filter((item): item is DecomposedStory => item !== null);
    }

    const single = coerceStoryCandidate(rawResponse);
    return single ? [single] : [];
  }

  if (typeof rawResponse !== 'string') {
    return [];
  }

  const cleaned = stripMarkdownCodeFences(rawResponse);
  if (!cleaned) return [];

  try {
    const parsed: unknown = JSON.parse(cleaned);
    const fromParsed = parseDecomposedStories(parsed);
    if (fromParsed.length > 0) {
      return fromParsed;
    }
  } catch {
    // Fall through to balanced-object recovery for truncated JSON outputs
  }

  const recovered: DecomposedStory[] = [];
  const objectBlocks = extractBalancedJsonObjects(cleaned);
  for (const block of objectBlocks) {
    try {
      const parsedBlock: unknown = JSON.parse(block);
      const story = coerceStoryCandidate(parsedBlock);
      if (story) {
        recovered.push(story);
      }
    } catch {
      // Skip malformed individual object block
    }
  }

  return recovered;
}

/**
 * Parses LLM curation output (`{"selected_ids": [...]}` or `{"selected_indices": [...]}`) across
 * both pre-parsed Workers AI objects and raw/truncated JSON strings.
 */
export function parseCuratedIds(
  rawResponse: unknown,
  candidates: ReadonlyArray<{ id: string }>
): Set<string> {
  const selectedIds = new Set<string>();
  if (!rawResponse || candidates.length === 0) return selectedIds;

  const validCandidateIds = new Set(candidates.map((c) => c.id));

  function collectFromParsed(value: unknown): boolean {
    if (!value) return false;
    if (Array.isArray(value)) {
      let matchedAny = false;
      for (const item of value) {
        if (typeof item === 'string' && validCandidateIds.has(item)) {
          selectedIds.add(item);
          matchedAny = true;
        } else if (typeof item === 'number' && candidates[item]) {
          selectedIds.add(candidates[item].id);
          matchedAny = true;
        }
      }
      return matchedAny;
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (Array.isArray(record.selected_ids)) {
        for (const id of record.selected_ids) {
          if (typeof id === 'string' && validCandidateIds.has(id)) {
            selectedIds.add(id);
          }
        }
        return true;
      }
      if (Array.isArray(record.selected_indices)) {
        for (const idx of record.selected_indices) {
          if (typeof idx === 'number' && candidates[idx]) {
            selectedIds.add(candidates[idx].id);
          }
        }
        return true;
      }
    }
    return false;
  }

  if (typeof rawResponse !== 'string') {
    collectFromParsed(rawResponse);
    return selectedIds;
  }

  const cleaned = stripMarkdownCodeFences(rawResponse);
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (collectFromParsed(parsed)) {
      return selectedIds;
    }
  } catch {
    // Fall back to regex matching candidate IDs in partially truncated responses
  }

  const regex = /"(hn-[^"]+|lobsters-[^"]+|reddit-[^"]+|newsletter-[^"]+|stacker-[^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleaned)) !== null) {
    if (validCandidateIds.has(match[1])) {
      selectedIds.add(match[1]);
    }
  }

  return selectedIds;
}

