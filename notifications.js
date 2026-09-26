// notifications.js — X Club v7
'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   THE APPROACH
   ─────────────────────────────────────────────────────────────────────────
   Like every real app (WhatsApp, Telegram, iMessage):

   1. ONE listener on `notifications/{uid}` — Firebase gives us the full
      snapshot and every change to it in real-time.
   2. We maintain a single in-memory Map (_notifCache) keyed by notif ID.
      child_added  → insert into map
      child_changed → update in map
      child_removed → delete from map
   3. On any change, _rebuildNotifUI() runs synchronously from the cache —
      zero async, zero re-fetch, zero race conditions.
   4. Badge is also computed from the same cache — no separate watcher.

   For connection_request accept/decline status we do a SINGLE one-time fetch
   per unique reqId only when we first see it, store the result in a separate
   _connStatusCache, and never fetch again unless the notif changes.
═══════════════════════════════════════════════════════════════════════════ */

/* ── In-memory state ────────────────────────────────────────────────────── */
let _notifCache      = new Map(); // notifId → notif obj
let _connStatusCache = new Map(); // reqId   → 'pending'|'connected'|'declined'
let _notifListenerOff = null;

/* ── Icons (SVG, not emoji, so they render consistently across devices) ─── */
const ICON_BELL = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';
const ICON_CHECK = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const ICON_CONNECT = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
const ICON_MAIL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>';
const ICON_CHAT = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

/* ── Time formatter ─────────────────────────────────────────────────────── */
function _nTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1)  return 'Just now';
  if (m < 60) return m + 'm ago';
  if (h < 24) return h + 'h ago';
  if (d < 7)  return d + 'd ago';
  return new Date(ts).toLocaleDateString(undefined, { month:'short', day:'numeric' });
}

/* ── Badge updater ──────────────────────────────────────────────────────── */
function _setBadge(type, count) {
  const n    = count > 99 ? '99+' : (count > 0 ? String(count) : '');
  const show = count > 0;
  const ids  = type === 'notif'
    ? ['navNotifBadge', 'mobileNotifBadge']
    : ['navMsgBadge',   'mobileMsgBadge'];
  ids.forEach(id => {
    const b = $(id); if (!b) return;
    b.textContent = n;
    b.style.display = show ? 'flex' : 'none';
  });
}

/* ── Compute badge count from cache ─────────────────────────────────────── */
function _computeNotifBadge() {
  const seen = new Set();
  let count = 0;
  // Sort newest first so dedup keeps latest per sender
  const sorted = [..._notifCache.values()].sort((a, b) => (b.createdAt||0) - (a.createdAt||0));
  for (const n of sorted) {
    if (n.read) continue;
    if (n.type === 'new_message') continue; // msg badge handles these
    if (n.type === 'connection_request') {
      if (seen.has(n.fromUid)) continue;
      seen.add(n.fromUid);
    }
    count++;
  }
  _setBadge('notif', count);
}

/* ── Fetch connection status (cached, non-blocking) ─────────────────────── */
async function _fetchConnStatus(reqId, fromUid) {
  if (_connStatusCache.has(reqId)) return;
  _connStatusCache.set(reqId, 'pending'); // optimistic — prevents double fetch
  try {
    const cs = await window.XF.get('connections/' + currentUser.uid + '/' + fromUid);
    if (cs.exists()) { _connStatusCache.set(reqId, 'connected'); return; }
    const rs = await window.XF.get('connectionRequests/' + reqId);
    _connStatusCache.set(reqId, rs.exists() ? (rs.val().status || 'pending') : 'pending');
  } catch (e) { _connStatusCache.set(reqId, 'pending'); }
  // Re-render once we have the real status
  if (activePage === 'notifications') _rebuildNotifUI();
}

