import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { verifyEvent } from 'nostr-tools'
import { FeedView } from './views/FeedView'
import { ArticleDetailView } from './views/ArticleDetailView'
import { Layout } from './views/Layout'
import { DebugView, DiagnosticReport, DiagnosticItem, VectorMatchDetail } from './views/DebugView'
import { generateRssFeed } from './views/rss'
import { ArticleModel, getOriginalPostUrl } from './views/helpers'
import {
  parseSources,
  cosineSimilarity,
  parseEmbedding,
  calculateImportanceScore,
  computeExpiresAt,
  toSqliteDateTime,
  rankHot,
  groupDigest,
  CLUSTER_SIMILARITY_THRESHOLD,
  CLUSTER_LOOKBACK_HOURS,
  CLUSTER_MAX_CANDIDATES,
  rescoreWithSignals,
  serializeEmbedding,
  DIGEST_DAYS,
  DEFAULT_DIGEST_TIME_ZONE,
  FEED_LIMIT
} from './scoring'

type Bindings = {
  news_db: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: any;
  REDDIT_CLIENT_ID: string;
  REDDIT_CLIENT_SECRET: string;
  REDDIT_REFRESH_TOKEN: string;
  AUTHORIZED_NOSTR_PUBKEY: string;
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
  GMAIL_SEARCH_QUERY?: string;
  DIGEST_TIMEZONE?: string;
  INGESTION_SECRET?: string;
  FRONTEND_URL?: string;
  USE_EMRE_THEME?: string;
  ENABLE_HN?: string;
  ENABLE_REDDIT?: string;
  ENABLE_LOBSTERS?: string;
  ENABLE_STACKER?: string;
  ENABLE_GMAIL?: string;
  ASSETS?: Fetcher;
}

// D1 caps bound parameters per statement at 100.
const D1_MAX_BOUND_PARAMS = 90;

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', async (c, next) => {
  const corsMiddleware = cors({
    origin: (origin) => {
      // Allow local development and the production frontend
      if (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173' || origin === 'http://localhost:8787') {
        return origin;
      }
      return c.env.FRONTEND_URL || 'https://news.emre.xyz';
    }
  });
  return corsMiddleware(c, next);
});

// Explicit column list: never ship stored embeddings to views or API consumers.
const ARTICLE_COLUMNS = 'id, title, url, source, created_at, is_liked, image_url, summary, follower_likes, sources, source_count, importance_score, cluster_id, seen_count, last_seen_at, expires_at';
// Rows predating per-article retention fall back to the previous fixed 2-day window.
const LIVE_ARTICLE_CONDITION = "coalesce(expires_at, datetime(created_at, '+2 days')) >= datetime('now')";
const RSS_LIMIT = 50;

type FeedSort = 'hot' | 'latest' | 'digest';

function parseFeedSort(value?: string): FeedSort {
  return value === 'latest' || value === 'digest' ? value : 'hot';
}

function formatArticle(article: any): ArticleModel {
  const sources = parseSources(article.sources, article.source);
  return {
    ...article,
    sources,
    source_count: article.source_count || sources.length || 1,
    seen_count: article.seen_count || 1,
    importance_score: article.importance_score || 1.0
  };
}

function resolveDigestTimeZone(configured?: string): string {
  if (!configured) return DEFAULT_DIGEST_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: configured });
    return configured;
  } catch (e) {
    console.error(`Invalid DIGEST_TIMEZONE "${configured}", falling back to ${DEFAULT_DIGEST_TIME_ZONE}`, e);
    return DEFAULT_DIGEST_TIME_ZONE;
  }
}

async function loadLiveArticles(env: Bindings, sort: FeedSort, source: string): Promise<ArticleModel[]> {
  const conditions = [LIVE_ARTICLE_CONDITION];
  const params: string[] = [];
  if (source !== 'all') {
    conditions.push('(source = ? OR sources LIKE ?)');
    params.push(source, `%"${source}"%`);
  }
  if (sort === 'digest') {
    conditions.push(`created_at >= datetime('now', '-${DIGEST_DAYS} days')`);
  }

  // Hot and digest are ranked in TS (D1 disallows SQL math functions such as power()); the live set
  // is bounded by retention, so loading it whole is cheap. Latest stays a plain indexed SQL sort.
  const tail = sort === 'latest'
    ? `ORDER BY coalesce(last_seen_at, created_at) DESC LIMIT ${FEED_LIMIT}`
    : '';
  const query = `SELECT ${ARTICLE_COLUMNS} FROM articles WHERE ${conditions.join(' AND ')} ${tail}`;
  const { results } = await env.news_db.prepare(query).bind(...params).all();
  return (results || []).map(formatArticle);
}

// SSR Home Feed Route
app.get('/', async (c) => {
  const sort = parseFeedSort(c.req.query('sort'));
  const source = c.req.query('source') || 'all';
  const now = new Date();

  const articles = await loadLiveArticles(c.env, sort, source);
  const latest: any = await c.env.news_db.prepare('SELECT MAX(created_at) as last_curated_at FROM articles').first();

  const digestGroups = sort === 'digest'
    ? groupDigest(articles, now, resolveDigestTimeZone(c.env.DIGEST_TIMEZONE))
    : undefined;
  const feedArticles = sort === 'hot' ? rankHot(articles, now) : articles;

  const useEmreTheme = c.env.USE_EMRE_THEME !== 'false';

  return c.html(
    <FeedView
      articles={feedArticles}
      digestGroups={digestGroups}
      sort={sort}
      sourceFilter={source}
      lastCuratedAt={latest?.last_curated_at || null}
      useEmreTheme={useEmreTheme}
    />
  );
});

// SSR Single Article Permalink Route
app.get('/article/:id', async (c) => {
  const id = c.req.param('id');
  const article: any = await c.env.news_db.prepare(`SELECT ${ARTICLE_COLUMNS} FROM articles WHERE id = ?`).bind(id).first();

  const useEmreTheme = c.env.USE_EMRE_THEME !== 'false';

  if (!article) {
    return c.html(
      <Layout title="Article Not Found - AI Curated News" useEmreTheme={useEmreTheme}>
        <main class="max-w-3xl mx-auto px-4 py-16 text-center">
          <h1 class="text-2xl font-bold text-[var(--color-ink)] mb-4">Article Not Found</h1>
          <p class="text-[var(--color-ink-muted)] mb-8">The requested article could not be found or has expired.</p>
          <a href="/" class="px-4 py-2 rounded-lg bg-[var(--color-surface-elevated)] border border-[var(--color-border)] text-[var(--color-ink)] text-sm font-medium hover:bg-[var(--color-surface-hover)]">
            &larr; Back to Feed
          </a>
        </main>
      </Layout>,
      404
    );
  }

  const formattedArticle: ArticleModel = {
    ...article,
    sources: parseSources(article.sources, article.source),
    source_count: article.source_count || parseSources(article.sources, article.source).length || 1,
    importance_score: article.importance_score || 1.0
  };

  return c.html(
    <ArticleDetailView
      article={formattedArticle}
      useEmreTheme={useEmreTheme}
    />
  );
});

// RSS 2.0 XML Feed Route
app.get('/rss.xml', async (c) => {
  const { results } = await c.env.news_db.prepare(
    `SELECT ${ARTICLE_COLUMNS} FROM articles 
     WHERE ${LIVE_ARTICLE_CONDITION} 
     ORDER BY created_at DESC 
     LIMIT ${RSS_LIMIT}`
  ).all();

  const formattedArticles: ArticleModel[] = (results || []).map(formatArticle);

  const siteUrl = c.env.FRONTEND_URL || 'https://news.emre.xyz';
  const rssXml = generateRssFeed(formattedArticles, siteUrl);

  return new Response(rssXml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': 'inline',
      'Cache-Control': 'public, max-age=1800, s-maxage=3600'
    }
  });
});

app.get('/rss', (c) => c.redirect('/rss.xml', 301));
app.get('/feed', (c) => c.redirect('/rss.xml', 301));

app.get('/api/articles', async (c) => {
  const requestedSort = parseFeedSort(c.req.query('sort'));
  // The JSON API keeps its flat contract: digest is an SSR-only view, so it falls back to hot here.
  const sort: FeedSort = requestedSort === 'digest' ? 'hot' : requestedSort;
  const articles = await loadLiveArticles(c.env, sort, 'all');
  const formattedArticles = sort === 'hot' ? rankHot(articles, new Date()) : articles;

  const latest: any = await c.env.news_db.prepare('SELECT MAX(created_at) as last_curated_at FROM articles').first();

  c.header('Cache-Control', 'no-cache');
  return c.json({
    meta: {
      last_curated_at: latest?.last_curated_at || null,
      sort
    },
    data: formattedArticles
  });
})

app.post('/api/articles/:id/like', async (c) => {
  const id = c.req.param('id');
  const payload = await c.req.json();
  const event = payload.event;
  const env = c.env;

  const article: any = await env.news_db.prepare('SELECT * FROM articles WHERE id = ?').bind(id).first();
  if (!article) {
    return c.json({ error: 'Article not found' }, 404);
  }

  // Anonymous Like (no event)
  if (!event) {
    await env.news_db.prepare('UPDATE articles SET follower_likes = follower_likes + 1 WHERE id = ?').bind(id).run();
    return c.json({ success: true, type: 'anonymous_like' });
  }

  // Verify the signature cryptographically
  try {
    const isValid = verifyEvent(event);
    if (!isValid) {
      return c.json({ error: 'Invalid signature' }, 400);
    }
  } catch (e) {
    return c.json({ error: 'Error verifying signature' }, 400);
  }

  // Check if it's a follower sharing (not the owner)
  if (event.pubkey !== env.AUTHORIZED_NOSTR_PUBKEY) {
    await env.news_db.prepare('UPDATE articles SET follower_likes = follower_likes + 1 WHERE id = ?').bind(id).run();
    return c.json({ success: true, type: 'follower_like' });
  }

  // If it is the owner, mark as liked in DB and train AI
  await env.news_db.prepare('UPDATE articles SET is_liked = 1, follower_likes = follower_likes + 1 WHERE id = ?').bind(id).run();

  // Scrape content and upsert to AI memory
  const details = await scrapeArticleDetails(article.url as string);
  const textToEmbed = buildEmbeddingText({
    title: article.title,
    source: article.source,
    description: details.description,
    content: details.content
  });
  
  try {
    const embedRes: any = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [textToEmbed] });
    const embedding = embedRes.data[0];
    
    const vectorId = `liked-${id}`;
    await env.VECTORIZE.upsert([{
      id: vectorId,
      values: embedding,
      metadata: { source: article.source, type: 'like', url: article.url, title: article.title }
    }]);

    // Update user taste profile in background
    await updateUserTasteProfile(env);
  } catch (e) {
    console.error('Failed to embed liked article', e);
  }

  return c.json({ success: true });
})

