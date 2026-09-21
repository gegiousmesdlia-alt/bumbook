// discover.js — X Club v7 — Discover, Search, Connections, Block/Unblock
'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   DISCOVER PAGE — v2: search-driven, shows nothing until you type.
   Previously this page always showed a "People you might know" list
   (plus a separate always-visible Bluesky accounts browser) whether you
   searched or not. Now it's a single search box across five categories —
   people, Bluesky accounts, hashtags, posts, videos, and groups — and
   shows an empty prompt instead of any content until you actually search.
═══════════════════════════════════════════════════════════════════════════ */
let _discoverCurrentQuery = '';
let _discoverSearchDebounce = null;

async function renderDiscover() {
  const input = $('discoverSearchInput');
  if (input) input.value = _discoverCurrentQuery;
  if (_discoverCurrentQuery) { await _runDiscoverSearch(_discoverCurrentQuery); return; }
  _showDiscoverEmptyPrompt();
}

function _showDiscoverEmptyPrompt() {
  const container = $('discoverResults');
  if (container) container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⌕</div><div class="empty-state-title">Search Discover</div><div class="empty-state-desc">Find people, posts, hashtags, videos, and groups</div></div>';
}

function handleDiscoverSearch(query) {
  _discoverCurrentQuery = (query || '').trim();
  clearTimeout(_discoverSearchDebounce);
  if (!_discoverCurrentQuery) { _showDiscoverEmptyPrompt(); return; }
  const container = $('discoverResults');
  if (container) container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
  _discoverSearchDebounce = setTimeout(() => _runDiscoverSearch(_discoverCurrentQuery), 350);
}

async function _runDiscoverSearch(q) {
  const container = $('discoverResults');
  if (!container) return;
  const isHashtagQuery = q.startsWith('#');
  const tag = (isHashtagQuery ? q.slice(1) : q).toLowerCase().trim();

  const [hashtagHTML, peopleHTML, postsHTML, videosHTML, groupsHTML] = await Promise.all([
    _searchDiscoverHashtag(tag),
    _searchDiscoverPeopleAndBsky(q),
    isHashtagQuery ? Promise.resolve('') : _searchDiscoverPosts(q),
    _searchDiscoverVideos(q),
    _searchDiscoverGroups(q)
  ]);

  const sections = [
    hashtagHTML && _discoverSection('#' + escapeHTML(tag), hashtagHTML),
    peopleHTML && _discoverSection('People', peopleHTML),
    postsHTML && _discoverSection('Posts', postsHTML),
    videosHTML && _discoverSection('Videos', videosHTML),
    groupsHTML && _discoverSection('Groups', groupsHTML)
  ].filter(Boolean);

  container.innerHTML = sections.length ? sections.join('') : `<div class="empty-state"><div class="empty-state-title">No results for "${escapeHTML(q)}"</div></div>`;
}

function _discoverSection(title, innerHTML) {
  return `<div class="page-header" style="position:static;border-bottom:none;padding-bottom:0;margin-top:8px"><div style="font-weight:700">${title}</div></div>${innerHTML}`;
}

/* One unified list — real bumbook members and real Bluesky accounts,
   sorted together rather than split into two zones. The one thing kept,
   on purpose: a small inline 🦋 next to a Bluesky result's name, same
   visual weight as a verified checkmark — enough to stay honest about
   which accounts are actual bumbook members without splitting the list
   back into two visually separate sections. */
async function _searchDiscoverPeopleAndBsky(q) {
  const [peopleCards, bskyCards] = await Promise.all([
    _searchDiscoverPeople(q, { asCards: true }),
    _searchDiscoverBsky(q, { asCards: true })
  ]);
  const all = [...peopleCards, ...bskyCards];
  if (!all.length) return '';
  // Shuffle rather than "all real members first, then all Bluesky" or
  // vice versa — either fixed order would itself read as a hierarchy.
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.join('');
}

