import type { FC } from 'hono/jsx'
import { RelatedArticle, getOriginalPostUrl, getSourceBadgeInfo, getDomain } from './helpers'

interface RelatedCoverageProps {
  related?: RelatedArticle[];
  primaryUrl: string;
  showTitles?: boolean;
}

// Other sources covering the same story, merged into the primary card by duplicate clustering.
export const RelatedCoverage: FC<RelatedCoverageProps> = ({ related, primaryUrl, showTitles = false }) => {
  if (!related || related.length === 0) return null;

  return (
    <div class={`news-related ${showTitles ? 'news-related-detailed' : ''}`}>
      <span class="news-related-label">{showTitles ? 'Also covered on' : 'Also on'}</span>
      {related.map((item) => {
        const badge = getSourceBadgeInfo(item.source);
        const discussLink = getOriginalPostUrl(item.id);
        const domain = getDomain(item.url);
        // Newsletter items have no discussion page, so their badge already points at the article itself.
        const showUrl = Boolean(domain) && item.url !== primaryUrl && Boolean(discussLink);
        return (
          <span class="news-related-item">
            <a
              href={discussLink || item.url}
              target="_blank"
              rel="noopener noreferrer"
              class="news-meta-link"
              title={discussLink ? `Discussion: ${item.title}` : item.title}
            >
              <span class={badge.className}>{badge.label}</span>
              {showTitles && <span class="news-related-title">{item.title}</span>}
            </a>
            {showUrl && (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                class="news-meta-link"
                title={item.url}
              >
                ({domain})
              </a>
            )}
          </span>
        );
      })}
    </div>
  );
};