app.post('/api/articles/:id/dislike', async (c) => {
  const id = c.req.param('id');
  const payload = await c.req.json();
  const event = payload.event;
  const env = c.env;

  if (!event) {
    return c.json({ error: 'Signature required for dislike' }, 400);
  }

  try {
    const isValid = verifyEvent(event);
    if (!isValid) {
      return c.json({ error: 'Invalid signature' }, 400);
    }
  } catch (e) {
    return c.json({ error: 'Error verifying signature' }, 400);
  }

  if (event.pubkey !== env.AUTHORIZED_NOSTR_PUBKEY) {
    return c.json({ error: 'Only owner can dislike' }, 403);
  }

  const article: any = await env.news_db.prepare('SELECT * FROM articles WHERE id = ?').bind(id).first();
  if (!article) {
    return c.json({ error: 'Article not found' }, 404);
  }

  const details = await scrapeArticleDetails(article.url as string);
  const textToEmbed = buildEmbeddingText({
    title: article.title,
    source: article.source,
    description: details.description,
    content: details.content
  });
  
  try {
    const embedRes: any = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [textToEmbed] });
    const embedding = embedRes.data[0];
    
    const vectorId = `disliked-${id}`;
    await env.VECTORIZE.upsert([{
      id: vectorId,
      values: embedding,
      metadata: { source: article.source, type: 'dislike', url: article.url, title: article.title }
    }]);

    // Update user taste profile in background
    await updateUserTasteProfile(env);
  } catch (e) {
    console.error('Failed to embed disliked article', e);
  }

  await env.news_db.prepare('DELETE FROM articles WHERE id = ?').bind(id).run();

  return c.json({ success: true });
})

interface ScrapedDetails {
  description: string;
  headings: string;
  content: string;
  fullText: string;
}

async function scrapeArticleDetails(url: string): Promise<ScrapedDetails> {
  const result: ScrapedDetails = {
    description: '',
    headings: '',
    content: '',
    fullText: ''
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) return result;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      return result;
    }

    let rawHeadings = '';
    let rawParagraphs = '';
    let rawDescription = '';

    const rewriter = new HTMLRewriter()
      .on('meta[name="description"], meta[property="og:description"], meta[name="twitter:description"]', {
        element(el) {
          if (!rawDescription) {
            const content = el.getAttribute('content');
            if (content) rawDescription = content.trim();
          }
        }
      })
      .on('h1, h2, h3', {
        text(textChunk) {
          if (textChunk.text) rawHeadings += textChunk.text + ' ';
        }
      })
      .on('p, article p, main p, div.entry-content p, div.post-content p', {
        text(textChunk) {
          if (textChunk.text) rawParagraphs += textChunk.text + ' ';
        }
      });

    await rewriter.transform(res).text();

    result.description = rawDescription.replace(/\s+/g, ' ').trim().substring(0, 350);
    result.headings = rawHeadings.replace(/\s+/g, ' ').trim().substring(0, 300);
    result.content = rawParagraphs.replace(/\s+/g, ' ').trim().substring(0, 1500);

    const parts = [];
    if (result.description) parts.push(result.description);
    if (result.headings) parts.push(result.headings);
    if (result.content) parts.push(result.content);
    result.fullText = parts.join(' ').substring(0, 1500);
  } catch (e) {
    // Gracefully handle network/timeout errors
  }

  return result;
}

async function scrapeContent(url: string): Promise<string> {
  const details = await scrapeArticleDetails(url);
  return details.fullText;
}

function buildEmbeddingText(article: { title: string; source?: string; description?: string; content?: string }): string {
  const parts: string[] = [`Title: ${article.title.trim()}`];
  if (article.source) {
    parts.push(`Source: ${article.source}`);
  }
  if (article.description && article.description.trim().length > 0) {
    parts.push(`Description: ${article.description.trim()}`);
  }
  if (article.content && article.content.trim().length > 0) {
    parts.push(`Content: ${article.content.trim().substring(0, 1200)}`);
  }
  return parts.join('\n\n');
}

function normalizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const paramsToKeep: [string, string][] = [];
    const trackingParams = new Set([
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'ref', 'ref_src', 'fbclid', 'gclid', 'twclid', 'igshid', 'mc_cid', 'mc_eid', '_ga'
    ]);
    parsed.searchParams.forEach((val, key) => {
      if (!trackingParams.has(key.toLowerCase()) && !key.toLowerCase().startsWith('utm_')) {
        paramsToKeep.push([key, val]);
      }
    });
    parsed.search = '';
    for (const [k, v] of paramsToKeep) {
      parsed.searchParams.append(k, v);
    }
    parsed.hash = '';
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return rawUrl ? rawUrl.trim() : '';
  }
}

interface MatchEvaluation {
  affinityScore: number;
  topPositiveScore: number;
  topNegativeScore: number;
  positiveCount: number;
  negativeCount: number;
  recommendation: 'accept' | 'reject' | 'uncertain';
}

function evaluateVectorMatches(matches: Array<{ id: string; score: number; metadata?: any }>): MatchEvaluation {
  if (!matches || matches.length === 0) {
    // Cold start - pass to LLM curation
    return {
      affinityScore: 0.5,
      topPositiveScore: 0,
      topNegativeScore: 0,
      positiveCount: 0,
      negativeCount: 0,
      recommendation: 'uncertain'
    };
  }

  let weightedPosScore = 0;
  let weightedNegScore = 0;
  let topPosScore = 0;
  let topNegScore = 0;
  let posCount = 0;
  let negCount = 0;

  for (const match of matches) {
    const isDislike = match.metadata?.type === 'dislike';
    const score = match.score;

    if (isDislike) {
      negCount++;
      if (score > topNegScore) topNegScore = score;
      if (score >= 0.60) {
        weightedNegScore += Math.pow((score - 0.60) / 0.40, 2);
      }
    } else {
      posCount++;
      if (score > topPosScore) topPosScore = score;
      if (score >= 0.55) {
        weightedPosScore += Math.pow((score - 0.55) / 0.45, 1.5);
      }
    }
  }

  // Hard rejection if very close to a disliked article
  if (topNegScore >= 0.78) {
    return {
      affinityScore: 0,
      topPositiveScore: topPosScore,
      topNegativeScore: topNegScore,
      positiveCount: posCount,
      negativeCount: negCount,
      recommendation: 'reject'
    };
  }

  const netScore = weightedPosScore - (weightedNegScore * 1.5);

  let recommendation: 'accept' | 'reject' | 'uncertain' = 'uncertain';
  if (topPosScore >= 0.76 && netScore > 0.8 && topNegScore < 0.65) {
    recommendation = 'accept';
  } else if (topNegScore >= 0.70 && netScore < 0) {
    recommendation = 'reject';
  } else {
    recommendation = 'uncertain';
  }

  return {
    affinityScore: netScore,
    topPositiveScore: topPosScore,
    topNegativeScore: topNegScore,
    positiveCount: posCount,
    negativeCount: negCount,
    recommendation
  };
}

async function getUserTasteProfile(env: Bindings): Promise<string> {
  try {
    const row: any = await env.news_db.prepare("SELECT value FROM user_preferences WHERE key = 'taste_profile'").first();
    if (row && row.value) {
      return row.value;
    }
  } catch (e) {
    console.error('Error fetching user taste profile', e);
  }
  return "Topics of interest: High-signal software engineering, systems programming, distributed systems, AI engineering, database internals, open-source projects, and developer tools. Dislikes: Low-effort tutorials, generic marketing/SEO, crypto hype, and corporate PR.";
}

async function updateUserTasteProfile(env: Bindings): Promise<void> {
  try {
    const likedRows: any = await env.news_db.prepare(
      "SELECT title, source FROM articles WHERE is_liked = 1 ORDER BY created_at DESC LIMIT 15"
    ).all();
    const likedArticles = likedRows.results || [];

    if (likedArticles.length === 0) return;

    const likedTitles = likedArticles.map((a: any) => `- [${a.source}] ${a.title}`).join('\n');

    const prompt = `Based on these recently liked tech articles by a senior software engineer:\n${likedTitles}\n\nWrite a 2-3 sentence concise description of their current reading preferences, technical focus areas, and topics they enjoy. Return ONLY the concise text summary, no introductory remarks.`;

    const aiRes: any = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: 'You are an AI analyst that profiles developer reading interests.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 250
    });

    if (aiRes && aiRes.response) {
      const tasteSummary = aiRes.response.trim();
      await env.news_db.prepare(
        "INSERT INTO user_preferences (key, value, updated_at) VALUES ('taste_profile', ?1, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(tasteSummary).run();
    }
  } catch (e) {
    console.error('Error updating user taste profile', e);
  }
}

