// discover.js — X Club v7 — Discover, Search, Connections, Block/Unblock
'use strict';

/* ─── DISCOVER PAGE ─── */
async function renderDiscover() {
  const container = $('discoverPeople'); if (!container) return;
  container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
  try {
    const snap = await window.XF.get('users');
    const blockedUids = await getBlockedUids();
    const people = [];
    if (snap.exists()) snap.forEach(c => { if (c.key !== currentUser?.uid && !blockedUids.has(c.key)) people.push(c.val()); });
    if (people.length === 0) { container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⊛</div><div class="empty-state-title">No members yet</div></div>`; return; }

    // Fetch my connections + pending requests in parallel
    const [myConnSnap, reqSnap] = await Promise.all([
      currentUser ? window.XF.get('connections/' + currentUser.uid) : Promise.resolve(null),
      currentUser ? window.XF.get('connectionRequests') : Promise.resolve(null)
    ]);
    const myConns = myConnSnap?.exists() ? myConnSnap.val() : {};
    const allReqs = reqSnap?.exists() ? reqSnap.val() : {};

    container.innerHTML = people.map(p => {
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
    }).join('');
  } catch (err) { container.innerHTML = '<div class="empty-state"><div class="empty-state-desc">Could not load members</div></div>'; }
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
  if (status === 'connected') return `<button class="btn btn-following btn-sm" onclick="event.stopPropagation();disconnect('${uid}')">Connected ✓</button>`;
  if (status === 'pending') return `<button class="btn btn-outline btn-sm" disabled style="opacity:0.6">Pending…</button>`;
  if (status === 'incoming' && incomingReqId) {
    return `<div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();acceptConnectionFromDiscover('${incomingReqId}','${uid}',this)">Accept</button>
      <button class="btn btn-outline btn-sm" onclick="event.stopPropagation();declineConnectionFromDiscover('${incomingReqId}',this)">Decline</button>
    </div>`;
  }
  return `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();sendConnectionRequest('${uid}')">Connect</button>`;
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
