import { ArticleModel } from './helpers'

function escapeXml(str?: string | null): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function generateRssFeed(articles: ArticleModel[], siteUrl: string = 'https://news.emre.xyz'): string {
  const latestDate = articles.length > 0 && articles[0].created_at
    ? new Date(articles[0].created_at.endsWith('Z') ? articles[0].created_at : articles[0].created_at + 'Z').toUTCString()
    : new Date().toUTCString();

  const itemsXml = articles.map((article) => {
    const pubDate = article.created_at
      ? new Date(article.created_at.endsWith('Z') ? article.created_at : article.created_at + 'Z').toUTCString()
      : new Date().toUTCString();
    
    const permalink = `${siteUrl}/article/${article.id}`;
    const description = article.summary || article.title;
    const enclosure = article.image_url
      ? `<enclosure url="${escapeXml(article.image_url)}" type="image/jpeg" length="0" />`
      : '';

    return `
    <item>
      <title><![CDATA[${article.title}]]></title>
      <link>${escapeXml(article.url)}</link>
      <guid isPermaLink="false">${escapeXml(permalink)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[${description}]]></description>
      <source url="${escapeXml(article.url)}">${escapeXml(article.source)}</source>
      ${enclosure}
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>AI Curated News</title>
    <link>${siteUrl}</link>
    <description>AI-curated engineering news, architecture deep-dives and technical postmortems.</description>
    <language>en-us</language>
    <lastBuildDate>${latestDate}</lastBuildDate>
    <atom:link href="${siteUrl}/rss.xml" rel="self" type="application/rss+xml"/>
    ${itemsXml}
  </channel>
</rss>`;
}
