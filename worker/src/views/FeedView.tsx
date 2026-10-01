import type { FC } from 'hono/jsx'
import { Layout } from './Layout'
import { ArticleCard } from './ArticleCard'
import { ArticleModel, timeSince } from './helpers'

interface FeedViewProps {
  articles: ArticleModel[];
  sort: string;
  sourceFilter?: string;
  lastCuratedAt?: string | null;
  useEmreTheme?: boolean;
}

export const FeedView: FC<FeedViewProps> = ({
  articles,
  sort,
  sourceFilter = 'all',
  lastCuratedAt,
  useEmreTheme = true
}) => {
  const isHot = sort !== 'latest';
  const sources = [
    { id: 'all', label: 'All Sources' },
    { id: 'hackernews', label: 'HN' },
    { id: 'lobsters', label: 'Lobsters' },
    { id: 'reddit', label: 'Reddit' },
    { id: 'stackernews', label: 'Stacker' }
  ];

  return (
    <Layout
      title="AI Curated News - Systems, AI & Software Engineering"
      description="Real-time AI-curated technical articles, engineering deep-dives, systems insights and postmortems."
      useEmreTheme={useEmreTheme}
    >
      <header class="news-container pt-8 pb-4">
        <div class="news-header-top">
          <p id="app-subtitle" class="news-subtitle">
            Curated engineering news, architecture deep-dives & systems insights.
          </p>
          <a
            href="/rss.xml"
            class="rss-feed-link"
            title="Subscribe via RSS"
          >
            <svg class="rss-icon" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6.18 15.64a2.18 2.18 0 1 1-2.18 2.18 2.18 2.18 0 0 1 2.18-2.18M4 4.44A15.56 15.56 0 0 1 19.56 20h-3.11A12.45 12.45 0 0 0 4 7.55Zm0 6.22A9.34 9.34 0 0 1 13.34 20h-3.11A6.23 6.23 0 0 0 4 13.77Z" />
            </svg>
            <span>RSS Feed</span>
          </a>
        </div>

        {/* Sorting & Filter Controls */}
        <div class="news-controls-row">
          <div class="news-tabs-group">
            <a
              id="tab-hot"
              href={sourceFilter !== 'all' ? `/?sort=hot&source=${sourceFilter}` : '/?sort=hot'}
              class={`tab-pill ${isHot ? 'is-active' : ''}`}
            >
              <span>🔥</span>
              <span>Top Stories</span>
            </a>
            <a
              id="tab-latest"
              href={sourceFilter !== 'all' ? `/?sort=latest&source=${sourceFilter}` : '/?sort=latest'}
              class={`tab-pill ${!isHot ? 'is-active' : ''}`}
            >
              <span>⏱️</span>
              <span>Latest</span>
            </a>
          </div>

          {lastCuratedAt && (
            <span id="curated-status" class="news-updated-time">
              Updated {timeSince(lastCuratedAt)}
            </span>
          )}
        </div>

        {/* Source Filter Pills */}
        <div class="news-sources-row">
          <span class="news-sources-label">Sources:</span>
          <div class="news-sources-list">
            {sources.map((src) => {
              const isActive = (sourceFilter === src.id) || (sourceFilter === 'all' && src.id === 'all');
              const href = src.id === 'all'
                ? `/?sort=${isHot ? 'hot' : 'latest'}`
                : `/?sort=${isHot ? 'hot' : 'latest'}&source=${src.id}`;

              return (
                <a
                  href={href}
                  class={`source-filter-pill ${isActive ? 'is-active' : ''}`}
                >
                  {src.label}
                </a>
              );
            })}
          </div>
        </div>
      </header>

      <main class="news-container pb-24">
        {/* Loading skeleton placeholder */}
        <div id="loading" class="hidden flex-col gap-2" aria-label="Loading curated articles" aria-busy="false">
          <div class="skeleton-card space-y-2">
            <div class="skeleton-bar h-4 w-1/4"></div>
            <div class="skeleton-bar h-5 w-4/5"></div>
          </div>
        </div>

        <div id="error" class="hidden text-center text-rose-300 bg-rose-950/30 p-6 rounded-xl border border-rose-800/40 text-sm mb-4"></div>

        {/* Feed container */}
        <div id="feed" class="flex flex-col gap-1.5">
          {articles.length === 0 ? (
            <div class="text-center text-[var(--color-ink-faint)] py-16 border border-[var(--color-border-subtle)] rounded-lg text-sm bg-[var(--color-surface)]">
              No curated articles found for this filter. Check back soon.
            </div>
          ) : (
            articles.map((article, idx) => (
              <ArticleCard article={article} index={idx} />
            ))
          )}
        </div>
      </main>
    </Layout>
  );
};
