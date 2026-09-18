// bluesky.js — fetches real Bluesky posts (via /api/bluesky-feed) and
// renders them as feed cards, clearly marked as external content.
//
// These are real posts by real Bluesky accounts, so likes/reposts/replies
// shown are always Bluesky's own real counts — nothing here writes a fake
// local like/comment against someone else's post. But everything is
// viewed IN-APP: tapping a post opens an in-app post-detail page (with
// real replies fetched live), and tapping the author opens an in-app
// profile page (with their real bio + recent posts) — no bsky.app tab
// ever opens from within bumbook itself.
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

async function fetchBlueskyProfile(actor) {
  try {
    const resp = await fetch('/api/bluesky-profile?actor=' + encodeURIComponent(actor));
    return await resp.json();
  } catch (e) { return { profile: null, posts: [], error: 'fetch' }; }
}

async function fetchBlueskyPost(uri) {
  try {
    const resp = await fetch('/api/bluesky-post?uri=' + encodeURIComponent(uri));
    return await resp.json();
  } catch (e) { return { post: null, replies: [], error: 'fetch' }; }
}

const BLUESKY_NICHE_LABELS = {
  tech: 'Tech', sports: 'Sports', news: 'News', comedy: 'Comedy',
  music: 'Music', gaming: 'Gaming', fashion: 'Fashion', food: 'Food'
};

function _blueskyAvatarHTML(author, size) {
  size = size || 'md';
  if (author.avatar) return `<img class="avatar avatar-${size}" src="${escapeHTML(author.avatar)}" alt="">`;
  return `<div class="avatar avatar-${size}">${escapeHTML((author.displayName || '?').charAt(0).toUpperCase())}</div>`;
}

// Both the profile-open and post-open handlers navigate WITHIN bumbook
// (showPage, from router.js) rather than window.open — nothing here ever
// leaves the site. did is used over handle where available since it's
// permanent (a handle can change; the did behind it can't).
function openBskyProfile(actor, e) {
  if (e) e.stopPropagation();
  showPage('bsky-profile', { bskyActor: actor });
}
function openBskyPost(uri, e) {
  if (e) e.stopPropagation();
  showPage('bsky-post', { bskyUri: uri });
}

function blueskyPostHTML(post) {
  const a = post.author || {};
  const followers = typeof a.followersCount === 'number' ? `<span class="post-time">· ${formatCount(a.followersCount)} followers</span>` : '';
  const nicheLabel = BLUESKY_NICHE_LABELS[post.niche] || 'Bluesky';
  return `<div class="post bluesky-post" data-id="${escapeHTML(post.id)}" data-ts="${post.createdAt || 0}" onclick="openBskyPost('${escapeAttrJS(post.id)}')">
    <div onclick="openBskyProfile('${escapeAttrJS(a.did || a.handle)}', event)">${_blueskyAvatarHTML(a)}</div>
    <div class="post-body">
      <div class="post-header">
        <span class="post-name" onclick="openBskyProfile('${escapeAttrJS(a.did || a.handle)}', event)">${escapeHTML(a.displayName || 'Unknown')}</span>
        <span class="post-handle">@${escapeHTML(a.handle || 'unknown')}</span>
        <span class="post-time">· ${timeAgo(post.createdAt)}</span>
        ${followers}
        <span class="bluesky-badge" title="Real post from Bluesky" style="margin-left:auto;font-size:0.7rem;padding:2px 8px;border-radius:10px;background:rgba(0,133,255,0.12);color:#0085ff;font-weight:600">🦋 ${escapeHTML(nicheLabel)}</span>
      </div>
      <div class="post-text">${post.textHTML || ''}</div>
      <div class="post-actions">
        <div class="post-action comment"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${post.replyCount > 0 ? ' ' + formatCount(post.replyCount) : ''}</div>
        <div class="post-action like"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${post.likeCount > 0 ? ' ' + formatCount(post.likeCount) : ''}</div>
        <div class="post-action share"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>${post.repostCount > 0 ? ' ' + formatCount(post.repostCount) : ''}</div>
      </div>
    </div>
  </div>`;
}

/* A slimmer post card variant for use INSIDE the profile page (author info
   is already shown once at the top there, so each post row just needs the
   text + counts) and inside reply lists. */