async function curateArticlesWithLLM(
  env: Bindings,
  candidates: Array<{ id: string; title: string; url: string; source: string; details?: ScrapedDetails; vectorEval?: MatchEvaluation }>,
  tasteProfile: string
): Promise<Set<string>> {
  const selectedIds = new Set<string>();
  if (candidates.length === 0) return selectedIds;

  const candidatePayload = candidates.map((c, index) => ({
    id: c.id,
    index,
    title: c.title,
    source: c.source,
    description: c.details?.description || c.details?.headings || ''
  }));

  const systemPrompt = `You are an expert news curation editor for a senior software engineer and hacker.
Filter the following candidate articles based on the user's taste profile and quality standards.

User Taste Profile:
${tasteProfile}

Curation Guidelines:
- ACCEPT: In-depth engineering postmortems, architecture breakdowns, systems & compiler internals, novel AI agent techniques, open source tools, security/vulnerability research, database systems, rigorous performance analysis.
- REJECT: Superficial AI hype, listicles ("Top 10 tools"), beginner-level tutorials, corporate marketing/PR announcements, paywalled teasers, crypto/trading spam, generic non-technical lifestyle posts.

Return ONLY a valid JSON object with the array of selected article ids.
Format:
{"selected_ids": ["id-1", "id-2"]}`;

  try {
    const aiRes: any = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(candidatePayload) }
      ],
      max_tokens: 1024
    });

    let text = aiRes.response || '';
    if (text.startsWith('```json')) {
      text = text.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    } else if (text.startsWith('```')) {
      text = text.replace(/^```\n?/, '').replace(/\n?```$/, '');
    }

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.selected_ids)) {
        for (const id of parsed.selected_ids) {
          selectedIds.add(id);
        }
      } else if (Array.isArray(parsed.selected_indices)) {
        for (const idx of parsed.selected_indices) {
          if (candidates[idx]) selectedIds.add(candidates[idx].id);
        }
      }
    } catch (parseErr) {
      const regex = /"(hn-[^"]+|lobsters-[^"]+|reddit-[^"]+|newsletter-[^"]+|stacker-[^"]+)"/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        selectedIds.add(match[1]);
      }
    }
  } catch (e) {
    console.error('LLM Curation failed, falling back to all candidates', e);
    for (const c of candidates) {
      selectedIds.add(c.id);
    }
  }

  return selectedIds;
}


app.get('/bootstrap-reddit-history', async (c) => {
  const env = c.env;
  if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET || !env.REDDIT_REFRESH_TOKEN) {
    return c.text('Missing Reddit credentials', 500);
  }
  
  // Get token
  const auth = btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`);
  const tokenRes = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "NewsAggregatorCron/1.0.0"
    },
    body: `grant_type=refresh_token&refresh_token=${env.REDDIT_REFRESH_TOKEN}`
  });
  if (!tokenRes.ok) return c.text('Failed to get token', 500);
  const tokenData: any = await tokenRes.json();
  const accessToken = tokenData.access_token;
  
  // Fetch user profile
  const meRes = await fetch("https://oauth.reddit.com/api/v1/me", {
    headers: { "Authorization": `Bearer ${accessToken}`, "User-Agent": "NewsAggregatorCron/1.0.0" }
  });
  if (!meRes.ok) return c.text('Failed to get user profile', 500);
  const meData: any = await meRes.json();
  const username = meData.name;
  
  // Fetch upvoted
  const upvotedRes = await fetch(`https://oauth.reddit.com/user/${username}/upvoted?limit=25`, {
    headers: { "Authorization": `Bearer ${accessToken}`, "User-Agent": "NewsAggregatorCron/1.0.0" }
  });
  if (!upvotedRes.ok) return c.text('Failed to get upvoted', 500);
  const upvotedData: any = await upvotedRes.json();
  
  const posts = upvotedData.data?.children || [];
  const inserted = [];
  
  for (const post of posts) {
    const item = post.data;
    if (item && item.title) {
      const url = item.url || `https://www.reddit.com${item.permalink}`;
      const details = await scrapeArticleDetails(url);
      const textToEmbed = buildEmbeddingText({
        title: item.title,
        source: 'reddit',
        description: details.description,
        content: details.content
      });
      
      try {
        const embedRes: any = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [textToEmbed] });
        const embedding = embedRes.data[0];
        
        const vectorId = `reddit-upvote-${item.id}`;
        await env.VECTORIZE.upsert([{
          id: vectorId,
          values: embedding,
          metadata: { source: 'reddit', type: 'upvote', url, title: item.title }
        }]);
        inserted.push(item.title);
      } catch (e) {
        console.error('Failed to embed/upsert', item.title, e);
      }
    }
  }
  
  return c.json({ success: true, inserted_count: inserted.length, inserted });
});

app.get('/bootstrap-lobsters-history', async (c) => {
  const env = c.env;
  const token = c.req.query('token');
  if (!token) return c.text('Please provide ?token=...', 400);

  const res = await fetch(`https://lobste.rs/upvoted/stories.rss?token=${token}`, {
    headers: { 'User-Agent': 'NewsAggregatorCron/1.0.0' }
  });
  if (!res.ok) return c.text('Failed to fetch Lobsters RSS', 500);
  
  const text = await res.text();
  const items = [...text.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>[\s\S]*?<link>(.*?)<\/link>[\s\S]*?<\/item>/g)];
  
  const inserted = [];
  for (const match of items) {
    const title = match[1];
    const url = match[2];
    const details = await scrapeArticleDetails(url);
    const textToEmbed = buildEmbeddingText({
      title,
      source: 'lobsters',
      description: details.description,
      content: details.content
    });
    
    try {
      const embedRes: any = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [textToEmbed] });
      const embedding = embedRes.data[0];
      
      const vectorId = `lobsters-upvote-${Date.now()}-${Math.floor(Math.random()*1000)}`;
      await env.VECTORIZE.upsert([{
        id: vectorId,
        values: embedding,
        metadata: { source: 'lobsters', type: 'upvote', url, title }
      }]);
      inserted.push(title);
    } catch (e) {
      console.error('Failed to embed/upsert', title, e);
    }
  }

  return c.json({ success: true, inserted_count: inserted.length, inserted });
});

app.get('/bootstrap-hn-history', async (c) => {
  const env = c.env;
  const username = c.req.query('id');
  if (!username) return c.text('Please provide ?id=YOUR_HN_USERNAME', 400);

  const res = await fetch(`https://news.ycombinator.com/upvoted?id=${username}`, {
    headers: { 'User-Agent': 'NewsAggregatorCron/1.0.0' }
  });
  
  const text = await res.text();
  if (text.includes('Sorry.')) {
    return c.text('HN profile is private. Please go to HackerNews Settings and set "showupvoted" to yes, then try again.', 403);
  }

  const items = [];
  const rewriter = new HTMLRewriter().on('.athing', {
    element(el) {
      items.push({ id: el.getAttribute('id') });
    }
  }).on('.titleline > a', {
    element(el) {
      const last = items[items.length - 1];
      if (last && !last.url) {
        last.url = el.getAttribute('href');
      }
    },
    text(textChunk) {
      const last = items[items.length - 1];
      if (last) {
        last.title = (last.title || '') + textChunk.text;
      }
    }
  });

  await rewriter.transform(res).text();

  const inserted = [];
  for (const item of items) {
    if (item.title && item.url) {
      let url = item.url;
      if (url.startsWith('item?id=')) {
        url = `https://news.ycombinator.com/${url}`;
      }
      
      const details = await scrapeArticleDetails(url);
      const textToEmbed = buildEmbeddingText({
        title: item.title.trim(),
        source: 'hackernews',
        description: details.description,
        content: details.content
      });
      
      try {
        const embedRes: any = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [textToEmbed] });
        const embedding = embedRes.data[0];
        
        const vectorId = `hn-upvote-${item.id}`;
        await env.VECTORIZE.upsert([{
          id: vectorId,
          values: embedding,
          metadata: { source: 'hackernews', type: 'upvote', url, title: item.title.trim() }
        }]);
        inserted.push(item.title.trim());
      } catch (e) {
        console.error('Failed to embed/upsert', item.title, e);
      }
    }
  }

  return c.json({ success: true, inserted_count: inserted.length, inserted });
});

app.post('/bootstrap-hn-json', async (c) => {
  const env = c.env;
  const items = await c.req.json();
  
  if (!Array.isArray(items)) return c.text('Expected JSON array', 400);

  const inserted = [];
  for (const item of items) {
    if (item.title && item.link) {
      let url = item.link;
      
      const details = await scrapeArticleDetails(url);
      const textToEmbed = buildEmbeddingText({
        title: item.title.trim(),
        source: 'hackernews',
        description: details.description,
        content: details.content
      });
      
      try {
        const embedRes: any = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [textToEmbed] });
        const embedding = embedRes.data[0];
        
        const vectorId = `hn-upvote-json-${Date.now()}-${Math.floor(Math.random()*1000)}`;
        await env.VECTORIZE.upsert([{
          id: vectorId,
          values: embedding,
          metadata: { source: 'hackernews', type: 'upvote', url, title: item.title.trim() }
        }]);
        inserted.push(item.title.trim());
      } catch (e) {
        console.error('Failed to embed/upsert', item.title, e);
      }
    }
  }

  return c.json({ success: true, inserted_count: inserted.length, inserted });
});

async function isAuthorizedForIngestion(c: any): Promise<boolean> {
  const url = new URL(c.req.url);
  // 1. Allow localhost / 127.0.0.1 for local development
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return true;
  }

  // 2. Secret Key auth via header (Authorization: Bearer <SECRET> or X-Ingestion-Key: <SECRET>) or query param (?key=<SECRET>)
  const authHeader = c.req.header('Authorization');
  const customKeyHeader = c.req.header('X-Ingestion-Key');
  const queryKey = c.req.query('key');
  const configuredSecret = c.env.INGESTION_SECRET;

  if (configuredSecret && configuredSecret.length > 0) {
    if (authHeader && authHeader.startsWith('Bearer ') && authHeader.slice(7).trim() === configuredSecret) {
      return true;
    }
    if (customKeyHeader && customKeyHeader.trim() === configuredSecret) {
      return true;
    }
    if (queryKey && queryKey.trim() === configuredSecret) {
      return true;
    }
  }

  // 3. Nostr Signature verification via header
  const nostrAuthHeader = c.req.header('X-Nostr-Event') || c.req.header('X-Nostr-Auth');
  if (nostrAuthHeader && c.env.AUTHORIZED_NOSTR_PUBKEY) {
    try {
      const event = typeof nostrAuthHeader === 'string' && nostrAuthHeader.startsWith('{')
        ? JSON.parse(nostrAuthHeader)
        : JSON.parse(atob(nostrAuthHeader));
      if (verifyEvent(event) && event.pubkey === c.env.AUTHORIZED_NOSTR_PUBKEY) {
        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - event.created_at) < 300) {
          return true;
        }
      }
    } catch {}
  }

  // 4. Nostr Signature verification via POST body
  if (c.req.method === 'POST') {
    try {
      const body = await c.req.raw.clone().json();
      if (body && body.event && c.env.AUTHORIZED_NOSTR_PUBKEY) {
        if (verifyEvent(body.event) && body.event.pubkey === c.env.AUTHORIZED_NOSTR_PUBKEY) {
          const now = Math.floor(Date.now() / 1000);
          if (Math.abs(now - body.event.created_at) < 300) {
            return true;
          }
        }
      }
    } catch {}
  }

  return false;
}

