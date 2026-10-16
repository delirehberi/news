export interface ArticleModel {
  id: string;
  title: string;
  url: string;
  source: string;
  sources?: string[];
  source_count?: number;
  importance_score?: number;
  cluster_id?: string | null;
  created_at?: string;
  is_liked?: boolean | number;
  image_url?: string | null;
  summary?: string | null;
  follower_likes?: number;
  hot_score?: number;
  seen_count?: number;
  last_seen_at?: string | null;
  expires_at?: string | null;
}

export function formatTimestamp(isoString?: string | null): string {
  if (!isoString) return '';
  const dateStr = isoString.endsWith('Z') ? isoString : isoString + 'Z';
  const date = new Date(dateStr);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric'
  }).format(date);
}

export function timeSince(isoString?: string | null): string {
  if (!isoString) return '';
  const dateStr = isoString.endsWith('Z') ? isoString : isoString + 'Z';
  const seconds = Math.floor((new Date().getTime() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 0) return 'just now';
  let interval = seconds / 31536000;
  if (interval >= 1) return Math.floor(interval) + "y ago";
  interval = seconds / 2592000;
  if (interval >= 1) return Math.floor(interval) + "mo ago";
  interval = seconds / 86400;
  if (interval >= 1) return Math.floor(interval) + "d ago";
  interval = seconds / 3600;
  if (interval >= 1) return Math.floor(interval) + "h ago";
  interval = seconds / 60;
  if (interval >= 1) return Math.floor(interval) + "m ago";
  return Math.floor(seconds) + "s ago";
}

export function getOriginalPostUrl(id: string): string | null {
  if (id.startsWith('hn-')) return `https://news.ycombinator.com/item?id=${id.replace('hn-', '')}`;
  if (id.startsWith('lobsters-')) return `https://lobste.rs/s/${id.replace('lobsters-', '')}`;
  if (id.startsWith('reddit-')) return `https://redd.it/${id.replace('reddit-', '')}`;
  if (id.startsWith('stacker-')) return `https://stacker.news/items/${id.replace('stacker-', '')}`;
  return null;
}

export function getSourceBadgeInfo(source: string): { label: string; className: string } {
  switch (source.toLowerCase()) {
    case 'hackernews':
    case 'hn':
      return {
        label: 'HN',
        className: 'source-badge source-badge-hn'
      };
    case 'lobsters':
      return {
        label: 'Lobsters',
        className: 'source-badge source-badge-lobsters'
      };
    case 'reddit':
      return {
        label: 'Reddit',
        className: 'source-badge source-badge-reddit'
      };
    case 'stackernews':
    case 'stacker':
      return {
        label: 'Stacker',
        className: 'source-badge source-badge-stacker'
      };
    case 'newsletter':
    case 'gmail':
      return {
        label: 'Newsletter',
        className: 'source-badge source-badge-newsletter'
      };
    default:
      return {
        label: source,
        className: 'source-badge source-badge-default'
      };
  }
}

export function getDomain(url?: string | null): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

