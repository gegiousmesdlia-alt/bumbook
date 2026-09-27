// messages.js — X Club v7
'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   THE APPROACH — same as every real messenger (WhatsApp, Telegram, iMessage)
   ─────────────────────────────────────────────────────────────────────────
   Conv list + badge live in notifications.js (_convCache, _rebuildConvUI).
   This file owns only the open DM chat view:

   _dmMsgCache  — Map(msgId → msgObj) for the active conversation only.
                  Two sources feed it, merged together for rendering:
                   (1) a bounded LIVE listener on just the latest
                       DM_LIVE_WINDOW messages (window.XF.onDmMessages) —
                       wholesale-replaced on every fire, tracked via
                       _dmLiveIds so a message that ages out of the top-N
                       window (not deleted, just no longer "recent") gets
                       dropped from the live-tracked set without touching
                       anything loaded separately by (2);
                   (2) one-shot OLDER pages fetched on scroll-up via
                       _dmLoadOlderMessages (window.XF.getDmMessages),
                       added once and left alone — not re-fetched, not
                       live-updated, same trade-off the feed already
                       makes for older posts.
                  This replaced an earlier version that live-listened to
                  the ENTIRE message history of every conversation, which
                  meant opening one old, active conversation could cost
                  thousands of Firestore reads every single time.
   _dmDoRender  — reads _dmMsgCache, sorts, builds HTML. Sync. No awaits.
                  Debounced to 16ms so rapid live-window bursts = 1 paint.
═══════════════════════════════════════════════════════════════════════════ */
const DM_LIVE_WINDOW = 50; // messages kept live-synced; older ones load on scroll-up

let _dmPartner    = null;
let _dmTypingOff  = null;
let _dmPresenceOff = null;
let _dmTypingTimer = null;
let _dmLiveIds        = new Set();  // ids currently owned by the live-window listener
let _dmHasMoreOlder   = true;       // false once a "load older" page comes back short
let _dmLoadingOlder   = false;      // re-entrancy guard for scroll-triggered loads

/* ═══════════════════════════════════════════════════════════════════════════
   PRESENCE — writes presence/{uid}, which _dmStartListeners already reads.
   Standard Firebase pattern: watch the special .info/connected path (fires
   whenever this specific socket connects/reconnects), and on each connect,
   (a) register an onDisconnect that flips us to offline+lastSeen the moment
   this connection drops — server-side, so it fires even on a crashed tab or
   lost network, not just a clean close — then (b) mark ourselves online now.
   This was wired up to be called (auth.js already had the call site) but the
   function itself was never written, so no one was ever marked online.
═══════════════════════════════════════════════════════════════════════════ */
function _initPresence(uid) {
  if (!uid || !window.XF || !window.XF.db) return;
  const myPresence   = window.XF.db.ref('presence/' + uid);
  const connectedRef = window.XF.db.ref('.info/connected');

  connectedRef.on('value', snap => {
    if (snap.val() !== true) return;
    myPresence.onDisconnect().set({ online: false, lastSeen: Date.now() }).then(() => {
      myPresence.set({ online: true, lastSeen: Date.now() });
    });
  });

  // Also mark offline on a clean tab close/navigation — onDisconnect covers
  // crashes/lost network, but firing it immediately on a normal close means
  // the other person sees "offline" right away instead of waiting out
  // Firebase's connection-timeout window.
  window.addEventListener('beforeunload', () => {
    myPresence.set({ online: false, lastSeen: Date.now() });
  });
}
let _dmMsgOff     = null;
let _dmReplyMsg   = null;
let _dmEmojiOpen  = false;
let _dmMsgCache   = new Map(); // msgId → msgObj  (Map preserves insertion order)

const _REACTIONS = ['❤️','😂','👍','😮','😢','😡'];
const _EMOJIS    = ['❤️','😂','😮','😢','😡','👍','👎','🔥','🎉','💯','😍','🙏','💪','✅','😭','🤣','😁','🥳','👏','💀','🫡','🤝','💰','📈','🚀','⭐','💎','👑','🤑','😎'];

/* ═══════════════════════════════════════════════════════════════════════════
   OPEN / CLOSE DM
═══════════════════════════════════════════════════════════════════════════ */
async function openDMWith(uid) {
  if (!requireVerified('message this member')) return;
  _dmTeardown();

  if (activePage !== 'messages') showPage('messages');
  activeConvUid = uid;

  const lv = $('messagesListView'), dp = $('dmFullpage');
  if (lv) lv.style.display = 'none';
  if (!dp) return;
  dp.style.display = 'flex';

  // Load partner profile (one-shot, not a listener)
  try {
    const s = await window.XF.get('users/' + uid);
    _dmPartner = s.exists() ? s.val() : null;
  } catch (e) { _dmPartner = null; }

  _dmRenderHeader(uid);
  _dmWireComposer(uid);

  const convId = [currentUser.uid, uid].sort().join('_');
  _dmStartListeners(uid, convId);

  // Mark messages as delivered when we open a chat — called after cache loads
  // _markDelivered is triggered from _dmDoRender once messages are in cache
}

function _dmTeardown() {
  if (_dmMsgOff)       { try { _dmMsgOff(); }       catch(e){} _dmMsgOff       = null; }
  if (_dmTypingOff)    { try { _dmTypingOff(); }    catch(e){} _dmTypingOff    = null; }
  if (_dmPresenceOff)  { try { _dmPresenceOff(); }  catch(e){} _dmPresenceOff  = null; }
  if (_dmTypingTimer)  { clearTimeout(_dmTypingTimer); _dmTypingTimer = null; }
  if (currentUser && activeConvUid) {
    const cid = [currentUser.uid, activeConvUid].sort().join('_');
    window.XF.db.ref('typing/' + cid + '/' + currentUser.uid).set(false).catch(()=>{});
  }
  _dmMsgCache.clear();
  _dmLiveIds      = new Set();
  _dmHasMoreOlder = true;
  _dmLoadingOlder = false;
  removeComposerPreview('dmLinkPreview');
  _dmPartner   = null;
  _dmReplyMsg  = null;
  _dmEmojiOpen = false;
  cancelReply();
}