/* ── Build and inject notification list from cache ──────────────────────── */
function _rebuildNotifUI() {
  const container = $('notifList');
  if (!container || !currentUser) return;

  if (_notifCache.size === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">' + ICON_BELL + '</div><div class="empty-state-title">' + t('notifs_empty') + '</div></div>';
    return;
  }

  // Sort all notifs newest first
  const all = [..._notifCache.values()].sort((a, b) => (b.createdAt||0) - (a.createdAt||0));

  // Deduplicate: one connection_request per sender. new_message notifications
  // are excluded entirely here (not just from the badge count above) — a new
  // DM already surfaces via the Messages tab's own badge/preview, so showing
  // it a second time in the Notifications list was pure duplication.
  const seenReq = new Set();
  const deduped = [];
  for (const n of all) {
    if (n.type === 'new_message') continue;
    if (n.type === 'connection_request') {
      if (seenReq.has(n.fromUid)) continue;
      seenReq.add(n.fromUid);
      // Kick off status fetch if needed (non-blocking)
      if (n.reqId && n.fromUid) _fetchConnStatus(n.reqId, n.fromUid);
    }
    deduped.push(n);
  }

  // Sort deduped: unread first, then newest
  deduped.sort((a, b) => {
    if (!a.read && b.read) return -1;
    if (a.read && !b.read)  return 1;
    return (b.createdAt||0) - (a.createdAt||0);
  });

  // Build HTML
  const hasUnread = deduped.some(n => !n.read);
  let html = `<div class="notif-toolbar">
    <span class="notif-toolbar-count">${deduped.length} notification${deduped.length !== 1 ? 's' : ''}</span>
    ${hasUnread ? `<button id="markAllReadBtn" class="notif-mark-all-btn" onclick="markAllNotifsRead()">✓ Mark all as read</button>` : ''}
  </div>`;

  let lastGroup = null;
  for (const n of deduped) {
    const unread = !n.read;
    const group  = unread ? 'unread' : 'read';
    if (group !== lastGroup) {
      html += `<div class="notif-section-header ${group === 'unread' ? 'unread-header' : 'read-header'}">${group === 'unread' ? '● Unread' : '✓ Earlier'}</div>`;
      lastGroup = group;
    }

    const cls  = 'notif-item' + (unread ? ' unread' : '');
    const dot  = unread ? '<div class="notif-unread-dot"></div>' : '';
    const time = _nTime(n.createdAt);

    if (n.type === 'connection_request') {
      const st = _connStatusCache.get(n.reqId) || 'pending';
      const action = st === 'connected' || st === 'accepted'
        ? `<div class="notif-action-done">${ICON_CHECK} Connected</div>`
        : st === 'declined'
          ? `<div class="notif-action-declined">Declined</div>`
          : `<div class="notif-action-btns" id="connBtns_${n.reqId}">
               <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();acceptConnectionFromNotif('${n.reqId}','${n.fromUid}',this)">Accept</button>
               <button class="btn btn-outline btn-sm"  onclick="event.stopPropagation();declineConnection('${n.reqId}')">Decline</button>
             </div>`;
      html += `<div class="${cls}" onclick="openUserProfile('${n.fromUid}',event)">
        <div class="notif-icon">${ICON_CONNECT}</div>
        <div class="notif-body">
          <div class="notif-text"><strong>${escapeHTML(n.fromName||'Someone')}</strong> wants to connect with you</div>
          <div class="notif-time">${time}</div>
          ${action}
        </div>${dot}</div>`;
      continue;
    }

    if (n.type === 'connection_accepted') {
      html += `<div class="${cls}" onclick="openUserProfile('${n.fromUid}',event)">
        <div class="notif-icon">${ICON_CHECK}</div>
        <div class="notif-body">
          <div class="notif-text"><strong>${escapeHTML(n.fromName||'Someone')}</strong> accepted your connection request</div>
          <div class="notif-time">${time}</div>
        </div>${dot}</div>`;
      continue;
    }

    if (n.type === 'message_request') {
      const prev = n.preview ? `: <em>${escapeHTML(n.preview)}</em>` : '';
      html += `<div class="${cls}" onclick="_switchMsgTab('requests');showPage('messages')">
        <div class="notif-icon">${ICON_MAIL}</div>
        <div class="notif-body">
          <div class="notif-text"><strong>${escapeHTML(n.fromName||'Someone')}</strong> sent you a message request${prev}</div>
          <div class="notif-time">${time}</div>
        </div>${dot}</div>`;
      continue;
    }

    if (n.type === 'message_request_accepted') {
      html += `<div class="${cls}" onclick="openDMWith('${n.fromUid}')">
        <div class="notif-icon">${ICON_CHECK}</div>
        <div class="notif-body">
          <div class="notif-text"><strong>${escapeHTML(n.fromName||'Someone')}</strong> accepted your message request</div>
          <div class="notif-time">${time}</div>
        </div>${dot}</div>`;
      continue;
    }

    // Generic
    html += `<div class="${cls}">
      <div class="notif-icon">${ICON_BELL}</div>
      <div class="notif-body">
        <div class="notif-text">${escapeHTML(n.text || 'New notification')}</div>
        <div class="notif-time">${time}</div>
      </div>${dot}</div>`;
  }

  container.innerHTML = html;
}

