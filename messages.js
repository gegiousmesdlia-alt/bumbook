// messages.js — X Club v7
'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   THE APPROACH — same as every real messenger (WhatsApp, Telegram, iMessage)
   ─────────────────────────────────────────────────────────────────────────
   Conv list + badge live in notifications.js (_convCache, _rebuildConvUI).
   This file owns only the open DM chat view:

   _dmMsgCache  — Map(msgId → msgObj) for the active conversation only.
                  Populated by child_added (last 100) + child_changed + child_removed.
                  Never re-fetched. Firebase pushes diffs.
   _dmDoRender  — reads _dmMsgCache, sorts, builds HTML. Sync. No awaits.
                  Debounced to 16ms so rapid child_added bursts = 1 paint.
═══════════════════════════════════════════════════════════════════════════ */

let _dmPartner    = null;
let _dmTypingOff  = null;
let _dmPresenceOff = null;
let _dmTypingTimer = null;

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
  const dmPath   = 'dms/' + convId;
  const typPath  = 'typing/' + convId + '/' + uid;
  const presPath = 'presence/' + uid;

  _dmPartnerPresence = null;
  _dmPartnerTyping   = false;

  // Merged live listener: combines old RTDB messages + new Firestore
  // messages into one snapshot each time either source changes, then we
  // rebuild the cache wholesale (simpler and just as fast as incremental
  // child events for a conversation-sized message list).
  const dmUnsub = window.XF.on(dmPath, snap => {
    const data = snap.val() || {};
    _dmMsgCache.clear();
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
  msgEl.innerHTML = _buildMsgsHTML(msgs, uid, convId);
  if (wasAtBottom) msgEl.scrollTop = msgEl.scrollHeight;

  setTimeout(() => { if (activeConvUid === uid) _markRead(convId); }, 800);
  setTimeout(() => { if (activeConvUid === uid) _markDelivered(convId); }, 100);
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
        <div class="dm-reply-text">${(m.replyTo.imageUrl || m.replyTo.imageUrls) ? 'Photo' : escapeHTML((m.replyTo.text||'').slice(0,50))}</div>
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
      ontouchstart="dmHoldStart(event,this)" ontouchend="dmHoldEnd()" ontouchmove="dmHoldEnd()">
      ${!isMe ? `<div class="dm-avatar">${avatarHTML(_dmPartner,'sm')}</div>` : ''}
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
   CONTEXT MENU
═══════════════════════════════════════════════════════════════════════════ */
let _dmHoldTimer = null;
function dmHoldStart(e, el) { _dmHoldTimer = setTimeout(() => dmCtxMenu(e, el), 500); }
function dmHoldEnd()        { clearTimeout(_dmHoldTimer); }

function dmCtxMenu(e, el) {
  e.preventDefault(); e.stopPropagation();
  document.querySelectorAll('.dm-ctx').forEach(m => m.remove());
  const mid = el.dataset.mid, cid = el.dataset.cid, isMe = el.dataset.me === '1';
  if (!mid || !cid) return;

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

  const rect = el.getBoundingClientRect();
  const top  = Math.min(rect.bottom + 4, window.innerHeight - 200);
  const fromRight = rect.left > window.innerWidth / 2;
  menu.style.cssText = `position:fixed;top:${top}px;${fromRight ? 'right:'+(window.innerWidth-rect.right)+'px' : 'left:'+Math.max(8,rect.left)+'px'};z-index:9999`;
  document.body.appendChild(menu);
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
    senderName: m.senderUid === currentUser.uid ? 'You' : (_dmPartner?.displayName || 'Member')
  };
  const bar = $('dmReplyBar');
  if (bar) {
    bar.style.display = 'flex';
    const prev = bar.querySelector('.dm-reply-preview');
    if (prev) prev.innerHTML = `<strong>${escapeHTML(_dmReplyMsg.senderName)}</strong><br><span>${(_dmReplyMsg.imageUrl || _dmReplyMsg.imageUrls) ? 'Photo' : escapeHTML(_dmReplyMsg.text.slice(0,60))}</span>`;
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
    if (Object.keys(updates).length) {
      await window.XF.multiUpdate(updates);
      refreshMsgBadge();
    }
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
   NOTIFY RECIPIENT
═══════════════════════════════════════════════════════════════════════════ */
async function _dmNotifyRecipient(toUid, preview) {
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