function closeDMFullpage() {
  _dmTeardown();
  activeConvUid = null;
  const lv = $('messagesListView'), dp = $('dmFullpage');
  if (dp) dp.style.display = 'none';
  if (lv) lv.style.display = 'block';
  // Conv list re-renders from cache — instant
  _rebuildConvUI();
}

/* ═══════════════════════════════════════════════════════════════════════════
   HEADER + COMPOSER WIRING
═══════════════════════════════════════════════════════════════════════════ */
function _dmRenderHeader(uid) {
  const hdr = $('dmFullpageHeader'); if (!hdr) return;
  hdr.innerHTML = `
    <div class="dm-back-btn" onclick="closeDMFullpage()">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
    </div>
    <div class="dm-header-info" onclick="openUserProfile('${uid}',event)">
      ${avatarHTML(_dmPartner, 'md')}
      <div>
        <div class="dm-header-name">${escapeHTML(_dmPartner?.displayName || 'Member')}${verifiedBadge(_dmPartner?.verified)}</div>
        <div class="dm-header-status" id="dmStatus"><span style="color:var(--text-dim);font-size:0.78rem">@${escapeHTML(_dmPartner?.handle || '')}</span></div>
      </div>
    </div>`;
}

/* Format last seen — today at HH:MM / yesterday at HH:MM / 19 March 25 at 7:17 */
function _fmtLastSeen(ts) {
  if (!ts) return '';
  const now = new Date(), d = new Date(ts);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffMins = Math.floor((Date.now() - ts) / 60000);
  if (diffMins < 2) return 'last seen just now';
  if (ts >= todayStart)
    return 'last seen today at ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (ts >= todayStart - 86400000)
    return 'last seen yesterday at ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return 'last seen ' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: '2-digit' }) +
    ' at ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* Update status line — presence and typing are independent, typing wins */
let _dmPartnerPresence = null;
let _dmPartnerTyping   = false;

function _updateDmStatus(presence, typing) {
  const st = $('dmStatus'); if (!st) return;
  if (typing) {
    st.innerHTML = '<span style="color:#00c853;font-size:0.78rem">● typing…</span>';
    return;
  }
  if (!presence) {
    st.innerHTML = `<span style="color:var(--text-dim);font-size:0.78rem">@${escapeHTML(_dmPartner?.handle || '')}</span>`;
    return;
  }
  if (presence.online) {
    st.innerHTML = '<span style="color:#00c853;font-size:0.78rem">● Online</span>';
  } else {
    st.innerHTML = `<span style="color:var(--text-dim);font-size:0.78rem">${escapeHTML(_fmtLastSeen(presence.lastSeen))}</span>`;
  }
}

function _dmWireComposer(uid) {
  const input = $('dmInput');
  if (input) {
    input.value = '';
    input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dmSend(uid); } };
    input.oninput   = () => { dmTyping(uid); dmUpdateSendBtn(); debouncedComposerPreview(input.value, 'dmLinkPreview'); };
  }
  const sendBtn = document.querySelector('#dmFullpage .dm-send-btn');
  if (sendBtn) sendBtn.onclick = () => dmSend(uid);

  _dmPendingImages = [];
  const previewEl = $('dmImgPreview'); if (previewEl) previewEl.innerHTML = '';
  const imgInput = $('dmImgInput');
  if (imgInput) { imgInput.value = ''; imgInput.onchange = () => previewDmImages(imgInput); }
  const fileInput = $('dmFileInput');
  if (fileInput) { fileInput.value = ''; fileInput.onchange = () => pickDmFile(fileInput); }

  const msgEl = $('dmMessages');
  if (msgEl) msgEl.addEventListener('scroll', _dmMessagesScrollHandler, { passive: true });

  const emojiBtn = $('dmEmojiBtn');
  if (emojiBtn) emojiBtn.onclick = e => { e.stopPropagation(); dmToggleEmoji(); };

  document.addEventListener('click', function _ce(e) {
    if (!$('dmEmojiPicker')?.contains(e.target) && e.target.id !== 'dmEmojiBtn') {
      const picker = $('dmEmojiPicker');
      if (picker) picker.style.display = 'none';
      _dmEmojiOpen = false;
    }
  });

  dmUpdateSendBtn();
}

/* ═══════════════════════════════════════════════════════════════════════════
   LISTENERS — child events on the active DM conversation only
   child_added   → new message (or initial load of last 100)
   child_changed → read receipts, reactions, edits
   child_removed → deleted message
   All three update _dmMsgCache then debounce a re-render.
═══════════════════════════════════════════════════════════════════════════ */
/* WhatsApp-style typing bubble pinned to the bottom of the thread, shown
   while the other person is actively typing in this conversation. Separate
   from the header status line — both fire off the same typing listener. */
function _renderTypingBubble(isTyping) {
  const msgEl = $('dmMessages'); if (!msgEl) return;
  const existing = $('dmTypingBubble');
  if (!isTyping) { if (existing) existing.remove(); return; }
  if (existing) return; // already shown
  const wasAtBottom = msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight < 140;
  const el = document.createElement('div');
  el.id = 'dmTypingBubble';
  el.className = 'dm-wrap them';
  el.innerHTML = `<div class="dm-avatar">${avatarHTML(_dmPartner, 'sm')}</div>
    <div class="dm-col"><div class="dm-bubble them dm-typing-bubble"><span></span><span></span><span></span></div></div>`;
  msgEl.appendChild(el);
  if (wasAtBottom) msgEl.scrollTop = msgEl.scrollHeight;
}

