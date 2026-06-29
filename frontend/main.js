import './style.css'
import { SimplePool } from 'nostr-tools/pool'

const API_URL = 'https://news-api.emre.xyz/api/articles'

const feedContainer = document.getElementById('feed');
const loadingIndicator = document.getElementById('loading');
const errorContainer = document.getElementById('error');
const curatedStatus = document.getElementById('curated-status');

function formatTimestamp(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric'
  }).format(date);
}

function timeSince(isoString) {
  if (!isoString) return '';
  const seconds = Math.floor((new Date() - new Date(isoString)) / 1000);
  let interval = seconds / 31536000;
  if (interval > 1) return Math.floor(interval) + " years ago";
  interval = seconds / 2592000;
  if (interval > 1) return Math.floor(interval) + " months ago";
  interval = seconds / 86400;
  if (interval > 1) return Math.floor(interval) + " days ago";
  interval = seconds / 3600;
  if (interval > 1) return Math.floor(interval) + " hours ago";
  interval = seconds / 60;
  if (interval > 1) return Math.floor(interval) + " minutes ago";
  return Math.floor(seconds) + " seconds ago";
}

function getSourceColor(source) {
  switch (source) {
    case 'hackernews': return 'text-orange-400 border-orange-500/30 bg-orange-500/10';
    case 'lobsters': return 'text-red-400 border-red-500/30 bg-red-500/10';
    case 'reddit': return 'text-[#ff4500] border-[#ff4500]/30 bg-[#ff4500]/10';
    default: return 'text-slate-400 border-slate-500/30 bg-slate-500/10';
  }
}

function getOriginalPostUrl(id) {
  if (id.startsWith('hn-')) return `https://news.ycombinator.com/item?id=${id.replace('hn-', '')}`;
  if (id.startsWith('lobsters-')) return `https://lobste.rs/s/${id.replace('lobsters-', '')}`;
  if (id.startsWith('reddit-')) return `https://redd.it/${id.replace('reddit-', '')}`;
  return '#';
}

function createArticleCard(article) {
  const card = document.createElement('article');
  card.className = 'glass rounded-2xl p-6 flex flex-col sm:flex-row justify-between gap-6 card-hover';
  
  let imgHtml = '';
  if (article.image_url) {
    imgHtml = `
      <div class="mt-4 mb-2 rounded-xl overflow-hidden shadow-lg border border-white/10 relative">
        <img src="${article.image_url}" class="w-full max-h-80 object-cover hover:scale-105 transition-transform duration-500" alt="Preview Image" loading="lazy" />
      </div>
    `;
  }

  card.innerHTML = `
    <div class="flex-1 overflow-hidden">
      <div class="flex flex-wrap items-center gap-3 mb-3">
        <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold border ${getSourceColor(article.source)} capitalize tracking-wider">
          ${article.source}
        </span>
        <a href="${getOriginalPostUrl(article.id)}" target="_blank" rel="noopener noreferrer" class="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z"></path></svg>
          Discuss
        </a>
        <time class="text-sm text-slate-400 font-light">&bull; ${formatTimestamp(article.created_at)}</time>
      </div>
      <h2 class="text-xl md:text-2xl font-semibold leading-tight text-white mb-2">
        <a href="${article.url}" target="_blank" rel="noopener noreferrer" class="hover:text-violet-300 transition-colors">
          ${article.title}
        </a>
      </h2>
      ${imgHtml}
    </div>
    <div class="flex sm:flex-col items-center justify-center sm:items-end shrink-0 gap-2 mt-4 sm:mt-0">
      <div class="flex flex-col items-center gap-1">
        <button class="like-btn px-5 py-2.5 rounded-xl bg-white/5 hover:bg-violet-500/20 border border-white/10 hover:border-violet-500/50 text-white font-medium transition-all flex items-center gap-2 group cursor-pointer" data-id="${article.id}">
          <svg class="w-5 h-5 text-slate-400 group-hover:text-violet-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"></path></svg>
          <span>Like</span>
        </button>
        <span class="text-xs text-slate-500 font-medium like-count-display ${article.follower_likes > 0 ? '' : 'hidden'}">${article.follower_likes || 0} likes</span>
      </div>
    </div>
  `;
  
  const likeBtn = card.querySelector('.like-btn');
  const countDisplay = card.querySelector('.like-count-display');
  
  likeBtn.addEventListener('click', async () => {
    // 1. Anonymous
    if (!window.nostr) {
      try {
        const res = await fetch(`${API_URL}/${article.id}/like`, { method: 'POST' });
        if (res.ok) {
          updateLikeUI(likeBtn, countDisplay, article);
        }
      } catch (e) {
        console.error(e);
      }
      return;
    }

    // 2. Nostr User Detected
    const isMommy = confirm("Are you my mommy?");
    let eventPayload = null;
    
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

    if (isMommy) {
      // Owner - Sign to train AI and publish note
      try {
        eventPayload = await window.nostr.signEvent({
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["r", article.url]],
          content: "Liked article: " + article.title + "\n" + article.url
        });
      } catch (e) {
        alert("Signature cancelled.");
        return;
      }
      
      try {
        // Publish to relays first
        const pool = new SimplePool();
        const pubs = pool.publish(userRelays, eventPayload);
        await Promise.any(pubs).catch(() => console.log("Some relays failed"));
        pool.close(userRelays);
        
        const res = await fetch(`${API_URL}/${article.id}/like`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: eventPayload })
        });
        
        if (res.status === 403) {
          alert("You are not my mommy! (Wrong Pubkey)");
          return;
        }
        if (res.ok) updateLikeUI(likeBtn, countDisplay, article);
      } catch (e) {
        console.error(e);
      }
      
    } else {
      // Follower Sharing
      const wantShare = confirm("Do you want to share this article as a note on your Nostr account?");
      if (wantShare) {
        try {
          const signedEvent = await window.nostr.signEvent({
            kind: 1,
            created_at: Math.floor(Date.now() / 1000),
            tags: [["r", article.url]],
            content: "Check out this curated article: " + article.title + "\\n" + article.url
          });
          
          // Publish to relay using SimplePool
          const pool = new SimplePool();
          const pubs = pool.publish(userRelays, signedEvent);
          await Promise.any(pubs).catch(() => console.log("Some relays failed"));
          pool.close(userRelays);
          
          alert("Shared to Nostr!");
          
          // Increment DB
          const res = await fetch(`${API_URL}/${article.id}/like`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: signedEvent })
          });
          if (res.ok) updateLikeUI(likeBtn, countDisplay, article);
          
        } catch (e) {
          alert("Failed to share. " + e.message);
        }
      } else {
        // Declined to share, fallback to Anonymous Like
        try {
          const res = await fetch(`${API_URL}/${article.id}/like`, { method: 'POST' });
          if (res.ok) updateLikeUI(likeBtn, countDisplay, article);
        } catch (e) { console.error(e) }
      }
    }
  });

  return card;
}

