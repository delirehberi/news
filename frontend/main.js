import './style.css'
import { SimplePool } from 'nostr-tools/pool'

const API_URL = '/api/articles';

const userRelays = [
  "wss://relay.emre.xyz",
  "wss://relay.nostr.band",
  "wss://relay.damus.io",
  "wss://relay.snort.social",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://nostr.mom",
  "wss://relay.nos.social",
  "wss://articles.layer3.news",
  "wss://mls.akdeniz.edu.tr/nostr"
];

function getOriginalPostUrl(id) {
  if (id.startsWith('hn-')) return `https://news.ycombinator.com/item?id=${id.replace('hn-', '')}`;
  if (id.startsWith('lobsters-')) return `https://lobste.rs/s/${id.replace('lobsters-', '')}`;
  if (id.startsWith('reddit-')) return `https://redd.it/${id.replace('reddit-', '')}`;
  if (id.startsWith('stacker-')) return `https://stacker.news/items/${id.replace('stacker-', '')}`;
  return null;
}

function updateLikeUI(btn, countDisplay, articleId) {
  btn.classList.add('is-liked');
  btn.disabled = true;
  btn.setAttribute('aria-pressed', 'true');
  
  const icon = btn.querySelector('.like-icon');
  if (icon) {
    icon.setAttribute('fill', 'currentColor');
    icon.classList.remove('hidden');
  }
  const loading = btn.querySelector('.loading-icon');
  if (loading) loading.classList.add('hidden');
  
  if (countDisplay) {
    const currentCount = parseInt(countDisplay.textContent || '0', 10);
    countDisplay.textContent = currentCount + 1;
  }

  const card = btn.closest('.news-item, .news-card');
  if (card) {
    card.dataset.liked = 'true';
    card.classList.remove('is-new');
    const newBadge = card.querySelector('.new-badge');
    if (newBadge) newBadge.hidden = true;
  }
  
  const likedArticles = JSON.parse(localStorage.getItem('likedArticles') || '[]');
  if (!likedArticles.includes(articleId)) {
    likedArticles.push(articleId);
    localStorage.setItem('likedArticles', JSON.stringify(likedArticles));
  }
}

export function buildCuratorNostrContent(comment, articleTitle, shareUrl) {
  const trimmed = typeof comment === 'string' ? comment.trim() : '';
  if (trimmed.length > 0) {
    return `${trimmed}\n\n${shareUrl}`;
  }
  return `Liked article: ${articleTitle}\n${shareUrl}`;
}

export function renderCuratorNoteOnCard(card, comment) {
  const trimmed = typeof comment === 'string' ? comment.trim() : '';
  if (!trimmed || !card) return;

  card.classList.add('has-curator-note');
  let noteEl = card.querySelector('.curator-note');
  if (!noteEl) {
    noteEl = document.createElement('div');
    noteEl.className = 'curator-note';

    const badge = document.createElement('span');
    badge.className = 'curator-note-badge font-mono';
    badge.textContent = 'Curator Note';

    const text = document.createElement('p');
    text.className = 'curator-note-text';

    noteEl.appendChild(badge);
    noteEl.appendChild(text);

    const row = card.querySelector('.news-row');
    if (row && row.nextSibling) {
      card.insertBefore(noteEl, row.nextSibling);
    } else {
      card.appendChild(noteEl);
    }
  }

  const textEl = noteEl.querySelector('.curator-note-text');
  if (textEl) {
    textEl.textContent = trimmed;
  }
}