async function _searchDiscoverPeople(q) {
  try {
    const snap = await window.XF.get('users');
    const blockedUids = await getBlockedUids();
    const lower = q.toLowerCase();
    const matches = [];
    if (snap.exists()) snap.forEach(c => {
      const p = c.val();
      if (p.uid === currentUser?.uid || blockedUids.has(p.uid)) return;
      if ((p.displayName || '').toLowerCase().includes(lower) || (p.handle || '').toLowerCase().includes(lower)) matches.push(p);
    });
    if (!matches.length) return [];
    const [myConnSnap, reqSnap] = await Promise.all([
      currentUser ? window.XF.get('connections/' + currentUser.uid) : Promise.resolve(null),
      currentUser ? window.XF.get('connectionRequests') : Promise.resolve(null)
    ]);
    const myConns = myConnSnap?.exists() ? myConnSnap.val() : {};
    const allReqs = reqSnap?.exists() ? reqSnap.val() : {};
    return matches.slice(0, 8).map(p => {
      const status = _getConnStatus(p.uid, myConns, allReqs);
      const incomingReqId = _getIncomingReqId(p.uid, allReqs);
      return `<div class="people-card" onclick="openUserProfile('${p.uid}',event)">
        ${avatarHTML(p, 'md')}
        <div class="people-card-info">
          <div class="people-card-name">${escapeHTML(p.displayName || 'Member')}${verifiedBadge(p.verified)}</div>
          <div class="people-card-handle">@${escapeHTML(p.handle || 'member')}</div>
          <div class="people-card-bio">${escapeHTML(p.bio || '')}</div>
        </div>
        <div onclick="event.stopPropagation()">${connectBtnHTML(p.uid, status, incomingReqId)}</div>
      </div>`;
    });
  } catch (e) { return []; }
}

async function _searchDiscoverBsky(q) {
  if (typeof escapeAttrJS !== 'function' || typeof _blueskyAvatarHTML !== 'function') return []; // bluesky.js not loaded
  try {
    const resp = await fetch('/api/bluesky?action=searchActors&q=' + encodeURIComponent(q));
    const data = await resp.json();
    if (!data.configured || data.error || !data.accounts?.length) return [];
    return data.accounts.map(a => `<div class="people-card" onclick="openBskyProfile('${escapeAttrJS(a.did)}')">
      ${_blueskyAvatarHTML(a, 'md')}
      <div class="people-card-info">
        <div class="people-card-name">${escapeHTML(a.displayName)} <span title="Real Bluesky account, not a bumbook member">🦋</span></div>
        <div class="people-card-handle">@${escapeHTML(a.handle)}</div>
      </div>
      <button class="btn btn-outline btn-sm" onclick="event.stopPropagation();openBskyProfile('${escapeAttrJS(a.did)}')">View</button>
    </div>`);
  } catch (e) { return []; }
}

/* Requires a Firestore composite index the first time it actually runs
   (array-contains + orderBy a different field) — Firestore will throw
   with a direct console link to create it. Caught gracefully here so a
   missing index degrades to "no hashtag results" instead of breaking the
   rest of the search. NOTE: only posts created AFTER this feature shipped
   have a hashtags field — older/seeded posts won't match. */
async function _searchDiscoverHashtag(tag) {
  if (!tag) return '';
  try {
    const snap = await firebase.firestore().collection('posts').where('hashtags', 'array-contains', tag).orderBy('createdAt', 'desc').limit(10).get();
    if (snap.empty) return '';
    const posts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const uids = [...new Set(posts.map(p => p.authorUid).filter(Boolean))];
    const profiles = {};
    await Promise.allSettled(uids.map(async uid => { try { const s = await window.XF.get('users/' + uid); if (s.exists()) profiles[uid] = s.val(); } catch (e) {} }));
    return posts.map(p => postHTML(p, profiles[p.authorUid])).join('');
  } catch (e) { return ''; }
}

/* Not true full-text search — Firestore has none built in. This scans a
   bounded window of recent posts client-side for a substring match, which
   is good enough at this scale but won't find an old post buried deep in
   history. A real search index (Algolia/Typesense) is the eventual fix if
   post volume grows enough for this to matter. */
async function _searchDiscoverPosts(q) {
  try {
    const snap = await window.XF.getPostsPage(60);
    const posts = [];
    if (snap.exists()) snap.forEach(c => posts.push({ id: c.key, ...c.val() }));
    const lower = q.toLowerCase();
    const matches = posts.filter(p => (p.text || '').toLowerCase().includes(lower)).slice(0, 10);
    if (!matches.length) return '';
    const uids = [...new Set(matches.map(p => p.authorUid).filter(Boolean))];
    const profiles = {};
    await Promise.allSettled(uids.map(async uid => { try { const s = await window.XF.get('users/' + uid); if (s.exists()) profiles[uid] = s.val(); } catch (e) {} }));
    return matches.map(p => postHTML(p, profiles[p.authorUid])).join('');
  } catch (e) { return ''; }
}

async function _searchDiscoverVideos(q) {
  try {
    const resp = await fetch('/api/youtube?action=reels&q=' + encodeURIComponent(q));
    const data = await resp.json();
    if (!data.configured || data.error || !data.items?.length) return '';
    window._discoverSearchVideos = data.items.slice(0, 10);
    const cards = window._discoverSearchVideos.map((v, i) => `
      <div class="fy-reel-card" onclick="openReelsAt(window._discoverSearchVideos[${i}])">
        <img class="fy-reel-thumb" src="${escapeHTML(v.thumb)}" alt="" loading="lazy">
        <div class="fy-reel-play"><svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></div>
        <div class="fy-reel-title">${escapeHTML(v.title || '')}</div>
      </div>`).join('');
    return `<div class="fy-reel-tray-scroll">${cards}</div>`;
  } catch (e) { return ''; }
}

