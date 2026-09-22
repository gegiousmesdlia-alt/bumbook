// bluesky.js — fetches real Bluesky posts (via /api/bluesky?action=feed) and
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
    const params = new URLSearchParams({ niche, action: 'feed' });
    if (_blueskyCursors[niche]) params.set('cursor', _blueskyCursors[niche]);
    const resp = await fetch('/api/bluesky?' + params.toString());
    const data = await resp.json();
    if (!data.configured || data.error || !data.items) return [];
    if (data.cursor) _blueskyCursors[niche] = data.cursor;
    return data.items.slice(0, count);
  } catch (e) { return []; }
}

async function fetchBlueskyProfile(actor) {
  try {
    const resp = await fetch('/api/bluesky?action=profile&actor=' + encodeURIComponent(actor));
    return await resp.json();
  } catch (e) { return { profile: null, posts: [], error: 'fetch' }; }
}

async function fetchBlueskyPost(uri) {
  try {
    const resp = await fetch('/api/bluesky?action=post&uri=' + encodeURIComponent(uri));
    return await resp.json();
  } catch (e) { return { post: null, replies: [], error: 'fetch' }; }
}

async function fetchBlueskyDiscoverAccounts(niche) {
  try {
    const params = new URLSearchParams({ action: 'discover' });
    if (niche) params.set('niche', niche);
    const resp = await fetch('/api/bluesky?' + params.toString());
    const data = await resp.json();
    return (data.configured && !data.error) ? (data.accounts || []) : [];
  } catch (e) { return []; }
}

/* ── Discover page section — real Bluesky accounts, clearly separate from
   bumbook members (see index.html: its own labeled section, not mixed
   into "People you might know"). Tapping opens the same in-app profile
   page used from the feed — nothing here pretends these are connectable
   bumbook users; there's no Connect button, just "View profile." */
