import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { verifyEvent } from 'nostr-tools'

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
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('*', cors({
  origin: (origin) => {
    // Allow local development and the production frontend
    if (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173') {
      return origin;
    }
    return 'https://news.emre.xyz';
  }
}))

app.get('/', (c) => {
  return c.text('News Aggregator API')
})

app.get('/api/articles', async (c) => {
  const { results } = await c.env.news_db.prepare(
    "SELECT * FROM articles WHERE created_at >= datetime('now', '-1 day') ORDER BY created_at DESC LIMIT 100"
  ).all();
  
  const latest: any = await c.env.news_db.prepare('SELECT MAX(created_at) as last_curated_at FROM articles').first();
  
  c.header('Cache-Control', 'no-cache');
  return c.json({
    meta: {
      last_curated_at: latest?.last_curated_at || null
    },
    data: results
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
  const content = await scrapeContent(article.url as string);
  const textToEmbed = `Title: ${article.title}\n\nContent: ${content}`;
  
  try {
    const embedRes: any = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [textToEmbed] });
    const embedding = embedRes.data[0];
    
    const vectorId = `liked-${id}`;
    await env.VECTORIZE.upsert([{
      id: vectorId,
      values: embedding,
      metadata: { source: article.source, type: 'like', url: article.url }
    }]);
  } catch (e) {
    console.error('Failed to embed liked article', e);
  }

  return c.json({ success: true });
})

async function scrapeContent(url: string): Promise<string> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'NewsAggregatorCron/1.0.0' } });
    if (!res.ok) return '';
    let content = '';
    const rewriter = new HTMLRewriter().on('p', {
      text(text) {
        content += text.text + ' ';
      }
    });
    await rewriter.transform(res).text();
    // Truncate to roughly fit embedding model limits (~512 tokens max)
    return content.replace(/\s+/g, ' ').trim().substring(0, 1500);
  } catch (e) {
    return '';
  }
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
      const content = await scrapeContent(url);
      const textToEmbed = `Title: ${item.title}\n\nContent: ${content}`;
      
      try {
        const embedRes: any = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [textToEmbed] });
        const embedding = embedRes.data[0];
        
        const vectorId = `reddit-upvote-${item.id}`;
        await env.VECTORIZE.upsert([{
          id: vectorId,
          values: embedding,
          metadata: { source: 'reddit', type: 'upvote', url }
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
    const content = await scrapeContent(url);
    const textToEmbed = `Title: ${title}\n\nContent: ${content}`;
    
    try {
      const embedRes: any = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [textToEmbed] });
      const embedding = embedRes.data[0];
      
      const vectorId = `lobsters-upvote-${Date.now()}-${Math.floor(Math.random()*1000)}`;
      await env.VECTORIZE.upsert([{
        id: vectorId,
        values: embedding,
        metadata: { source: 'lobsters', type: 'upvote', url }
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
      
      const content = await scrapeContent(url);
      const textToEmbed = `Title: ${item.title.trim()}\n\nContent: ${content}`;
      
      try {
        const embedRes: any = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [textToEmbed] });
        const embedding = embedRes.data[0];
        
        const vectorId = `hn-upvote-${item.id}`;
        await env.VECTORIZE.upsert([{
          id: vectorId,
          values: embedding,
          metadata: { source: 'hackernews', type: 'upvote', url }
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
      
      const content = await scrapeContent(url);
      const textToEmbed = `Title: ${item.title.trim()}\n\nContent: ${content}`;
      
      try {
        const embedRes: any = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [textToEmbed] });
        const embedding = embedRes.data[0];
        
        const vectorId = `hn-upvote-json-${Date.now()}-${Math.floor(Math.random()*1000)}`;
        await env.VECTORIZE.upsert([{
          id: vectorId,
          values: embedding,
          metadata: { source: 'hackernews', type: 'upvote', url }
        }]);
        inserted.push(item.title.trim());
      } catch (e) {
        console.error('Failed to embed/upsert', item.title, e);
      }
    }
  }

  return c.json({ success: true, inserted_count: inserted.length, inserted });
});

app.get('/test-ingestion', async (c) => {
  // Security check: Only allow this endpoint during local development
  const url = new URL(c.req.url);
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && url.search!=="?1542") {
    return c.text('Forbidden: This endpoint is only available during local development.', 403);
  }
  
  await handleIngestion(c.env);
  return c.text('Ingestion complete! Check your frontend.');
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(handleIngestion(env))
  }
}