async function isAuthorizedAdmin(c: any): Promise<boolean> {
  const url = new URL(c.req.url);
  // 1. Allow localhost / 127.0.0.1 for local development
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return true;
  }

  // 2. Secret Key auth via header or query param
  const authHeader = c.req.header('Authorization');
  const customKeyHeader = c.req.header('X-Ingestion-Key');
  const queryKey = c.req.query('key');
  const configuredSecret = c.env.INGESTION_SECRET;

  if (configuredSecret && configuredSecret.length > 0) {
    if (authHeader && authHeader.startsWith('Bearer ') && authHeader.slice(7).trim() === configuredSecret) {
      return true;
    }
    if (customKeyHeader && customKeyHeader.trim() === configuredSecret) {
      return true;
    }
    if (queryKey && queryKey.trim() === configuredSecret) {
      return true;
    }
  }

  // 3. Nostr Signature verification via header, cookie, or query param
  let nostrRaw = c.req.header('X-Nostr-Event') || c.req.header('X-Nostr-Auth') || c.req.query('nostr_auth');
  if (!nostrRaw) {
    const cookieHeader = c.req.header('Cookie') || '';
    const match = cookieHeader.match(/news_nostr_auth=([^;]+)/);
    if (match && match[1]) {
      try {
        nostrRaw = decodeURIComponent(match[1]);
      } catch {}
    }
  }

  if (nostrRaw && c.env.AUTHORIZED_NOSTR_PUBKEY) {
    try {
      const event = typeof nostrRaw === 'string' && nostrRaw.startsWith('{')
        ? JSON.parse(nostrRaw)
        : JSON.parse(atob(nostrRaw));
      if (verifyEvent(event) && event.pubkey === c.env.AUTHORIZED_NOSTR_PUBKEY) {
        const now = Math.floor(Date.now() / 1000);
        // Allow within 3600 seconds (1 hour) for admin sessions
        if (Math.abs(now - event.created_at) < 3600) {
          return true;
        }
      }
    } catch (err) {
      console.error('Nostr admin verification error', err);
    }
  }

  return false;
}

// Diagnostic Debugger UI Route (Localhost & Nostr Verified Admin in Production)
app.get('/debug', async (c) => {
  const url = new URL(c.req.url);
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const isAuthorized = await isAuthorizedAdmin(c);
  const source = c.req.query('source') || 'all';
  const useEmreTheme = c.env.USE_EMRE_THEME !== 'false';

  if (!isAuthorized) {
    return c.html(
      <DebugView
        isAuthorized={false}
        isLocal={isLocal}
        authorizedPubkey={c.env.AUTHORIZED_NOSTR_PUBKEY}
        currentSource={source}
        useEmreTheme={useEmreTheme}
      />
    );
  }

  try {
    const report = await runDebugPipeline(c.env, source);
    report.is_local = isLocal;
    report.is_admin_authenticated = isAuthorized;
    report.admin_pubkey = c.env.AUTHORIZED_NOSTR_PUBKEY;

    return c.html(
      <DebugView
        report={report}
        isAuthorized={true}
        isLocal={isLocal}
        authorizedPubkey={c.env.AUTHORIZED_NOSTR_PUBKEY}
        currentSource={source}
        useEmreTheme={useEmreTheme}
      />
    );
  } catch (err: any) {
    return c.html(
      <DebugView
        error={err?.message || String(err)}
        isAuthorized={true}
        isLocal={isLocal}
        authorizedPubkey={c.env.AUTHORIZED_NOSTR_PUBKEY}
        currentSource={source}
        useEmreTheme={useEmreTheme}
      />
    );
  }
});

// Diagnostic Debugger JSON API Route
app.get('/api/debug', async (c) => {
  const url = new URL(c.req.url);
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const isAuthorized = await isAuthorizedAdmin(c);

  if (!isAuthorized) {
    return c.json({
      error: 'Unauthorized',
      message: 'Access restricted. Authenticate via Nostr (NIP-07), provide Authorization Bearer token, or connect via localhost.'
    }, 401);
  }

  const source = c.req.query('source') || 'all';
  try {
    const report = await runDebugPipeline(c.env, source);
    report.is_local = isLocal;
    report.is_admin_authenticated = isAuthorized;
    report.admin_pubkey = c.env.AUTHORIZED_NOSTR_PUBKEY;
    return c.json(report);
  } catch (err: any) {
    return c.json({ error: 'Debug pipeline error', message: err?.message || String(err) }, 500);
  }
});

const handleIngestEndpoint = async (c: any) => {
  const isAuth = await isAuthorizedAdmin(c);
  if (!isAuth) {
    return c.json({
      error: 'Unauthorized',
      message: 'Access restricted. Provide Authorization Bearer header, ?key= query parameter, or Nostr admin authentication.'
    }, 401);
  }

  const source = c.req.query('source');
  const stats = await handleIngestion(c.env, source);
  return c.json({ message: 'Ingestion complete!', source: source || 'all', stats });
};

app.get('/api/admin/ingest', handleIngestEndpoint);
app.post('/api/admin/ingest', handleIngestEndpoint);
app.get('/test-ingestion', handleIngestEndpoint);
app.post('/test-ingestion', handleIngestEndpoint);

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    const sources = [];
    if (env.ENABLE_HN !== 'false') sources.push('hn');
    if (env.ENABLE_LOBSTERS !== 'false') sources.push('lobsters');
    if (env.ENABLE_STACKER !== 'false') sources.push('stacker');
    if (env.ENABLE_REDDIT !== 'false') sources.push('reddit');
    if (env.ENABLE_GMAIL === 'true') sources.push('gmail');

    if (sources.length === 0) return;

    // Run exactly one source per hour to bypass the 50 subrequest limit without using multiple cron triggers
    const hour = new Date(event.scheduledTime).getUTCHours();
    const cycle = hour % sources.length;
    
    ctx.waitUntil(handleIngestion(env, sources[cycle]));
  }
}

