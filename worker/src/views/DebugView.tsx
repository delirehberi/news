import type { FC } from 'hono/jsx'
import { Layout } from './Layout'
import { getSourceBadgeInfo, getDomain, getOriginalPostUrl } from './helpers'

export interface VectorMatchDetail {
  id: string;
  score: number;
  type: 'like' | 'dislike' | 'upvote' | 'unknown';
  title?: string;
  source?: string;
  url?: string;
}

export interface DiagnosticItem {
  id: string;
  title: string;
  url: string;
  source: string;
  sources: string[];
  source_count: number;
  original_post_url?: string | null;
  status: 'ACCEPTED' | 'REJECTED';
  primary_reason: string;
  rejection_stage?: 'dedup' | 'scrape' | 'vector' | 'llm' | 'filter';
  details?: {
    description?: string;
    headings?: string;
    content?: string;
    fullText?: string;
  };
  vector_eval?: {
    affinityScore: number;
    topPositiveScore: number;
    topNegativeScore: number;
    positiveCount: number;
    negativeCount: number;
    recommendation: 'accept' | 'reject' | 'uncertain';
    top_positive_matches: VectorMatchDetail[];
    top_negative_matches: VectorMatchDetail[];
  };
  llm_eval?: {
    was_sent_to_llm: boolean;
    llm_accepted?: boolean;
    raw_response?: string;
  };
  scores: {
    importance_score: number;
    affinity_score: number;
    top_positive_score: number;
    top_negative_score: number;
    source_multiplier: number;
  };
}

export interface DiagnosticReport {
  timestamp: string;
  source: string;
  is_local: boolean;
  is_admin_authenticated: boolean;
  admin_pubkey?: string;
  taste_profile: string;
  stats: {
    total_raw: number;
    total_unique: number;
    total_scraped: number;
    total_accepted: number;
    total_rejected: number;
    duration_ms: number;
    errors: string[];
  };
  items: DiagnosticItem[];
}

interface DebugViewProps {
  report?: DiagnosticReport | null;
  error?: string | null;
  isAuthorized: boolean;
  isLocal: boolean;
  authorizedPubkey?: string;
  currentSource: string;
  useEmreTheme?: boolean;
}

