import type { FC } from 'hono/jsx'
import { ArticleModel, formatTimestamp, getOriginalPostUrl, getSourceBadgeInfo, getDomain } from './helpers'

interface ArticleCardProps {
  article: ArticleModel;
  index: number;
  initialOpen?: boolean;
}

export const ArticleCard: FC<ArticleCardProps> = ({ article, index, initialOpen = false }) => {
  const sources = Array.isArray(article.sources) && article.sources.length > 0
    ? article.sources
    : [article.source];

  const discussLink = getOriginalPostUrl(article.id);
  const domain = getDomain(article.url);
  const isFirst = index === 0;

  return (
    <article class="news-item" data-id={article.id}>
      {/* 1. HackerNews-like Compact Title Row */}
      <div class="news-row">
        {/* Left: Source badge + Title + Domain */}
        <div class="news-row-main">
          {/* Source Badges */}
          <div class="news-source-badges">
            {sources.map((src) => {
              const badge = getSourceBadgeInfo(src);
              return (
                <span class={badge.className}>
                  {badge.label}
                </span>
              );
            })}
            {sources.length > 1 && (
              <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono font-semibold border border-red-500/40 text-red-600 dark:text-red-400 bg-red-500/10 tracking-tight">
                <span>🔥</span>
                <span>{sources.length}</span>
              </span>
            )}
          </div>

          {/* Title Link */}
          <h2 class="news-title">
            <a
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              class="news-link"
            >
              {article.title}
            </a>
            {domain && (
              <span class="news-domain font-mono">
                ({domain})
              </span>
            )}
          </h2>
        </div>

        {/* Right: Controls (Summary Accordion Toggle | Like Icon | Dislike Icon) */}
        <div class="news-actions">
          {/* Expand Summary Button */}
          <button
            type="button"
            class={`action-btn-pill summary-toggle-btn ${initialOpen ? 'is-active' : ''}`}
            aria-expanded={initialOpen ? 'true' : 'false'}
            aria-controls={`summary-${article.id}`}
            title="Toggle AI Summary"
          >
            <span class="summary-btn-text">{initialOpen ? 'Collapse' : 'Summary'}</span>
            <svg class="w-3.5 h-3.5 summary-icon transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {/* Discuss Button (Icon-Only) */}
          {discussLink && (
            <a
              href={discussLink}
              target="_blank"
              rel="noopener noreferrer"
              class="action-icon-btn discuss-btn"
              title="Open discussion on source"
              aria-label="Open discussion on source"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z" />
              </svg>
            </a>
          )}

          {/* Like Button (Icon-Only with counter) */}
          <button
            type="button"
            class="action-icon-btn like-btn"
            data-id={article.id}
            aria-label="Like article"
            title={`Like article (${article.follower_likes || 0} likes)`}
          >
            <svg class="w-4 h-4 like-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
            <svg class="w-4 h-4 animate-spin hidden loading-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span class="like-count-display font-mono">{article.follower_likes || 0}</span>
          </button>

          {/* Dislike Button (Icon-Only) */}
          <button
            type="button"
            class="action-icon-btn dislike-btn"
            data-id={article.id}
            aria-label="Dislike and hide article"
            title="Dislike and hide article"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
            <svg class="w-3.5 h-3.5 animate-spin hidden loading-icon-dislike" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </button>
        </div>
      </div>

      {/* 2. Collapsible Accordion Drawer */}
      <div
        id={`summary-${article.id}`}
        class={`news-accordion-panel ${initialOpen ? 'is-open' : ''}`}
        aria-hidden={initialOpen ? 'false' : 'true'}
      >
        <div class="news-accordion-inner">
          {/* Summary Text */}
          {article.summary ? (
            <p class="news-summary-content">
              {article.summary}
            </p>
          ) : (
            <p class="news-summary-content italic text-[var(--color-ink-faint)]">
              No AI summary generated for this article yet.
            </p>
          )}

          {/* Optional Image */}
          {article.image_url && (
            <div class="news-summary-image-wrapper">
              <img
                src={article.image_url}
                class="news-summary-image"
                alt="Article preview"
                loading={isFirst ? 'eager' : 'lazy'}
              />
            </div>
          )}

          {/* Accordion Footer Metadata & Links */}
          <div class="news-accordion-footer">
            <div class="flex items-center gap-3 flex-wrap">
              {discussLink && (
                <a
                  href={discussLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="news-meta-link"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z" />
                  </svg>
                  <span>Discussion</span>
                </a>
              )}

              <a
                href={`/article/${article.id}`}
                class="news-meta-link"
                title="Direct permalink"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                <span>Permalink</span>
              </a>

              {article.created_at && (
                <time class="news-meta-time font-mono">
                  &bull; {formatTimestamp(article.created_at)}
                </time>
              )}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
};