function _dmStartListeners(uid, convId) {
  const typPath  = 'typing/' + convId + '/' + uid;
  const presPath = 'presence/' + uid;

  _dmPartnerPresence = null;
  _dmPartnerTyping   = false;
  _dmLiveIds      = new Set();
  _dmHasMoreOlder = true;
  _dmLoadingOlder = false;

  // Bounded live listener: only the latest DM_LIVE_WINDOW messages, not
  // the whole conversation history — see this file's header for why.
  // Diff against the previous live-window id set so a message aging out
  // of the window (superseded by newer ones) is dropped from the cache,
  // without touching anything loaded separately via "load older".
  const dmUnsub = window.XF.onDmMessages(convId, DM_LIVE_WINDOW, snap => {
    const data = snap.val() || {};
    const newIds = new Set(Object.keys(data));
    _dmLiveIds.forEach(id => { if (!newIds.has(id)) _dmMsgCache.delete(id); });
    _dmLiveIds = newIds;
    Object.entries(data).forEach(([key, val]) => _dmMsgCache.set(key, { id: key, ...val }));
    _dmRender(uid, convId);
  });

  _dmMsgOff = () => { dmUnsub(); };

  // Typing + presence live in the Realtime Database (see firebase.js header),
  // NOT Firestore — and the writes already go there via window.XF.db.ref().
  // Reading them through window.XF.on() routed to Firestore's resolver, which
  // has no mapping for these paths and threw "[XF] Unmapped path", aborting
  // listener setup entirely. That's why online status and typing never
  // appeared. Read them straight off the RTDB handle instead.
  const rtdb = window.XF.db;

  // Typing — layers on top of presence, doesn't replace it
  const typRef = rtdb.ref(typPath);
  const onType = snap => {
    _dmPartnerTyping = snap.val() === true;
    _updateDmStatus(_dmPartnerPresence, _dmPartnerTyping);
    _renderTypingBubble(_dmPartnerTyping);
  };
  typRef.on('value', onType);
  _dmTypingOff = () => typRef.off('value', onType);

  // Presence — online / last seen
  const presRef = rtdb.ref(presPath);
  const onPresence = snap => {
    _dmPartnerPresence = snap.exists() ? snap.val() : null;
    _updateDmStatus(_dmPartnerPresence, _dmPartnerTyping);
  };
  presRef.on('value', onPresence);
  _dmPresenceOff = () => presRef.off('value', onPresence);
}

/* ═══════════════════════════════════════════════════════════════════════════
   RENDER — reads cache, sorts, paints. Debounced to collapse burst events.
═══════════════════════════════════════════════════════════════════════════ */
let _dmRenderTimer = null;
function _dmRender(uid, convId) {
  clearTimeout(_dmRenderTimer);
  _dmRenderTimer = setTimeout(() => _dmDoRender(uid, convId), 16);
}

function _dmDoRender(uid, convId) {
  const msgEl = $('dmMessages'); if (!msgEl) return;

  // Sort by timestamp — Map keeps insertion order but timestamps might not be
  const msgs = [..._dmMsgCache.values()].sort((a, b) => (a.createdAt||0) - (b.createdAt||0));

  if (!msgs.length) {
    msgEl.innerHTML = `<div class="dm-empty">Start the conversation! 👋</div>`;
    return;
  }

  const wasAtBottom = msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight < 120;
  const topSentinel = _dmHasMoreOlder
    ? '<div class="dm-load-older" id="dmLoadOlder"></div>' // empty until scroll-triggered; also the scroll-position anchor for _dmLoadOlderMessages
    : '<div class="dm-load-older dm-load-older-end" id="dmLoadOlder">Beginning of conversation</div>';
  msgEl.innerHTML = topSentinel + _buildMsgsHTML(msgs, uid, convId);
  if (wasAtBottom) msgEl.scrollTop = msgEl.scrollHeight;

  setTimeout(() => { if (activeConvUid === uid) _markRead(convId); }, 800);
  setTimeout(() => { if (activeConvUid === uid) _markDelivered(convId); }, 100);
}

/* ═══════════════════════════════════════════════════════════════════════════
   LOAD OLDER — triggered by scrolling near the top of the thread. Fetches
   one bounded page further back (window.XF.getDmMessages) and preserves
   scroll position so the view doesn't jump while older messages are
   prepended above what's currently visible — same technique the feed
   uses for "load more" on scroll.
═══════════════════════════════════════════════════════════════════════════ */
function _dmMessagesScrollHandler() {
  const msgEl = $('dmMessages'); if (!msgEl || !activeConvUid || !currentUser) return;
  if (msgEl.scrollTop < 80) _dmLoadOlderMessages(activeConvUid);
}