async function handleIngestion(env: Bindings) {
  const rawArticles: { id: string, title: string, url: string, source: string, image_url?: string, summary?: string }[] = [];

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
  } catch (e) { console.error('HN error', e); }

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
  } catch (e) { console.error('Lobsters error', e); }

  // Fetch Reddit
  try {
    const redditArticles = await fetchRedditPosts(env);
    rawArticles.push(...redditArticles);
  } catch (e) { console.error('Reddit error', e); }

  // Fetch Gmail Newsletters
  try {
    const newsletterArticles = await fetchGmailNewsletters(env);
    rawArticles.push(...newsletterArticles);
  } catch (e) { console.error('Gmail error', e); }

  if (rawArticles.length === 0) return;

  // Filter based on Vectorize AI
  const filteredArticles = [];
  try {
    // We scrape all contents concurrently
    const textsToEmbed = await Promise.all(rawArticles.map(async a => {
      const content = await scrapeContent(a.url);
      return `Title: ${a.title}\n\nContent: ${content}`;
    }));
    
    // Batch generate embeddings
    const embedRes: any = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: textsToEmbed });
    const embeddings = embedRes.data;

    // Query Vectorize for each
    for (let i = 0; i < rawArticles.length; i++) {
      const article = rawArticles[i];
      const embedding = embeddings[i];
      
      try {
        const queryRes = await env.VECTORIZE.query(embedding, { topK: 1 });
        const matches = queryRes.matches;
        // Accept if no history (Cold Start) OR if there's a highly similar upvoted item
        if (matches.length === 0) {
          filteredArticles.push(article);
        } else {
          const bestMatch = matches[0];
          // Cosine similarity threshold (adjust as needed, typically 0.65 - 0.75 is a good start)
          if (bestMatch.score >= 0.70) {
            filteredArticles.push(article);
          }
        }
      } catch (e) {
        console.error('Vectorize query error', e);
        // If error querying vectorize, fallback to insert
        filteredArticles.push(article);
      }
    }
  } catch (e) {
    console.error('AI Embed error', e);
    // If AI fails, fallback to insert all
    filteredArticles.push(...rawArticles);
  }

  // Generate summaries for filtered articles
  for (const article of filteredArticles) {
    try {
      const content = await scrapeContent(article.url);
      if (content && content.length > 50) {
        const response: any = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [
            { role: 'system', content: 'You are a news summarizer. Write a single, concise paragraph summarizing the article.' },
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
      INSERT INTO articles (id, title, url, source, image_url, summary) 
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(id) DO UPDATE SET summary = excluded.summary
    `);
    
    const batch = filteredArticles.map(a => stmt.bind(a.id, a.title, a.url, a.source, a.image_url || null, a.summary || null));
    
    try {
      await env.news_db.batch(batch);
      console.log(`Successfully attempted to insert ${batch.length} articles`);
    } catch (e) {
      console.error('Failed to insert into D1', e);
    }
  }

  // Cleanup old articles to keep DB small
  try {
    await env.news_db.prepare("DELETE FROM articles WHERE created_at < datetime('now', '-2 days')").run();
  } catch (e) {
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
  const query = encodeURIComponent(env.GMAIL_SEARCH_QUERY || "label:newsletter");
  // Fetch messages from the last day to limit processing
  const searchRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query} newer_than:1d&maxResults=5`, {
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
    if (msgData.payload.parts) {
      // Find text/plain or text/html
      const part = msgData.payload.parts.find((p: any) => p.mimeType === "text/plain") || msgData.payload.parts.find((p: any) => p.mimeType === "text/html");
      if (part && part.body && part.body.data) {
        bodyData = part.body.data;
      } else if (msgData.payload.parts[0]?.parts) {
         // Handle nested multipart
         const subpart = msgData.payload.parts[0].parts.find((p: any) => p.mimeType === "text/plain");
         if (subpart && subpart.body && subpart.body.data) bodyData = subpart.body.data;
      }
    } else if (msgData.payload.body && msgData.payload.body.data) {
      bodyData = msgData.payload.body.data;
    }

    if (!bodyData) continue;
    
    // Base64url decode
    const textContent = decodeBase64Utf8(bodyData);
    
    // Limit text size to avoid token overflow
    const truncatedText = textContent.substring(0, 4000);

    // 3. Extract Links using AI
    try {
      const aiResponse: any = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          { role: 'system', content: 'You are an assistant that extracts news article links and their titles from a newsletter email. Return ONLY a raw JSON array of objects with "title" and "url" properties. Do not include markdown formatting or any other text. Ignore unsubscribe links, social media profiles, and sponsor links.' },
          { role: 'user', content: truncatedText }
        ]
      });

      let responseText = aiResponse.response;
      // Clean up markdown if the AI mistakenly included it
      if (responseText.startsWith('\`\`\`json')) {
        responseText = responseText.replace(/^\`\`\`json\n?/, '').replace(/\n?\`\`\`$/, '');
      } else if (responseText.startsWith('\`\`\`')) {
        responseText = responseText.replace(/^\`\`\`\n?/, '').replace(/\n?\`\`\`$/, '');
      }

      const extractedLinks = JSON.parse(responseText);
      
      for (const link of extractedLinks) {
        if (link.url && link.title) {
           articles.push({
             id: `newsletter-${msg.id}-${btoa(link.url).substring(0, 20).replace(/[^a-zA-Z0-9]/g, '')}`,
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