async function handleIngestion(env: Bindings, targetSource?: string) {
  const stats: any = { raw: 0, filtered: 0, inserted: 0, errors: [] };
  const rawArticles: {
    id: string;
    title: string;
    url: string;
    source: string;
    image_url?: string;
    summary?: string;
    details?: ScrapedDetails;
  }[] = [];

  if (!targetSource || targetSource === 'hn') {
    // Fetch Hacker News
    try {
      const hnRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
      if (hnRes.ok) {
        const topIds: number[] = await hnRes.json();
        const top10 = topIds.slice(0, 10);
        for (const id of top10) {
          const itemRes = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
          if (itemRes.ok) {
            const item: any = await itemRes.json();
            if (item.url) {
              rawArticles.push({
                id: `hn-${item.id}`,
                title: item.title,
                url: item.url,
                source: 'hackernews'
              });
            }
          }
        }
      }
    } catch (e: any) { stats.errors.push('HN error: ' + e.message); console.error('HN error', e); }
  }

  if (!targetSource || targetSource === 'lobsters') {
    // Fetch Lobsters
    try {
      const lobstersRes = await fetch('https://lobste.rs/hottest.json');
      if (lobstersRes.ok) {
        const lobsters: any[] = await lobstersRes.json();
        const top10 = lobsters.slice(0, 10);
        for (const item of top10) {
          if (item.url) {
            rawArticles.push({
              id: `lobsters-${item.short_id}`,
              title: item.title,
              url: item.url,
              source: 'lobsters'
            });
          }
        }
      }
    } catch (e: any) { stats.errors.push('Lobsters error: ' + e.message); console.error('Lobsters error', e); }
  }

  if (!targetSource || targetSource === 'stacker') {
    // Fetch Stacker News
    try {
      const stackerArticles = await fetchStackerNews();
      rawArticles.push(...stackerArticles.slice(0, 15));
    } catch (e: any) { stats.errors.push('Stacker News error: ' + e.message); console.error('Stacker News error', e); }
  }

  if (!targetSource || targetSource === 'reddit') {
    // Fetch Reddit
    try {
      const redditArticles = await fetchRedditPosts(env);
      rawArticles.push(...redditArticles);
    } catch (e: any) { stats.errors.push('Reddit error: ' + e.message); console.error('Reddit error', e); }
  }

  if (!targetSource || targetSource === 'gmail') {
    // Fetch Gmail Newsletters
    try {
      const newsletterArticles = await fetchGmailNewsletters(env);
      rawArticles.push(...newsletterArticles);
    } catch (e: any) { stats.errors.push('Gmail error: ' + e.message); console.error('Gmail error', e); }
  }

  stats.raw = rawArticles.length;
  if (rawArticles.length === 0) return stats;

  // Deduplicate and aggregate rawArticles by normalized URL before slicing
  const urlMap = new Map<string, {
    id: string;
    title: string;
    url: string;
    source: string;
    sources: Set<string>;
    image_url?: string;
    summary?: string;
    details?: ScrapedDetails;
  }>();

  for (const a of rawArticles) {
    const normUrl = normalizeUrl(a.url);
    a.url = normUrl;
    if (!urlMap.has(normUrl)) {
      urlMap.set(normUrl, {
        ...a,
        sources: new Set([a.source])
      });
    } else {
      const existing = urlMap.get(normUrl)!;
      existing.sources.add(a.source);
      if (!existing.image_url && a.image_url) {
        existing.image_url = a.image_url;
      }
      if (!existing.summary && a.summary) {
        existing.summary = a.summary;
      }
      if (!existing.details && a.details) {
        existing.details = a.details;
      }
    }
  }

  const uniqueRawArticles = Array.from(urlMap.values()).map(item => ({
    ...item,
    sources: Array.from(item.sources),
    source_count: item.sources.size
  }));

  const now = new Date();
  const nowSql = toSqliteDateTime(now);

  // Split re-sightings (URL already stored) from brand-new URLs. Re-sightings only bump signals,
  // skipping scrape/embed/judge/summarize, which also frees subrequest budget for new items.
  const existingByUrl = new Map<string, ExistingArticleRow>();
  for (let i = 0; i < uniqueRawArticles.length; i += D1_MAX_BOUND_PARAMS) {
    const urls = uniqueRawArticles.slice(i, i + D1_MAX_BOUND_PARAMS).map(a => a.url);
    const placeholders = urls.map(() => '?').join(',');
    try {
      const existing = await env.news_db.prepare(
        `SELECT id, url, source, sources, source_count, seen_count, importance_score, expires_at FROM articles WHERE url IN (${placeholders})`
      ).bind(...urls).all<ExistingArticleRow>();
      for (const row of existing.results || []) {
        existingByUrl.set(row.url, row);
      }
    } catch (e) {
      console.error('URL map check error', e);
    }
  }

  const resightUpdates: D1PreparedStatement[] = [];
  const newRawArticles: typeof uniqueRawArticles = [];
  for (const article of uniqueRawArticles) {
    const dbRec = existingByUrl.get(article.url);
    if (!dbRec) {
      newRawArticles.push(article);
      continue;
    }
    const dbSources = parseSources(dbRec.sources, dbRec.source);
    const mergedSources = Array.from(new Set([...dbSources, ...article.sources]));
    const previousSeen = dbRec.seen_count || 1;
    const seenCount = previousSeen + 1;
    const importanceScore = rescoreWithSignals(
      dbRec.importance_score,
      dbRec.source_count || dbSources.length || 1,
      previousSeen,
      mergedSources.length,
      seenCount
    );
    resightUpdates.push(env.news_db.prepare(
      'UPDATE articles SET sources = ?1, source_count = ?2, seen_count = ?3, importance_score = ?4, expires_at = ?5, last_seen_at = ?6 WHERE id = ?7'
    ).bind(
      JSON.stringify(mergedSources),
      mergedSources.length,
      seenCount,
      importanceScore,
      computeExpiresAt(mergedSources, importanceScore, now, dbRec.expires_at),
      nowSql,
      dbRec.id
    ));
  }

  if (resightUpdates.length > 0) {
    try {
      await env.news_db.batch(resightUpdates);
      stats.resighted = resightUpdates.length;
    } catch (e: any) {
      stats.errors.push('Re-sighting update error: ' + e.message);
      console.error('Failed to update re-sighted articles', e);
    }
  }

  // Cloudflare Workers have a 50 subrequest limit per invocation.
  // If we run ALL sources (no targetSource), API calls use ~20 subrequests, so we cap scraping to 20.
  // If we run a SINGLE source (via cron), API calls use ~5 subrequests, so we can safely scrape up to 40.
  const limit = targetSource ? 40 : 20;
  const limitedRawArticles = newRawArticles.slice(0, limit);
  if (limitedRawArticles.length === 0) {
    await cleanupExpiredArticles(env, stats);
    return stats;
  }

  // Scrape all contents concurrently and extract rich metadata (bypasses scraping when details are already provided)
  const rawWithDetails = await Promise.all(limitedRawArticles.map(async a => {
    if (a.details && a.details.fullText) {
      return {
        ...a,
        details: a.details
      };
    }
    const details = await scrapeArticleDetails(a.url);
    return {
      ...a,
      details
    };
  }));

  // Multi-Stage Recommendation Engine (k-NN Soft Scoring + LLM Curation Judge)
  let filteredArticles: any[] = [];
  try {
    const textsToEmbed = rawWithDetails.map(a => buildEmbeddingText({
      title: a.title,
      source: a.source,
      description: a.details.description,
      content: a.details.content
    }));
    
    // Batch generate embeddings
    const embedRes: any = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: textsToEmbed });
    const embeddings = embedRes.data;

    const rawWithEmbeddings = rawWithDetails.map((a, idx) => ({
      ...a,
      embedding: embeddings[idx]
    }));

    const definitiveAccepted: any[] = [];
    const candidatePool: any[] = [];

    // Query Vectorize with topK: 6 for multi-neighbor evaluation
    for (let i = 0; i < rawWithEmbeddings.length; i++) {
      const article = rawWithEmbeddings[i];
      const embedding = article.embedding;
      
      try {
        const queryRes = await env.VECTORIZE.query(embedding, { topK: 6, returnMetadata: 'all' });
        const evalResult = evaluateVectorMatches(queryRes.matches);

        if (evalResult.recommendation === 'reject') {
          // Explicitly matches disliked themes
          continue;
        } else if (evalResult.recommendation === 'accept') {
          // Strong affinity match to upvoted/liked content
          definitiveAccepted.push({ ...article, vectorEval: evalResult });
        } else {
          // Ambiguous / Moderate / Cold-start: evaluate via LLM Judge
          candidatePool.push({ ...article, vectorEval: evalResult });
        }
      } catch (e: any) {
        console.error('Vectorize query error', e);
        candidatePool.push(article);
      }
    }

    // Stage 2: Batch LLM Curation Judge for candidate pool
    if (candidatePool.length > 0) {
      const tasteProfile = await getUserTasteProfile(env);
      const approvedIds = await curateArticlesWithLLM(env, candidatePool, tasteProfile);
      const approvedCandidates = candidatePool.filter(a => approvedIds.has(a.id));
      filteredArticles = [...definitiveAccepted, ...approvedCandidates];
    } else {
      filteredArticles = definitiveAccepted;
    }
  } catch (e: any) {
    stats.errors.push('Recommendation pipeline error: ' + e.message);
    console.error('Recommendation pipeline error', e);
    // Fallback if AI/Vectorize fails completely
    filteredArticles = rawWithDetails;
  }

  stats.filtered = filteredArticles.length;

  // Stage 3: Semantic Cross-Source Topic Clustering via Cosine Similarity
  try {
    // Inter-run clustering: compare new articles against stored embeddings of recently active articles.
    // Cron ingests one source per run, so this is what links e.g. an HN and a Lobsters post on the same story.
    let recentDbArticles: RecentClusterRow[] = [];
    try {
      const recentRes = await env.news_db.prepare(
        `SELECT id, url, source, sources, source_count, seen_count, importance_score, cluster_id, expires_at, embedding
         FROM articles
         WHERE embedding IS NOT NULL AND coalesce(last_seen_at, created_at) >= datetime('now', ?1)
         ORDER BY coalesce(last_seen_at, created_at) DESC
         LIMIT ?2`
      ).bind(`-${CLUSTER_LOOKBACK_HOURS} hours`, CLUSTER_MAX_CANDIDATES).all<RecentClusterRow>();
      recentDbArticles = recentRes.results || [];
    } catch (dbErr) {
      console.error('Failed to fetch recent DB articles for clustering', dbErr);
    }

    const recentWithEmbeddings = recentDbArticles
      .map(row => ({ row, embedding: parseEmbedding(row.embedding) }))
      .filter((r): r is { row: RecentClusterRow; embedding: number[] } => r.embedding !== null);

    const touchedDbRows = new Map<string, { row: RecentClusterRow; sources: Set<string>; clusterId: string }>();
    for (const article of filteredArticles) {
      if (!article.embedding) continue;
      for (const { row, embedding } of recentWithEmbeddings) {
        if (row.id === article.id || row.url === article.url) continue;
        if (cosineSimilarity(article.embedding, embedding) < CLUSTER_SIMILARITY_THRESHOLD) continue;

        const touched = touchedDbRows.get(row.id);
        const clusterId = article.cluster_id || touched?.clusterId || row.cluster_id || `cluster-${row.id}`;
        article.cluster_id = clusterId;

        const dbSources = touched ? Array.from(touched.sources) : parseSources(row.sources, row.source);
        const merged = new Set([...(article.sources || [article.source]), ...dbSources]);
        article.sources = Array.from(merged);
        article.source_count = merged.size;
        touchedDbRows.set(row.id, { row, sources: merged, clusterId });
      }
    }

    // Intra-batch clustering: compare pairs of filteredArticles
    for (let i = 0; i < filteredArticles.length; i++) {
      for (let j = i + 1; j < filteredArticles.length; j++) {
        const artA = filteredArticles[i];
        const artB = filteredArticles[j];
        if (artA.embedding && artB.embedding) {
          const sim = cosineSimilarity(artA.embedding, artB.embedding);
          if (sim >= CLUSTER_SIMILARITY_THRESHOLD) {
            // Highly similar topic/event across articles
            const clusterId = artA.cluster_id || artB.cluster_id || `cluster-${artA.id}`;
            artA.cluster_id = clusterId;
            artB.cluster_id = clusterId;

            // Merge sources across the cluster
            const combinedSources = Array.from(new Set([...(artA.sources || [artA.source]), ...(artB.sources || [artB.source])]));
            artA.sources = combinedSources;
            artB.sources = combinedSources;
            artA.source_count = combinedSources.length;
            artB.source_count = combinedSources.length;
          }
        }
      }
    }

    // New coverage of a stored story means it is still active: boost, extend retention and refresh last_seen_at.
    if (touchedDbRows.size > 0) {
      const clusterUpdates = Array.from(touchedDbRows.values()).map(({ row, sources, clusterId }) => {
        const mergedSources = Array.from(sources);
        const seenCount = row.seen_count || 1;
        const importanceScore = rescoreWithSignals(
          row.importance_score,
          row.source_count || parseSources(row.sources, row.source).length || 1,
          seenCount,
          mergedSources.length,
          seenCount
        );
        return env.news_db.prepare(
          'UPDATE articles SET sources = ?1, source_count = ?2, importance_score = ?3, cluster_id = ?4, expires_at = ?5, last_seen_at = ?6 WHERE id = ?7'
        ).bind(
          JSON.stringify(mergedSources),
          mergedSources.length,
          importanceScore,
          clusterId,
          computeExpiresAt(mergedSources, importanceScore, now, row.expires_at),
          nowSql,
          row.id
        );
      });
      await env.news_db.batch(clusterUpdates);
      stats.clustered = clusterUpdates.length;
    }
  } catch (clusterErr) {
    console.error('Topic clustering error', clusterErr);
  }

  // Calculate final importance_score and retention for all filtered articles
  for (const article of filteredArticles) {
    const sourcesList = article.sources || [article.source];
    article.source_count = sourcesList.length;
    article.importance_score = calculateImportanceScore(
      article.source_count,
      article.vectorEval?.affinityScore || 0
    );
    article.expires_at = computeExpiresAt(sourcesList, article.importance_score, now);
  }

  // Generate summaries for filtered articles using cached scrape data (skip if already pre-summarized)
  for (const article of filteredArticles) {
    if (article.summary && article.summary.trim().length > 0) {
      continue;
    }
    try {
      const content = article.details?.fullText || article.details?.content || '';
      if (content && content.length > 50) {
        const response: any = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [
            { role: 'system', content: 'You are a technical news summarizer. Write a single, concise paragraph summarizing the key points of the article.' },
            { role: 'user', content: `Title: ${article.title}\n\nContent: ${content}` }
          ]
        });
        article.summary = response.response;
      }
    } catch (e) {
      console.error('Summarization failed for', article.title, e);
    }
  }

  // Insert into D1
  if (filteredArticles.length > 0) {
    // ON CONFLICT(id) only fires on an id collision for a URL not matched above; treat it as a re-sighting.
    // Timestamps share the 'YYYY-MM-DD HH:MM:SS' format, so string comparison orders them correctly.
    const stmt = env.news_db.prepare(`
      INSERT INTO articles (id, title, url, source, sources, source_count, importance_score, cluster_id, image_url, summary, seen_count, last_seen_at, expires_at, embedding) 
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?12, ?13)
      ON CONFLICT(id) DO UPDATE SET 
        sources = excluded.sources,
        source_count = excluded.source_count,
        importance_score = excluded.importance_score,
        cluster_id = excluded.cluster_id,
        summary = coalesce(excluded.summary, articles.summary),
        seen_count = coalesce(articles.seen_count, 1) + 1,
        last_seen_at = excluded.last_seen_at,
        expires_at = CASE WHEN articles.expires_at IS NULL OR excluded.expires_at > articles.expires_at THEN excluded.expires_at ELSE articles.expires_at END,
        embedding = coalesce(excluded.embedding, articles.embedding)
    `);
    
    const batch = filteredArticles.map(a => stmt.bind(
      a.id,
      a.title,
      a.url,
      a.source,
      JSON.stringify(a.sources || [a.source]),
      a.source_count || 1,
      a.importance_score || 1.0,
      a.cluster_id || null,
      a.image_url || null,
      a.summary || null,
      nowSql,
      a.expires_at,
      Array.isArray(a.embedding) ? serializeEmbedding(a.embedding) : null
    ));
    
    try {
      await env.news_db.batch(batch);
      stats.inserted = batch.length;
      console.log(`Successfully attempted to insert ${batch.length} articles`);
    } catch (e: any) {
      stats.errors.push('D1 Batch error: ' + e.message);
      console.error('Failed to insert into D1', e);
    }
  }

  await cleanupExpiredArticles(env, stats);
  return stats;
}

