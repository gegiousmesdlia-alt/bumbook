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
    container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔔</div><div class="empty-state-title">No notifications yet</div></div>';
    return;
  }

  // Sort all notifs newest first
  const all = [..._notifCache.values()].sort((a, b) => (b.createdAt||0) - (a.createdAt||0));

  // Count unread messages per sender before dedup
  const unreadMsgCount = {};
  for (const n of all) {
    if (n.type === 'new_message' && !n.read)
      unreadMsgCount[n.fromUid] = (unreadMsgCount[n.fromUid] || 0) + 1;
  }

  // Deduplicate: one connection_request per sender, one new_message per sender
  const seenReq = new Set(), seenMsg = new Set();
  const deduped = [];
  for (const n of all) {
    if (n.type === 'connection_request') {
      if (seenReq.has(n.fromUid)) continue;
      seenReq.add(n.fromUid);
      // Kick off status fetch if needed (non-blocking)
      if (n.reqId && n.fromUid) _fetchConnStatus(n.reqId, n.fromUid);
    } else if (n.type === 'new_message') {
      if (seenMsg.has(n.fromUid)) continue;
      seenMsg.add(n.fromUid);
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
        ? `<div class="notif-action-done">✓ Connected</div>`
        : st === 'declined'
          ? `<div class="notif-action-declined">Declined</div>`
          : `<div class="notif-action-btns" id="connBtns_${n.reqId}">
               <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();acceptConnectionFromNotif('${n.reqId}','${n.fromUid}',this)">Accept</button>
               <button class="btn btn-outline btn-sm"  onclick="event.stopPropagation();declineConnection('${n.reqId}')">Decline</button>
             </div>`;
      html += `<div class="${cls}" onclick="openUserProfile('${n.fromUid}',event)">
        <div class="notif-icon">🤝</div>
        <div class="notif-body">
          <div class="notif-text"><strong>${escapeHTML(n.fromName||'Someone')}</strong> wants to connect with you</div>
          <div class="notif-time">${time}</div>
          ${action}
        </div>${dot}</div>`;
      continue;
    }

    if (n.type === 'connection_accepted') {
      html += `<div class="${cls}" onclick="openUserProfile('${n.fromUid}',event)">
        <div class="notif-icon">✅</div>
        <div class="notif-body">
          <div class="notif-text"><strong>${escapeHTML(n.fromName||'Someone')}</strong> accepted your connection request</div>
          <div class="notif-time">${time}</div>
        </div>${dot}</div>`;
      continue;
    }

    if (n.type === 'new_message') {
      const cnt   = unreadMsgCount[n.fromUid] || 0;
      const badge = cnt > 1 ? ` <span class="notif-msg-count">${cnt}</span>` : '';
      const prev  = n.preview ? `: <em>${escapeHTML(n.preview)}</em>` : '';
      html += `<div class="${cls}" onclick="openDMWith('${n.fromUid}')">
        <div class="notif-icon">💬</div>
        <div class="notif-body">
          <div class="notif-text"><strong>${escapeHTML(n.fromName||'Someone')}</strong> sent you a message${prev}${badge}</div>
          <div class="notif-time">${time}</div>
        </div>${dot}</div>`;
      continue;
    }

    if (n.type === 'message_request') {
      const prev = n.preview ? `: <em>${escapeHTML(n.preview)}</em>` : '';
      html += `<div class="${cls}" onclick="_switchMsgTab('requests');showPage('messages')">
        <div class="notif-icon">✉</div>
        <div class="notif-body">
          <div class="notif-text"><strong>${escapeHTML(n.fromName||'Someone')}</strong> sent you a message request${prev}</div>
          <div class="notif-time">${time}</div>
        </div>${dot}</div>`;
      continue;
    }

    if (n.type === 'message_request_accepted') {
      html += `<div class="${cls}" onclick="openDMWith('${n.fromUid}')">
        <div class="notif-icon">✅</div>
        <div class="notif-body">
          <div class="notif-text"><strong>${escapeHTML(n.fromName||'Someone')}</strong> accepted your message request</div>
          <div class="notif-time">${time}</div>
        </div>${dot}</div>`;
      continue;
    }

    // Generic
    html += `<div class="${cls}">
      <div class="notif-icon">🔔</div>
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
   Same pattern: one in-memory map per conversation.
   _convCache: uid → { profile, msgs: Map(msgId→msg) }

   Listeners:
   - One 'value' on `connections/{uid}` to know who we talk to
   - Per-conv child_added / child_changed on `dms/{convId}`
   - Per-conv child_added on `users/{uid}` (profile changes — rare)

   Conv list is rebuilt synchronously from _convCache.
   Badge is computed from _convCache.
═══════════════════════════════════════════════════════════════════════════ */
let _convCache    = new Map(); // uid → { profile, msgs: Map }
let _msgWatchers  = [];        // unsub functions for per-conv listeners
let _convListenerReady = false;

function _computeMsgBadge() {
  let total = 0;
  _convCache.forEach(({ msgs }) => {
    msgs.forEach(m => {
      if (m.senderUid !== currentUser.uid && (!m.readBy || !m.readBy[currentUser.uid]))
        total++;
    });
  });
  _setBadge('msg', total);
}

function _rebuildConvUI() {
  const container = $('convList');
  if (!container) return;

  if (_convCache.size === 0) {
    container.innerHTML = `<div class="empty-state" style="padding:40px 16px">
      <div class="empty-state-icon">💬</div>
      <div class="empty-state-title">No messages yet</div>
      <div class="empty-state-desc">Connect with members to start chatting</div>
    </div>`;
    return;
  }

  // Build summary per uid
  const rows = [];
  _convCache.forEach(({ profile, msgs }, uid) => {
    if (!profile) return;
    const allMsgs = [...msgs.values()].sort((a, b) => (a.createdAt||0) - (b.createdAt||0));
    const latest  = allMsgs[allMsgs.length - 1] || null;
    const unread  = allMsgs.filter(m =>
      m.senderUid !== currentUser.uid && (!m.readBy || !m.readBy[currentUser.uid])
    ).length;
    rows.push({ uid, profile, latest, unread, ts: latest?.createdAt || 0 });
  });

  // Sort: unread first, then newest
  rows.sort((a, b) => {
    if (a.unread > 0 && b.unread === 0) return -1;
    if (a.unread === 0 && b.unread > 0) return 1;
    return b.ts - a.ts;
  });

  container.innerHTML = rows.map(({ uid, profile: p, latest, unread, ts }) => {
    const preview   = latest ? (latest.imageUrl ? '📷 Photo' : String(latest.text || '').slice(0, 50)) : 'Say hello!';
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
}

// Badge-only refresh (called externally by markRead etc.)
function refreshMsgBadge() { _computeMsgBadge(); }

/* ── Attach per-conversation listeners ──────────────────────────────────── */
function _watchConv(uid) {
  const convId  = [currentUser.uid, uid].sort().join('_');
  const dmPath  = 'dms/' + convId;

  if (!_convCache.has(uid)) _convCache.set(uid, { profile: null, msgs: new Map() });

  // Load profile once
  window.XF.get('users/' + uid).then(s => {
    if (s.exists()) _convCache.get(uid).profile = s.val();
    _rebuildConvUI();
  }).catch(() => {});

  // Timestamp guard: child_added replays all existing children on attach.
  // We want ALL of them for the initial load (that's correct — we need history
  // for preview + unread count). We only skip the popup for old ones.
  const watchStarted = Date.now();

  const onAdded = async snap => {
    const m = snap.val(); if (!m) return;
    _convCache.get(uid)?.msgs.set(snap.key, { id: snap.key, ...m });
    _computeMsgBadge();
    if (activePage === 'messages' && $('messagesListView')?.style.display !== 'none')
      _rebuildConvUI();

    // Popup only for genuinely new incoming messages
    const isNew = (m.createdAt || 0) >= watchStarted;
    if (isNew && activeConvUid !== uid && m.senderUid !== currentUser.uid &&
        (!m.readBy || !m.readBy[currentUser.uid])) {
      try {
        const ps = await window.XF.get('users/' + uid);
        const prof = ps.exists() ? ps.val() : { displayName: 'New message' };
        showMsgPopup(uid, prof, m.imageUrl ? '📷 Photo' : (m.text || ''));
      } catch (_) {}
    }
  };

  const onChanged = snap => {
    const m = snap.val(); if (!m) return;
    _convCache.get(uid)?.msgs.set(snap.key, { id: snap.key, ...m });
    _computeMsgBadge();
    if (activePage === 'messages' && $('messagesListView')?.style.display !== 'none')
      _rebuildConvUI();
  };

  const offAdded   = window.XF.onChild(dmPath, 'child_added',   onAdded);
  const offChanged = window.XF.onChild(dmPath, 'child_changed', onChanged);
  _msgWatchers.push(() => { offAdded(); offChanged(); });
}

/* ── Start message watcher — called once on login ───────────────────────── */
async function startMsgWatch() {
  if (!currentUser) return;

  // Watch connections list — re-wire conv listeners if connections change
  window.XF.on('connections/' + currentUser.uid, connSnap => {
    // Tear down old per-conv watchers
    _msgWatchers.forEach(off => { try { off(); } catch (_) {} });
    _msgWatchers = [];
    _convCache.clear();

    if (!connSnap.exists()) {
      _convListenerReady = true;
      _setBadge('msg', 0);
      _rebuildConvUI();
      return;
    }

    const uids = Object.keys(connSnap.val());
    uids.forEach(uid => _watchConv(uid));

    _convListenerReady = true;
    // UI will refresh as each conv's child_added fires (they're nearly instant)
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