async function renderDiscoverBsky() {
  const container = $('discoverBsky');
  if (!container) return;
  container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
  const niche = BLUESKY_NICHE_ROTATION[Math.floor(Math.random() * BLUESKY_NICHE_ROTATION.length)];
  const accounts = await fetchBlueskyDiscoverAccounts(niche);
  if (!accounts.length) { container.innerHTML = '<div class="empty-state"><div class="empty-state-desc">Could not load Bluesky accounts right now</div></div>'; return; }

  container.innerHTML = accounts.map(a => `
    <div class="people-card" onclick="openBskyProfile('${escapeAttrJS(a.did)}')">
      ${_blueskyAvatarHTML(a, 'md')}
      <div class="people-card-info">
        <div class="people-card-name">${escapeHTML(a.displayName)}${typeof a.followersCount === 'number' ? ` <span style="font-weight:400;color:var(--text-dim);font-size:0.8rem">· ${formatCount(a.followersCount)} followers</span>` : ''}</div>
        <div class="people-card-handle">@${escapeHTML(a.handle)}</div>
        ${a.description ? `<div class="people-card-bio">${escapeHTML(a.description)}</div>` : ''}
      </div>
      <button class="btn btn-outline btn-sm" onclick="event.stopPropagation();openBskyProfile('${escapeAttrJS(a.did)}')">View</button>
    </div>`).join('');
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

/* Renders whatever's attached to a post — a photo, a grid of photos, or a
   link-preview card — using the embed data api/bluesky.js now extracts.
   Images link out to Bluesky's own image at full size on click (stopping
   propagation so it doesn't also trigger opening the post). */
function _blueskyEmbedHTML(embed) {
  if (!embed) return '';
  if (embed.type === 'images' && embed.images?.length) {
    const cols = embed.images.length === 1 ? '1fr' : '1fr 1fr';
    const imgs = embed.images.slice(0, 4).map(img => `
      <img src="${escapeHTML(img.thumb)}" alt="${escapeHTML(img.alt)}" loading="lazy"
        style="width:100%;height:100%;object-fit:cover;border-radius:8px;cursor:pointer"
        onclick="event.stopPropagation();window.open('${escapeAttrJS(img.fullsize || img.thumb)}','_blank','noopener')">`).join('');
    return `<div style="display:grid;grid-template-columns:${cols};gap:4px;margin:8px 0;max-height:280px">${imgs}</div>`;
  }
  if (embed.type === 'external' && embed.external?.uri) {
    const ext = embed.external;
    return `<a href="${escapeAttrJS(ext.uri)}" target="_blank" rel="noopener noreferrer nofollow" onclick="event.stopPropagation()"
        style="display:block;margin:8px 0;border:1px solid var(--border);border-radius:8px;overflow:hidden;text-decoration:none;color:inherit">
      ${ext.thumb ? `<img src="${escapeHTML(ext.thumb)}" alt="" loading="lazy" style="width:100%;max-height:180px;object-fit:cover">` : ''}
      <div style="padding:8px 10px">
        <div style="font-weight:600;font-size:0.85rem;line-height:1.3">${escapeHTML(ext.title || ext.uri)}</div>
        ${ext.description ? `<div style="font-size:0.78rem;color:var(--text-dim);margin-top:2px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${escapeHTML(ext.description)}</div>` : ''}
      </div>
    </a>`;
  }
  return '';
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
      ${_blueskyEmbedHTML(post.embed)}
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
      ${_blueskyEmbedHTML(post.embed)}
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

/* ── Settings page: Connect Bluesky account (for sending real DMs) ─────
 * ⚠️ This is the ONLY part of the Bluesky integration that holds real
 * credentials on someone's behalf — everything else in this file
 * (feed posts, profiles, discover) is read-only and keyless. See
 * api/_bskyOAuthClient.js for what gets stored and where. */
async function renderBskyConnectSection() {
  const container = $('bskyConnectSection');
  if (!container || !currentUser) return;
  container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
  try {
    const snap = await window.XF.get('bskyConnections/' + currentUser.uid);
    if (snap.exists()) {
      const c = snap.val();
      container.innerHTML = `<div class="privacy-toggle-row" style="margin:0">
        <span class="privacy-toggle-label">🦋 Connected as @${escapeHTML(c.handle)}</span>
        <button class="btn btn-outline btn-sm" onclick="disconnectBsky()">Disconnect</button>
      </div>`;
    } else {
      container.innerHTML = `<div class="privacy-toggle-row" style="margin:0">
        <span class="privacy-toggle-label">🦋 Bluesky — connect to send real DMs from bumbook</span>
        <button class="btn btn-primary btn-sm" onclick="startBskyConnect()">Connect</button>
      </div>`;
    }
  } catch (e) {
    console.error('[bsky] connection status failed:', e.code || e, e.message || '');
    container.innerHTML = `<div class="privacy-toggle-label" style="color:var(--text-dim)">Could not load connection status${e.code ? ' (' + e.code + ')' : ''}</div>`;
  }
}

async function startBskyConnect() {
  const existing = document.getElementById('bskyConnectModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'bskyConnectModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9000;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);padding:24px;width:100%;max-width:400px">
      <div style="font-weight:700;font-size:1rem;margin-bottom:6px">🦋 Connect Bluesky</div>
      <div style="font-size:0.82rem;color:var(--text-dim);margin-bottom:14px">Link your Bluesky account to send real DMs from bumbook.</div>
      <label style="font-size:0.8rem;color:var(--text-dim);display:block;margin-bottom:6px">Your Bluesky handle</label>
      <input id="bskyConnectHandle" type="text" placeholder="yourname.bsky.social" autocomplete="off"
        style="width:100%;background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;color:var(--text);font-size:0.9rem;outline:none;font-family:inherit;margin-bottom:6px;box-sizing:border-box" />
      <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:14px">
        Don't have a Bluesky account? <a href="https://bsky.app" target="_blank" rel="noopener noreferrer" style="color:var(--accent)">Sign up on Bluesky</a> first, then come back here and connect.
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('bskyConnectModal').remove()">Cancel</button>
        <button class="btn btn-primary btn-sm" onclick="_submitBskyConnect()">Connect</button>
      </div>
    </div>`;
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
  setTimeout(() => document.getElementById('bskyConnectHandle')?.focus(), 50);
}

async function _submitBskyConnect() {
  const input = document.getElementById('bskyConnectHandle');
  let handle = input?.value?.trim();
  if (!handle) { showToast('Enter your Bluesky handle first'); return; }
  handle = handle.replace(/^@/, '');
  // Bluesky handles are full domain-style identifiers — the AT Protocol's
  // handle system is literally DNS-based, so a bare username on its own
  // (no dot) was never actually valid, and is exactly what that "Value
  // for actor must be..." error meant. Most people don't have a custom
  // domain handle, so defaulting to .bsky.social if they typed a bare
  // username covers the common case without forcing them to know this.
  if (handle && !handle.includes('.')) handle += '.bsky.social';
  const modal = document.getElementById('bskyConnectModal');
  try {
    const idToken = await currentUser.getIdToken();
    const resp = await fetch('/api/bsky-connect-start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body: JSON.stringify({ handle })
    });
    const data = await resp.json();
    if (data.url) { window.location.href = data.url; return; }
    showToast('Could not start Bluesky connection: ' + (data.message || data.error || 'unknown error'));
  } catch (e) { showToast('Could not start Bluesky connection'); }
}

async function disconnectBsky() {
  // NOTE: this only removes bumbook's OWN record/session for this
  // account — it does not revoke the grant on Bluesky's side. A more
  // complete disconnect would also call the OAuth client's revoke, which
  // isn't wired up yet in this first pass (see bsky-connect-start.js's
  // header for the staged build plan).
  if (!confirm('Disconnect your Bluesky account from bumbook?')) return;
  try { await window.XF.remove('bskyConnections/' + currentUser.uid); } catch (e) {}
  renderBskyConnectSection();
}