interface ExistingArticleRow {
  id: string;
  url: string;
  source: string;
  sources: string | null;
  source_count: number | null;
  seen_count: number | null;
  importance_score: number | null;
  expires_at: string | null;
}

interface RecentClusterRow extends ExistingArticleRow {
  cluster_id: string | null;
  embedding: string | null;
}

// Expired articles are removed unless liked; liked articles are kept indefinitely.
async function cleanupExpiredArticles(env: Bindings, stats: { errors: string[] }): Promise<void> {
  try {
    await env.news_db.prepare(
      "DELETE FROM articles WHERE coalesce(expires_at, datetime(created_at, '+2 days')) < datetime('now') AND coalesce(is_liked, 0) = 0"
    ).run();
  } catch (e: any) {
    stats.errors.push('Cleanup error: ' + e.message);
    console.error('Failed to clean up old articles', e);
  }
}

async function fetchRedditPosts(env: Bindings) {
  const articles: { id: string, title: string, url: string, source: string, image_url?: string }[] = [];
  
  if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET || !env.REDDIT_REFRESH_TOKEN) {
    return articles;
  }

  const auth = btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`);
  const tokenRes = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "NewsAggregatorCron/1.0.0"
    },
    body: `grant_type=refresh_token&refresh_token=${env.REDDIT_REFRESH_TOKEN}`
  });

  if (!tokenRes.ok) return articles;
  const tokenData: any = await tokenRes.json();
  const accessToken = tokenData.access_token;

  const feedRes = await fetch("https://oauth.reddit.com/", {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "User-Agent": "NewsAggregatorCron/1.0.0"
    }
  });

  if (!feedRes.ok) return articles;
  const feedData: any = await feedRes.json();
  const posts = feedData.data?.children || [];

  const top10 = posts.slice(0, 20); // fetch more to account for skipped NSFW
  let count = 0;
  for (const post of top10) {
    if (count >= 10) break;
    const item = post.data;
    if (item && item.title) {
      // Filter NSFW
      if (item.over_18) continue;

      let url = item.url;
      if (item.is_self || !url) url = `https://www.reddit.com${item.permalink}`;
      
      let image_url = null;
      if (url.match(/\.(jpeg|jpg|gif|png)$/i)) {
        image_url = url;
      } else if (item.preview && item.preview.images && item.preview.images.length > 0) {
        image_url = item.preview.images[0].source.url.replace(/&amp;/g, '&');
      }

      articles.push({
        id: `reddit-${item.id}`,
        title: item.title,
        url: url,
        source: 'reddit',
        image_url
      });
      count++;
    }
  }

  return articles;
}

function decodeBase64Utf8(base64: string) {
  const binaryString = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function decodeEmailEntities(text: string): string {
  return text
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
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .trim();
}

function convertEmailToStructuredMarkdown(htmlContent: string, plainTextContent?: string): { markdown: string, issueWebUrl: string | null } {
  let issueWebUrl: string | null = null;

  // Try to find the web version link from HTML
  const webLinkMatch = htmlContent.match(/<a[^>]+href=["']([^"']+)["'][^>]*>(?:[\s\S]*?(?:Tarayıcıda oku|Web Version|View in browser|View online|Read in browser|View this issue|Web version)[\s\S]*?)<\/a>/i)
    || htmlContent.match(/<a[^>]+href=["']([^"']+)["'][^>]*>\s*(?:WEB VERSION|Tarayıcıda oku|View in browser)\s*<\/a>/i);

  if (webLinkMatch && webLinkMatch[1]) {
    issueWebUrl = decodeEmailEntities(webLinkMatch[1].trim());
  }

  // 1. Remove comments, styles, scripts, SVGs, head
  let text = htmlContent
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '');

  // 2. Headings
  text = text.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n\n## $1\n\n');

  // 3. Lists and paragraphs
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n• $1\n');
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n');
  text = text.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, '\n$1\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // 4. Links: convert <a href="url">link text</a> -> [link text](url)
  text = text.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (match, href, linkBody) => {
    const cleanLinkText = linkBody.replace(/<[^>]+>/g, '').trim();
    if (!cleanLinkText || href.startsWith('mailto:') || href.startsWith('javascript:')) {
      return cleanLinkText;
    }
    return `[${cleanLinkText}](${href})`;
  });

  // 5. Bold and emphasis
  text = text.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**');
  text = text.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*');

  // 6. Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // 7. Decode HTML entities
  text = decodeEmailEntities(text);

  // 8. Clean up whitespace
  text = text
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1].length > 0))
    .join('\n');

  // Fallback to plain text if HTML was empty or too small
  if (text.length < 50 && plainTextContent && plainTextContent.length > 50) {
    text = plainTextContent;
  }

  return { markdown: text, issueWebUrl };
}

