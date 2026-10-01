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
  
  const likedArticles = JSON.parse(localStorage.getItem('likedArticles') || '[]');
  if (!likedArticles.includes(articleId)) {
    likedArticles.push(articleId);
    localStorage.setItem('likedArticles', JSON.stringify(likedArticles));
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

  // 3. Like Button Listener
  if (likeBtn && !likeBtn.dataset.bound) {
    likeBtn.dataset.bound = 'true';
    likeBtn.addEventListener('click', async () => {
      if (likeBtn.disabled) return;

      // Anonymous User
      if (!window.nostr) {
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
        return;
      }

      // Nostr User Detected
      const isMommy = confirm("Are you my mommy?");
      let eventPayload = null;

      if (isMommy) {
        // Owner - Sign to train AI and publish note
        try {
          const shareUrl = discussLink ? discussLink : articleUrl;
          eventPayload = await window.nostr.signEvent({
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [["r", shareUrl]],
            content: "Liked article: " + articleTitle + "\n" + shareUrl
          });
        } catch (e) {
          alert("Signature cancelled.");
          return;
        }
        
        setLikeLoading(true);
        try {
          const pool = new SimplePool();
          const pubs = pool.publish(userRelays, eventPayload);
          await Promise.any(pubs).catch(() => console.log("Some relays failed"));
          pool.close(userRelays);
          
          const res = await fetch(`${API_URL}/${articleId}/like`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: eventPayload })
          });
          
          if (res.status === 403) {
            alert("You are not my mommy! (Wrong Pubkey)");
            setLikeLoading(false);
            return;
          }
          if (res.ok) {
            updateLikeUI(likeBtn, countDisplay, articleId);
          } else {
            setLikeLoading(false);
          }
        } catch (e) {
          console.error(e);
          setLikeLoading(false);
        }
      } else {
        // Follower Sharing
        const wantShare = confirm("Do you want to share this article as a note on your Nostr account?");
        if (wantShare) {
          try {
            const shareUrl = discussLink ? discussLink : articleUrl;
            const signedEvent = await window.nostr.signEvent({
              kind: 1,
              created_at: Math.floor(Date.now() / 1000),
              tags: [["r", shareUrl]],
              content: "Check out this curated article: " + articleTitle + "\n" + shareUrl
            });
            
            setLikeLoading(true);
            const pool = new SimplePool();
            const pubs = pool.publish(userRelays, signedEvent);
            await Promise.any(pubs).catch(() => console.log("Some relays failed"));
            pool.close(userRelays);
            
            alert("Shared to Nostr!");
            
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
            alert("Failed to share: " + (e?.message || 'Error'));
            setLikeLoading(false);
          }
        } else {
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
        }
      }
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

// Hydrate all server-rendered cards
function hydrate() {
  const cards = document.querySelectorAll('.news-item, .news-card');
  cards.forEach(attachCardListeners);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', hydrate);
} else {
  hydrate();
}