function blueskyPostRowHTML(post, opts) {
  opts = opts || {};
  const a = post.author || {};
  return `<div class="post bluesky-post" data-id="${escapeHTML(post.id)}" ${opts.clickable === false ? '' : `onclick="openBskyPost('${escapeAttrJS(post.id)}')"`}>
    <div>${_blueskyAvatarHTML(a, opts.avatarSize || 'md')}</div>
    <div class="post-body">
      <div class="post-header">
        <span class="post-name">${escapeHTML(a.displayName || 'Unknown')}</span>
        <span class="post-handle">@${escapeHTML(a.handle || 'unknown')}</span>
        <span class="post-time">· ${timeAgo(post.createdAt)}</span>
      </div>
      <div class="post-text">${post.textHTML || ''}</div>
      <div class="post-actions" style="pointer-events:none">
        <div class="post-action comment"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${post.replyCount > 0 ? ' ' + formatCount(post.replyCount) : ''}</div>
        <div class="post-action like"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${post.likeCount > 0 ? ' ' + formatCount(post.likeCount) : ''}</div>
        <div class="post-action share"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>${post.repostCount > 0 ? ' ' + formatCount(post.repostCount) : ''}</div>
      </div>
    </div>
  </div>`;
}

/* ── Page: in-app Bluesky profile ───────────────────────────────────── */
async function renderBskyProfile(actor) {
  const container = $('bskyProfileContent');
  if (!container || !actor) return;
  container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';

  const data = await fetchBlueskyProfile(actor);
  if (!data.profile) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-desc">Could not load this Bluesky profile</div></div>';
    return;
  }
  const p = data.profile;
  const postsHTML = (data.posts || []).length
    ? data.posts.map(post => blueskyPostRowHTML(post)).join('')
    : '<div class="empty-state"><div class="empty-state-desc">No recent posts</div></div>';

  container.innerHTML = `
    <div style="padding:16px">
      <div style="display:flex;gap:12px;align-items:flex-start">
        ${_blueskyAvatarHTML(p, 'lg')}
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:1.1rem">${escapeHTML(p.displayName)}</div>
          <div style="color:var(--text-dim)">@${escapeHTML(p.handle)}</div>
        </div>
        <span class="bluesky-badge" style="font-size:0.7rem;padding:3px 10px;border-radius:10px;background:rgba(0,133,255,0.12);color:#0085ff;font-weight:600;white-space:nowrap">🦋 Bluesky account</span>
      </div>
      ${p.description ? `<div style="margin-top:12px;white-space:pre-wrap">${escapeHTML(p.description)}</div>` : ''}
      <div style="display:flex;gap:20px;margin-top:12px;font-size:0.9rem">
        <span><strong>${formatCount(p.postsCount)}</strong> <span style="color:var(--text-dim)">posts</span></span>
        <span><strong>${formatCount(p.followersCount)}</strong> <span style="color:var(--text-dim)">followers</span></span>
        <span><strong>${formatCount(p.followsCount)}</strong> <span style="color:var(--text-dim)">following</span></span>
      </div>
      <div style="margin-top:8px;padding:8px 12px;background:var(--bg-3);border-radius:8px;font-size:0.8rem;color:var(--text-dim)">
        This is a real, independent Bluesky account shown here read-only — not a bumbook member.
      </div>
    </div>
    <div style="border-top:1px solid var(--border);margin-top:4px">${postsHTML}</div>
  `;
}

/* ── Page: in-app Bluesky post detail (post + real replies) ──────────── */
async function renderBskyPost(uri) {
  const container = $('bskyPostContent');
  if (!container || !uri) return;
  container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';

  const data = await fetchBlueskyPost(uri);
  if (!data.post) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-desc">Could not load this post</div></div>';
    return;
  }
  const mainHTML = blueskyPostRowHTML(data.post, { clickable: false });
  const repliesHTML = (data.replies || []).length
    ? data.replies.map(r => blueskyPostRowHTML(r, { avatarSize: 'sm' })).join('')
    : '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:0.85rem">No replies yet</div>';

  container.innerHTML = `
    ${mainHTML}
    <div style="padding:12px 16px 4px;font-weight:600;font-size:0.85rem;color:var(--text-dim);border-top:1px solid var(--border)">Replies</div>
    ${repliesHTML}
  `;
}

// post.url / IDs are server-controlled (built from handle/rkey/DID we
// constructed ourselves), but escape defensively anyway before dropping
// into an inline onclick attribute.
function escapeAttrJS(s) { return String(s || '').replace(/'/g, "\\'"); }
