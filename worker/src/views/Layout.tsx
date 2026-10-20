import type { FC, PropsWithChildren } from 'hono/jsx'
import { raw } from 'hono/html'

interface LayoutProps {
  title?: string;
  description?: string;
  canonicalUrl?: string;
  ogImage?: string;
  useEmreTheme?: boolean;
  lang?: string;
}

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({
  title = 'AI Curated News',
  description = 'AI-curated engineering news, deep-dives, and technical postmortems across Hacker News, Lobsters, Reddit, and Stacker News.',
  canonicalUrl = 'https://news.emre.xyz',
  ogImage = 'https://news.emre.xyz/assets/hero.png',
  useEmreTheme = true,
  lang = 'en',
  children
}) => {
  return (
    <>
      {raw('<!DOCTYPE html>\n')}
      <html lang={lang}>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{title}</title>
        <meta name="description" content={description} />
        <link rel="canonical" href={canonicalUrl} />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="alternate" type="application/rss+xml" title="AI Curated News RSS Feed" href="/rss.xml" />

        {/* OpenGraph */}
        <meta property="og:type" content="website" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={canonicalUrl} />
        <meta property="og:image" content={ogImage} />
        <meta property="og:site_name" content="AI Curated News" />

        {/* Twitter */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={description} />
        <meta name="twitter:image" content={ogImage} />

        {/* CSS Bundle */}
        <link rel="stylesheet" href="/assets/app.css" />

        {/* Emre Theme Integration (if enabled) */}
        {useEmreTheme && (
          <>
            <link rel="stylesheet" href="https://emre.xyz/components/theme.css" />
            <script type="module" src="https://emre.xyz/components/ui.js"></script>
          </>
        )}
      </head>
      <body class={`antialiased selection:bg-amber-500/20 selection:text-amber-200 ${useEmreTheme ? 'emre-unified' : ''}`}>
        {/* Header container */}
        <div id="header-container">
          {useEmreTheme ? (
            <div dangerouslySetInnerHTML={{ __html: '<emre-header active-page="news"></emre-header>' }} />
          ) : (
            <header class="w-full border-b border-[var(--color-border-subtle)] bg-[var(--color-surface)] sticky top-0 z-50">
              <div class="news-container h-14 flex items-center justify-between">
                <a href="/" class="text-base font-semibold tracking-tight text-[var(--color-ink)] hover:opacity-80">
                  AI News
                </a>
                <nav class="flex items-center gap-4">
                  <a href="/" class="text-sm text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors">Feed</a>
                  <a href="/weekly" class="text-sm text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors">Haftalık</a>
                  <a href="/rss.xml" class="text-sm text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors flex items-center gap-1.5">
                    <svg class="w-3.5 h-3.5 text-amber-500" fill="currentColor" viewBox="0 0 24 24"><path d="M6.18 15.64a2.18 2.18 0 1 1-2.18 2.18 2.18 2.18 0 0 1 2.18-2.18M4 4.44A15.56 15.56 0 0 1 19.56 20h-3.11A12.45 12.45 0 0 0 4 7.55Zm0 6.22A9.34 9.34 0 0 1 13.34 20h-3.11A6.23 6.23 0 0 0 4 13.77Z"/></svg>
                    <span>RSS</span>
                  </a>
                </nav>
              </div>
            </header>
          )}
        </div>

        {/* Main Content */}
        {children}

        {/* Footer container */}
        <div id="footer-container">
          {useEmreTheme ? (
            <div dangerouslySetInnerHTML={{ __html: '<emre-footer></emre-footer>' }} />
          ) : (
            <footer class="news-container border-t border-[var(--color-border-subtle)] mt-12 py-8 text-center text-xs text-[var(--color-ink-faint)]">
              <p>Curated with Cloudflare Workers & Nostr</p>
            </footer>
          )}
        </div>

        {/* Client-side Progressive Enhancement Script */}
        <script type="module" src="/assets/app.js"></script>
      </body>
    </html>
    </>
  );
};
