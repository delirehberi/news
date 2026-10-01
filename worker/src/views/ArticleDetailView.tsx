import type { FC } from 'hono/jsx'
import { Layout } from './Layout'
import { ArticleCard } from './ArticleCard'
import { ArticleModel } from './helpers'

interface ArticleDetailViewProps {
  article: ArticleModel;
  useEmreTheme?: boolean;
}

export const ArticleDetailView: FC<ArticleDetailViewProps> = ({
  article,
  useEmreTheme = true
}) => {
  const pageTitle = `${article.title} - AI Curated News`;
  const pageDescription = article.summary || `Curated engineering article from ${article.source}: ${article.title}`;
  const canonicalUrl = `https://news.emre.xyz/article/${article.id}`;
  const ogImage = article.image_url || 'https://news.emre.xyz/assets/hero.png';

  return (
    <Layout
      title={pageTitle}
      description={pageDescription}
      canonicalUrl={canonicalUrl}
      ogImage={ogImage}
      useEmreTheme={useEmreTheme}
    >
      <div class="news-container pt-8 pb-4">
        <a
          href="/"
          class="inline-flex items-center gap-1.5 text-xs font-mono text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors mb-4 group"
        >
          <svg class="w-4 h-4 transition-transform group-hover:-translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          <span>Back to all stories</span>
        </a>
      </div>

      <main class="news-container pb-24">
        <div id="feed" class="flex flex-col gap-1.5">
          <ArticleCard article={article} index={0} initialOpen={true} />
        </div>
      </main>
    </Layout>
  );
};