async function _dmLoadOlderMessages(uid) {
  if (_dmLoadingOlder || !_dmHasMoreOlder || !currentUser) return;
  const convId = [currentUser.uid, uid].sort().join('_');
  const msgs = [..._dmMsgCache.values()];
  const oldestTs = msgs.length ? Math.min(...msgs.map(m => m.createdAt || Date.now())) : Date.now();

  _dmLoadingOlder = true;
  const msgEl = $('dmMessages');
  const sentinel = $('dmLoadOlder');
  if (sentinel) sentinel.textContent = 'Loading earlier messages…'; // immediate feedback — the fetch below is async, and _dmDoRender only fires once it resolves
  const prevScrollHeight = msgEl ? msgEl.scrollHeight : 0;
  const prevScrollTop = msgEl ? msgEl.scrollTop : 0;

  try {
    const snap = await window.XF.getDmMessages(convId, DM_LIVE_WINDOW, oldestTs);
    const older = snap.exists() ? snap.val() : {};
    const keys = Object.keys(older);
    if (keys.length < DM_LIVE_WINDOW) _dmHasMoreOlder = false;
    keys.forEach(k => { if (!_dmMsgCache.has(k)) _dmMsgCache.set(k, { id: k, ...older[k] }); });
    if (keys.length) {
      _dmDoRender(uid, convId); // sync, not debounced — need scroll fixed up immediately after
      if (msgEl) msgEl.scrollTop = msgEl.scrollHeight - prevScrollHeight + prevScrollTop;
    } else if (sentinel) {
      // Nothing further back — flip the sentinel to its end-state text
      // directly rather than a full re-render, since there's no new
      // content to fix scroll position for.
      sentinel.textContent = 'Beginning of conversation';
      sentinel.classList.add('dm-load-older-end');
    }
  } catch (e) {
  } finally {
    _dmLoadingOlder = false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   HTML BUILDER
═══════════════════════════════════════════════════════════════════════════ */
function _buildMsgsHTML(msgs, uid, convId) {
  let html = '', lastDate = '';

  for (const m of msgs) {
    const isMe = m.senderUid === currentUser.uid;

    // Date separator
    if (m.createdAt > 0) {
      const ds = new Date(m.createdAt).toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' });
      if (ds !== lastDate) {
        html += `<div class="dm-date-sep"><span>${ds}</span></div>`;
        lastDate = ds;
      }
    }

    // Reply preview
    let replyHTML = '';
    if (m.replyTo) {
      replyHTML = `<div class="dm-reply-preview-bubble" onclick="dmScrollTo('${m.replyTo.id}')">
        <div class="dm-reply-name">${escapeHTML(m.replyTo.senderName || '')}</div>
        <div class="dm-reply-text">${(m.replyTo.imageUrl || m.replyTo.imageUrls) ? 'Photo' : m.replyTo.fileName ? ('📎 ' + escapeHTML(m.replyTo.fileName)) : escapeHTML((m.replyTo.text||'').slice(0,50))}</div>
      </div>`;
    }

    // Content
    let content = '';
    if (m.imageUrls && m.imageUrls.length) {
      const galleryClass = 'dm-img-gallery dm-img-gallery-' + Math.min(m.imageUrls.length, 4);
      content += `<div class="${galleryClass}">` + m.imageUrls.map(u =>
        `<img src="${escapeHTML(u)}" class="dm-img-bubble dm-img-gallery-item" onclick="openLightbox('${escapeHTML(u)}')" loading="lazy">`
      ).join('') + '</div>';
    } else if (m.imageUrl) content += `<img src="${escapeHTML(m.imageUrl)}" class="dm-img-bubble" onclick="openLightbox('${escapeHTML(m.imageUrl)}')" loading="lazy">`;
    else if (m.fileUrl) content += `<a href="${escapeHTML(m.fileUrl)}" target="_blank" rel="noopener" class="dm-file-bubble">
        <span class="dm-file-icon">📎</span>
        <span class="dm-file-info"><span class="dm-file-name">${escapeHTML(m.fileName || 'File')}</span><span class="dm-file-size">${_formatFileSize(m.fileSize || 0)}</span></span>
      </a>`;
    if (m.text)     content += `<span class="dm-text">${escapeHTML(m.text)}</span>`;
    if (m.linkPreview) content += linkPreviewCardHTML(m.linkPreview);

    // Meta
    const t      = m.createdAt > 0 ? new Date(m.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
    const isDelivered = m.deliveredTo && Object.keys(m.deliveredTo).some(k => k !== currentUser.uid);
    const isRead      = m.readBy && Object.keys(m.readBy).some(k => k !== currentUser.uid);
    const tickLabel = isRead ? 'Seen' : isDelivered ? 'Delivered' : 'Sent';
    const tickClass = isRead ? ' seen' : isDelivered ? ' delivered' : ' sent';
    const ticks = isMe ? `<span class="dm-ticks${tickClass}">${tickLabel}</span>` : '';
    const starred = m.starred?.[currentUser.uid] ? '<span class="dm-starred">⭐</span>' : '';

    // Reactions
    let reactHTML = '';
    if (m.reactions && Object.keys(m.reactions).length) {
      const counts = {};
      Object.values(m.reactions).forEach(r => { counts[r] = (counts[r]||0)+1; });
      reactHTML = `<div class="dm-reacts">
        ${Object.entries(counts).map(([e,c]) =>
          `<span class="dm-react${m.reactions[currentUser.uid]===e?' mine':''}" onclick="dmReact('${convId}','${m.id}','${e}')">${e}${c>1?' '+c:''}</span>`
        ).join('')}
      </div>`;
    }

    html += `<div class="dm-wrap${isMe?' me':' them'}" id="dmm-${m.id}"
      data-mid="${m.id}" data-cid="${convId}" data-me="${isMe?1:0}"
      oncontextmenu="dmCtxMenu(event,this)"
      ontouchstart="dmTouchStart(event,this)" ontouchmove="dmTouchMove(event,this)" ontouchend="dmTouchEnd(event,this)" ontouchcancel="dmTouchEnd(event,this)">
      ${!isMe ? `<div class="dm-avatar">${avatarHTML(_dmPartner,'sm')}</div>` : ''}
      <div class="dm-swipe-reply-icon">↩</div>
      <div class="dm-col">
        ${replyHTML}
        <div class="dm-bubble${isMe?' me':' them'}">
          ${starred}${content}
          <div class="dm-meta"><span class="dm-time">${t}</span>${ticks}</div>
        </div>
        ${reactHTML}
      </div>
    </div>`;
  }
  return html;
}

/* ═══════════════════════════════════════════════════════════════════════════
   TOUCH: swipe-to-reply (drag right, WhatsApp/Telegram-style) + long-press
   context menu, unified into one handler set since both start from the
   same touchstart and need to tell each other apart as the gesture
   develops — a plain touchstart timer (the old approach) can't do that:
   it has no way to know a real swipe is happening until it's too late,
   so it would pop the context menu open mid-swipe.
═══════════════════════════════════════════════════════════════════════════ */
const DM_SWIPE_TRIGGER_PX = 56; // drag distance (right) that counts as "reply"
const DM_SWIPE_MAX_PX     = 74; // visual cap — bubble stops following the finger past this
let _dmHoldTimer = null;
let _dmSwipe = null; // { el, col, startX, startY, moved, armed }

function dmTouchStart(e, el) {
  const t = e.touches[0];
  _dmSwipe = { el, col: el.querySelector('.dm-col'), startX: t.clientX, startY: t.clientY, moved: false, armed: false };
  el.classList.add('dm-bubble-pressing'); // subtle scale-down while held — see .dm-bubble-pressing in style.css for why this exists instead of the menu just snapping into view with no feedback at all
  _dmHoldTimer = setTimeout(() => {
    if (!_dmSwipe || _dmSwipe.moved) return; // a real swipe took over — don't also open the menu
    el.classList.remove('dm-bubble-pressing');
    if (navigator.vibrate) navigator.vibrate(10);
    dmCtxMenu(e, el);
  }, 500);
}

function dmTouchMove(e, el) {
  if (!_dmSwipe) return;
  const t = e.touches[0];
  const dx = t.clientX - _dmSwipe.startX;
  const dy = t.clientY - _dmSwipe.startY;

  if (!_dmSwipe.moved) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return; // still deciding — could just be a tap
    _dmSwipe.moved = true;
    clearTimeout(_dmHoldTimer);
    el.classList.remove('dm-bubble-pressing');
  }

  // Only a rightward, mostly-horizontal drag counts as swipe-to-reply —
  // anything more vertical is the person scrolling the thread, which
  // must keep working normally (not get eaten by this handler).
  if (Math.abs(dx) <= Math.abs(dy) || dx <= 0) return;
  e.preventDefault(); // we're taking over this gesture from page scroll now
  const drag = Math.min(dx, DM_SWIPE_MAX_PX);
  if (_dmSwipe.col) { _dmSwipe.col.style.transition = 'none'; _dmSwipe.col.style.transform = `translateX(${drag}px)`; }
  const icon = el.querySelector('.dm-swipe-reply-icon');
  if (icon) icon.style.opacity = Math.min(drag / DM_SWIPE_TRIGGER_PX, 1);

  const nowArmed = drag >= DM_SWIPE_TRIGGER_PX;
  if (nowArmed !== _dmSwipe.armed) {
    _dmSwipe.armed = nowArmed;
    if (nowArmed && navigator.vibrate) navigator.vibrate(8); // crossing the trigger threshold gets its own tick, same as iOS/WhatsApp's swipe-to-reply
    if (icon) icon.classList.toggle('armed', nowArmed);
  }
}

function dmTouchEnd(e, el) {
  clearTimeout(_dmHoldTimer);
  el.classList.remove('dm-bubble-pressing');
  if (!_dmSwipe) return;
  const { col, armed, moved } = _dmSwipe;
  if (col) { col.style.transition = 'transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)'; col.style.transform = ''; }
  const icon = el.querySelector('.dm-swipe-reply-icon');
  if (icon) { icon.style.opacity = ''; icon.classList.remove('armed'); }
  if (moved && armed) {
    const mid = el.dataset.mid, cid = el.dataset.cid;
    if (mid && cid) dmReply(cid, mid);
  }
  _dmSwipe = null;
}

function dmCtxMenu(e, el) {
  e.preventDefault(); e.stopPropagation();
  document.querySelectorAll('.dm-ctx').forEach(m => m.remove());
  el.classList.add('dm-bubble-selected');
  const mid = el.dataset.mid, cid = el.dataset.cid, isMe = el.dataset.me === '1';
  if (!mid || !cid) { el.classList.remove('dm-bubble-selected'); return; }

  const menu = document.createElement('div');
  menu.className = 'dm-ctx';
  menu.innerHTML = `
    <div class="dm-ctx-reacts">
      ${_REACTIONS.map(r => `<span class="dm-ctx-react" onclick="dmReact('${cid}','${mid}','${r}')">${r}</span>`).join('')}
    </div>
    <div class="dm-ctx-item" onclick="dmReply('${cid}','${mid}')">↩ Reply</div>
    <div class="dm-ctx-item" onclick="dmStar('${cid}','${mid}')">⭐ Star</div>
    <div class="dm-ctx-item" onclick="dmCopy('${mid}')">📋 Copy</div>
    ${isMe ? `<div class="dm-ctx-item danger" onclick="dmDelete('${cid}','${mid}')">🗑 Delete</div>` : ''}`;

  // Position within the ACTUAL visible area, not window.innerHeight/innerWidth.
  // Those reflect the full layout viewport, which on iOS Safari does NOT
  // shrink when the keyboard opens — the keyboard just overlays part of
  // it. A position:fixed element placed using innerHeight can end up
  // computed as "on screen" while actually sitting behind the keyboard,
  // which is exactly why this menu appeared to vanish until the keyboard
  // closed. window.visualViewport tracks the real visible region and
  // shrinks correctly when the keyboard is up.
  const vv = window.visualViewport;
  const vpW = vv ? vv.width  : window.innerWidth;
  const vpH = vv ? vv.height : window.innerHeight;
  const vpL = vv ? vv.offsetLeft : 0;
  const vpT = vv ? vv.offsetTop  : 0;

  const rect = el.getBoundingClientRect();
  const menuH = 216; // approx: reactions row + 4 items — good enough for clamping, doesn't need to be exact
  let top = rect.bottom + 4;
  const maxTop = vpT + vpH - menuH - 8;
  if (top > maxTop) top = Math.max(vpT + 8, rect.top - menuH - 4); // no room below — flip above the bubble instead
  top = Math.min(Math.max(top, vpT + 8), maxTop);

  const fromRight = rect.left > vpL + vpW / 2;
  const rightPos = vpL + vpW - rect.right;
  const leftPos  = Math.max(vpL + 8, rect.left);
  menu.style.cssText = `position:fixed;top:${top}px;${fromRight ? 'right:'+rightPos+'px' : 'left:'+leftPos+'px'};z-index:9999`;
  document.body.appendChild(menu);
  const cleanup = () => { menu.remove(); el.classList.remove('dm-bubble-selected'); document.removeEventListener('click', h); };
  const h = () => cleanup();
  setTimeout(() => document.addEventListener('click', h, { once: true }), 50);
}

/* ═══════════════════════════════════════════════════════════════════════════
   ATTACH MENU — small-screen "+" toggle (see .dm-attach-toggle in
   style.css). Same pop-in animation and dismiss-on-outside-click pattern
   as dmCtxMenu above, just anchored to the toggle button instead of a
   message bubble.
═══════════════════════════════════════════════════════════════════════════ */
function toggleAttachMenu(e) {
  e.preventDefault(); e.stopPropagation();
  const existing = document.querySelector('.dm-attach-menu');
  if (existing) { existing.remove(); return; } // tap again to close

  const btn = $('dmAttachToggle'); if (!btn) return;
  const menu = document.createElement('div');
  menu.className = 'dm-attach-menu';
  menu.innerHTML = `
    <div class="dm-attach-menu-item" id="dmAttachPhoto">🖼️ Photo</div>
    <div class="dm-attach-menu-item" id="dmAttachFile">📎 File</div>`;

  const vv = window.visualViewport;
  const rect = btn.getBoundingClientRect();
  const rightEdge = vv ? vv.offsetLeft + vv.width : window.innerWidth;
  const rightPos = Math.max(8, rightEdge - rect.right);
  menu.style.cssText = `position:fixed;bottom:${window.innerHeight - rect.top + 8}px;right:${rightPos}px;z-index:9999`;
  document.body.appendChild(menu);

  $('dmAttachPhoto').onclick = () => { menu.remove(); $('dmImgInput')?.click(); };
  $('dmAttachFile').onclick  = () => { menu.remove(); $('dmFileInput')?.click(); };
  setTimeout(() => document.addEventListener('click', function h(){ menu.remove(); document.removeEventListener('click',h); }, { once:true }), 50);
}

/* ═══════════════════════════════════════════════════════════════════════════
   MESSAGE ACTIONS
═══════════════════════════════════════════════════════════════════════════ */
async function dmReact(cid, mid, emoji) {
  document.querySelectorAll('.dm-ctx').forEach(m => m.remove());
  if (!currentUser) return;
  const path = 'dms/' + cid + '/' + mid + '/reactions/' + currentUser.uid;
  try {
    const s = await window.XF.get(path);
    if (s.exists() && s.val() === emoji) await window.XF.remove(path);
    else await window.XF.set(path, emoji);
  } catch(e) {}
}

async function dmReply(cid, mid) {
  document.querySelectorAll('.dm-ctx').forEach(m => m.remove());
  const m = _dmMsgCache.get(mid); if (!m) return;
  _dmReplyMsg = {
    id: mid, text: m.text || '', imageUrl: m.imageUrl || '', imageUrls: m.imageUrls || null,
    fileName: m.fileName || '',
    senderName: m.senderUid === currentUser.uid ? 'You' : (_dmPartner?.displayName || 'Member')
  };
  const bar = $('dmReplyBar');
  if (bar) {
    bar.style.display = 'flex';
    const prev = bar.querySelector('.dm-reply-preview');
    const previewText = (_dmReplyMsg.imageUrl || _dmReplyMsg.imageUrls) ? 'Photo' : _dmReplyMsg.fileName ? ('📎 ' + escapeHTML(_dmReplyMsg.fileName)) : escapeHTML(_dmReplyMsg.text.slice(0,60));
    if (prev) prev.innerHTML = `<strong>${escapeHTML(_dmReplyMsg.senderName)}</strong><br><span>${previewText}</span>`;
  }
  $('dmInput')?.focus();
}

function cancelReply() {
  _dmReplyMsg = null;
  const bar = $('dmReplyBar'); if (bar) bar.style.display = 'none';
}

async function dmStar(cid, mid) {
  document.querySelectorAll('.dm-ctx').forEach(m => m.remove());
  const path = 'dms/' + cid + '/' + mid + '/starred/' + currentUser.uid;
  try {
    const s = await window.XF.get(path);
    if (s.exists()) { await window.XF.remove(path); showToast('Star removed'); }
    else            { await window.XF.set(path, true); showToast('⭐ Starred'); }
  } catch(e) {}
}

function dmCopy(mid) {
  document.querySelectorAll('.dm-ctx').forEach(m => m.remove());
  const m = _dmMsgCache.get(mid);
  if (m?.text) navigator.clipboard?.writeText(m.text).then(() => showToast('Copied!')).catch(()=>{});
}

async function dmDelete(cid, mid) {
  document.querySelectorAll('.dm-ctx').forEach(m => m.remove());
  try { await window.XF.remove('dms/' + cid + '/' + mid); }
  catch(e) { showToast('Could not delete'); }
}

function dmScrollTo(mid) {
  const el = document.getElementById('dmm-' + mid);
  if (el) {
    el.scrollIntoView({ behavior:'smooth', block:'center' });
    el.classList.add('dm-highlight');
    setTimeout(() => el.classList.remove('dm-highlight'), 1500);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   EMOJI PICKER
═══════════════════════════════════════════════════════════════════════════ */
function dmToggleEmoji() {
  const p = $('dmEmojiPicker'); if (!p) return;
  _dmEmojiOpen = !_dmEmojiOpen;
  p.style.display = _dmEmojiOpen ? 'flex' : 'none';
}
function insertEmoji(emoji) {
  const input = $('dmInput'); if (!input) return;
  const pos = input.selectionStart ?? input.value.length;
  input.value = input.value.slice(0, pos) + emoji + input.value.slice(pos);
  input.selectionStart = input.selectionEnd = pos + emoji.length;
  input.focus(); dmUpdateSendBtn();
  const p = $('dmEmojiPicker'); if (p) { p.style.display='none'; _dmEmojiOpen=false; }
}
function dmUpdateSendBtn() {
  const btn = document.querySelector('#dmFullpage .dm-send-btn'); if (!btn) return;
  const hasText = ($('dmInput')?.value?.trim()?.length || 0) > 0;
  const hasImages = _dmPendingImages.length > 0;
  btn.style.opacity = (hasText || hasImages) ? '1' : '0.5';
}

/* ═══════════════════════════════════════════════════════════════════════════
   TYPING INDICATOR
═══════════════════════════════════════════════════════════════════════════ */
function dmTyping(uid) {
  if (!currentUser || !uid) return;
  const cid = [currentUser.uid, uid].sort().join('_');
  window.XF.db.ref('typing/' + cid + '/' + currentUser.uid).set(true).catch(()=>{});
  clearTimeout(_dmTypingTimer);
  _dmTypingTimer = setTimeout(() => {
    window.XF.db.ref('typing/' + cid + '/' + currentUser.uid).set(false).catch(()=>{});
  }, 2500);
}

/* ═══════════════════════════════════════════════════════════════════════════
   MARK READ
═══════════════════════════════════════════════════════════════════════════ */
async function _markRead(convId) {
  if (!currentUser) return;
  try {
    const updates = {};
    _dmMsgCache.forEach((m, key) => {
      if (m.senderUid !== currentUser.uid && (!m.readBy || !m.readBy[currentUser.uid]))
        updates['dms/' + convId + '/' + key + '/readBy/' + currentUser.uid] = true;
    });
    if (Object.keys(updates).length) await window.XF.multiUpdate(updates);
    // Zero the maintained counter notifications.js's conv list reads —
    // separate from the per-message readBy fan-out above, which still
    // matters for the "seen" indicator inside an open chat.
    await window.XF.set('conversations/' + convId + '/unread/' + currentUser.uid, 0);
    refreshMsgBadge();
  } catch(e) {}
}

/* Mark all messages in a conv as delivered to me (used when opening a chat) */
async function _markDelivered(convId) {
  if (!currentUser) return;
  try {
    const updates = {};
    _dmMsgCache.forEach((m, key) => {
      if (m.senderUid !== currentUser.uid && (!m.deliveredTo || !m.deliveredTo[currentUser.uid]))
        updates['dms/' + convId + '/' + key + '/deliveredTo/' + currentUser.uid] = true;
    });
    if (Object.keys(updates).length) await window.XF.multiUpdate(updates);
  } catch(e) {}
}

/* ═══════════════════════════════════════════════════════════════════════════
   SEND — dispatches to text-only or images(+optional caption), whichever
   the composer currently holds. This is what the send button and Enter key
   both call now.
═══════════════════════════════════════════════════════════════════════════ */
async function dmSend(uid) {
  if (_dmPendingImages.length > 0) return dmSendPendingImages(uid);
  return dmSendText(uid);
}

async function dmSendText(uid) {
  uid = uid || activeConvUid;
  if (!uid || !currentUser) return;
  const input = $('dmInput');
  const text  = input?.value?.trim();
  if (!text) return;

  input.value = '';
  dmUpdateSendBtn();

  const cid = [currentUser.uid, uid].sort().join('_');
  window.XF.db.ref('typing/' + cid + '/' + currentUser.uid).set(false).catch(()=>{});
  clearTimeout(_dmTypingTimer);

  const msg = {
    senderUid: currentUser.uid,
    text,
    createdAt: Date.now(),
    readBy: { [currentUser.uid]: true }
  };
  if (_dmReplyMsg) { msg.replyTo = { ..._dmReplyMsg }; cancelReply(); }

  try {
    const firstUrl = detectFirstUrl(text);
    const cached = window._composerPreviews['dmLinkPreview'];
    if (firstUrl && cached && cached.url === firstUrl) msg.linkPreview = cached;
    removeComposerPreview('dmLinkPreview');

    const ref = await window.XF.push('dms/' + cid, msg);
    _dmNotifyRecipient(uid, text);
    // If the preview hadn't finished fetching yet (e.g. sent right after
    // pasting, before the debounce fired), patch it in once it's ready.
    if (firstUrl && !msg.linkPreview && ref?.key) {
      fetchLinkPreview(firstUrl).then(preview => {
        if (preview) window.XF.update('dms/' + cid + '/' + ref.key, { linkPreview: preview }).catch(() => {});
      });
    }
  } catch (err) {
    input.value = text;
    dmUpdateSendBtn();
    showToast('Failed to send');
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   IMAGES — select multiple, preview as a thumbnail strip with per-image
   remove, then send them all as ONE message (imageUrls array) with an
   optional caption pulled from the text input, matching how a gallery
   message renders as a single grouped bubble.
═══════════════════════════════════════════════════════════════════════════ */
let _dmPendingImages = []; // File[]

function previewDmImages(input) {
  if (!input?.files?.length) return;
  _dmPendingImages = _dmPendingImages.concat(Array.from(input.files));
  input.value = ''; // allow re-selecting the same file, and lets the user add more in a second pick
  _renderDmImagePreview();
  dmUpdateSendBtn();
}

function removeDmPendingImage(index) {
  _dmPendingImages.splice(index, 1);
  _renderDmImagePreview();
  dmUpdateSendBtn();
}

function _renderDmImagePreview() {
  const el = $('dmImgPreview'); if (!el) return;
  if (_dmPendingImages.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="dm-img-preview-strip">' + _dmPendingImages.map((file, i) => {
    const url = URL.createObjectURL(file);
    return `<div class="dm-img-preview-thumb"><img src="${url}"><div class="img-preview-remove" onclick="removeDmPendingImage(${i})">✕</div></div>`;
  }).join('') + '</div>';
}

async function dmSendPendingImages(uid) {
  uid = uid || activeConvUid;
  if (!uid || !currentUser || _dmPendingImages.length === 0) return;
  const files = _dmPendingImages;
  _dmPendingImages = [];
  _renderDmImagePreview();
  const input = $('dmInput');
  const caption = input?.value?.trim() || '';
  if (input) { input.value = ''; dmUpdateSendBtn(); }

  showToast(files.length > 1 ? `Uploading ${files.length} photos…` : 'Uploading…');
  try {
    const uploads = await Promise.all(files.map(f => window.XCloud.upload(f, 'dm_images')));
    const cid = [currentUser.uid, uid].sort().join('_');
    const msg = {
      senderUid: currentUser.uid,
      imageUrls: uploads.map(r => r.url),
      text: caption,
      createdAt: Date.now(),
      readBy: { [currentUser.uid]: true }
    };
    if (_dmReplyMsg) { msg.replyTo = { ..._dmReplyMsg }; cancelReply(); }
    await window.XF.push('dms/' + cid, msg);
    _dmNotifyRecipient(uid, files.length > 1 ? `${files.length} photos` : 'Photo');
  } catch (e) { showToast('Image upload failed'); }
}

/* ═══════════════════════════════════════════════════════════════════════════
   FILES — any file type, one at a time (unlike images there's no gallery
   grouping), uploaded to Firebase Storage rather than Cloudinary (see
   firebase.js's uploadFile header for why: separate free quota, no
   compression needed to keep it under budget). Capped client-side at
   10MB — Storage's free tier is generous (5GB) but uncompressed files
   burn through it far faster than the aggressively-compressed images
   cloudinary.js produces, so this cap exists to keep it comfortably free
   rather than because of any hard platform limit.
═══════════════════════════════════════════════════════════════════════════ */
const DM_FILE_MAX_BYTES = 10 * 1024 * 1024; // 10MB

function pickDmFile(input) {
  if (!input?.files?.length) return;
  const file = input.files[0];
  input.value = ''; // allow re-selecting the same file
  if (file.size > DM_FILE_MAX_BYTES) {
    showToast('File too large — 10MB max');
    return;
  }
  dmSendFile(file);
}

function _formatFileSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}

async function dmSendFile(file, uid) {
  uid = uid || activeConvUid;
  if (!uid || !currentUser || !file) return;

  // Persistent (not auto-dismissing) toast with live progress, plus a
  // hard timeout — the earlier version showed a plain 3-second toast
  // that vanished on its own regardless of whether the upload was still
  // going, stuck, or had failed silently, which is exactly why it looked
  // like "says Uploading, then nothing happens" even when something WAS
  // actually going wrong underneath. Now failure and success both end
  // with a clear, explicit message that replaces the progress toast.
  const toast = showToast('Uploading 0%…', { persistent: true });
  const UPLOAD_TIMEOUT_MS = 30000;

  try {
    const upload = await Promise.race([
      window.XF.uploadFile(file, pct => { if (toast) toast.update(`Uploading ${pct}%…`); }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('Timed out — check your connection, and that Firebase Storage is set up (see storage.rules)')),
        UPLOAD_TIMEOUT_MS
      ))
    ]);
    const cid = [currentUser.uid, uid].sort().join('_');
    const msg = {
      senderUid: currentUser.uid,
      fileUrl: upload.url,
      fileName: upload.name,
      fileSize: upload.size,
      fileType: upload.type,
      text: '',
      createdAt: Date.now(),
      readBy: { [currentUser.uid]: true }
    };
    if (_dmReplyMsg) { msg.replyTo = { ..._dmReplyMsg }; cancelReply(); }
    await window.XF.push('dms/' + cid, msg);
    _dmNotifyRecipient(uid, `📎 ${upload.name}`);
    if (toast) toast.dismiss();
  } catch (e) {
    console.error('[dmSendFile] upload failed:', e);
    if (toast) toast.dismiss();
    showToast('File upload failed — ' + (e?.message || 'try again'), { duration: 5000 });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   NOTIFY RECIPIENT
═══════════════════════════════════════════════════════════════════════════ */
async function _dmNotifyRecipient(toUid, preview) {
  const cid = [currentUser.uid, toUid].sort().join('_');
  try {
    // Maintains the conv-list summary (unread badge + last-message
    // preview) that notifications.js's _watchConv now reads instead of
    // scanning full message history — see that file's header comment
    // for why. increment() is atomic, so two people messaging each
    // other in quick succession can't race and drop a count.
    await window.XF.update('conversations/' + cid, {
      lastMessage: { text: (preview || '').slice(0, 80), senderUid: currentUser.uid, createdAt: Date.now() }
    });
    await window.XF.increment('conversations/' + cid + '/unread/' + toUid, 1);
  } catch (e) {}

  try {
    await window.XF.push('notifications/' + toUid, {
      type: 'new_message',
      fromUid: currentUser.uid,
      fromName: currentProfile?.displayName || 'Member',
      preview: (preview || '').slice(0, 40),
      createdAt: Date.now(),
      read: false
    });
  } catch(e) {}

  // Real OS-level push, so the recipient knows even if the site/app isn't
  // open at all. Fire-and-forget — a failed push should never block or
  // surface an error for the message itself, which already sent fine.
  if (typeof sendPushNow === 'function') {
    sendPushNow(
      toUid,
      currentProfile?.displayName || 'New message',
      (preview || '').slice(0, 100),
      '/messages?uid=' + currentUser.uid
    );
  }
}