function updateLikeUI(btn, countDisplay, article) {
  btn.classList.add('bg-violet-500/20', 'border-violet-500/50');
  const svg = btn.querySelector('svg');
  svg.classList.add('text-violet-400', 'fill-violet-400/20');
  
  // increment visual count
  article.follower_likes = (article.follower_likes || 0) + 1;
  countDisplay.textContent = `${article.follower_likes} likes`;
  countDisplay.classList.remove('hidden');
}

function interleaveArticles(articles) {
  const groups = { hackernews: [], reddit: [], lobsters: [], unknown: [] };
  articles.forEach(a => {
    if (groups[a.source]) groups[a.source].push(a);
    else groups.unknown.push(a);
  });
  
  const interleaved = [];
  let added = true;
  while(added) {
    added = false;
    for (const key of Object.keys(groups)) {
      if (groups[key].length > 0) {
        interleaved.push(groups[key].shift());
        added = true;
      }
    }
  }
  return interleaved;
}

async function fetchArticles() {
  try {
    const response = await fetch(API_URL);
    if (!response.ok) throw new Error(`Worker responded with status: ${response.status}`);
    const payload = await response.json();
    const articles = payload.data || [];
    
    // Curated status
    if (payload.meta && payload.meta.last_curated_at) {
      curatedStatus.textContent = `Curated ${timeSince(payload.meta.last_curated_at)}`;
      curatedStatus.classList.remove('hidden');
    }
    
    loadingIndicator.classList.add('hidden');
    feedContainer.classList.remove('hidden');
    
    if (!articles || articles.length === 0) {
      feedContainer.innerHTML = '<p class="text-center text-slate-400 font-light py-10 glass rounded-2xl">No articles found. Your AI has not curated anything yet!</p>';
      return;
    }

    const shuffled = interleaveArticles(articles);
    shuffled.forEach(article => {
      feedContainer.appendChild(createArticleCard(article));
    });
  } catch (error) {
    loadingIndicator.classList.add('hidden');
    errorContainer.classList.remove('hidden');
    errorContainer.textContent = `Failed to load articles: ${error.message}`;
  }
}

fetchArticles();