/* Private groups you're not a member of NEVER show here, search or not —
   this is the actual fix for "don't show groups I'm not in." Public
   groups show for anyone and can be joined right from the result. */
async function _searchDiscoverGroups(q) {
  try {
    const snap = await window.XF.get('groups');
    const groups = [];
    if (snap.exists()) snap.forEach(c => groups.push({ id: c.key, ...c.val() }));
    const mine = (typeof myGroupIds === 'function') ? myGroupIds() : new Set();
    const lower = q.toLowerCase();
    const matches = groups.filter(g =>
      (g.name || '').toLowerCase().includes(lower) &&
      (g.privacy !== 'private' || mine.has(g.id))
    ).slice(0, 8);
    if (!matches.length) return '';
    return matches.map(g => (typeof _groupCardHTML === 'function') ? _groupCardHTML(g) : '').join('');
  } catch (e) { return ''; }
}

/* ─── CONNECTION STATUS HELPERS ─── */
function _getConnStatus(uid, myConns, allReqs) {
  if (!currentUser) return 'none';
  if (myConns[uid]) return 'connected';
  const sentKey = currentUser.uid + '_' + uid;
  const recvKey = uid + '_' + currentUser.uid;
  if (allReqs[sentKey]?.status === 'pending') return 'pending';
  if (allReqs[recvKey]?.status === 'pending') return 'incoming';
  return 'none';
}

function _getIncomingReqId(uid, allReqs) {
  if (!currentUser) return null;
  const recvKey = uid + '_' + currentUser.uid;
  return allReqs[recvKey]?.status === 'pending' ? recvKey : null;
}

/* ─── CONNECT BUTTON — shows Accept/Decline if incoming ─── */
function connectBtnHTML(uid, status, incomingReqId) {
  if (!currentUser || uid === currentUser.uid) return '';
  if (status === 'connected') return `<button class="btn btn-following btn-sm" onclick="event.stopPropagation();disconnect('${uid}')">${t('btn_connected')} ✓</button>`;
  if (status === 'pending') return `<button class="btn btn-outline btn-sm" disabled style="opacity:0.6">${t('btn_pending')}…</button>`;
  if (status === 'incoming' && incomingReqId) {
    return `<div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();acceptConnectionFromDiscover('${incomingReqId}','${uid}',this)">${t('btn_accept')}</button>
      <button class="btn btn-outline btn-sm" onclick="event.stopPropagation();declineConnectionFromDiscover('${incomingReqId}',this)">${t('btn_decline')}</button>
    </div>`;
  }
  return `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();sendConnectionRequest('${uid}')">${t('btn_connect')}</button>`;
}

/* ─── SEND CONNECTION REQUEST ─── */
async function sendConnectionRequest(toUid) {
  if (!requireVerified('connect with members')) return;
  const reqId = currentUser.uid + '_' + toUid;
  await window.XF.set('connectionRequests/' + reqId, { from: currentUser.uid, to: toUid, status: 'pending', createdAt: Date.now() });
  await window.XF.push('notifications/' + toUid, { type: 'connection_request', fromUid: currentUser.uid, fromName: currentProfile.displayName, reqId, createdAt: Date.now(), read: false });
  showToast('Connection request sent!');
  renderDiscover();
}

/* ─── ACCEPT / DECLINE ─── */
async function acceptConnection(reqId, fromUid) {
  const myUid = currentUser.uid;
  await window.XF.update('connectionRequests/' + reqId, { status: 'accepted' });
  await window.XF.set('connections/' + myUid + '/' + fromUid, true);
  await window.XF.set('connections/' + fromUid + '/' + myUid, true);
  const [myF, myFw, thF, thFw] = await Promise.all([
    window.XF.get('users/' + myUid + '/followersCount').then(s => s.val() || 0),
    window.XF.get('users/' + myUid + '/followingCount').then(s => s.val() || 0),
    window.XF.get('users/' + fromUid + '/followersCount').then(s => s.val() || 0),
    window.XF.get('users/' + fromUid + '/followingCount').then(s => s.val() || 0),
  ]);
  await window.XF.update('users/' + myUid, { followersCount: myF + 1, followingCount: myFw + 1 });
  await window.XF.update('users/' + fromUid, { followersCount: thF + 1, followingCount: thFw + 1 });
  if (currentProfile) { currentProfile.followersCount = myF + 1; currentProfile.followingCount = myFw + 1; }
  await window.XF.push('notifications/' + fromUid, { type: 'connection_accepted', fromUid: myUid, fromName: currentProfile?.displayName || 'Member', createdAt: Date.now(), read: false });
  showToast('✓ Connected!');
}