/* ── Public: open notifications page ───────────────────────────────────── */
// Called by router when navigating to notifications page.
// No fetch needed — cache is already live.
function renderNotifications() {
  _rebuildNotifUI();
  // Opening the notifications page counts as seeing them — mark them read
  // automatically (as every other app does) instead of relying on the user
  // finding the "Mark all as read" button. Short delay so the unread
  // highlight is actually visible for a moment before it clears.
  setTimeout(() => {
    if (window.__PAGE__ === 'notifications') _autoMarkNotifsRead();
  }, 1200);
}

async function _autoMarkNotifsRead() {
  if (!currentUser) return;
  try {
    const updates = {};
    _notifCache.forEach((n, id) => {
      if (!n.read) updates['notifications/' + currentUser.uid + '/' + id + '/read'] = true;
    });
    if (Object.keys(updates).length) {
      await window.XF.multiUpdate(updates);
      _setBadge('notif', 0);
    }
  } catch (e) {}
}

/* ── Mark all read ──────────────────────────────────────────────────────── */
async function markAllNotifsRead() {
  if (!currentUser) return;
  const btn = $('markAllReadBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Marking…'; }
  try {
    const updates = {};
    _notifCache.forEach((n, id) => {
      if (!n.read)
        updates['notifications/' + currentUser.uid + '/' + id + '/read'] = true;
    });
    if (Object.keys(updates).length) {
      await window.XF.multiUpdate(updates);
      // Cache will update via the live listener — no manual patch needed
    }
    _setBadge('notif', 0);
  } catch (e) { showToast('Could not mark all as read'); }
}

/* ═══════════════════════════════════════════════════════════════════════════
   NOTIFICATION WATCHER — starts once on login, never re-attaches
   Uses child_added / child_changed / child_removed so Firebase only sends
   diffs, not the entire list on every change.
═══════════════════════════════════════════════════════════════════════════ */
function startNotifWatch() {
  if (!currentUser) return;
  if (_notifListenerOff) return; // guard: never attach twice

  const path = 'notifications/' + currentUser.uid;

  const onAdded = snap => {
    _notifCache.set(snap.key, { id: snap.key, ...snap.val() });
    _computeNotifBadge();
    if (activePage === 'notifications') _rebuildNotifUI();
  };
  const onChanged = snap => {
    _notifCache.set(snap.key, { id: snap.key, ...snap.val() });
    // If a connection_request status might have changed, invalidate its cache
    const n = _notifCache.get(snap.key);
    if (n?.type === 'connection_request' && n.reqId) _connStatusCache.delete(n.reqId);
    _computeNotifBadge();
    if (activePage === 'notifications') _rebuildNotifUI();
  };
  const onRemoved = snap => {
    _notifCache.delete(snap.key);
    _computeNotifBadge();
    if (activePage === 'notifications') _rebuildNotifUI();
  };

  const offAdded   = window.XF.onChild(path, 'child_added',   onAdded);
  const offChanged = window.XF.onChild(path, 'child_changed', onChanged);
  const offRemoved = window.XF.onChild(path, 'child_removed', onRemoved);

  _notifListenerOff = () => { offAdded(); offChanged(); offRemoved(); };
}

