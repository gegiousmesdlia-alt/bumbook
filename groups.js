// groups.js — Facebook-style groups: public/private, admin roles, group posts.
'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   MEMBERSHIP — denormalized onto the user's own profile doc (groupIds: [])
   so "which groups am I in" is a single field read, not a collection-group
   query the app's lightweight Firestore wrapper doesn't support. Kept in
   sync every time someone joins/leaves/gets removed.
═══════════════════════════════════════════════════════════════════════════ */
function myGroupIds() {
  return new Set((currentProfile && currentProfile.groupIds) || []);
}

async function _addToMyGroupIds(groupId) {
  if (!currentUser) return;
  currentProfile.groupIds = [...new Set([...(currentProfile.groupIds || []), groupId])];
  // set/merge rather than update: update() throws on a doc that has no
  // groupIds field yet, which is every account created before groups existed.
  await window.XF.fs.collection('users').doc(currentUser.uid)
    .set({ groupIds: firebase.firestore.FieldValue.arrayUnion(groupId) }, { merge: true });
}
async function _removeFromMyGroupIds(groupId) {
  if (!currentUser) return;
  currentProfile.groupIds = (currentProfile.groupIds || []).filter(g => g !== groupId);
  await window.XF.fs.collection('users').doc(currentUser.uid)
    .set({ groupIds: firebase.firestore.FieldValue.arrayRemove(groupId) }, { merge: true });
}

/* ═══════════════════════════════════════════════════════════════════════════
   DISCOVERY PAGE — "My Groups" + browsable public groups, with search and
   the Create Group entry point (verified users only).
═══════════════════════════════════════════════════════════════════════════ */
let _allGroupsCache = [];

async function renderGroupsPage() {
  const container = $('groupsListContainer');
  if (!container) return;
  container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';

  const createBtn = $('createGroupBtn');
  if (createBtn) createBtn.style.display = currentUser ? '' : 'none';

  try {
    const snap = await window.XF.get('groups');
    const groups = [];
    if (snap.exists()) snap.forEach(c => groups.push({ id: c.key, ...c.val() }));
    groups.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    _allGroupsCache = groups;
    _renderGroupsList(groups);
  } catch (e) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-title">Could not load groups</div></div>';
  }
}

function searchGroups(query) {
  const q = (query || '').trim().toLowerCase();
  const filtered = q ? _allGroupsCache.filter(g => (g.name || '').toLowerCase().includes(q)) : _allGroupsCache;
  _renderGroupsList(filtered);
}

function _renderGroupsList(groups) {
  const container = $('groupsListContainer');
  if (!container) return;
  const mine = myGroupIds();
  const myGroups = groups.filter(g => mine.has(g.id));
  const other = groups.filter(g => !mine.has(g.id));

  if (groups.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-title">No groups yet</div><div class="empty-state-desc">Be the first to start one</div></div>';
    return;
  }

  let html = '';
  if (myGroups.length) {
    html += '<div class="sidebar-section-title" style="padding:12px 4px 8px">My Groups</div>';
    html += myGroups.map(_groupCardHTML).join('');
  }
  html += '<div class="sidebar-section-title" style="padding:16px 4px 8px">Discover</div>';
  html += other.length ? other.map(_groupCardHTML).join('')
    : '<div style="padding:12px 4px;color:var(--text-dim);font-size:0.85rem">No other groups to show</div>';
  container.innerHTML = html;
}