export const DebugView: FC<DebugViewProps> = ({
  report,
  error,
  isAuthorized,
  isLocal,
  authorizedPubkey,
  currentSource = 'all',
  useEmreTheme = true
}) => {
  const sources = [
    { id: 'all', label: 'All Sources' },
    { id: 'hn', label: 'Hacker News' },
    { id: 'lobsters', label: 'Lobsters' },
    { id: 'reddit', label: 'Reddit' },
    { id: 'stacker', label: 'Stacker News' },
    { id: 'gmail', label: 'Newsletters' }
  ];

  return (
    <Layout
      title="Ingestion & Recommendation Debugger — AI News"
      description="Live diagnostic inspector for ingestion pipelines, vector similarity matching, LLM judge curation, and score breakdowns."
      useEmreTheme={useEmreTheme}
    >
      <main class="news-container py-8 max-w-6xl mx-auto font-sans">
        {/* Technical Header */}
        <div class="border-b border-[var(--color-border)] pb-6 mb-8">
          <div class="flex flex-wrap items-center justify-between gap-4 mb-3">
            <div class="flex items-center gap-3">
              <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium bg-amber-500/10 text-amber-400 border border-amber-500/30">
                SYSTEM DIAGNOSTICS
              </span>
              <h1 class="text-xl md:text-2xl font-bold tracking-tight text-[var(--color-ink)]">
                Feed Ingestion & Curation Inspector
              </h1>
            </div>

            {/* Auth Environment Indicator */}
            <div class="flex items-center gap-2 text-xs font-mono">
              {isLocal ? (
                <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-950/40 text-emerald-400 border border-emerald-800/40">
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                  LOCAL ENVIRONMENT (UNRESTRICTED)
                </span>
              ) : isAuthorized ? (
                <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-cyan-950/40 text-cyan-400 border border-cyan-800/40">
                  <span class="w-1.5 h-1.5 rounded-full bg-cyan-400"></span>
                  NOSTR AUTHENTICATED ADMIN
                </span>
              ) : (
                <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-rose-950/40 text-rose-400 border border-rose-800/40">
                  <span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span>
                  UNAUTHORIZED PRODUCTION ACCESS
                </span>
              )}
            </div>
          </div>

          <p class="text-xs md:text-sm text-[var(--color-ink-muted)] max-w-3xl leading-relaxed">
            Real-time dry-run trace of upstream sources, scraping extractors, Vectorize nearest-neighbor cosine similarity scores, LLM taste profile evaluation, and link exclusion reasons.
          </p>
        </div>

        {/* Auth Gate for Production */}
        {!isAuthorized ? (
          <div class="my-12 p-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-elevated)] max-w-xl mx-auto text-center shadow-lg">
            <div class="w-12 h-12 mx-auto mb-4 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h2 class="text-lg font-bold text-[var(--color-ink)] mb-2">
              Nostr Admin Signature Required
            </h2>
            <p class="text-xs text-[var(--color-ink-muted)] mb-6 leading-relaxed">
              This endpoint performs live AI and vector queries against production services. Sign an authorization challenge with your Nostr extension (NIP-07) to verify ownership of the authorized curator pubkey.
            </p>
            {authorizedPubkey && (
              <div class="mb-6 p-2.5 bg-[var(--color-surface)] border border-[var(--color-border-subtle)] rounded text-[11px] font-mono text-[var(--color-ink-faint)] break-all">
                Authorized Pubkey: {authorizedPubkey}
              </div>
            )}
            <button
              id="btn-nostr-auth"
              class="w-full py-2.5 px-4 rounded font-medium text-xs bg-amber-500 text-black hover:bg-amber-400 active:bg-amber-600 transition-colors flex items-center justify-center gap-2 cursor-pointer"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/>
              </svg>
              <span>Authenticate with Nostr (NIP-07)</span>
            </button>
            <div id="auth-status" class="mt-3 text-xs text-rose-400 hidden font-mono"></div>
          </div>
        ) : error ? (
          <div class="p-6 rounded-lg bg-rose-950/20 border border-rose-800/40 text-rose-300 text-xs font-mono mb-8">
            <div class="font-bold mb-1 text-sm">Diagnostic Execution Error:</div>
            <div>{error}</div>
          </div>
        ) : report ? (
          <div>
            {/* Control Bar & Source Selectors */}
            <div class="flex flex-wrap items-center justify-between gap-4 p-4 rounded-lg bg-[var(--color-surface-elevated)] border border-[var(--color-border)] mb-6">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-xs font-mono uppercase tracking-wider text-[var(--color-ink-faint)] mr-1">Source:</span>
                {sources.map((src) => {
                  const isActive = currentSource === src.id;
                  return (
                    <a
                      href={`/debug?source=${src.id}`}
                      class={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                        isActive
                          ? 'bg-amber-500 text-black font-semibold'
                          : 'bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:border-amber-500/50'
                      }`}
                    >
                      {src.label}
                    </a>
                  );
                })}
              </div>

              <div class="flex items-center gap-2">
                <button
                  type="button"
                  id="btn-live-ingest"
                  data-source={currentSource}
                  class="px-3 py-1 text-xs font-mono rounded bg-emerald-950/60 border border-emerald-600/60 text-emerald-300 hover:bg-emerald-900/80 active:bg-emerald-800 transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                  title="Run live ingestion and insert curated articles into the main feed database"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                  </svg>
                  <span id="btn-live-ingest-text">Ingest to Feed</span>
                </button>
                <a
                  href={`/debug?source=${currentSource}&refresh=1`}
                  class="px-3 py-1 text-xs font-mono rounded bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-ink)] hover:bg-[var(--color-surface-hover)] transition-colors inline-flex items-center gap-1.5"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span>Re-run Trace</span>
                </a>
                <a
                  href={`/api/debug?source=${currentSource}`}
                  target="_blank"
                  class="px-3 py-1 text-xs font-mono rounded bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors"
                >
                  JSON API &nearr;
                </a>
              </div>
            </div>

            {/* Metrics Dashboard */}
            <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 mb-6">
              <div class="p-3.5 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border-subtle)]">
                <div class="text-[10px] font-mono uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Raw Fetched</div>
                <div class="text-xl font-bold font-mono text-[var(--color-ink)]">{report.stats.total_raw}</div>
              </div>

              <div class="p-3.5 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border-subtle)]">
                <div class="text-[10px] font-mono uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Unique URLs</div>
                <div class="text-xl font-bold font-mono text-[var(--color-ink)]">{report.stats.total_unique}</div>
              </div>

              <div class="p-3.5 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border-subtle)]">
                <div class="text-[10px] font-mono uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Scraped & Embedded</div>
                <div class="text-xl font-bold font-mono text-[var(--color-ink)]">{report.stats.total_scraped}</div>
              </div>

              <div class="p-3.5 rounded-lg bg-emerald-950/20 border border-emerald-800/40">
                <div class="text-[10px] font-mono uppercase tracking-wider text-emerald-400 mb-1">Accepted (Listed)</div>
                <div class="text-xl font-bold font-mono text-emerald-300">{report.stats.total_accepted}</div>
              </div>

              <div class="p-3.5 rounded-lg bg-rose-950/20 border border-rose-800/40">
                <div class="text-[10px] font-mono uppercase tracking-wider text-rose-400 mb-1">Rejected (Excluded)</div>
                <div class="text-xl font-bold font-mono text-rose-300">{report.stats.total_rejected}</div>
              </div>

              <div class="p-3.5 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border-subtle)]">
                <div class="text-[10px] font-mono uppercase tracking-wider text-[var(--color-ink-faint)] mb-1">Trace Latency</div>
                <div class="text-xl font-bold font-mono text-[var(--color-ink)]">{(report.stats.duration_ms / 1000).toFixed(2)}s</div>
              </div>
            </div>

            {/* Active Taste Profile Bar */}
            <div class="p-4 rounded-lg bg-[var(--color-surface-elevated)] border border-[var(--color-border)] mb-6 text-xs">
              <div class="flex items-center gap-2 mb-1.5 font-mono text-[11px] text-amber-400 uppercase tracking-wide">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Active AI Taste Profile (Curation Reference):
              </div>
              <div class="text-[var(--color-ink-muted)] leading-relaxed italic">
                "{report.taste_profile}"
              </div>
            </div>

            {/* Errors display if any */}
            {report.stats.errors && report.stats.errors.length > 0 && (
              <div class="p-4 rounded-lg bg-rose-950/20 border border-rose-800/30 text-rose-300 text-xs font-mono mb-6">
                <div class="font-bold mb-1">Pipeline Warnings / Notices:</div>
                <ul class="list-disc list-inside space-y-0.5 text-[11px]">
                  {report.stats.errors.map((err) => <li>{err}</li>)}
                </ul>
              </div>
            )}

            {/* Interactive Filter Bar */}
            <div class="flex items-center justify-between border-b border-[var(--color-border)] pb-3 mb-4 text-xs">
              <div class="flex items-center gap-2">
                <span class="text-[var(--color-ink-faint)] font-mono">FILTER:</span>
                <button
                  type="button"
                  data-filter="all"
                  class="debug-filter-btn px-2.5 py-1 rounded font-mono font-medium bg-amber-500/20 text-amber-300 border border-amber-500/40"
                >
                  All ({report.items.length})
                </button>
                <button
                  type="button"
                  data-filter="accepted"
                  class="debug-filter-btn px-2.5 py-1 rounded font-mono font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] border border-transparent"
                >
                  Accepted ({report.stats.total_accepted})
                </button>
                <button
                  type="button"
                  data-filter="rejected"
                  class="debug-filter-btn px-2.5 py-1 rounded font-mono font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] border border-transparent"
                >
                  Rejected ({report.stats.total_rejected})
                </button>
              </div>

              <div class="text-[11px] font-mono text-[var(--color-ink-faint)]">
                Click any item to inspect vector matches & scrape data
              </div>
            </div>

            {/* Link Diagnostic Cards */}
            <div class="flex flex-col gap-3" id="debug-items-list">
              {report.items.length === 0 ? (
                <div class="p-12 text-center text-xs font-mono text-[var(--color-ink-faint)] border border-dashed border-[var(--color-border)] rounded-lg">
                  No candidate articles fetched from this source.
                </div>
              ) : (
                report.items.map((item, idx) => {
                  const isAccepted = item.status === 'ACCEPTED';
                  const domain = getDomain(item.url);
                  const originalUrl = item.original_post_url || getOriginalPostUrl(item.id);
                  const badgeInfo = getSourceBadgeInfo(item.source);

                  return (
                    <details
                      data-status={item.status.toLowerCase()}
                      class={`group border rounded-lg overflow-hidden transition-all bg-[var(--color-surface)] ${
                        isAccepted
                          ? 'border-emerald-800/40 hover:border-emerald-500/50'
                          : 'border-rose-900/40 hover:border-rose-700/50 opacity-90'
                      }`}
                    >
                      <summary class="flex flex-col md:flex-row md:items-center justify-between p-4 cursor-pointer select-none gap-3 hover:bg-[var(--color-surface-hover)]">
                        <div class="flex-1 min-w-0">
                          {/* Top Status & Reason Bar */}
                          <div class="flex flex-wrap items-center gap-2 mb-1.5">
                            {/* Status Badge */}
                            <span class={`px-2 py-0.5 text-[10px] font-mono font-bold tracking-wider uppercase rounded ${
                              isAccepted
                                ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-600/50'
                                : 'bg-rose-950/80 text-rose-300 border border-rose-600/50'
                            }`}>
                              {item.status}
                            </span>

                            {/* Source Badge */}
                            <span class={`text-[10px] font-mono px-1.5 py-0.5 rounded ${badgeInfo.className}`}>
                              {badgeInfo.label}
                            </span>

                            {/* Multi-source count if > 1 */}
                            {item.source_count > 1 && (
                              <span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-950/50 text-blue-300 border border-blue-800/40">
                                {item.source_count} Sources ({item.sources.join(', ')})
                              </span>
                            )}

                            {/* Primary Reason Pill */}
                            <span class={`text-xs font-medium px-2 py-0.5 rounded ${
                              isAccepted
                                ? 'text-emerald-300/90 bg-emerald-950/40'
                                : 'text-rose-300/90 bg-rose-950/40'
                            }`}>
                              {item.primary_reason}
                            </span>
                          </div>

                          {/* Title */}
                          <div class="flex items-baseline gap-2">
                            <h3 class="text-sm font-semibold text-[var(--color-ink)] leading-snug group-hover:text-amber-400 transition-colors">
                              {item.title}
                            </h3>
                            {domain && (
                              <span class="text-[11px] font-mono text-[var(--color-ink-faint)] shrink-0">
                                ({domain})
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Scores Strip */}
                        <div class="flex items-center gap-2 shrink-0 pt-2 md:pt-0 border-t md:border-t-0 border-[var(--color-border-subtle)] font-mono text-xs">
                          {isAccepted && (
                            <div class="text-right px-2.5 py-1 rounded bg-amber-500/10 border border-amber-500/20">
                              <div class="text-[9px] uppercase tracking-wider text-amber-400">Score</div>
                              <div class="font-bold text-amber-300">{item.scores.importance_score.toFixed(2)}</div>
                            </div>
                          )}

                          <div class="text-right px-2 py-1 rounded bg-[var(--color-surface-elevated)] border border-[var(--color-border-subtle)]">
                            <div class="text-[9px] uppercase tracking-wider text-[var(--color-ink-faint)]">Affinity</div>
                            <div class={`font-bold ${item.scores.affinity_score > 0 ? 'text-emerald-400' : item.scores.affinity_score < 0 ? 'text-rose-400' : 'text-[var(--color-ink-muted)]'}`}>
                              {item.scores.affinity_score > 0 ? `+${item.scores.affinity_score.toFixed(2)}` : item.scores.affinity_score.toFixed(2)}
                            </div>
                          </div>

                          <div class="text-right px-2 py-1 rounded bg-[var(--color-surface-elevated)] border border-[var(--color-border-subtle)]">
                            <div class="text-[9px] uppercase tracking-wider text-emerald-400">Top +</div>
                            <div class="font-bold text-emerald-300">
                              {item.scores.top_positive_score > 0 ? (item.scores.top_positive_score * 100).toFixed(0) + '%' : '—'}
                            </div>
                          </div>

                          <div class="text-right px-2 py-1 rounded bg-[var(--color-surface-elevated)] border border-[var(--color-border-subtle)]">
                            <div class="text-[9px] uppercase tracking-wider text-rose-400">Top -</div>
                            <div class="font-bold text-rose-300">
                              {item.scores.top_negative_score > 0 ? (item.scores.top_negative_score * 100).toFixed(0) + '%' : '—'}
                            </div>
                          </div>

                          <div class="text-[var(--color-ink-faint)] pl-1">
                            <svg class="w-4 h-4 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                            </svg>
                          </div>
                        </div>
                      </summary>

                      {/* Expanded Technical Inspector Details */}
                      <div class="border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-elevated)] p-4 text-xs space-y-4 font-mono">
                        {/* Links Row */}
                        <div class="flex flex-wrap items-center gap-3 pb-3 border-b border-[var(--color-border-subtle)]">
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="text-amber-400 hover:underline inline-flex items-center gap-1 font-sans"
                          >
                            <span>Direct Link &rarr;</span>
                            <span class="text-[10px] text-[var(--color-ink-faint)] max-w-md truncate">{item.url}</span>
                          </a>

                          {originalUrl && (
                            <a
                              href={originalUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              class="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:underline inline-flex items-center gap-1"
                            >
                              Discussion ({item.source}) &rarr;
                            </a>
                          )}
                        </div>

                        {/* Recommendation Pipeline Breakdown */}
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {/* Vector Match Breakdown */}
                          <div class="p-3 rounded bg-[var(--color-surface)] border border-[var(--color-border-subtle)]">
                            <div class="text-[11px] font-bold text-[var(--color-ink)] mb-2 flex items-center justify-between">
                              <span>Vector Similarity Analysis (topK: 6)</span>
                              <span class={`px-1.5 py-0.2 rounded text-[10px] ${
                                item.vector_eval?.recommendation === 'accept'
                                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                                  : item.vector_eval?.recommendation === 'reject'
                                  ? 'bg-rose-950 text-rose-300 border border-rose-800'
                                  : 'bg-amber-950 text-amber-300 border border-amber-800'
                              }`}>
                                Vector Rec: {item.vector_eval?.recommendation || 'uncertain'}
                              </span>
                            </div>

                            {/* Nearest Positive Matches */}
                            <div class="mb-3">
                              <div class="text-[10px] text-emerald-400 uppercase tracking-wide mb-1">
                                Top Positive Matches (Upvoted/Liked Memory):
                              </div>
                              {item.vector_eval?.top_positive_matches && item.vector_eval.top_positive_matches.length > 0 ? (
                                <div class="space-y-1.5">
                                  {item.vector_eval.top_positive_matches.map((m) => {
                                    const matchTitle = m.title || m.id;
                                    return (
                                      <div class="text-[11px] flex items-center justify-between text-[var(--color-ink-muted)] bg-[var(--color-surface-elevated)] p-1.5 rounded gap-2">
                                        <div class="flex items-center gap-1.5 min-w-0 flex-1">
                                          <span class="text-[9px] font-mono px-1 py-0.2 rounded bg-emerald-950/60 text-emerald-400 border border-emerald-800/40 shrink-0">
                                            {m.type === 'like' ? 'LIKED' : 'UPVOTE'}
                                          </span>
                                          {m.url ? (
                                            <a
                                              href={m.url}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              class="truncate text-[var(--color-ink)] hover:text-amber-400 hover:underline"
                                              title={`${matchTitle} (ID: ${m.id})`}
                                            >
                                              {matchTitle}
                                            </a>
                                          ) : (
                                            <span class="truncate text-[var(--color-ink)]" title={`${matchTitle} (ID: ${m.id})`}>
                                              {matchTitle}
                                            </span>
                                          )}
                                        </div>
                                        <span class="text-emerald-400 font-bold shrink-0 font-mono">
                                          {(m.score * 100).toFixed(1)}%
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div class="text-[10px] text-[var(--color-ink-faint)] italic">No significant positive matches found</div>
                              )}
                            </div>

                            {/* Nearest Negative Matches */}
                            <div>
                              <div class="text-[10px] text-rose-400 uppercase tracking-wide mb-1">
                                Top Negative Matches (Disliked Memory):
                              </div>
                              {item.vector_eval?.top_negative_matches && item.vector_eval.top_negative_matches.length > 0 ? (
                                <div class="space-y-1.5">
                                  {item.vector_eval.top_negative_matches.map((m) => {
                                    const matchTitle = m.title || m.id;
                                    return (
                                      <div class="text-[11px] flex items-center justify-between text-[var(--color-ink-muted)] bg-[var(--color-surface-elevated)] p-1.5 rounded gap-2">
                                        <div class="flex items-center gap-1.5 min-w-0 flex-1">
                                          <span class="text-[9px] font-mono px-1 py-0.2 rounded bg-rose-950/60 text-rose-400 border border-rose-800/40 shrink-0">
                                            DISLIKED
                                          </span>
                                          {m.url ? (
                                            <a
                                              href={m.url}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              class="truncate text-[var(--color-ink)] hover:text-rose-400 hover:underline"
                                              title={`${matchTitle} (ID: ${m.id})`}
                                            >
                                              {matchTitle}
                                            </a>
                                          ) : (
                                            <span class="truncate text-[var(--color-ink)]" title={`${matchTitle} (ID: ${m.id})`}>
                                              {matchTitle}
                                            </span>
                                          )}
                                        </div>
                                        <span class="text-rose-400 font-bold shrink-0 font-mono">
                                          {(m.score * 100).toFixed(1)}%
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div class="text-[10px] text-[var(--color-ink-faint)] italic">No negative/dislike matches found</div>
                              )}
                            </div>
                          </div>

                          {/* LLM Evaluation & Scraped Text */}
                          <div class="space-y-3">
                            {/* LLM Judge Section */}
                            <div class="p-3 rounded bg-[var(--color-surface)] border border-[var(--color-border-subtle)]">
                              <div class="text-[11px] font-bold text-[var(--color-ink)] mb-1 flex items-center justify-between">
                                <span>LLM Curation Judge (Llama 3.3 70B)</span>
                                {item.llm_eval?.was_sent_to_llm ? (
                                  <span class={`px-1.5 py-0.2 rounded text-[10px] ${
                                    item.llm_eval.llm_accepted
                                      ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                                      : 'bg-rose-950 text-rose-300 border border-rose-800'
                                  }`}>
                                    {item.llm_eval.llm_accepted ? 'LLM ACCEPTED' : 'LLM REJECTED'}
                                  </span>
                                ) : (
                                  <span class="text-[10px] text-[var(--color-ink-faint)]">
                                    Bypassed (Vector Definitive)
                                  </span>
                                )}
                              </div>
                              <div class="text-[11px] text-[var(--color-ink-muted)] leading-relaxed font-sans">
                                {item.llm_eval?.was_sent_to_llm
                                  ? item.llm_eval.llm_accepted
                                    ? 'Evaluated against taste profile: approved as high-signal engineering / systems topic.'
                                    : 'Evaluated against taste profile: rejected as off-topic, tutorial, PR/marketing, or insufficient depth.'
                                  : 'Candidate had decisive vector score and was not sent to LLM judge stage.'}
                              </div>
                            </div>

                            {/* Scraped Content Preview */}
                            <div class="p-3 rounded bg-[var(--color-surface)] border border-[var(--color-border-subtle)]">
                              <div class="text-[10px] text-[var(--color-ink-faint)] uppercase tracking-wide mb-1">
                                Scraped Metadata Preview (Used for Embeddings):
                              </div>
                              {item.details?.description ? (
                                <div class="text-[11px] text-[var(--color-ink-muted)] font-sans line-clamp-3 mb-1">
                                  {item.details.description}
                                </div>
                              ) : (
                                <div class="text-[10px] text-[var(--color-ink-faint)] italic mb-1">
                                  No description meta tag found
                                </div>
                              )}
                              {item.details?.headings && (
                                <div class="text-[10px] text-[var(--color-ink-faint)] truncate font-sans">
                                  Headings: {item.details.headings}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </details>
                  );
                })
              )}
            </div>
          </div>
        ) : null}
      </main>

      {/* Progressive Client Script for Nostr Auth and Filtering */}
      <script dangerouslySetInnerHTML={{
        __html: `
        // Tab / Status Filtering
        document.querySelectorAll('.debug-filter-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const filter = btn.dataset.filter;
            document.querySelectorAll('.debug-filter-btn').forEach(b => {
              b.classList.remove('bg-amber-500/20', 'text-amber-300', 'border-amber-500/40');
              b.classList.add('text-[var(--color-ink-muted)]', 'border-transparent');
            });
            btn.classList.add('bg-amber-500/20', 'text-amber-300', 'border-amber-500/40');
            btn.classList.remove('text-[var(--color-ink-muted)]', 'border-transparent');

            const items = document.querySelectorAll('#debug-items-list details');
            items.forEach(item => {
              const status = item.dataset.status;
              if (filter === 'all' || status === filter) {
                item.style.display = '';
              } else {
                item.style.display = 'none';
              }
            });
          });
        });

        // Nostr Authentication Handler
        const authBtn = document.getElementById('btn-nostr-auth');
        const authStatus = document.getElementById('auth-status');
        if (authBtn) {
          authBtn.addEventListener('click', async () => {
            if (!window.nostr) {
              authStatus.textContent = 'Error: Nostr browser extension (Alby, nos2x, etc.) not detected.';
              authStatus.classList.remove('hidden');
              return;
            }
            try {
              authBtn.disabled = true;
              authBtn.textContent = 'Signing authorization event...';
              authStatus.classList.add('hidden');

              const authEvent = await window.nostr.signEvent({
                kind: 27235,
                created_at: Math.floor(Date.now() / 1000),
                tags: [
                  ['u', window.location.href],
                  ['method', 'GET']
                ],
                content: 'news-admin-debug-access'
              });

              // Set session cookie with serialized event
              const eventStr = JSON.stringify(authEvent);
              document.cookie = "news_nostr_auth=" + encodeURIComponent(eventStr) + "; path=/; max-age=3600; SameSite=Lax";
              sessionStorage.setItem('news_nostr_auth', eventStr);

              authBtn.textContent = 'Authenticated! Reloading...';
              window.location.reload();
            } catch (err) {
              authBtn.disabled = false;
              authBtn.textContent = 'Authenticate with Nostr (NIP-07)';
              authStatus.textContent = 'Signing failed or rejected: ' + (err.message || err);
              authStatus.classList.remove('hidden');
            }
          });
        }

        // Live Ingestion to Feed Handler
        const liveIngestBtn = document.getElementById('btn-live-ingest');
        const liveIngestText = document.getElementById('btn-live-ingest-text');
        if (liveIngestBtn && liveIngestText) {
          liveIngestBtn.addEventListener('click', async () => {
            const src = liveIngestBtn.dataset.source || 'all';
            liveIngestBtn.disabled = true;
            liveIngestText.textContent = 'Ingesting to Feed...';
            try {
              const res = await fetch('/api/admin/ingest?source=' + src);
              const data = await res.json();
              if (res.ok) {
                const insertedCount = data.stats?.inserted || 0;
                liveIngestText.textContent = 'Done! Inserted ' + insertedCount + ' articles';
                setTimeout(() => {
                  liveIngestText.textContent = 'Ingest to Feed';
                  liveIngestBtn.disabled = false;
                }, 4000);
              } else {
                alert('Ingestion error: ' + (data.message || data.error));
                liveIngestText.textContent = 'Ingest to Feed';
                liveIngestBtn.disabled = false;
              }
            } catch (err) {
              alert('Ingestion request failed: ' + (err.message || err));
              liveIngestText.textContent = 'Ingest to Feed';
              liveIngestBtn.disabled = false;
            }
          });
        }
        `
      }} />
    </Layout>
  );
};