/* ═══════════════════════════════════════════════════════════════════════════
   MESSAGE BADGE + CONV LIST
   ─────────────────────────────────────────────────────────────────────────
   _convCache: uid → { profile, unread (number, mine), lastMessage }

   Unread count and last-message preview now come from a maintained
   conversations/{convId} doc (unread.{uid} incremented atomically on
   send in messages.js's _dmNotifyRecipient, reset to 0 on _markRead) —
   NOT from scanning message history. Previously this whole section
   worked by attaching a full onChild('child_added') listener per
   conversation, which replays and re-reads EVERY message ever sent in
   that conversation, for every connection, every time anyone opens the
   app or connections change at all. That's what was driving Firestore
   read-quota usage sky high on completely ordinary days. Now each
   conversation costs exactly ONE cheap document listener (conversations/
   {convId}) plus a bounded onNewSince listener that only reads messages
   created after attach time — used purely to trigger the in-app popup
   toast, never to rebuild history.

   Trade-off worth knowing: because we no longer keep full message
   history in memory here, a read receipt on an OLD message (one sent
   before this session's watch started) won't live-update the badge/list
   the instant the other person reads it — the badge is still accurate
   (it's driven by the maintained counter, not by scanning readBy), this
   only affects a live "seen" indicator on old messages, which this list
   view never rendered anyway.

   Listeners per connection:
   - One doc listener on `conversations/{convId}` (unread + lastMessage)
   - One bounded onNewSince listener on `dms/{convId}` (popups only)
   Plus one list listener on `connections/{uid}` to know who to watch.
═══════════════════════════════════════════════════════════════════════════ */
let _convCache    = new Map(); // uid → { profile, unread, lastMessage }
let _msgWatchers  = new Map(); // uid → unsub function, so we can diff instead of full teardown
let _convListenerReady = false;

function _computeMsgBadge() {
  let total = 0;
  _convCache.forEach(({ unread }) => { total += (unread || 0); });
  _setBadge('msg', total);
}