function _groupCardHTML(g) {
  const privacyLabel = g.privacy === 'private'
    ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Private'
    : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Public';
  return `<div class="group-card" onclick="openGroup('${g.id}')">
    <div class="group-card-cover" style="${g.coverURL ? `background-image:url('${escapeHTML(g.coverURL)}')` : ''}"></div>
    <div class="group-card-body">
      <div class="group-card-name">${escapeHTML(g.name || 'Untitled group')}</div>
      <div class="group-card-meta">${privacyLabel} · ${formatCount(g.membersCount || 0)} member${(g.membersCount||0) === 1 ? '' : 's'}</div>
    </div>
  </div>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   CREATE GROUP — verified users only.
═══════════════════════════════════════════════════════════════════════════ */
function openCreateGroupModal() {
  if (!currentUser) { requireVerified('create a group'); return; }
  if (!currentProfile.verified) { showToast('Get verified to create a group'); showPaywall(); return; }
  const m = $('createGroupModal');
  if (m) m.classList.add('open');
}
function closeCreateGroupModal() {
  const m = $('createGroupModal'); if (m) m.classList.remove('open');
  ['groupNameInput','groupDescInput'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  const cover = $('groupCoverInput'); if (cover) cover.value = '';
  const coverPrev = $('groupCoverPreview'); if (coverPrev) coverPrev.innerHTML = '';
  const priv = document.querySelector('input[name="groupPrivacy"][value="public"]'); if (priv) priv.checked = true;
  const joinMode = document.querySelector('input[name="groupJoinMode"][value="request"]'); if (joinMode) joinMode.checked = true;
  const jmRow = $('groupJoinModeRow'); if (jmRow) jmRow.style.display = 'none';
}
function onGroupPrivacyChange(val) {
  const row = $('groupJoinModeRow');
  if (row) row.style.display = val === 'private' ? 'flex' : 'none';
}

async function submitCreateGroup() {
  const name = $('groupNameInput')?.value.trim();
  const description = $('groupDescInput')?.value.trim() || '';
  const privacy = document.querySelector('input[name="groupPrivacy"]:checked')?.value || 'public';
  const joinMode = document.querySelector('input[name="groupJoinMode"]:checked')?.value || 'request';
  if (!name) { showToast('Give your group a name'); return; }

  const btn = $('createGroupSubmitBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  try {
    let coverURL = '';
    const coverInput = $('groupCoverInput');
    if (coverInput?.files?.[0]) {
      if (btn) btn.textContent = 'Uploading photo…';
      const r = await window.XCloud.upload(coverInput.files[0], 'group_covers');
      coverURL = r.url;
      if (btn) btn.textContent = 'Creating…';
    }
    const groupData = {
      name, description, privacy,
      joinMode: privacy === 'private' ? joinMode : 'open',
      createdBy: currentUser.uid,
      createdAt: Date.now(),
      membersCount: 1,
      coverURL
    };
    const ref = await window.XF.push('groups', groupData);
    const groupId = ref.key;
    await window.XF.set('groupMembers/' + groupId + '/' + currentUser.uid, {
      uid: currentUser.uid, role: 'admin', joinedAt: Date.now()
    });
    await _addToMyGroupIds(groupId);
    closeCreateGroupModal();
    showToast('Group created!');
    openGroup(groupId);
  } catch (e) {
    showToast('Could not create group');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Create group'; }
  }
}

function previewGroupCover(input) {
  const preview = $('groupCoverPreview');
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = e => { preview.innerHTML = `<div class="img-preview-wrap"><img src="${e.target.result}"><div class="img-preview-remove" onclick="removeGroupCover()">✕</div></div>`; };
    reader.readAsDataURL(input.files[0]);
  }
}
function removeGroupCover() {
  const i = $('groupCoverInput'); if (i) i.value = '';
  const p = $('groupCoverPreview'); if (p) p.innerHTML = '';
}

/* Admin: change an existing group's cover photo from the group page. */
async function changeGroupCover(input) {
  if (!_activeGroup || _activeGroupRole !== 'admin' || !input?.files?.[0]) return;
  showToast('Uploading…');
  try {
    const r = await window.XCloud.upload(input.files[0], 'group_covers');
    await window.XF.update('groups/' + _activeGroup.id, { coverURL: r.url });
    _activeGroup.coverURL = r.url;
    showToast('Group photo updated');
    renderGroupDetail(_activeGroup.id);
  } catch (e) { showToast('Could not update photo'); }
}

/* Share — native share sheet where available, clipboard copy otherwise. */
function shareGroup(groupId, groupName) {
  const url = `${window.location.origin}/group?groupId=${encodeURIComponent(groupId)}`;
  const text = `Check out ${groupName || 'this group'} on Bum Book`;
  if (navigator.share) {
    navigator.share({ title: groupName || 'Bum Book group', text, url }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(url)
      .then(() => showToast('Group link copied'))
      .catch(() => showToast(url));
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP DETAIL PAGE
═══════════════════════════════════════════════════════════════════════════ */
let _activeGroup = null;      // { id, ...groupData }
let _activeGroupRole = null;  // 'admin' | 'member' | null (not a member)
let _activeGroupTab = 'posts';

function openGroup(groupId) {
  showPage('group-detail', { groupId });
}

async function renderGroupDetail(groupId) {
  const container = $('groupDetailContent');
  if (!container || !groupId) return;
  container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';

  try {
    const snap = await window.XF.get('groups/' + groupId);
    if (!snap.exists()) { container.innerHTML = '<div class="empty-state"><div class="empty-state-title">Group not found</div></div>'; return; }
    _activeGroup = { id: groupId, ...snap.val() };

    let myMembership = null;
    let myRequest = null;
    if (currentUser) {
      const mSnap = await window.XF.get('groupMembers/' + groupId + '/' + currentUser.uid);
      if (mSnap.exists()) myMembership = mSnap.val();
      if (!myMembership && _activeGroup.privacy === 'private') {
        const rSnap = await window.XF.get('groupJoinRequests/' + groupId + '/' + currentUser.uid);
        if (rSnap.exists()) myRequest = rSnap.val();
      }
    }
    _activeGroupRole = myMembership ? myMembership.role : null;
    _activeGroupTab = 'posts';

    container.innerHTML = _groupHeaderHTML(_activeGroup, _activeGroupRole, !!myRequest) + `
      <div class="group-tabs" id="groupTabs">
        <div class="group-tab active" data-tab="posts" onclick="switchGroupTab('posts')">Posts</div>
        <div class="group-tab" data-tab="members" onclick="switchGroupTab('members')">Members</div>
        <div class="group-tab" data-tab="about" onclick="switchGroupTab('about')">About</div>
        ${_activeGroupRole === 'admin' && _activeGroup.privacy === 'private' && _activeGroup.joinMode === 'request'
          ? '<div class="group-tab" data-tab="requests" onclick="switchGroupTab(\'requests\')">Requests</div>' : ''}
      </div>
      <div id="groupTabContent"></div>
    `;
    _renderGroupTab();
  } catch (e) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-title">Could not load group</div></div>';
  }
}

function _groupHeaderHTML(g, role, hasPendingRequest) {
  const isMember = !!role;
  let actionBtn = '';
  if (!currentUser) {
    actionBtn = `<button class="btn btn-primary" onclick="requireVerified('join this group')">Join group</button>`;
  } else if (isMember) {
    actionBtn = role === 'admin'
      ? `<button class="btn btn-outline" onclick="openGroupSettingsModal()">Group settings</button>`
      : `<button class="btn btn-outline" onclick="leaveGroup('${g.id}')">Leave group</button>`;
  } else if (g.privacy === 'public') {
    actionBtn = `<button class="btn btn-primary" onclick="joinGroup('${g.id}')">Join group</button>`;
  } else if (hasPendingRequest) {
    actionBtn = `<button class="btn btn-outline" disabled>Request pending</button>`;
  } else if (g.joinMode === 'request') {
    actionBtn = `<button class="btn btn-primary" onclick="requestToJoinGroup('${g.id}')">Request to join</button>`;
  } else {
    actionBtn = `<button class="btn btn-outline" disabled title="Invite only">Invite only</button>`;
  }

  const privacyLabel = g.privacy === 'private'
    ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Private group'
    : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg> Public group';

  return `<div class="group-header">
    <div class="group-cover" style="${g.coverURL ? `background-image:url('${escapeHTML(g.coverURL)}')` : ''}">
      ${role === 'admin' ? `<label class="group-cover-edit" title="Change group photo"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg><input type="file" accept="image/*" style="display:none" onchange="changeGroupCover(this)"></label>` : ''}
    </div>
    <div class="group-header-body">
      <div class="group-header-name">${escapeHTML(g.name || 'Untitled group')}</div>
      <div class="group-header-meta">${privacyLabel} · ${formatCount(g.membersCount || 0)} member${(g.membersCount||0) === 1 ? '' : 's'}</div>
      ${g.description ? `<div class="group-header-desc">${escapeHTML(g.description)}</div>` : ''}
      <div class="group-header-actions">
        ${actionBtn}
        <button class="btn btn-outline" onclick="shareGroup('${g.id}','${escapeHTML((g.name||'').replace(/'/g, "\\'"))}')" title="Share group"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg> Share</button>
      </div>
    </div>
  </div>`;
}

function switchGroupTab(tab) {
  _activeGroupTab = tab;
  document.querySelectorAll('#groupTabs .group-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  _renderGroupTab();
}

async function _renderGroupTab() {
  const el = $('groupTabContent'); if (!el || !_activeGroup) return;
  el.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
  if (_activeGroupTab === 'posts') return _renderGroupPosts();
  if (_activeGroupTab === 'members') return _renderGroupMembers();
  if (_activeGroupTab === 'about') return _renderGroupAbout();
  if (_activeGroupTab === 'requests') return _renderGroupRequests();
}

/* ── Posts tab ── */
async function _renderGroupPosts() {
  const el = $('groupTabContent'); if (!el || !_activeGroup) return;
  const isMember = !!_activeGroupRole;
  const composer = isMember ? `
    <div class="group-post-composer">
      <textarea id="groupPostText" class="form-input" placeholder="Post to ${escapeHTML(_activeGroup.name || 'the group')}…" rows="2"></textarea>
      <div id="groupPostImagePreview"></div>
      <div class="group-post-composer-actions">
        <label class="composer-tool" title="Add image"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><input id="groupPostImageInput" type="file" accept="image/*" style="display:none" onchange="previewGroupPostImage(this)"></label>
        <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="submitGroupPost()">Post</button>
      </div>
    </div>` : '';

  try {
    const snap = await window.XF.get('posts');
    const posts = [];
    if (snap.exists()) snap.forEach(c => { const p = { id: c.key, ...c.val() }; if (p.groupId === _activeGroup.id) posts.push(p); });
    posts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (posts.length === 0) {
      el.innerHTML = composer + '<div class="empty-state" style="padding:30px 16px"><div class="empty-state-title">No posts yet</div><div class="empty-state-desc">' + (isMember ? 'Be the first to post' : 'Join to start posting') + '</div></div>';
      return;
    }
    const uids = [...new Set(posts.map(p => p.authorUid).filter(Boolean))];
    const profiles = {};
    await Promise.allSettled(uids.map(async uid => { try { const s = await window.XF.get('users/' + uid); if (s.exists()) profiles[uid] = s.val(); } catch (e) {} }));
    el.innerHTML = composer + posts.map(p => postHTML(p, profiles[p.authorUid])).join('');
  } catch (e) {
    el.innerHTML = composer + '<div class="empty-state"><div class="empty-state-title">Could not load posts</div></div>';
  }
}

function previewGroupPostImage(input) {
  const preview = $('groupPostImagePreview');
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = e => { preview.innerHTML = `<div class="img-preview-wrap"><img src="${e.target.result}"><div class="img-preview-remove" onclick="removeGroupPostImage()">✕</div></div>`; };
    reader.readAsDataURL(input.files[0]);
  }
}
function removeGroupPostImage() { $('groupPostImageInput').value = ''; $('groupPostImagePreview').innerHTML = ''; }

async function submitGroupPost() {
  if (!_activeGroup || !currentUser) return;
  const text = $('groupPostText')?.value.trim();
  const imgInput = $('groupPostImageInput');
  if (!text && !(imgInput?.files?.[0])) { showToast('Write something or add an image'); return; }

  try {
    let imageURL = '';
    if (imgInput?.files?.[0]) {
      showToast('Uploading…');
      const r = await window.XCloud.upload(imgInput.files[0], 'group_post_images');
      imageURL = r.url;
    }
    await window.XF.push('posts', {
      authorUid: currentUser.uid,
      text: text || '',
      imageURL,
      groupId: _activeGroup.id,
      groupName: _activeGroup.name,
      groupPrivacy: _activeGroup.privacy,
      createdAt: Date.now(),
      commentCount: 0
    });
    await window.XF.update('users/' + currentUser.uid, { postsCount: (currentProfile.postsCount || 0) + 1 });
    currentProfile.postsCount = (currentProfile.postsCount || 0) + 1;
    showToast('Posted!');
    _renderGroupPosts();
  } catch (e) { showToast('Failed to post'); }
}

/* ── Members tab ── */
async function _renderGroupMembers() {
  const el = $('groupTabContent'); if (!el || !_activeGroup) return;
  try {
    const snap = await window.XF.get('groupMembers/' + _activeGroup.id);
    const members = [];
    if (snap.exists()) snap.forEach(c => members.push({ uid: c.key, ...c.val() }));
    members.sort((a, b) => (a.role === 'admin' ? -1 : 1) - (b.role === 'admin' ? -1 : 1));

    const profiles = {};
    await Promise.allSettled(members.map(async m => { try { const s = await window.XF.get('users/' + m.uid); if (s.exists()) profiles[m.uid] = s.val(); } catch (e) {} }));

    const isAdminHere = _activeGroupRole === 'admin';
    el.innerHTML = members.map(m => {
      const p = profiles[m.uid] || {};
      const controls = (isAdminHere && m.uid !== currentUser.uid) ? `
        <div class="group-member-controls">
          ${m.role === 'admin'
            ? `<button class="btn btn-outline btn-sm" onclick="toggleGroupAdmin('${_activeGroup.id}','${m.uid}',false)">Remove admin</button>`
            : `<button class="btn btn-outline btn-sm" onclick="toggleGroupAdmin('${_activeGroup.id}','${m.uid}',true)">Make admin</button>`}
          <button class="btn btn-outline btn-sm" onclick="removeGroupMember('${_activeGroup.id}','${m.uid}')" style="color:var(--danger)">Remove</button>
        </div>` : '';
      return `<div class="group-member-row" onclick="openUserProfile('${m.uid}',event)">
        ${avatarHTML(p, 'md')}
        <div class="group-member-info">
          <div class="group-member-name">${escapeHTML(p.displayName || 'Member')}${verifiedBadge(p.verified)}${m.role === 'admin' ? ' <span class="group-admin-tag">Admin</span>' : ''}</div>
          <div class="group-member-handle">@${escapeHTML(p.handle || '')}</div>
        </div>
        ${controls}
      </div>`;
    }).join('') || '<div class="empty-state"><div class="empty-state-title">No members</div></div>';
  } catch (e) {
    el.innerHTML = '<div class="empty-state"><div class="empty-state-title">Could not load members</div></div>';
  }
}

/* ── About tab ── */
function _renderGroupAbout() {
  const el = $('groupTabContent'); if (!el || !_activeGroup) return;
  const g = _activeGroup;
  el.innerHTML = `<div style="padding:16px">
    <div class="sidebar-section-title" style="padding:0 0 6px">Description</div>
    <div style="font-size:0.9rem;color:var(--text-dim);margin-bottom:20px">${escapeHTML(g.description || 'No description yet.')}</div>
    <div class="sidebar-section-title" style="padding:0 0 6px">Privacy</div>
    <div style="font-size:0.9rem;color:var(--text-dim);margin-bottom:20px">${g.privacy === 'private' ? 'Private — only members can see posts. ' + (g.joinMode === 'invite' ? 'Invite-only.' : 'Anyone can request to join.') : 'Public — anyone can see posts and join.'}</div>
    ${_activeGroupRole === 'admin' ? `<button class="btn btn-outline btn-sm" style="color:var(--danger)" onclick="deleteGroupConfirm('${g.id}')">Delete group</button>` : ''}
  </div>`;
}

/* ── Requests tab (admin only, private+request groups) ── */
async function _renderGroupRequests() {
  const el = $('groupTabContent'); if (!el || !_activeGroup) return;
  try {
    const snap = await window.XF.get('groupJoinRequests/' + _activeGroup.id);
    const requests = [];
    if (snap.exists()) snap.forEach(c => requests.push({ uid: c.key, ...c.val() }));
    if (requests.length === 0) { el.innerHTML = '<div class="empty-state"><div class="empty-state-title">No pending requests</div></div>'; return; }

    const profiles = {};
    await Promise.allSettled(requests.map(async r => { try { const s = await window.XF.get('users/' + r.uid); if (s.exists()) profiles[r.uid] = s.val(); } catch (e) {} }));

    el.innerHTML = requests.map(r => {
      const p = profiles[r.uid] || {};
      return `<div class="group-member-row">
        ${avatarHTML(p, 'md')}
        <div class="group-member-info">
          <div class="group-member-name">${escapeHTML(p.displayName || 'Member')}${verifiedBadge(p.verified)}</div>
          <div class="group-member-handle">@${escapeHTML(p.handle || '')}</div>
        </div>
        <div class="group-member-controls">
          <button class="btn btn-primary btn-sm" onclick="approveJoinRequest('${_activeGroup.id}','${r.uid}')">Approve</button>
          <button class="btn btn-outline btn-sm" onclick="declineJoinRequest('${_activeGroup.id}','${r.uid}')">Decline</button>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = '<div class="empty-state"><div class="empty-state-title">Could not load requests</div></div>';
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   MEMBERSHIP ACTIONS
═══════════════════════════════════════════════════════════════════════════ */
async function joinGroup(groupId) {
  if (!requireVerified('join this group')) return;
  try {
    await window.XF.set('groupMembers/' + groupId + '/' + currentUser.uid, { uid: currentUser.uid, role: 'member', joinedAt: Date.now() });
    await window.XF.update('groups/' + groupId, { membersCount: firebase.firestore.FieldValue.increment(1) });
    await _addToMyGroupIds(groupId);
    showToast('Joined group');
    renderGroupDetail(groupId);
  } catch (e) { showToast('Could not join group'); }
}

