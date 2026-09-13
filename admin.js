// admin.js — X Club v7
'use strict';

/* ══════════════════════════════════════════════
   ADMIN TABS
══════════════════════════════════════════════ */
function switchAdminTab(tab, el) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active')); el.classList.add('active');
  $('adminTabUsers').style.display    = tab === 'users'    ? 'block' : 'none';
  $('adminTabFeed').style.display     = tab === 'feed'     ? 'block' : 'none';
  $('adminTabPosts').style.display    = tab === 'posts'    ? 'block' : 'none';
  $('adminTabStats').style.display    = tab === 'stats'    ? 'block' : 'none';
  $('adminTabSettings').style.display = tab === 'settings' ? 'block' : 'none';
  if (tab === 'stats')    { loadAdminStats(); loadScheduledPostsAdmin(); }
  if (tab === 'posts')    { adminLoadPosts(); }
  if (tab === 'feed')     { adminLoadFeed(); }
  if (tab === 'settings') { loadAdminSettings(); }
}

/* ══════════════════════════════════════════════
   USER MANAGEMENT
══════════════════════════════════════════════ */
async function loadAdminUsers() {
  const container = $('adminUserList'); if (!container) return;
  container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
  try {
    const snap = await window.XF.get('users'); allUsersCache = [];
    if (snap.exists()) snap.forEach(c => { const v = c.val(); if (v && typeof v === 'object') allUsersCache.push({ id: c.key, uid: v.uid || c.key, ...v }); });
    allUsersCache.sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0));

    // Count total unread messages across all conversations for each user
    const unreadMap = {};
    try {
      const dmsSnap = await window.XF.get('dms');
      if (dmsSnap.exists()) {
        dmsSnap.forEach(conv => {
          const convKey = conv.key; // e.g. "uid1_uid2"
          const parts = convKey.split('_');
          parts.forEach(uid => {
            if (!allUsersCache.find(u => u.uid === uid)) return;
            let count = 0;
            conv.forEach(msg => {
              const m = msg.val();
              if (m && m.senderUid !== uid && (!m.readBy || !m.readBy[uid])) count++;
            });
            if (count > 0) unreadMap[uid] = (unreadMap[uid] || 0) + count;
          });
        });
      }
    } catch (e) {}

    renderAdminUsers(allUsersCache, unreadMap);
    const ce = $('adminUserCount'); if (ce) ce.textContent = allUsersCache.length + ' members';
  } catch (err) { container.innerHTML = '<div class="empty-state"><div class="empty-state-desc">Could not load users</div></div>'; }
}