function _rebuildConvUI() {
  const container = $('convList');
  if (!container) return;

  if (_convCache.size === 0) {
    container.innerHTML = `<div class="empty-state" style="padding:40px 16px">
      <div class="empty-state-icon">${ICON_CHAT}</div>
      <div class="empty-state-title">${t('messages_empty_title')}</div>
      <div class="empty-state-desc">${t('messages_empty_desc')}</div>
    </div>`;
    return;
  }

  const rows = [];
  _convCache.forEach(({ profile, unread, lastMessage }, uid) => {
    if (!profile) return;
    rows.push({ uid, profile, latest: lastMessage || null, unread: unread || 0, ts: lastMessage?.createdAt || 0 });
  });

  // Sort: unread first, then newest
  rows.sort((a, b) => {
    if (a.unread > 0 && b.unread === 0) return -1;
    if (a.unread === 0 && b.unread > 0) return 1;
    return b.ts - a.ts;
  });

  container.innerHTML = rows.map(({ uid, profile: p, latest, unread, ts }) => {
    const preview   = latest ? ((latest.imageUrl || latest.imageUrls) ? 'Photo' : latest.fileName ? ('📎 ' + latest.fileName) : String(latest.text || '').slice(0, 50)) : 'Say hello!';
    const timeStr   = ts > 0 ? timeAgo(ts) : '';
    const hasUnread = unread > 0;
    return `<div class="conv-row${hasUnread ? ' conv-row-unread' : ''}" onclick="openDMWith('${uid}')">
      <div class="conv-avatar-wrap">
        ${avatarHTML(p, 'md')}
        ${hasUnread ? `<div class="conv-avatar-badge">${unread > 99 ? '99+' : unread}</div>` : ''}
      </div>
      <div class="conv-info">
        <div class="conv-top">
          <span class="conv-name${hasUnread ? ' conv-name-bold' : ''}">${escapeHTML(p.displayName || 'Member')}${verifiedBadge(p.verified)}</span>
          <span class="conv-time${hasUnread ? ' conv-time-accent' : ''}">${timeStr}</span>
        </div>
        <div class="conv-bottom">
          <span class="conv-preview${hasUnread ? ' conv-preview-bold' : ''}">${escapeHTML(preview)}</span>
          ${hasUnread ? `<span class="conv-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

// Called by router / closeDMFullpage — just re-renders from cache
function renderConversations() {
  const lv = $('messagesListView'), dp = $('dmFullpage');
  if (lv) lv.style.display = 'block';
  if (dp) dp.style.display = 'none';
  if (!currentUser) { const c = $('convList'); if (c) c.innerHTML = ''; return; }
  if (!_convListenerReady) {
    // First call before watchers are up — show spinner, watchers will call us
    const c = $('convList');
    if (c) c.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
    return;
  }
  _rebuildConvUI();
  if (typeof renderPushOffBanner === 'function') renderPushOffBanner();
}

// Badge-only refresh (called externally by markRead etc.)
function refreshMsgBadge() { _computeMsgBadge(); }

/* ── Attach per-conversation listeners ──────────────────────────────────── */
function _watchConv(uid) {
  const convId = [currentUser.uid, uid].sort().join('_');

  if (!_convCache.has(uid)) _convCache.set(uid, { profile: null, unread: 0, lastMessage: null });

  // Load profile once
  window.XF.get('users/' + uid).then(s => {
    if (s.exists()) _convCache.get(uid).profile = s.val();
    _rebuildConvUI();
  }).catch(() => {});

  // ONE cheap document listener — unread count + last-message preview,
  // maintained by the sender on every send (see messages.js's
  // _dmNotifyRecipient) rather than computed here by reading history.
  const offMeta = window.XF.on('conversations/' + convId, snap => {
    const meta = snap.val() || {};
    const entry = _convCache.get(uid);
    if (!entry) return;
    entry.unread = (meta.unread && meta.unread[currentUser.uid]) || 0;
    entry.lastMessage = meta.lastMessage || null;
    _computeMsgBadge();
    if (activePage === 'messages' && $('messagesListView')?.style.display !== 'none')
      _rebuildConvUI();
  });

  // Bounded: only ever reads messages created from this moment forward —
  // used solely to trigger the in-app popup toast for a genuinely new
  // incoming message, never to populate history or the badge (the doc
  // listener above already handles both of those, far more cheaply).
  const watchStarted = Date.now();
  const offAdded = window.XF.onNewSince('dms/' + convId, watchStarted, async snap => {
    const m = snap.val(); if (!m) return;
    if (activeConvUid === uid || m.senderUid === currentUser.uid) return;
    try {
      const ps = await window.XF.get('users/' + uid);
      const prof = ps.exists() ? ps.val() : { displayName: 'New message' };
      showMsgPopup(uid, prof, (m.imageUrl || m.imageUrls) ? 'Photo' : (m.text || ''));
    } catch (_) {}
  });

  _msgWatchers.set(uid, () => { offMeta(); offAdded(); });
}

/* ── Start message watcher — called once on login ───────────────────────── */
async function startMsgWatch() {
  if (!currentUser) return;

  // Watch connections list — diff added/removed uids and only (re)wire
  // the conversations that actually changed, instead of tearing down and
  // rebuilding every single conversation's listeners on any change at
  // all (previously: accepting ONE new connection re-read the full
  // history of every OTHER conversation too).
  window.XF.on('connections/' + currentUser.uid, connSnap => {
    const nextUids = connSnap.exists() ? new Set(Object.keys(connSnap.val())) : new Set();

    // Remove watchers for connections that no longer exist
    _msgWatchers.forEach((off, uid) => {
      if (!nextUids.has(uid)) { try { off(); } catch (_) {} _msgWatchers.delete(uid); _convCache.delete(uid); }
    });
    // Add watchers for newly-appeared connections only
    nextUids.forEach(uid => { if (!_msgWatchers.has(uid)) _watchConv(uid); });

    _convListenerReady = true;
    if (nextUids.size === 0) { _setBadge('msg', 0); _rebuildConvUI(); }
    // UI will refresh as each conv's meta doc listener fires (near-instant)
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   IN-APP MESSAGE POPUP
═══════════════════════════════════════════════════════════════════════════ */
let _popupDismiss = null;

function showMsgPopup(uid, profile, text) {
  document.querySelectorAll('.msg-popup').forEach(el => el.remove());
  clearTimeout(_popupDismiss);

  const popup = document.createElement('div');
  popup.className = 'msg-popup';
  popup.innerHTML = `
    <div class="msg-popup-avatar">${avatarHTML(profile, 'sm')}</div>
    <div class="msg-popup-body">
      <div class="msg-popup-name">${escapeHTML(profile.displayName || 'New message')}</div>
      <div class="msg-popup-preview">${escapeHTML((text || '').slice(0, 60))}</div>
    </div>
    <div class="msg-popup-close">✕</div>`;

  const dismiss = () => {
    clearTimeout(_popupDismiss);
    popup.classList.remove('visible');
    setTimeout(() => popup.remove(), 350);
  };

  popup.querySelector('.msg-popup-close').addEventListener('click', e => { e.stopPropagation(); dismiss(); });
  popup.addEventListener('click', () => { dismiss(); openDMWith(uid); });

  document.body.appendChild(popup);
  requestAnimationFrame(() => requestAnimationFrame(() => popup.classList.add('visible')));
  _popupDismiss = setTimeout(dismiss, 5000);
}
