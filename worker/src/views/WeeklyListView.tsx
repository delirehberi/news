import type { FC } from 'hono/jsx'
import { Layout } from './Layout'
import type { WeeklyStatus } from '../weekly'

export interface WeeklySummary {
  week: string;
  status: WeeklyStatus;
  title_tr?: string | null;
  intro_tr?: string | null;
  item_count: number;
  youtube_video_id?: string | null;
  published_at?: string | null;
  updated_at?: string;
}

interface WeeklyListViewProps {
  editions: WeeklySummary[];
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

export const WeeklyListView: FC<WeeklyListViewProps> = ({
  editions,
  useEmreTheme = true
}) => {
  const pageTitle = 'Haftalık Bültenler - AI Curated News';
  const pageDescription = 'Hacker News, Lobsters, Reddit ve Stacker News üzerinden derlenen haftalık Türkçe teknoloji özetleri ve video bültenleri.';
  const canonicalUrl = 'https://news.emre.xyz/weekly';

  return (
    <Layout
      title={pageTitle}
      description={pageDescription}
      canonicalUrl={canonicalUrl}
      useEmreTheme={useEmreTheme}
      lang="tr"
    >
      <div class="news-container pt-8 pb-16">
        {/* Header Section */}
        <header class="mb-10 pb-6 border-b border-[var(--color-border-subtle)]">
          <div class="flex items-center gap-2 mb-2 text-xs font-mono text-[var(--color-ink-muted)]">
            <a href="/" class="hover:text-[var(--color-ink)] transition-colors">
              Haber Akışı
            </a>
            <span class="text-[var(--color-ink-faint)]">/</span>
            <span class="text-[var(--color-ink)] font-semibold">Haftalık</span>
          </div>

          <h1 class="text-3xl font-bold tracking-tight text-[var(--color-ink)] mb-3">
            Haftalık Bültenler
          </h1>

          <p class="text-base text-[var(--color-ink-muted)] max-w-2xl leading-relaxed">
            Haftanın en çok dikkat çeken mühendislik makaleleri, sistem mimarileri ve teknoloji haberlerinin Türkçe editoryal özetleri ve video kayıtları.
          </p>
        </header>

        {/* Editions Grid / List */}
        {editions.length === 0 ? (
          <div class="text-center py-16 px-4 rounded-xl border border-dashed border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
            <div class="text-3xl mb-3">📬</div>
            <h2 class="text-lg font-semibold text-[var(--color-ink)] mb-2">
              Henüz yayınlanmış bülten bulunmuyor
            </h2>
            <p class="text-sm text-[var(--color-ink-muted)] mb-6 max-w-md mx-auto">
              Haftalık bültenler her hafta sonu otomatik ve editoryal inceleme sonrasında yayınlanmaktadır.
            </p>
            <a
              href="/"
              class="inline-flex items-center px-4 py-2 rounded-lg bg-[var(--color-surface-elevated)] border border-[var(--color-border)] text-sm font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-hover)] transition-colors"
            >
              &larr; Canlı Haber Akışına Dön
            </a>
          </div>
        ) : (
          <div class="flex flex-col gap-5">
            {editions.map((edition) => {
              const formattedDate = formatPublishedDate(edition.published_at);
              const hasVideo = Boolean(edition.youtube_video_id);

              return (
                <article
                  key={`edition-${edition.week}`}
                  class="group relative rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 hover:border-[var(--color-border)] hover:bg-[var(--color-surface-elevated)] transition-all"
                >
                  <div class="flex flex-wrap items-center gap-2.5 mb-3">
                    <span class="px-2.5 py-0.5 rounded text-xs font-mono font-semibold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30 tracking-tight">
                      {edition.week}
                    </span>

                    {hasVideo && (
                      <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/30 tracking-tight">
                        <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M10 15l5.19-3L10 9v6m11.56-7.83c.13.47.22 1.1.28 1.9.07.8.1 1.49.1 2.09L22 12c0 2.19-.16 3.8-.44 4.83-.25.9-.83 1.48-1.73 1.73-.47.13-1.33.22-2.65.28-1.3.07-2.49.1-3.59.1L12 22c-4.19 0-6.8-.16-7.83-.44-.9-.25-1.48-.83-1.73-1.73-.13-.47-.22-1.1-.28-1.9-.07-.8-.1-1.49-.1-2.09L2 12c0-2.19.16-3.8.44-4.83.25-.9.83-1.48 1.73-1.73.47-.13 1.33-.22 2.65-.28 1.3-.07 2.49-.1 3.59-.1L12 2c4.19 0 6.8.16 7.83.44.9.25 1.48.83 1.73 1.73z" />
                        </svg>
                        <span>Video</span>
                      </span>
                    )}

                    <span class="text-xs font-mono text-[var(--color-ink-faint)]">
                      {edition.item_count} haber
                    </span>

                    {formattedDate && (
                      <time class="text-xs font-mono text-[var(--color-ink-faint)] ml-auto">
                        {formattedDate}
                      </time>
                    )}
                  </div>

                  <h2 class="text-xl font-semibold text-[var(--color-ink)] mb-2 group-hover:text-[var(--color-accent)] transition-colors">
                    <a href={`/weekly/${edition.week}`} class="focus:outline-none">
                      {edition.title_tr || `Haftalık Teknoloji Özeti - ${edition.week}`}
                    </a>
                  </h2>

                  {edition.intro_tr && (
                    <p class="text-sm leading-relaxed text-[var(--color-ink-muted)] mb-4 line-clamp-2">
                      {edition.intro_tr}
                    </p>
                  )}

                  <div class="flex items-center text-xs font-mono font-medium text-[var(--color-ink-muted)] group-hover:text-[var(--color-ink)] transition-colors">
                    <span>Bülteni İncele</span>
                    <span class="ml-1 transition-transform group-hover:translate-x-1">&rarr;</span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
};

