// bluesky.js — fetches real Bluesky posts (via /api/bluesky-feed) and
// renders them as feed cards, clearly marked as external content.
//
// These are real posts by real Bluesky accounts, so they're treated as
// read-only here: the like/reply/repost counts shown are Bluesky's own
// real counts, and tapping a card opens the real post on bsky.app instead
// of writing a fake local like/comment against someone else's post.
'use strict';

const BLUESKY_NICHE_ROTATION = ['tech', 'sports', 'news', 'comedy', 'music', 'gaming', 'fashion', 'food'];
let _blueskyNicheIdx = Math.floor(Math.random() * BLUESKY_NICHE_ROTATION.length);
const _blueskyCursors = {}; // niche -> next cursor, so repeated loads page forward instead of repeating

function _nextBlueskyNiche() {
  const niche = BLUESKY_NICHE_ROTATION[_blueskyNicheIdx % BLUESKY_NICHE_ROTATION.length];
  _blueskyNicheIdx++;
  return niche;
}

/* Fetches one batch (up to `count`) of Bluesky posts for a rotating niche.
   Never throws — a failed/unconfigured fetch just means fewer posts get
   mixed in, not a broken feed. */
async function fetchBlueskyBatch(count) {
  const niche = _nextBlueskyNiche();
  try {
    const params = new URLSearchParams({ niche });
    if (_blueskyCursors[niche]) params.set('cursor', _blueskyCursors[niche]);
    const resp = await fetch('/api/bluesky-feed?' + params.toString());
    const data = await resp.json();
    if (!data.configured || data.error || !data.items) return [];
    if (data.cursor) _blueskyCursors[niche] = data.cursor;
    return data.items.slice(0, count);
  } catch (e) { return []; }
}

const BLUESKY_NICHE_LABELS = {
  tech: 'Tech', sports: 'Sports', news: 'News', comedy: 'Comedy',
  music: 'Music', gaming: 'Gaming', fashion: 'Fashion', food: 'Food'
};

function _blueskyAvatarHTML(author) {
  if (author.avatar) return `<img class="avatar avatar-md" src="${escapeHTML(author.avatar)}" alt="">`;
  return `<div class="avatar avatar-md">${escapeHTML((author.displayName || '?').charAt(0).toUpperCase())}</div>`;
}

function blueskyPostHTML(post) {
  const a = post.author || {};
  const followers = typeof a.followersCount === 'number' ? `<span class="post-time">· ${formatCount(a.followersCount)} followers</span>` : '';
  const nicheLabel = BLUESKY_NICHE_LABELS[post.niche] || 'Bluesky';
  return `<div class="post bluesky-post" data-id="${escapeHTML(post.id)}" data-ts="${post.createdAt || 0}" onclick="window.open('${escapeAttrJS(post.url)}','_blank','noopener')">
    <div>${_blueskyAvatarHTML(a)}</div>
    <div class="post-body">
      <div class="post-header">
        <span class="post-name">${escapeHTML(a.displayName || 'Unknown')}</span>
        <span class="post-handle">@${escapeHTML(a.handle || 'unknown')}</span>
        <span class="post-time">· ${timeAgo(post.createdAt)}</span>
        ${followers}
        <span class="bluesky-badge" title="Real post from Bluesky" style="margin-left:auto;font-size:0.7rem;padding:2px 8px;border-radius:10px;background:rgba(0,133,255,0.12);color:#0085ff;font-weight:600">🦋 ${escapeHTML(nicheLabel)}</span>
      </div>
      <div class="post-text">${post.textHTML || ''}</div>
      <div class="post-actions" onclick="event.stopPropagation()">
        <div class="post-action comment" onclick="window.open('${escapeAttrJS(post.url)}','_blank','noopener')"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${post.replyCount > 0 ? ' ' + formatCount(post.replyCount) : ''}</div>
        <div class="post-action like" onclick="window.open('${escapeAttrJS(post.url)}','_blank','noopener')"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${post.likeCount > 0 ? ' ' + formatCount(post.likeCount) : ''}</div>
        <div class="post-action share" onclick="window.open('${escapeAttrJS(post.url)}','_blank','noopener')"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>${post.repostCount > 0 ? ' ' + formatCount(post.repostCount) : ''}</div>
      </div>
    </div>
  </div>`;
}

// post.url is server-controlled (built from handle/rkey we constructed
// ourselves), but escape defensively anyway before dropping it into an
// inline onclick attribute.
function escapeAttrJS(s) { return String(s || '').replace(/'/g, "\\'"); }
