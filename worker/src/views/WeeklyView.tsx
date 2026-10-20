import type { FC } from 'hono/jsx'
import { Layout } from './Layout'
import { getDomain, getSourceBadgeInfo } from './helpers'
import type { WeeklyItem, WeeklyStatus } from '../weekly'

export interface WeeklyViewEdition {
  week: string;
  status: WeeklyStatus;
  title_tr?: string | null;
  intro_tr?: string | null;
  items: WeeklyItem[];
  youtube_video_id?: string | null;
  published_at?: string | null;
  updated_at?: string;
}

interface WeeklyViewProps {
  edition: WeeklyViewEdition;
  useEmreTheme?: boolean;
}

function formatPublishedDate(isoDate?: string | null): string {
  if (!isoDate) return '';
  try {
    const dateStr = isoDate.endsWith('Z') ? isoDate : `${isoDate}Z`;
    const date = new Date(dateStr);
    return new Intl.DateTimeFormat('tr-TR', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }).format(date);
  } catch {
    return isoDate;
  }
}

export const WeeklyView: FC<WeeklyViewProps> = ({
  edition,
  useEmreTheme = true
}) => {
  const pageTitle = `${edition.title_tr || `Haftalık Bülten (${edition.week})`} - AI Curated News`;
  const pageDescription = edition.intro_tr || `Haftalık özet: ${edition.week} bülteni.`;
  const canonicalUrl = `https://news.emre.xyz/weekly/${edition.week}`;
  const formattedDate = formatPublishedDate(edition.published_at);

  return (
    <Layout
      title={pageTitle}
      description={pageDescription}
      canonicalUrl={canonicalUrl}
      useEmreTheme={useEmreTheme}
      lang="tr"
    >
      <div class="news-container pt-8 pb-4">
        {/* Navigation Breadcrumb */}
        <div class="flex items-center gap-3 mb-6 text-xs font-mono text-[var(--color-ink-muted)]">
          <a
            href="/weekly"
            class="inline-flex items-center gap-1.5 hover:text-[var(--color-ink)] transition-colors group"
          >
            <svg class="w-4 h-4 transition-transform group-hover:-translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            <span>Tüm Bültenler</span>
          </a>
          <span class="text-[var(--color-ink-faint)]">/</span>
          <span class="text-[var(--color-ink)] font-semibold">{edition.week}</span>
        </div>

        {/* Edition Header */}
        <header class="mb-8 border-b border-[var(--color-border-subtle)] pb-6">
          <div class="flex flex-wrap items-center gap-2 mb-3">
            <span class="px-2.5 py-0.5 rounded text-xs font-mono font-semibold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30 tracking-tight">
              {edition.week}
            </span>
            {formattedDate && (
              <time class="text-xs font-mono text-[var(--color-ink-faint)]">
                {formattedDate}
              </time>
            )}
            <span class="text-xs font-mono text-[var(--color-ink-faint)] ml-auto">
              {edition.items.length} haber
            </span>
          </div>

          <h1 class="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--color-ink)] mb-4">
            {edition.title_tr || `Haftalık Teknoloji Özeti - ${edition.week}`}
          </h1>

          {edition.intro_tr && (
            <p class="text-base sm:text-lg leading-relaxed text-[var(--color-ink-muted)] max-w-3xl">
              {edition.intro_tr}
            </p>
          )}
        </header>

        {/* YouTube Video Player Embed */}
        {edition.youtube_video_id && (
          <section class="mb-10">
            <div class="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-black shadow-lg">
              <div class="relative w-full aspect-video">
                <iframe
                  class="absolute inset-0 w-full h-full"
                  src={`https://www.youtube-nocookie.com/embed/${edition.youtube_video_id}`}
                  title={`${edition.title_tr || 'Haftalık Video Özeti'} - YouTube`}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowfullscreen
                />
              </div>
            </div>
          </section>
        )}

        {/* Curated Stories Section */}
        <section class="pb-16">
          <h2 class="text-xs font-mono font-semibold uppercase tracking-wider text-[var(--color-ink-faint)] mb-4">
            Öne Çıkan Gelişmeler
          </h2>

          <div class="flex flex-col gap-4">
            {edition.items.map((item, index) => {
              const badge = getSourceBadgeInfo(item.source);
              const domain = getDomain(item.url);

              return (
                <article
                  key={`${edition.week}-item-${index}`}
                  class="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 sm:p-5 hover:border-[var(--color-border)] transition-colors"
                >
                  <div class="flex flex-wrap items-center gap-2 mb-2">
                    <span class={badge.className}>{badge.label}</span>
                    {domain && (
                      <span class="text-xs font-mono text-[var(--color-ink-faint)]">
                        {domain}
                      </span>
                    )}
                  </div>

                  <h3 class="text-base sm:text-lg font-semibold text-[var(--color-ink)] mb-2">
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="hover:text-[var(--color-accent)] transition-colors"
                    >
                      {item.title_tr}
                    </a>
                  </h3>

                  <p class="text-sm leading-relaxed text-[var(--color-ink-muted)] mb-3">
                    {item.summary_tr}
                  </p>

                  {item.image_url && (
                    <div class="mb-3 max-w-lg overflow-hidden rounded-md border border-[var(--color-border-subtle)]">
                      <img
                        src={item.image_url}
                        alt={item.title_tr}
                        loading="lazy"
                        class="w-full max-h-64 object-cover"
                      />
                    </div>
                  )}

                  <div class="pt-2 border-t border-[var(--color-border-subtle)] flex items-center justify-between">
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="inline-flex items-center gap-1 text-xs font-mono text-[var(--color-ink-faint)] hover:text-[var(--color-ink)] transition-colors"
                    >
                      <span>Kaynağa Git</span>
                      <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </a>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        {/* Footer Navigation */}
        <div class="pt-8 border-t border-[var(--color-border-subtle)] flex flex-wrap items-center justify-between gap-4 text-xs font-mono text-[var(--color-ink-muted)] mb-12">
          <a
            href="/weekly"
            class="hover:text-[var(--color-ink)] transition-colors flex items-center gap-1"
          >
            <span>&larr;</span>
            <span>Tüm Haftalık Bültenler</span>
          </a>
          <a
            href="/"
            class="hover:text-[var(--color-ink)] transition-colors"
          >
            Canlı Haber Akışı &rarr;
          </a>
        </div>
      </div>
    </Layout>
  );
};