function renderAdminUsers(users, unreadMap = {}) {
  const container = $('adminUserList'); if (!container) return;
  if (users.length === 0) { container.innerHTML = '<div class="empty-state"><div class="empty-state-desc">No users found</div></div>'; return; }
  container.innerHTML = users.map(u => {
    const unread = unreadMap[u.uid] || 0;
    const unreadBadge = unread > 0
      ? `<span class="admin-unread-badge" title="${unread} unread message${unread > 1 ? 's' : ''}">✉ ${unread > 99 ? '99+' : unread}</span>`
      : '';
    return `
    <div class="admin-user-card" id="adminCard-${u.uid}">
      ${avatarHTML(u, 'md')}
      <div class="admin-user-info">
        <div class="admin-user-name">
          ${escapeHTML(u.displayName || 'Member')}
          ${u.verified ? '<span class="admin-badge-verified">✓ Verified</span>' : '<span class="admin-badge-unverified">Unverified</span>'}
          ${unreadBadge}
        </div>
        <div class="admin-user-meta">@${escapeHTML(u.handle || '?')} · ${escapeHTML(u.email || '')} · ${formatCount(u.followersCount || 0)} followers</div>
      </div>
      <div class="admin-user-actions">
        <div class="admin-action-group">
          <label class="admin-action-label">Followers</label>
          <div class="admin-action-row">
            <input class="admin-followers-input" id="flwInput-${u.uid}" type="number" value="${u.followersCount || 0}" min="0" placeholder="0">
            <button class="btn btn-accent btn-sm" onclick="adminSetFollowers('${u.uid}')">Set</button>
          </div>
        </div>
        <div class="admin-action-group">
          <label class="admin-action-label">Status</label>
          <div class="admin-action-row">
            ${u.verified
              ? `<button class="btn btn-sm admin-btn-danger" onclick="adminToggleVerify('${u.uid}',false)">Unverify</button>`
              : `<button class="btn btn-sm admin-btn-success" onclick="adminToggleVerify('${u.uid}',true)">Verify</button>`}
            <button class="btn btn-sm btn-danger" onclick="adminDeleteUser('${u.uid}')">Delete</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function adminSearchUsers(query) {
  if (!query) { renderAdminUsers(allUsersCache); return; }
  const q = query.toLowerCase();
  renderAdminUsers(allUsersCache.filter(u => (u.displayName || '').toLowerCase().includes(q) || (u.handle || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q)));
}

async function adminSetFollowers(uid) {
  const input = $('flwInput-' + uid); const val = parseInt(input.value);
  if (isNaN(val) || val < 0) return showToast('Enter a valid number');
  try { await window.XF.update('users/' + uid, { followersCount: val }); const u = allUsersCache.find(x => x.uid === uid); if (u) u.followersCount = val; showToast('Followers updated!'); }
  catch (err) { showToast('Failed to update followers'); }
}

async function adminToggleVerify(uid, verify) {
  try {
    await window.XF.update('users/' + uid, { verified: verify, ...(verify ? { verifiedAt: window.XF.ts() } : { verifiedAt: null }) });
    const u = allUsersCache.find(x => x.uid === uid); if (u) u.verified = verify;
    renderAdminUsers(allUsersCache); showToast(verify ? '✓ User verified!' : 'User unverified');
  } catch (err) { showToast('Failed to update verification'); }
}

async function adminDeleteUser(uid) {
  if (!confirm('Delete this user and all their data? Cannot be undone.')) return;
  try {
    await window.XF.remove('users/' + uid); await window.XF.remove('notifications/' + uid); await window.XF.remove('connections/' + uid);
    allUsersCache = allUsersCache.filter(u => u.uid !== uid); renderAdminUsers(allUsersCache); showToast('User deleted');
  } catch (err) { showToast('Failed to delete user'); }
}

/* ══════════════════════════════════════════════
   SETTINGS TAB — Verification Price + Currency
   Reads/writes to appConfig/membershipPrice and
   appConfig/membershipCurrency in Firebase.
   auth.js reads these dynamically on payment.
══════════════════════════════════════════════ */
async function loadAdminSettings() {
  const container = $('adminSettingsContent'); if (!container) return;
  container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
  try {
    container.innerHTML = `
      <div style="padding:4px 0 20px">

        <div style="margin-bottom:24px">
          <div style="font-weight:700;font-size:0.93rem;margin-bottom:10px">✓ Verification Requests</div>
          <div id="verificationQueueContainer"><div class="loading-center"><div class="spinner"></div></div></div>
        </div>

        <div style="margin-top:28px;padding-top:20px;border-top:1px solid var(--border)">
          <div style="font-weight:700;font-size:0.93rem;margin-bottom:10px">⚙ Platform Keys</div>
          <div style="font-size:0.78rem;color:var(--text-dim);margin-bottom:4px;font-weight:600">AI — Groq Key</div>
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
            <input id="groqKeyInput" class="form-input" type="password" placeholder="Paste gsk_... key" style="flex:1;font-size:0.82rem" onfocus="if(this.value.startsWith('•'))this.value=''">
            <button class="btn btn-accent btn-sm" onclick="saveGroqKey()">Save</button>
          </div>
          <div style="font-size:0.72rem;color:var(--text-dim)">Free key from console.groq.com</div>
        </div>

        <div style="margin-top:20px;padding:14px 16px;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div>
            <div style="font-weight:700;font-size:0.93rem">◈ Claude Engineer</div>
            <div style="font-size:0.78rem;color:var(--text-dim)">Post AI business insight to feed</div>
          </div>
          <button id="cePostBtn" class="btn btn-accent btn-sm" onclick="triggerClaudeEngineerPost()">Post Now</button>
        </div>
      </div>`;

    loadVerificationQueue();

    window.XF.get('config/groqKey').then(s => {
      if (s.exists() && s.val()) { const e = $('groqKeyInput'); if (e) e.value = '••••••••••••••••'; }
    }).catch(() => {});

  } catch (e) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-desc">Could not load settings</div></div>';
  }
}

async function loadVerificationQueue() {
  const container = $('verificationQueueContainer'); if (!container) return;
  try {
    const snap = await window.XF.get('verificationRequests');
    const requests = Object.entries(snap.val() || {})
      .map(([id, r]) => ({ id, ...r }))
      .filter(r => r.status === 'pending');

    if (requests.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-desc">No pending requests</div></div>';
      return;
    }

    container.innerHTML = requests.map(r => `
      <div style="display:flex;gap:12px;padding:14px;border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:10px;align-items:center;flex-wrap:wrap">
        <div style="display:flex;gap:8px">
          <img src="${escapeHTML(r.selfieURL)}" alt="Selfie" style="width:70px;height:70px;object-fit:cover;border-radius:8px;cursor:pointer" onclick="openLightbox('${escapeHTML(r.selfieURL)}')">
          <img src="${escapeHTML(r.idURL)}" alt="ID card" style="width:70px;height:70px;object-fit:cover;border-radius:8px;cursor:pointer" onclick="openLightbox('${escapeHTML(r.idURL)}')">
        </div>
        <div style="flex:1;min-width:140px">
          <div style="font-weight:700;font-size:0.9rem">${escapeHTML(r.displayName || 'Member')}</div>
          <div style="font-size:0.78rem;color:var(--text-dim)">@${escapeHTML(r.handle || '')}</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-accent btn-sm" onclick="reviewVerification('${r.id}', true)">Approve</button>
          <button class="btn btn-outline btn-sm" onclick="reviewVerification('${r.id}', false)">Reject</button>
        </div>
      </div>`).join('');
  } catch (e) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-desc">Could not load requests</div></div>';
  }
}

async function reviewVerification(uid, approve) {
  try {
    if (approve) {
      await window.XF.update('users/' + uid, { verified: true, verifiedAt: window.XF.ts() });
    }
    await window.XF.update('verificationRequests/' + uid, { status: approve ? 'approved' : 'rejected', reviewedAt: window.XF.ts() });
    showToast(approve ? 'Approved!' : 'Rejected');
    loadVerificationQueue();
  } catch (e) {
    showToast('Failed — try again');
  }
}

/* ══════════════════════════════════════════════
   STATS
══════════════════════════════════════════════ */
async function loadAdminStats() {
  try {
    const us = await window.XF.get('users'), ps = await window.XF.get('posts');
    let total = 0, verified = 0, posts = 0;
    if (us.exists()) us.forEach(c => { total++; if (c.val().verified) verified++; });
    if (ps.exists()) ps.forEach(() => posts++);
    $('statTotalUsers').textContent = total; $('statVerified').textContent = verified; $('statPosts').textContent = posts;
  } catch (err) {}
}

/* ══════════════════════════════════════════════
   SCHEDULED POSTS (ADMIN VIEW)
══════════════════════════════════════════════ */
async function loadScheduledPostsAdmin() {
  const statsTab = $('adminTabStats'); if (!statsTab) return;
  if (!$('scheduledPostsList')) {
    const s = document.createElement('div'); s.style.cssText = 'margin-top:20px';
    s.innerHTML = `<div class="admin-section-title" style="margin-bottom:10px">◷ Scheduled Posts Queue</div><div id="scheduledPostsList"></div>`;
    statsTab.appendChild(s);
  }
  const container = $('scheduledPostsList'); if (!container) return;
  container.innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem">Loading…</div>';
  try {
    const snap = await window.XF.get('scheduledPosts'); if (!snap.exists()) { container.innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem">No scheduled posts</div>'; return; }
    const all = Object.entries(snap.val()).filter(([, p]) => p.status === 'scheduled');
    if (!all.length) { container.innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem">No pending scheduled posts</div>'; return; }
    all.sort(([, a], [, b]) => a.fireAt - b.fireAt);
    container.innerHTML = all.map(([key, p]) => `<div style="padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:8px;font-size:0.83rem"><div style="font-weight:600;margin-bottom:4px">@${escapeHTML(p.handle || '?')} · <span style="color:var(--accent)">◷ ${new Date(p.fireAt).toLocaleString()}</span></div><div style="color:var(--text-dim);margin-bottom:6px">${escapeHTML(p.text)}</div><button class="btn btn-outline btn-sm" style="font-size:0.75rem;color:var(--danger)" onclick="cancelScheduled('${key}')">Cancel</button></div>`).join('');
  } catch (e) { container.innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem">Could not load</div>'; }
}

async function cancelScheduled(key) { await window.XF.set('scheduledPosts/' + key + '/status', 'cancelled'); showToast('Scheduled post cancelled'); loadScheduledPostsAdmin(); }

/* ══════════════════════════════════════════════
   ADMIN TOOLS INJECTION (legacy — now in Settings tab)
══════════════════════════════════════════════ */
function injectAdminTools() {
  // countBadge still injected into users tab
  const adminContent = $('adminTabUsers'); if (!adminContent || $('adminUserCount')) return;
  const countBadge = document.createElement('div'); countBadge.id = 'adminUserCount';
  countBadge.style.cssText = 'font-size:0.8rem;color:var(--text-dim);margin-bottom:8px;padding:0 2px';
  const titleEl = adminContent.querySelector('.admin-section-title');
  if (titleEl) titleEl.after(countBadge); else adminContent.prepend(countBadge);
}

async function triggerClaudeEngineerPost() {
  const btn = $('cePostBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }
  await postClaudeEngineerToFeed();
  if (btn) { btn.disabled = false; btn.textContent = 'Post Now'; }
  showToast('[OK] Claude Engineer posted to feed!');
}

async function saveGroqKey() {
  const input = $('groqKeyInput'); if (!input) return;
  const val = input.value.trim();
  if (!val || val.startsWith('•')) { showToast('Paste your Groq key first'); return; }
  if (!val.startsWith('gsk_')) { showToast('Invalid key — Groq keys start with gsk_'); return; }
  try { await window.XF.set('config/groqKey', val); _groqKey = val; input.value = '••••••••••••••••'; showToast('[OK] Groq key saved'); }
  catch (e) { showToast('Failed to save key — check Firebase rules'); }
}

/* ══════════════════════════════════════════════
   ADMIN: EDIT POST LIKES
══════════════════════════════════════════════ */
async function adminLoadPosts() {
  const container = $('adminPostList'); if (!container) return;
  container.innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem">Loading…</div>';
  try {
    const snap = await window.XF.get('posts');
    if (!snap.exists()) { container.innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem">No posts</div>'; return; }
    const posts = []; snap.forEach(c => posts.push({ id: c.key, ...c.val() }));
    posts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    container.innerHTML = posts.slice(0, 30).map(p => {
      const likeCount = p.likes ? Object.keys(p.likes).length : 0;
      return `<div style="padding:10px;border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:8px;font-size:0.83rem">
        <div style="font-weight:600;margin-bottom:4px;color:var(--text-dim)">@${escapeHTML(p.handle || p.authorUid || '?')} · ${timeAgo(p.createdAt)}</div>
        <div style="margin-bottom:8px;color:var(--text)">${escapeHTML((p.text || '').slice(0, 80))}${(p.text || '').length > 80 ? '…' : ''}</div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="color:var(--text-dim);font-size:0.8rem">❤ ${likeCount} likes</span>
          <input id="likeEdit-${p.id}" type="number" value="${likeCount}" min="0" style="width:70px;padding:4px 8px;background:var(--bg-3);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:0.8rem;outline:none">
          <button class="btn btn-accent btn-sm" style="font-size:0.75rem;padding:4px 10px" onclick="adminSetLikes('${p.id}')">Set Likes</button>
          <button class="btn btn-sm admin-btn-danger" style="font-size:0.75rem;padding:4px 10px;margin-left:auto" onclick="adminDeletePost('${p.id}',this)">Delete Post</button>
        </div>
      </div>`;
    }).join('');
  } catch (e) { container.innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem">Could not load posts</div>'; }
}

async function adminDeletePost(postId, btn) {
  if (!confirm('Delete this post? This cannot be undone.')) return;
  try {
    btn.disabled = true; btn.textContent = 'Deleting…';
    await window.XF.remove('posts/' + postId);
    await window.XF.remove('comments/' + postId);
    showToast('Post deleted');
    adminLoadPosts();
  } catch (e) { showToast('Failed to delete post'); btn.disabled = false; btn.textContent = 'Delete Post'; }
}

async function adminSetLikes(postId) {
  const input = $('likeEdit-' + postId); if (!input) return;
  const newCount = parseInt(input.value); if (isNaN(newCount) || newCount < 0) return showToast('Enter a valid number');
  try {
    const snap = await window.XF.get('posts/' + postId + '/likes');
    const existing = snap.exists() ? snap.val() : {};
    const existingKeys = Object.keys(existing);
    const fakeBase = '_fake_like_';
    const updates = {};
    existingKeys.filter(k => k.startsWith(fakeBase)).forEach(k => updates['posts/' + postId + '/likes/' + k] = null);
    const realCount = existingKeys.filter(k => !k.startsWith(fakeBase)).length;
    const toAdd = Math.max(0, newCount - realCount);
    for (let i = 0; i < toAdd; i++) updates['posts/' + postId + '/likes/' + fakeBase + i] = true;
    await window.XF.multiUpdate(updates);
    showToast('Likes updated to ' + newCount); adminLoadPosts();
  } catch (e) { showToast('Failed to update likes'); }
}

/* ══════════════════════════════════════════════
   ADMIN: ALL USERS FEED (see posts like a regular user)
   Admin can delete any post and adjust likes +/-
══════════════════════════════════════════════ */
let _adminFeedPosts = [];

async function adminLoadFeed() {
  const container = $('adminFeedList'); if (!container) return;
  container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
  try {
    const snap = await window.XF.get('posts');
    if (!snap.exists()) { container.innerHTML = '<div class="empty-state"><div class="empty-state-desc">No posts yet</div></div>'; return; }
    _adminFeedPosts = [];
    snap.forEach(c => _adminFeedPosts.push({ id: c.key, ...c.val() }));
    _adminFeedPosts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    // Load author profiles
    const uids = [...new Set(_adminFeedPosts.map(p => p.authorUid).filter(u => u && u !== CLAUDE_ENGINEER_UID))];
    const profiles = {};
    await Promise.allSettled(uids.map(async uid => {
      try { const s = await window.XF.get('users/' + uid); if (s.exists()) profiles[uid] = s.val(); } catch (e) {}
    }));

    renderAdminFeed(_adminFeedPosts, profiles);
  } catch (e) { container.innerHTML = '<div class="empty-state"><div class="empty-state-desc">Could not load posts</div></div>'; }
}

function renderAdminFeed(posts, profiles) {
  const container = $('adminFeedList'); if (!container) return;
  if (!posts.length) { container.innerHTML = '<div class="empty-state"><div class="empty-state-desc">No posts</div></div>'; return; }
  container.innerHTML = posts.slice(0, 50).map(p => {
    const author = p.authorUid === CLAUDE_ENGINEER_UID
      ? { displayName: 'Claude Engineer', handle: 'claudeengineer', verified: true }
      : (profiles[p.authorUid] || { displayName: 'Unknown', handle: '?' });
    const likeCount = p.likes ? Object.keys(p.likes).length : 0;
    const commentCount = p.commentCount || 0;
    const mediaHTML = p.imageURL ? `<img src="${p.imageURL}" style="width:100%;border-radius:var(--radius-sm);margin-top:10px;max-height:360px;object-fit:cover" loading="lazy">` : '';
    return `
    <div class="admin-feed-post" id="adminFeedPost-${p.id}">
      <div class="admin-feed-post-header">
        ${avatarHTML(author, 'md')}
        <div class="admin-feed-post-author">
          <span class="admin-feed-post-name">${escapeHTML(author.displayName || 'Member')}${author.verified ? verifiedBadge(true) : ''}</span>
          <span class="admin-feed-post-meta">@${escapeHTML(author.handle || '?')} · ${timeAgo(p.createdAt)}</span>
        </div>
        <button class="admin-feed-delete-btn" onclick="adminFeedDeletePost('${p.id}')" title="Delete post">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          Delete
        </button>
      </div>
      <div class="admin-feed-post-text">${escapeHTML(p.text || '')}</div>
      ${mediaHTML}
      <div class="admin-feed-post-actions">
        <span class="admin-feed-like-count" id="adminLikeCount-${p.id}">❤ ${formatCount(likeCount)}</span>
        <button class="admin-feed-like-btn" onclick="adminFeedAdjustLikes('${p.id}', 1)" title="Increase likes">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          +1 Like
        </button>
        <button class="admin-feed-like-btn admin-feed-like-btn--minus" onclick="adminFeedAdjustLikes('${p.id}', -1)" title="Decrease likes" ${likeCount === 0 ? 'disabled' : ''}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
          −1 Like
        </button>
        <span style="color:var(--text-dim);font-size:0.8rem;margin-left:auto">💬 ${commentCount}</span>
      </div>
    </div>`;
  }).join('');
}

async function adminFeedDeletePost(postId) {
  if (!confirm('Delete this post permanently?')) return;
  try {
    await window.XF.remove('posts/' + postId);
    await window.XF.remove('comments/' + postId);
    const el = $('adminFeedPost-' + postId);
    if (el) { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }
    showToast('Post deleted');
  } catch (e) { showToast('Failed to delete post'); }
}

async function adminFeedAdjustLikes(postId, delta) {
  try {
    const snap = await window.XF.get('posts/' + postId + '/likes');
    const existing = snap.exists() ? snap.val() : {};
    const fakeBase = '_fake_like_';
    const realKeys = Object.keys(existing).filter(k => !k.startsWith(fakeBase));
    const fakeKeys = Object.keys(existing).filter(k => k.startsWith(fakeBase));
    const currentCount = Object.keys(existing).length;
    const newCount = Math.max(0, currentCount + delta);
    const updates = {};

    if (delta > 0) {
      // Add a fake like
      const newIdx = fakeKeys.length;
      updates['posts/' + postId + '/likes/' + fakeBase + newIdx] = true;
    } else if (delta < 0 && currentCount > 0) {
      // Remove a fake like if any, else remove nothing (never remove real likes)
      if (fakeKeys.length > 0) {
        updates['posts/' + postId + '/likes/' + fakeKeys[fakeKeys.length - 1]] = null;
      } else if (realKeys.length > 0) {
        // Optional: allow removing a real like if no fakes left
        updates['posts/' + postId + '/likes/' + realKeys[realKeys.length - 1]] = null;
      }
    }

    if (Object.keys(updates).length === 0) return;
    await window.XF.multiUpdate(updates);

    // Update UI
    const countEl = $('adminLikeCount-' + postId);
    if (countEl) countEl.textContent = '❤ ' + formatCount(newCount);
    // Update minus button disabled state
    const minusBtn = countEl?.closest('.admin-feed-post-actions')?.querySelector('.admin-feed-like-btn--minus');
    if (minusBtn) minusBtn.disabled = newCount === 0;
  } catch (e) { showToast('Failed to update likes'); }
}
