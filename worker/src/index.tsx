import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { verifyEvent } from 'nostr-tools'
import { FeedView } from './views/FeedView'
import { ArticleDetailView } from './views/ArticleDetailView'
import { Layout } from './views/Layout'
import { generateRssFeed } from './views/rss'
import { ArticleModel } from './views/helpers'

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

// SSR Home Feed Route
app.get('/', async (c) => {
  const sort = c.req.query('sort') || 'hot';
  const source = c.req.query('source') || 'all';

  const orderByClause = sort === 'latest'
    ? 'ORDER BY created_at DESC'
    : 'ORDER BY ((coalesce(importance_score, 1.0) + (coalesce(follower_likes, 0) * 2.0)) / ((((julianday(\'now\') - julianday(created_at)) * 24.0) + 2.0) * (((julianday(\'now\') - julianday(created_at)) * 24.0) + 2.0))) DESC, created_at DESC';

  let query = `SELECT *, 
      ((coalesce(importance_score, 1.0) + (coalesce(follower_likes, 0) * 2.0)) / ((((julianday('now') - julianday(created_at)) * 24.0) + 2.0) * (((julianday('now') - julianday(created_at)) * 24.0) + 2.0))) AS hot_score 
     FROM articles 
     WHERE created_at >= datetime('now', '-2 days')`;

  if (source && source !== 'all') {
    query += ` AND (source = ? OR sources LIKE ?)`;
  }

  query += ` ${orderByClause} LIMIT 100`;

  const stmt = source && source !== 'all'
    ? c.env.news_db.prepare(query).bind(source, `%"${source}"%`)
    : c.env.news_db.prepare(query);

  const { results } = await stmt.all();
  const latest: any = await c.env.news_db.prepare('SELECT MAX(created_at) as last_curated_at FROM articles').first();

  const formattedArticles: ArticleModel[] = (results || []).map((article: any) => ({
    ...article,
    sources: parseSources(article.sources, article.source),
    source_count: article.source_count || parseSources(article.sources, article.source).length || 1,
    importance_score: article.importance_score || 1.0
  }));

  const useEmreTheme = c.env.USE_EMRE_THEME !== 'false';

  return c.html(
    <FeedView
      articles={formattedArticles}
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
  const article: any = await c.env.news_db.prepare('SELECT * FROM articles WHERE id = ?').bind(id).first();

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
    `SELECT * FROM articles 
     WHERE created_at >= datetime('now', '-2 days') 
     ORDER BY created_at DESC 
     LIMIT 50`
  ).all();

  const formattedArticles: ArticleModel[] = (results || []).map((article: any) => ({
    ...article,
    sources: parseSources(article.sources, article.source),
    source_count: article.source_count || parseSources(article.sources, article.source).length || 1,
    importance_score: article.importance_score || 1.0
  }));

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
  const sort = c.req.query('sort') || 'hot';
  
  const orderByClause = sort === 'latest'
    ? 'ORDER BY created_at DESC'
    : 'ORDER BY ((coalesce(importance_score, 1.0) + (coalesce(follower_likes, 0) * 2.0)) / ((((julianday(\'now\') - julianday(created_at)) * 24.0) + 2.0) * (((julianday(\'now\') - julianday(created_at)) * 24.0) + 2.0))) DESC, created_at DESC';

  const { results } = await c.env.news_db.prepare(
    `SELECT *, 
      ((coalesce(importance_score, 1.0) + (coalesce(follower_likes, 0) * 2.0)) / ((((julianday('now') - julianday(created_at)) * 24.0) + 2.0) * (((julianday('now') - julianday(created_at)) * 24.0) + 2.0))) AS hot_score 
     FROM articles 
     WHERE created_at >= datetime('now', '-2 days') 
     ${orderByClause} 
     LIMIT 100`
  ).all();
  
  const latest: any = await c.env.news_db.prepare('SELECT MAX(created_at) as last_curated_at FROM articles').first();
  
  const formattedArticles = (results || []).map((article: any) => ({
    ...article,
    sources: parseSources(article.sources, article.source),
    source_count: article.source_count || parseSources(article.sources, article.source).length || 1,
    importance_score: article.importance_score || 1.0
  }));

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

function parseSources(sourcesJson?: string | null, fallbackSource?: string): string[] {
  if (sourcesJson) {
    try {
      const parsed = JSON.parse(sourcesJson);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {}
  }
  return fallbackSource ? [fallbackSource] : [];
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length === 0 || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function calculateImportanceScore(sourceCount: number, affinityScore: number = 0): number {
  // Base score 1.0. Each distinct source after the first increases importance by 1.5x
  const sourceMultiplier = 1.0 + Math.max(0, sourceCount - 1) * 1.5;
  const affinityBonus = Math.max(0, affinityScore) * 0.4;
  return Number(((1.0 + affinityBonus) * sourceMultiplier).toFixed(2));
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

const handleIngestEndpoint = async (c: any) => {
  const isAuth = await isAuthorizedForIngestion(c);
  if (!isAuth) {
    return c.json({
      error: 'Unauthorized',
      message: 'Access restricted. Provide Authorization Bearer header, ?key= query parameter, or signed Nostr authorization event.'
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
  const rawArticles: { id: string, title: string, url: string, source: string, image_url?: string, summary?: string }[] = [];

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
    }
  }

  const uniqueRawArticles = Array.from(urlMap.values()).map(item => ({
    ...item,
    sources: Array.from(item.sources),
    source_count: item.sources.size
  }));

  // Cloudflare Workers have a 50 subrequest limit per invocation.
  // If we run ALL sources (no targetSource), API calls use ~20 subrequests, so we cap scraping to 20.
  // If we run a SINGLE source (via cron), API calls use ~5 subrequests, so we can safely scrape up to 40.
  const limit = targetSource ? 40 : 20;
  const limitedRawArticles = uniqueRawArticles.slice(0, limit);

  // PREVENT UNIQUE(url) constraints by mapping existing URLs to their existing IDs and merging sources!
  if (limitedRawArticles.length > 0) {
    const urls = limitedRawArticles.map(a => a.url);
    const placeholders = urls.map(() => '?').join(',');
    try {
      const existing: any = await env.news_db.prepare(
        `SELECT url, id, source, sources, source_count, importance_score, cluster_id FROM articles WHERE url IN (${placeholders})`
      ).bind(...urls).all();
      
      const existingMap = new Map((existing.results || []).map((r: any) => [r.url, r]));
      for (const article of limitedRawArticles) {
        if (existingMap.has(article.url)) {
          const dbRec: any = existingMap.get(article.url);
          article.id = dbRec.id; // Use existing DB id to trigger ON CONFLICT(id) properly
          const dbSources = parseSources(dbRec.sources, dbRec.source);
          const mergedSources = Array.from(new Set([...dbSources, ...article.sources]));
          article.sources = mergedSources;
          article.source_count = mergedSources.length;
          if (dbRec.cluster_id) {
            article.cluster_id = dbRec.cluster_id;
          }
        }
      }
    } catch (e) {
      console.error('URL map check error', e);
    }
  }

  // Scrape all contents concurrently and extract rich metadata
  const rawWithDetails = await Promise.all(limitedRawArticles.map(async a => {
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
    let recentDbArticles: any[] = [];
    try {
      const recentRes: any = await env.news_db.prepare(
        "SELECT id, title, url, source, sources, source_count, importance_score, cluster_id FROM articles WHERE created_at >= datetime('now', '-24 hours')"
      ).all();
      recentDbArticles = recentRes.results || [];
    } catch (dbErr) {
      console.error('Failed to fetch recent DB articles for clustering', dbErr);
    }

    // Intra-batch clustering: compare pairs of filteredArticles
    for (let i = 0; i < filteredArticles.length; i++) {
      for (let j = i + 1; j < filteredArticles.length; j++) {
        const artA = filteredArticles[i];
        const artB = filteredArticles[j];
        if (artA.embedding && artB.embedding) {
          const sim = cosineSimilarity(artA.embedding, artB.embedding);
          if (sim >= 0.82) {
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

    // Inter-run clustering: compare batch articles against recent DB articles with same cluster
    for (const article of filteredArticles) {
      if (!article.cluster_id) continue;
      for (const dbArt of recentDbArticles) {
        if (dbArt.id === article.id || dbArt.url === article.url) continue;
        
        if (dbArt.cluster_id && dbArt.cluster_id === article.cluster_id) {
          const dbSources = parseSources(dbArt.sources, dbArt.source);
          const merged = Array.from(new Set([...(article.sources || [article.source]), ...dbSources]));
          article.sources = merged;
          article.source_count = merged.length;
          
          await env.news_db.prepare(
            "UPDATE articles SET sources = ?1, source_count = ?2, importance_score = ?3 WHERE id = ?4"
          ).bind(
            JSON.stringify(merged),
            merged.length,
            calculateImportanceScore(merged.length),
            dbArt.id
          ).run();
        }
      }
    }
  } catch (clusterErr) {
    console.error('Topic clustering error', clusterErr);
  }

  // Calculate final importance_score for all filtered articles
  for (const article of filteredArticles) {
    const sourcesList = article.sources || [article.source];
    article.source_count = sourcesList.length;
    article.importance_score = calculateImportanceScore(
      article.source_count,
      article.vectorEval?.affinityScore || 0
    );
  }

  // Generate summaries for filtered articles using cached scrape data
  for (const article of filteredArticles) {
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
    const stmt = env.news_db.prepare(`
      INSERT INTO articles (id, title, url, source, sources, source_count, importance_score, cluster_id, image_url, summary) 
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT(id) DO UPDATE SET 
        sources = excluded.sources,
        source_count = excluded.source_count,
        importance_score = excluded.importance_score,
        cluster_id = excluded.cluster_id,
        summary = coalesce(excluded.summary, articles.summary)
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
      a.summary || null
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

  // Cleanup old articles to keep DB small
  try {
    await env.news_db.prepare("DELETE FROM articles WHERE created_at < datetime('now', '-2 days')").run();
  } catch (e: any) {
    stats.errors.push('Cleanup error: ' + e.message);
    console.error('Failed to clean up old articles', e);
  }

  return stats;
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

async function fetchGmailNewsletters(env: Bindings) {
  const articles: { id: string, title: string, url: string, source: string, image_url?: string }[] = [];
  
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
  // Fetch messages from the last day to limit processing
  const searchRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=5`, {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  if (!searchRes.ok) {
    console.error("Failed to search Gmail messages");
    return articles;
  }
  const searchData: any = await searchRes.json();
  const messages = searchData.messages || [];

  for (const msg of messages) {
    const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`, {
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    if (!msgRes.ok) continue;
    const msgData: any = await msgRes.json();
    
    // Extract body content
    let bodyData = "";
    let isHtml = false;
    
    function extractBody(part: any): { data: string, isHtml: boolean } | null {
      if (part.mimeType === "text/html" && part.body && part.body.data) return { data: part.body.data, isHtml: true };
      if (part.mimeType === "text/plain" && part.body && part.body.data) return { data: part.body.data, isHtml: false };
      if (part.parts) {
        let plainFallback = null;
        for (const subPart of part.parts) {
          const res = extractBody(subPart);
          if (res) {
            if (res.isHtml) return res;
            plainFallback = res;
          }
        }
        return plainFallback;
      }
      return null;
    }

    if (msgData.payload) {
      const extracted = extractBody(msgData.payload);
      if (extracted) {
        bodyData = extracted.data;
        isHtml = extracted.isHtml;
      }
    }

    if (!bodyData) continue;
    
    // Base64url decode
    const textContent = decodeBase64Utf8(bodyData);
    
    let textToAnalyze = "";
    if (isHtml) {
      const linksMap: { href: string, text: string }[] = [];
      let currentLink: any = null;
      
      const rewriter = new HTMLRewriter().on('a', {
        element(el) {
          const href = el.getAttribute('href');
          if (href && href.startsWith('http')) {
            currentLink = { href, text: '' };
            linksMap.push(currentLink);
          } else {
            currentLink = null;
          }
        },
        text(textChunk) {
          if (currentLink) {
            currentLink.text += textChunk.text;
          }
        }
      });
      
      await rewriter.transform(new Response(textContent)).text();
      
      const validLinks = linksMap
        .map(l => ({ href: l.href, text: l.text.replace(/\s+/g, ' ').trim() }))
        .filter(l => l.text.length > 2 && !l.href.toLowerCase().includes('unsubscribe') && !l.href.includes('twitter.com') && !l.href.includes('facebook.com') && !l.href.includes('instagram.com') && !l.href.includes('linkedin.com'));
        
      const linkStrings = validLinks.map(l => `- [${l.text}](${l.href})`);
      textToAnalyze = linkStrings.slice(0, 150).join('\n');
    } else {
      textToAnalyze = textContent.substring(0, 4000);
    }

    // 3. Extract Links using AI
    try {
      const aiResponse: any = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          { role: 'system', content: 'You are an assistant that curates news. You are given a list of markdown links (or raw text) extracted from a newsletter. Filter out unsubscribe links, social media profiles, navigation links, and sponsor links. Return ALL valid news articles found in the list. Do not summarize or limit the count. Return ONLY a raw JSON array of objects with "title" and "url" properties representing the actual news articles/content. Do not include markdown formatting or any other text.' },
          { role: 'user', content: textToAnalyze }
        ],
        max_tokens: 2048
      });

      let responseText = aiResponse.response;
      // Clean up markdown if the AI mistakenly included it
      if (responseText.startsWith('\`\`\`json')) {
        responseText = responseText.replace(/^\`\`\`json\n?/, '').replace(/\n?\`\`\`$/, '');
      } else if (responseText.startsWith('\`\`\`')) {
        responseText = responseText.replace(/^\`\`\`\n?/, '').replace(/\n?\`\`\`$/, '');
      }

      let extractedLinks = [];
      try {
        extractedLinks = JSON.parse(responseText);
      } catch(e) {
        // Fallback: If JSON is malformed, use regex to extract titles and URLs safely.
        const regex = /"title"\s*:\s*"([^"]+)"\s*,\s*"url"\s*:\s*"([^"]+)"/g;
        let match;
        while ((match = regex.exec(responseText)) !== null) {
          extractedLinks.push({ title: match[1], url: match[2] });
        }
      }
      
      for (const link of extractedLinks) {
        if (link.url && link.title) {
           const hashBuffer = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(link.url));
           const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
           articles.push({
             id: `newsletter-${msg.id}-${hashHex}`,
             title: link.title,
             url: link.url,
             source: 'newsletter'
           });
        }
      }
    } catch (e) {
      console.error('AI link extraction error for msg', msg.id, e);
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