async function fetchGmailNewsletters(env: Bindings): Promise<{
  id: string;
  title: string;
  url: string;
  source: string;
  image_url?: string;
  summary?: string;
  details?: ScrapedDetails;
}[]> {
  const articles: {
    id: string;
    title: string;
    url: string;
    source: string;
    image_url?: string;
    summary?: string;
    details?: ScrapedDetails;
  }[] = [];
  
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    return articles;
  }

  // 1. Get Access Token
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `client_id=${env.GMAIL_CLIENT_ID}&client_secret=${env.GMAIL_CLIENT_SECRET}&refresh_token=${env.GMAIL_REFRESH_TOKEN}&grant_type=refresh_token`
  });
  if (!tokenRes.ok) {
    console.error("Failed to get Gmail access token");
    return articles;
  }
  const tokenData: any = await tokenRes.json();
  const accessToken = tokenData.access_token;

  // 2. Search for messages
  const query = encodeURIComponent((env.GMAIL_SEARCH_QUERY || "label:newsletter") + " newer_than:7d");
  const searchRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=5`, {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  if (!searchRes.ok) {
    console.error("Failed to search Gmail messages");
    return articles;
  }
  const searchData: any = await searchRes.json();
  const listedMessages: Array<{ id: string }> = searchData.messages || [];

  // The search window spans days, so the same emails are listed every cycle. Skip already-decomposed
  // messages: re-running the LLM is wasteful and its varying titles would create duplicate articles.
  let messages = listedMessages;
  if (listedMessages.length > 0) {
    try {
      const placeholders = listedMessages.map(() => '?').join(',');
      const processed = await env.news_db.prepare(
        `SELECT message_id FROM processed_emails WHERE message_id IN (${placeholders})`
      ).bind(...listedMessages.map(m => m.id)).all<{ message_id: string }>();
      const processedIds = new Set((processed.results || []).map(r => r.message_id));
      messages = listedMessages.filter(m => !processedIds.has(m.id));
    } catch (e) {
      console.error('Failed to load processed email ids; processing all listed messages', e);
    }
  }

  for (const msg of messages) {
    const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`, {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (!msgRes.ok) continue;
    const msgData: any = await msgRes.json();

    // Extract Subject & From headers
    let emailSubject = "";
    let emailFrom = "";
    const headers = msgData.payload?.headers || [];
    for (const h of headers) {
      if (h.name?.toLowerCase() === 'subject') emailSubject = h.value;
      if (h.name?.toLowerCase() === 'from') emailFrom = h.value;
    }
    
    // Extract HTML and Plain text parts
    let rawHtml = "";
    let rawPlain = "";
    
    function extractParts(part: any) {
      if (part.mimeType === "text/html" && part.body && part.body.data) {
        rawHtml = decodeBase64Utf8(part.body.data);
      } else if (part.mimeType === "text/plain" && part.body && part.body.data) {
        rawPlain = decodeBase64Utf8(part.body.data);
      }
      if (part.parts) {
        for (const subPart of part.parts) {
          extractParts(subPart);
        }
      }
    }

    if (msgData.payload) {
      extractParts(msgData.payload);
    }

    if (!rawHtml && !rawPlain) continue;

    // Convert into clean structured markdown
    const { markdown, issueWebUrl } = convertEmailToStructuredMarkdown(rawHtml, rawPlain);
    if (!markdown || markdown.trim().length < 50) continue;

    // Slice structured text to fit comfortably in LLM context
    const textToAnalyze = markdown.substring(0, 14000);
    const fallbackIssueUrl = issueWebUrl || `https://news.emre.xyz/newsletter/${msg.id}`;

    // 3. Decompose multi-topic newsletter using AI
    try {
      const systemPrompt = `You are an expert news and technical digest curator.
Your task is to analyze the provided markdown content of an email newsletter ("${emailSubject}" from ${emailFrom}) and extract ALL discrete news stories, articles, tool releases, and technical developments into a structured JSON array.

Extraction Rules:
1. Extract every distinct story or tool mentioned in the newsletter.
2. For each item provide:
   - "title": A clear, meaningful headline (e.g., "mastodon-post: Web Component to display Mastodon posts", "OpenAI introduces ChatGPT Workspace & Pages", "T24 internet sitesine erişim engeli getirildi").
   - "summary": A complete, concise 1-3 sentence summary capturing the key facts/context from the text.
   - "category": The section/topic heading (e.g., "Technology", "CSS & HTML Tools", "Markets & Economy", "World News").
   - "url": The direct external link associated with this specific item if present. If no specific external link is present for this story, use "${fallbackIssueUrl}".
   - "is_sponsored": true IF this item is an advertisement, sponsored promotion, classified ad, affiliate pitch, or partner placement (e.g. "SPONSORED", "AD", "Bugünkü Destekçimiz", "Advertisement", "Commercial Apps & Classifieds"). Otherwise false.
3. Exclude newsletter housekeeping (e.g. "Tarayıcıda oku", "Web Version", greetings, unsubscribe links, feedback requests, social media follow buttons, daily music playlist).

Return ONLY a valid JSON array of objects. Do not include markdown code block formatting or extra commentary.
Format:
[
  {
    "title": "Story Title",
    "summary": "1-3 sentence description.",
    "category": "Technology",
    "url": "https://...",
    "is_sponsored": false
  }
]`;

      const aiResponse: any = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: textToAnalyze }
        ],
        max_tokens: 2500
      });

      let responseText = aiResponse.response || '';
      if (responseText.startsWith('```json')) {
        responseText = responseText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
      } else if (responseText.startsWith('```')) {
        responseText = responseText.replace(/^```\n?/, '').replace(/\n?```$/, '');
      }

      let extractedStories: any[] = [];
      try {
        extractedStories = JSON.parse(responseText.trim());
      } catch (parseErr) {
        // Fallback regex parser for story objects
        const storyRegex = /{\s*"title"\s*:\s*"([^"]+)"[\s\S]*?"summary"\s*:\s*"([^"]+)"[\s\S]*?"url"\s*:\s*"([^"]+)"(?:[\s\S]*?"is_sponsored"\s*:\s*(true|false))?[\s\S]*?}/g;
        let m;
        while ((m = storyRegex.exec(responseText)) !== null) {
          if (m[4] !== 'true') {
            extractedStories.push({
              title: m[1],
              summary: m[2],
              url: m[3],
              is_sponsored: false
            });
          }
        }
      }

      if (Array.isArray(extractedStories)) {
        for (const story of extractedStories) {
          if (story.is_sponsored) continue;
          const title = (story.title || '').trim();
          const summary = (story.summary || '').trim();
          if (!title || title.length < 3 || !summary || summary.length < 10) continue;

          let targetUrl = (story.url || '').trim();
          if (!targetUrl.startsWith('http')) {
            const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 30);
            targetUrl = `${fallbackIssueUrl}#${slug}`;
          }

          const hashBuffer = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(targetUrl + title));
          const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);

          articles.push({
            id: `newsletter-${msg.id}-${hashHex}`,
            title,
            url: targetUrl,
            source: 'newsletter',
            summary,
            details: {
              description: summary,
              headings: title,
              content: summary,
              fullText: `${title}${story.category ? ` (${story.category})` : ''}. ${summary}`
            }
          });
        }
      }

      // Marked only after a successful decomposition so failed or unparseable responses are retried next cycle.
      if (Array.isArray(extractedStories) && extractedStories.length > 0) {
        try {
          await env.news_db.prepare(
            'INSERT INTO processed_emails (message_id) VALUES (?1) ON CONFLICT(message_id) DO NOTHING'
          ).bind(msg.id).run();
        } catch (markErr) {
          console.error('Failed to mark email as processed', msg.id, markErr);
        }
      }
    } catch (aiErr) {
      console.error('AI newsletter decomposition error for msg', msg.id, aiErr);
    }
  }

  return articles;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .trim();
}

async function fetchStackerNews(): Promise<{ id: string, title: string, url: string, source: string }[]> {
  const articles: { id: string, title: string, url: string, source: string }[] = [];
  try {
    const res = await fetch('https://stacker.news/rss', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      }
    });

    if (!res.ok) {
      console.error(`Failed to fetch Stacker News RSS: ${res.status}`);
      return articles;
    }

    const xml = await res.text();
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;

    while ((match = itemRegex.exec(xml)) !== null) {
      const itemContent = match[1];

      const titleMatch = itemContent.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
      const linkMatch = itemContent.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/);
      const guidMatch = itemContent.match(/<guid[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/guid>/);
      const commentsMatch = itemContent.match(/<comments>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/comments>/);

      const rawTitle = titleMatch ? titleMatch[1].trim() : '';
      const link = linkMatch ? linkMatch[1].trim() : '';
      const guid = guidMatch ? guidMatch[1].trim() : '';
      const comments = commentsMatch ? commentsMatch[1].trim() : '';

      if (rawTitle && (link || guid)) {
        const title = decodeXmlEntities(rawTitle);
        const targetUrl = link || guid;

        const idMatch = (guid || comments || link).match(/\/items\/(\d+)/);
        const itemId = idMatch ? idMatch[1] : (guid || link).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 32);

        articles.push({
          id: `stacker-${itemId}`,
          title,
          url: targetUrl,
          source: 'stackernews'
        });
      }
    }
  } catch (e: any) {
    console.error('Stacker News RSS fetch error', e);
  }

  return articles;
}