function attachCardListeners(card) {
  const articleId = card.getAttribute('data-id');
  if (!articleId) return;

  const summaryBtn = card.querySelector('.summary-toggle-btn');
  const summaryPanel = card.querySelector('.news-accordion-panel');
  const likeBtn = card.querySelector('.like-btn');
  const dislikeBtn = card.querySelector('.dislike-btn');
  const countDisplay = card.querySelector('.like-count-display');
  const headlineLink = card.querySelector('.news-link');
  const articleTitle = headlineLink ? headlineLink.textContent.trim() : '';
  const articleUrl = headlineLink ? headlineLink.getAttribute('href') : '';
  const discussLink = getOriginalPostUrl(articleId);

  // 1. Accordion Toggle Listener
  if (summaryBtn && summaryPanel && !summaryBtn.dataset.bound) {
    summaryBtn.dataset.bound = 'true';
    summaryBtn.addEventListener('click', () => {
      const isExpanded = summaryBtn.getAttribute('aria-expanded') === 'true';
      const nextState = !isExpanded;

      summaryBtn.setAttribute('aria-expanded', String(nextState));
      summaryBtn.classList.toggle('is-active', nextState);
      
      const btnText = summaryBtn.querySelector('.summary-btn-text');
      if (btnText) {
        btnText.textContent = nextState ? 'Collapse' : 'Summary';
      }

      summaryPanel.classList.toggle('is-open', nextState);
      summaryPanel.setAttribute('aria-hidden', String(!nextState));
    });
  }

  // 2. Restore local storage liked state
  const likedArticles = JSON.parse(localStorage.getItem('likedArticles') || '[]');
  if (likedArticles.includes(articleId) && likeBtn) {
    card.dataset.liked = 'true';
    likeBtn.classList.add('is-liked');
    likeBtn.disabled = true;
    likeBtn.setAttribute('aria-pressed', 'true');
    const icon = likeBtn.querySelector('.like-icon');
    if (icon) icon.setAttribute('fill', 'currentColor');
  }

  const setLikeLoading = (isLoading) => {
    if (!likeBtn) return;
    const icon = likeBtn.querySelector('.like-icon');
    const loading = likeBtn.querySelector('.loading-icon');
    if (isLoading) {
      likeBtn.disabled = true;
      if (icon) icon.classList.add('hidden');
      if (loading) loading.classList.remove('hidden');
    } else {
      likeBtn.disabled = false;
      if (icon) icon.classList.remove('hidden');
      if (loading) loading.classList.add('hidden');
    }
  };

  const sendAnonymousLike = async () => {
    setLikeLoading(true);
    try {
      const res = await fetch(`${API_URL}/${articleId}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (res.ok) {
        updateLikeUI(likeBtn, countDisplay, articleId);
      } else {
        setLikeLoading(false);
      }
    } catch (e) {
      console.error(e);
      setLikeLoading(false);
    }
  };

  const publishCuratorHighlight = async (rawComment, composerEl) => {
    const comment = typeof rawComment === 'string' ? rawComment.trim() : '';
    const shareUrl = discussLink ? discussLink : articleUrl;
    const noteContent = buildCuratorNostrContent(comment, articleTitle, shareUrl);

    let eventPayload = null;
    try {
      eventPayload = await window.nostr.signEvent({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['r', shareUrl]],
        content: noteContent
      });
    } catch (e) {
      alert('Signature cancelled.');
      return;
    }

    if (composerEl) composerEl.remove();
    setLikeLoading(true);
    try {
      const pool = new SimplePool();
      const pubs = pool.publish(userRelays, eventPayload);
      await Promise.any(pubs).catch(() => console.log('Some relays failed'));
      pool.close(userRelays);

      const res = await fetch(`${API_URL}/${articleId}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: eventPayload,
          ...(comment ? { comment } : {})
        })
      });

      if (res.status === 403) {
        alert('You are not my mommy! (Wrong Pubkey)');
        setLikeLoading(false);
        return;
      }
      if (res.ok) {
        updateLikeUI(likeBtn, countDisplay, articleId);
        if (comment) {
          renderCuratorNoteOnCard(card, comment);
        }
      } else {
        setLikeLoading(false);
      }
    } catch (e) {
      console.error(e);
      setLikeLoading(false);
    }
  };

  const publishFollowerShare = async (composerEl) => {
    if (composerEl) composerEl.remove();
    try {
      const shareUrl = discussLink ? discussLink : articleUrl;
      const signedEvent = await window.nostr.signEvent({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['r', shareUrl]],
        content: 'Check out this curated article: ' + articleTitle + '\n' + shareUrl
      });

      setLikeLoading(true);
      const pool = new SimplePool();
      const pubs = pool.publish(userRelays, signedEvent);
      await Promise.any(pubs).catch(() => console.log('Some relays failed'));
      pool.close(userRelays);

      alert('Shared to Nostr!');

      const res = await fetch(`${API_URL}/${articleId}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: signedEvent })
      });
      if (res.ok) {
        updateLikeUI(likeBtn, countDisplay, articleId);
      } else {
        setLikeLoading(false);
      }
    } catch (e) {
      alert('Failed to share: ' + (e?.message || 'Error'));
      setLikeLoading(false);
    }
  };

  const openHighlightComposer = () => {
    const existing = card.querySelector('.curator-comment-composer');
    if (existing) {
      existing.remove();
      return;
    }

    const composer = document.createElement('div');
    composer.className = 'curator-comment-composer';
    composer.innerHTML = `
      <div class="curator-composer-header">
        <span class="curator-composer-title font-mono">Highlight &amp; Share on Nostr</span>
        <button type="button" class="curator-composer-close" aria-label="Close highlight panel">&times;</button>
      </div>
      <textarea
        class="curator-comment-input"
        rows="2"
        maxlength="2000"
        placeholder="Add your thoughts or commentary on this link (optional — published as your Nostr note)..."
      ></textarea>
      <div class="curator-composer-actions">
        <button type="button" class="action-btn-pill curator-publish-btn">Highlight &amp; Publish (Curator)</button>
        <button type="button" class="action-btn-pill follower-share-btn">Share as Follower</button>
        <button type="button" class="action-btn-pill anon-like-btn">Just Like</button>
      </div>
    `;

    const row = card.querySelector('.news-row');
    if (row && row.nextSibling) {
      card.insertBefore(composer, row.nextSibling);
    } else {
      card.appendChild(composer);
    }

    const textarea = composer.querySelector('.curator-comment-input');
    const publishBtn = composer.querySelector('.curator-publish-btn');
    const followerBtn = composer.querySelector('.follower-share-btn');
    const anonBtn = composer.querySelector('.anon-like-btn');
    const closeBtn = composer.querySelector('.curator-composer-close');

    if (textarea) {
      textarea.focus();
      textarea.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          publishCuratorHighlight(textarea.value, composer);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          composer.remove();
        }
      });
    }

    if (publishBtn) {
      publishBtn.addEventListener('click', () => {
        publishCuratorHighlight(textarea ? textarea.value : '', composer);
      });
    }

    if (followerBtn) {
      followerBtn.addEventListener('click', () => {
        publishFollowerShare(composer);
      });
    }

    if (anonBtn) {
      anonBtn.addEventListener('click', () => {
        composer.remove();
        sendAnonymousLike();
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        composer.remove();
      });
    }
  };

  // 3. Like Button Listener
  if (likeBtn && !likeBtn.dataset.bound) {
    likeBtn.dataset.bound = 'true';
    likeBtn.addEventListener('click', async () => {
      if (likeBtn.disabled) return;

      // Anonymous User
      if (!window.nostr) {
        await sendAnonymousLike();
        return;
      }

      // Nostr User Detected: open inline highlight/comment composer
      openHighlightComposer();
    });
  }

  // 4. Dislike Button Listener
  if (dislikeBtn && !dislikeBtn.dataset.bound) {
    dislikeBtn.dataset.bound = 'true';
    const setDislikeLoading = (isLoading) => {
      const icon = dislikeBtn.querySelector('svg:not(.loading-icon-dislike)');
      const loading = dislikeBtn.querySelector('.loading-icon-dislike');
      if (isLoading) {
        dislikeBtn.disabled = true;
        if (icon) icon.classList.add('hidden');
        if (loading) loading.classList.remove('hidden');
      } else {
        dislikeBtn.disabled = false;
        if (icon) icon.classList.remove('hidden');
        if (loading) loading.classList.add('hidden');
      }
    };

    dislikeBtn.addEventListener('click', async () => {
      if (dislikeBtn.disabled) return;

      if (!window.nostr) {
        alert("Nostr extension not found. Only the curator can dislike articles.");
        return;
      }

      let eventPayload = null;
      try {
        eventPayload = await window.nostr.signEvent({
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["r", articleUrl]],
          content: "Disliked article: " + articleTitle + "\n" + articleUrl
        });
      } catch (e) {
        return;
      }

      setDislikeLoading(true);
      try {
        const res = await fetch(`${API_URL}/${articleId}/dislike`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: eventPayload })
        });
        
        if (res.status === 403) {
          alert("Only the owner can dislike articles.");
          setDislikeLoading(false);
          return;
        }
        
        if (res.ok) {
          card.style.opacity = '0';
          card.style.transform = 'translateY(4px)';
          card.style.transition = 'opacity var(--dur-med) var(--ease-out), transform var(--dur-med) var(--ease-out)';
          setTimeout(() => card.remove(), 250);
        } else {
          setDislikeLoading(false);
        }
      } catch (e) {
        console.error(e);
        setDislikeLoading(false);
      }
    });
  }
}

const LAST_VISIT_STORAGE_KEY = 'lastVisitAt';

// D1 timestamps are UTC 'YYYY-MM-DD HH:MM:SS' without a zone marker.
function parseUtcTimestamp(value) {
  if (!value) return NaN;
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  return Date.parse(/[zZ]$/.test(iso) ? iso : `${iso}Z`);
}

function readLastVisit() {
  try {
    const stored = Number(localStorage.getItem(LAST_VISIT_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch (e) {
    console.warn('Cannot read last visit time; NEW badges disabled', e);
    return null;
  }
}

function writeLastVisit(timestamp) {
  try {
    localStorage.setItem(LAST_VISIT_STORAGE_KEY, String(timestamp));
  } catch (e) {
    console.warn('Cannot persist last visit time', e);
  }
}

// Marks cards that arrived since the previous visit. The baseline is only advanced when the page is
// hidden or left, so a refresh during the same visit keeps the badges. Already-liked cards were
// already seen and interacted with (possibly on another device), so they are never marked as NEW.
export function markNewSinceLastVisit(cards) {
  const lastVisit = readLastVisit();
  const visitStartedAt = Date.now();

  if (lastVisit !== null) {
    let newCount = 0;
    cards.forEach((card) => {
      if (card.dataset.liked === 'true' || card.querySelector('.like-btn.is-liked')) {
        return;
      }
      const createdAt = parseUtcTimestamp(card.dataset.createdAt);
      if (Number.isFinite(createdAt) && createdAt > lastVisit) {
        card.classList.add('is-new');
        const badge = card.querySelector('.new-badge');
        if (badge) badge.hidden = false;
        newCount++;
      }
    });

    const counter = document.getElementById('new-since-visit');
    if (counter && newCount > 0) {
      counter.textContent = `${newCount} new since your last visit`;
      counter.hidden = false;
    }
  }

  const persist = () => writeLastVisit(visitStartedAt);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persist();
  });
  window.addEventListener('pagehide', persist);
}

// Hydrate all server-rendered cards
function hydrate() {
  const cards = document.querySelectorAll('.news-item, .news-card');
  cards.forEach(attachCardListeners);
  markNewSinceLastVisit(document.querySelectorAll('.news-item'));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', hydrate);
} else {
  hydrate();
}