async function requestToJoinGroup(groupId) {
  if (!requireVerified('request to join this group')) return;
  try {
    await window.XF.set('groupJoinRequests/' + groupId + '/' + currentUser.uid, { uid: currentUser.uid, requestedAt: Date.now() });
    showToast('Request sent');
    renderGroupDetail(groupId);
  } catch (e) { showToast('Could not send request'); }
}

async function leaveGroup(groupId) {
  if (!currentUser) return;
  try {
    await window.XF.fs.collection('groups').doc(groupId).collection('members').doc(currentUser.uid).delete();
    await window.XF.update('groups/' + groupId, { membersCount: firebase.firestore.FieldValue.increment(-1) });
    await _removeFromMyGroupIds(groupId);
    showToast('Left group');
    renderGroupDetail(groupId);
  } catch (e) { showToast('Could not leave group'); }
}

async function approveJoinRequest(groupId, uid) {
  try {
    await window.XF.set('groupMembers/' + groupId + '/' + uid, { uid, role: 'member', joinedAt: Date.now() });
    await window.XF.update('groups/' + groupId, { membersCount: firebase.firestore.FieldValue.increment(1) });
    await window.XF.fs.collection('users').doc(uid).set({ groupIds: firebase.firestore.FieldValue.arrayUnion(groupId) }, { merge: true });
    await window.XF.fs.collection('groups').doc(groupId).collection('joinRequests').doc(uid).delete();
    showToast('Request approved');
    _renderGroupRequests();
  } catch (e) { showToast('Could not approve request'); }
}
async function declineJoinRequest(groupId, uid) {
  try {
    await window.XF.fs.collection('groups').doc(groupId).collection('joinRequests').doc(uid).delete();
    showToast('Request declined');
    _renderGroupRequests();
  } catch (e) { showToast('Could not decline request'); }
}