async function runDebugPipeline(env: Bindings, targetSource: string = 'all'): Promise<DiagnosticReport> {
  const startTime = performance.now();
  const errors: string[] = [];
  const rawArticles: {
    id: string;
    title: string;
    url: string;
    source: string;
    image_url?: string;
    summary?: string;
    details?: ScrapedDetails;
  }[] = [];

  const sourceKey = targetSource === 'all' ? undefined : targetSource;

  if (!sourceKey || sourceKey === 'hn') {
    try {
      const hnRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
      if (hnRes.ok) {
        const topIds: number[] = await hnRes.json();
        const top10 = topIds.slice(0, 10);
        for (const id of top10) {
          const itemRes = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
          if (itemRes.ok) {
            const item: any = await itemRes.json();
            if (item.url) {
              rawArticles.push({
                id: `hn-${item.id}`,
                title: item.title,
                url: item.url,
                source: 'hackernews'
              });
            }
          }
        }
      }
    } catch (e: any) {
      errors.push('HN fetch error: ' + (e.message || String(e)));
    }
  }

  if (!sourceKey || sourceKey === 'lobsters') {
    try {
      const lobstersRes = await fetch('https://lobste.rs/hottest.json');
      if (lobstersRes.ok) {
        const lobsters: any[] = await lobstersRes.json();
        const top10 = lobsters.slice(0, 10);
        for (const item of top10) {
          if (item.url) {
            rawArticles.push({
              id: `lobsters-${item.short_id}`,
              title: item.title,
              url: item.url,
              source: 'lobsters'
            });
          }
        }
      }
    } catch (e: any) {
      errors.push('Lobsters fetch error: ' + (e.message || String(e)));
    }
  }

  if (!sourceKey || sourceKey === 'stacker') {
    try {
      const stackerArticles = await fetchStackerNews();
      rawArticles.push(...stackerArticles.slice(0, 10));
    } catch (e: any) {
      errors.push('Stacker News error: ' + (e.message || String(e)));
    }
  }

  if (!sourceKey || sourceKey === 'reddit') {
    try {
      const redditArticles = await fetchRedditPosts(env);
      rawArticles.push(...redditArticles.slice(0, 10));
    } catch (e: any) {
      errors.push('Reddit error: ' + (e.message || String(e)));
    }
  }

  if (!sourceKey || sourceKey === 'gmail') {
    try {
      const newsletterArticles = await fetchGmailNewsletters(env);
      rawArticles.push(...newsletterArticles);
    } catch (e: any) {
      errors.push('Gmail newsletter error: ' + (e.message || String(e)));
    }
  }

  const totalRaw = rawArticles.length;

  // Deduplicate and aggregate rawArticles by normalized URL
  const urlMap = new Map<string, {
    id: string;
    title: string;
    url: string;
    source: string;
    sources: Set<string>;
    image_url?: string;
    summary?: string;
    details?: ScrapedDetails;
  }>();

  for (const a of rawArticles) {
    const normUrl = normalizeUrl(a.url);
    a.url = normUrl;
    if (!urlMap.has(normUrl)) {
      urlMap.set(normUrl, {
        ...a,
        sources: new Set([a.source])
      });
    } else {
      const existing = urlMap.get(normUrl)!;
      existing.sources.add(a.source);
      if (!existing.image_url && a.image_url) existing.image_url = a.image_url;
      if (!existing.summary && a.summary) existing.summary = a.summary;
      if (!existing.details && a.details) existing.details = a.details;
    }
  }

  const uniqueRawArticles = Array.from(urlMap.values()).map(item => ({
    ...item,
    sources: Array.from(item.sources),
    source_count: item.sources.size
  }));

  const totalUnique = uniqueRawArticles.length;
  // Limit to 20 for interactive performance in debug
  const limitedArticles = uniqueRawArticles.slice(0, 20);

  // Scrape article details
  const scrapedArticles = await Promise.all(limitedArticles.map(async (a) => {
    if (a.details && a.details.fullText) {
      return { ...a, details: a.details };
    }
    const details = await scrapeArticleDetails(a.url);
    return { ...a, details };
  }));

  const tasteProfile = await getUserTasteProfile(env);
  const items: DiagnosticItem[] = [];

  try {
    const textsToEmbed = scrapedArticles.map(a => buildEmbeddingText({
      title: a.title,
      source: a.source,
      description: a.details?.description,
      content: a.details?.content
    }));

    const embedRes: any = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: textsToEmbed });
    const embeddings = embedRes.data || [];

    const candidatePoolForLLM: Array<{
      index: number;
      id: string;
      title: string;
      url: string;
      source: string;
      details?: ScrapedDetails;
      vectorEval?: MatchEvaluation;
    }> = [];

    // Query Vectorize for each candidate and build detailed evaluation trace
    for (let i = 0; i < scrapedArticles.length; i++) {
      const art = scrapedArticles[i];
      const embedding = embeddings[i];

      let vectorEval: MatchEvaluation = {
        affinityScore: 0.5,
        topPositiveScore: 0,
        topNegativeScore: 0,
        positiveCount: 0,
        negativeCount: 0,
        recommendation: 'uncertain'
      };
      const topPositiveMatches: VectorMatchDetail[] = [];
      const topNegativeMatches: VectorMatchDetail[] = [];

      try {
        if (embedding && env.VECTORIZE) {
          const queryRes = await env.VECTORIZE.query(embedding, { topK: 6, returnMetadata: 'all' });
          const matches = queryRes.matches || [];
          vectorEval = evaluateVectorMatches(matches);

          for (const m of matches) {
            const isDislike = m.metadata?.type === 'dislike';
            const matchDetail: VectorMatchDetail = {
              id: m.id,
              score: m.score,
              type: isDislike ? 'dislike' : (m.metadata?.type === 'like' ? 'like' : 'upvote'),
              title: m.metadata?.title || m.id,
              source: m.metadata?.source,
              url: m.metadata?.url
            };
            if (isDislike) {
              topNegativeMatches.push(matchDetail);
            } else {
              topPositiveMatches.push(matchDetail);
            }
          }
        }
      } catch (vecErr: any) {
        errors.push(`Vectorize query error for "${art.title}": ${vecErr.message || String(vecErr)}`);
      }

      topPositiveMatches.sort((a, b) => b.score - a.score);
      topNegativeMatches.sort((a, b) => b.score - a.score);

      const importanceScore = calculateImportanceScore(art.source_count, vectorEval.affinityScore);
      const sourceMultiplier = 1.0 + Math.max(0, art.source_count - 1) * 1.5;

      const diagItem: DiagnosticItem = {
        id: art.id,
        title: art.title,
        url: art.url,
        source: art.source,
        sources: art.sources,
        source_count: art.source_count,
        original_post_url: getOriginalPostUrl(art.id),
        status: 'REJECTED',
        primary_reason: '',
        details: art.details,
        vector_eval: {
          ...vectorEval,
          top_positive_matches: topPositiveMatches,
          top_negative_matches: topNegativeMatches
        },
        llm_eval: {
          was_sent_to_llm: false
        },
        scores: {
          importance_score: importanceScore,
          affinity_score: vectorEval.affinityScore,
          top_positive_score: vectorEval.topPositiveScore,
          top_negative_score: vectorEval.topNegativeScore,
          source_multiplier: sourceMultiplier
        }
      };

      if (vectorEval.recommendation === 'reject') {
        diagItem.status = 'REJECTED';
        diagItem.rejection_stage = 'vector';
        diagItem.primary_reason = vectorEval.topNegativeScore >= 0.78
          ? `Vector hard rejection: strong similarity (${(vectorEval.topNegativeScore * 100).toFixed(0)}%) to disliked article`
          : `Vector rejection: net negative affinity score (${vectorEval.affinityScore.toFixed(2)})`;
      } else if (vectorEval.recommendation === 'accept') {
        diagItem.status = 'ACCEPTED';
        diagItem.primary_reason = `Decisive vector affinity match (${(vectorEval.topPositiveScore * 100).toFixed(0)}% similarity to upvoted content)`;
      } else {
        // Uncertain / cold-start candidate -> evaluate via LLM Judge
        candidatePoolForLLM.push({
          index: i,
          id: art.id,
          title: art.title,
          url: art.url,
          source: art.source,
          details: art.details,
          vectorEval
        });
      }

      items.push(diagItem);
    }

    // Stage 2: Batch evaluate candidate pool with LLM Curation Judge
    if (candidatePoolForLLM.length > 0) {
      const approvedIds = await curateArticlesWithLLM(env, candidatePoolForLLM, tasteProfile);

      for (const cand of candidatePoolForLLM) {
        const diagItem = items[cand.index];
        const isApproved = approvedIds.has(cand.id);

        diagItem.llm_eval = {
          was_sent_to_llm: true,
          llm_accepted: isApproved
        };

        if (isApproved) {
          diagItem.status = 'ACCEPTED';
          diagItem.primary_reason = diagItem.source_count > 1
            ? `Approved by LLM Judge + Multi-source boost (${diagItem.source_count} sources)`
            : 'Approved by LLM Curation Judge (aligned with technical taste profile)';
        } else {
          diagItem.status = 'REJECTED';
          diagItem.rejection_stage = 'llm';
          diagItem.primary_reason = 'Rejected by LLM Judge (did not meet depth or engineering taste criteria)';
        }
      }
    }
    // Stage 3: Resolve titles and URLs for all vector matches across all items
    const allMatchesToResolve: VectorMatchDetail[] = [];
    for (const item of items) {
      if (item.vector_eval?.top_positive_matches) {
        allMatchesToResolve.push(...item.vector_eval.top_positive_matches);
      }
      if (item.vector_eval?.top_negative_matches) {
        allMatchesToResolve.push(...item.vector_eval.top_negative_matches);
      }
    }
    await resolveVectorMatchTitles(env, allMatchesToResolve);

  } catch (pipeErr: any) {
    errors.push('Recommendation pipeline error: ' + (pipeErr.message || String(pipeErr)));
    console.error('Recommendation pipeline error', pipeErr);
  }

  let totalAccepted = 0;
  let totalRejected = 0;
  for (const it of items) {
    if (it.status === 'ACCEPTED') totalAccepted++;
    else totalRejected++;
  }

  const durationMs = Math.round(performance.now() - startTime);

  return {
    timestamp: new Date().toISOString(),
    source: targetSource,
    is_local: false,
    is_admin_authenticated: true,
    taste_profile: tasteProfile,
    stats: {
      total_raw: totalRaw,
      total_unique: totalUnique,
      total_scraped: scrapedArticles.length,
      total_accepted: totalAccepted,
      total_rejected: totalRejected,
      duration_ms: durationMs,
      errors
    },
    items
  };
}

function extractArticleIdFromVectorId(vectorId: string): { dbId: string; sourceHint?: string; externalId?: string; originalUrl?: string } {
  let dbId = vectorId.replace(/^(liked|disliked)-/, '');
  let originalUrl: string | undefined;
  let externalId: string | undefined;
  let sourceHint: string | undefined;

  if (vectorId.startsWith('reddit-upvote-') || dbId.startsWith('reddit-')) {
    sourceHint = 'Reddit';
    externalId = vectorId.replace(/^reddit-upvote-/, '').replace(/^reddit-/, '');
    originalUrl = `https://redd.it/${externalId}`;
    dbId = `reddit-${externalId}`;
  } else if (vectorId.startsWith('hn-upvote-') || dbId.startsWith('hn-')) {
    sourceHint = 'Hacker News';
    externalId = vectorId.replace(/^hn-upvote-/, '').replace(/^hn-/, '');
    originalUrl = `https://news.ycombinator.com/item?id=${externalId}`;
    dbId = `hn-${externalId}`;
  } else if (vectorId.startsWith('lobsters-upvote-') || dbId.startsWith('lobsters-')) {
    sourceHint = 'Lobsters';
    externalId = vectorId.replace(/^lobsters-upvote-/, '').replace(/^lobsters-/, '');
    originalUrl = `https://lobste.rs/s/${externalId}`;
    dbId = `lobsters-${externalId}`;
  } else if (vectorId.startsWith('stacker-')) {
    sourceHint = 'Stacker News';
    externalId = vectorId.replace(/^stacker-/, '');
    originalUrl = `https://stacker.news/items/${externalId}`;
    dbId = `stacker-${externalId}`;
  }

  return { dbId, sourceHint, externalId, originalUrl };
}

async function resolveVectorMatchTitles(env: Bindings, matches: VectorMatchDetail[]): Promise<void> {
  if (!matches || matches.length === 0) return;

  const candidateDbIds = new Set<string>();
  const matchMap = new Map<string, VectorMatchDetail[]>();

  for (const m of matches) {
    const { dbId } = extractArticleIdFromVectorId(m.id);
    candidateDbIds.add(m.id);
    if (dbId) candidateDbIds.add(dbId);

    const list1 = matchMap.get(m.id) || [];
    list1.push(m);
    matchMap.set(m.id, list1);

    if (dbId && dbId !== m.id) {
      const list2 = matchMap.get(dbId) || [];
      list2.push(m);
      matchMap.set(dbId, list2);
    }
  }

  if (candidateDbIds.size > 0) {
    const ids = Array.from(candidateDbIds);
    const placeholders = ids.map(() => '?').join(',');
    try {
      const dbResults: any = await env.news_db.prepare(
        `SELECT id, title, url, source FROM articles WHERE id IN (${placeholders})`
      ).bind(...ids).all();

      for (const row of (dbResults.results || [])) {
        const matchingItems = matchMap.get(row.id);
        if (matchingItems) {
          for (const item of matchingItems) {
            if (row.title) item.title = row.title;
            if (row.url && !item.url) item.url = row.url;
            if (row.source && !item.source) item.source = row.source;
          }
        }
      }
    } catch (e) {
      console.error('Failed to resolve match titles from DB', e);
    }
  }

  // Fallback for remaining items
  for (const m of matches) {
    const { sourceHint, externalId, originalUrl } = extractArticleIdFromVectorId(m.id);
    if (originalUrl && !m.url) {
      m.url = originalUrl;
    }
    if (!m.title || m.title === m.id || m.title.startsWith('liked-') || m.title.startsWith('disliked-') || m.title.startsWith('reddit-upvote-') || m.title.startsWith('hn-upvote-')) {
      if (externalId && sourceHint) {
        m.title = `${sourceHint} Post #${externalId}`;
      } else {
        m.title = m.id;
      }
    }
    if (!m.source && sourceHint) {
      m.source = sourceHint.toLowerCase().replace(/\s+/g, '');
    }
  }
}