async function declineConnection(reqId) {
  await window.XF.update('connectionRequests/' + reqId, { status: 'declined' });
  showToast('Request declined');
  renderNotifications();
}

// Accept from notification page
async function acceptConnectionFromNotif(reqId, fromUid, btn) {
  const container = btn?.closest('[id^="connBtns_"]');
  if (container) container.innerHTML = '<span style="color:var(--success);font-size:0.85rem;font-weight:600">✓ Connected</span>';
  await acceptConnection(reqId, fromUid);
  renderNotifications();
}

// Accept from discover page
async function acceptConnectionFromDiscover(reqId, fromUid, btn) {
  const wrap = btn?.parentElement;
  if (wrap) wrap.innerHTML = '<span style="color:var(--success);font-size:0.82rem;font-weight:600">✓ Connected</span>';
  await acceptConnection(reqId, fromUid);
}

async function declineConnectionFromDiscover(reqId, btn) {
  await window.XF.update('connectionRequests/' + reqId, { status: 'declined' });
  const wrap = btn?.parentElement;
  if (wrap) wrap.innerHTML = '<span style="color:var(--text-dim);font-size:0.82rem">Declined</span>';
  showToast('Request declined');
}

// Accept from user profile page
async function acceptConnectionFromProfile(reqId, fromUid, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
  await acceptConnection(reqId, fromUid);
  renderUserProfile(fromUid);
}

/* ─── DISCONNECT ─── */
async function disconnect(uid) {
  if (!currentUser) return;
  await window.XF.remove('connections/' + currentUser.uid + '/' + uid);
  await window.XF.remove('connections/' + uid + '/' + currentUser.uid);
  const myF = (await window.XF.get('users/' + currentUser.uid + '/followersCount')).val() || 0;
  const myFw = (await window.XF.get('users/' + currentUser.uid + '/followingCount')).val() || 0;
  await window.XF.update('users/' + currentUser.uid, { followersCount: Math.max(0, myF - 1), followingCount: Math.max(0, myFw - 1) });
  if (currentProfile) { currentProfile.followersCount = Math.max(0, myF - 1); currentProfile.followingCount = Math.max(0, myFw - 1); }
  showToast('Disconnected');
  renderDiscover();
}

/* ─── BLOCK / UNBLOCK ─── */
async function blockUser(uid, displayName) {
  if (!currentUser || uid === currentUser.uid) return;
  if (!confirm(`Block ${displayName || 'this user'}?`)) return;
  try {
    await window.XF.set('blocks/' + currentUser.uid + '/' + uid, { blockedAt: Date.now(), displayName: displayName || '' });
    await window.XF.remove('connections/' + currentUser.uid + '/' + uid);
    await window.XF.remove('connections/' + uid + '/' + currentUser.uid);
    showToast('User blocked'); goBack();
  } catch (e) { showToast('Could not block user'); }
}

async function unblockUser(uid, displayName) {
  if (!currentUser) return;
  try { await window.XF.remove('blocks/' + currentUser.uid + '/' + uid); showToast(displayName + ' unblocked'); }
  catch (e) { showToast('Could not unblock'); }
}

async function getBlockedUids() {
  if (!currentUser) return new Set();
  try {
    const snap = await window.XF.get('blocks/' + currentUser.uid);
    return snap.exists() ? new Set(Object.keys(snap.val())) : new Set();
  } catch (e) { return new Set(); }
}

async function isBlocked(uid) {
  if (!currentUser) return false;
  try { const s = await window.XF.get('blocks/' + currentUser.uid + '/' + uid); return s.exists(); }
  catch (e) { return false; }
}

/* ─── SEARCH ─── */
async function searchUsers(query) {
  const containers = [$('searchResults'), $('sidebarSearchResults')].filter(Boolean);
  if (!query || query.length < 2) { containers.forEach(c => c.innerHTML = ''); return; }
  const snap = await window.XF.get('users');
  const results = [];
  if (snap.exists()) {
    snap.forEach(c => {
      const p = c.val(); if (p.uid === currentUser?.uid) return;
      const q = query.toLowerCase();
      if ((p.displayName || '').toLowerCase().includes(q) || (p.handle || '').toLowerCase().includes(q)) results.push(p);
    });
  }
  const html = results.slice(0, 8).map(p =>
    `<div class="people-card" onclick="openUserProfile('${p.uid}',event)">${avatarHTML(p, 'sm')}<div class="people-card-info"><div class="people-card-name">${escapeHTML(p.displayName || 'Member')}${verifiedBadge(p.verified)}</div><div class="people-card-handle">@${escapeHTML(p.handle || 'member')}</div></div></div>`
  ).join('');
  containers.forEach(c => c.innerHTML = html);
}