async function removeGroupMember(groupId, uid) {
  try {
    await window.XF.fs.collection('groups').doc(groupId).collection('members').doc(uid).delete();
    await window.XF.update('groups/' + groupId, { membersCount: firebase.firestore.FieldValue.increment(-1) });
    await window.XF.fs.collection('users').doc(uid).set({ groupIds: firebase.firestore.FieldValue.arrayRemove(groupId) }, { merge: true });
    showToast('Member removed');
    _renderGroupMembers();
  } catch (e) { showToast('Could not remove member'); }
}

async function toggleGroupAdmin(groupId, uid, makeAdmin) {
  try {
    await window.XF.update('groupMembers/' + groupId + '/' + uid, { role: makeAdmin ? 'admin' : 'member' });
    showToast(makeAdmin ? 'Now an admin' : 'Admin removed');
    _renderGroupMembers();
  } catch (e) { showToast('Could not update role'); }
}

function deleteGroupConfirm(groupId) {
  if (!confirm('Delete this group? This cannot be undone.')) return;
  deleteGroup(groupId);
}
async function deleteGroup(groupId) {
  try {
    await window.XF.fs.collection('groups').doc(groupId).delete();
    showToast('Group deleted');
    showPage('groups');
  } catch (e) { showToast('Could not delete group'); }
}

function openGroupSettingsModal() {
  // Lightweight v1: settings surface is the About tab (rename/description
  // editing and delete) rather than a separate modal, keeping this in one
  // place for now.
  switchGroupTab('about');
}
