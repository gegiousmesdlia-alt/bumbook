// auth.js — X Club — Auth, Session, Deep Links (multi-page)
'use strict';

/* ── Shared nav/head snippets are injected by each page's boot ── */

async function handleLogin(e) {
  e.preventDefault();
  const btn = $('loginBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
  try {
    await window.XF.signIn($('loginEmail').value.trim(), $('loginPass').value);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
    console.error('[login]', err);
    showToast(friendlyError(err.code));
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const btn = $('regBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Creating account…'; }
  const name   = $('regName')?.value.trim();
  const handle = $('regHandle')?.value.trim().toLowerCase().replace(/[^a-z0-9_]/g,'');
  const email  = $('regEmail')?.value.trim();
  const pass   = $('regPass')?.value;
  if (!name || !handle || !email || !pass) { showToast('Fill in all fields'); if (btn) { btn.disabled = false; btn.textContent = 'Create account'; } return; }
  if (pass.length < 8) { showToast('Password must be at least 8 characters'); if (btn) { btn.disabled = false; btn.textContent = 'Create account'; } return; }
  try {
    const snap = await window.XF.get('handles/' + handle);
    if (snap.exists()) { showToast('@' + handle + ' is already taken'); if (btn) { btn.disabled = false; btn.textContent = 'Create account'; } return; }
    const cred = await window.XF.register(email, pass);
    await window.XF.set('users/' + cred.user.uid, { uid: cred.user.uid, displayName: name, handle, email, bio: '', photoURL: '', verified: false, followersCount: 0, followingCount: 0, postsCount: 0, joinedAt: window.XF.ts() });
    await window.XF.set('handles/' + handle, cred.user.uid);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Create account'; }
    console.error('[register]', err);
    showToast(friendlyError(err.code));
  }
}

async function handleGoogleAuth() {
  try {
    const cred = await window.XF.googleSignIn();
    const snap = await window.XF.get('users/' + cred.user.uid);
    if (!snap.exists()) {
      const handle = (cred.user.email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g,'') + '_' + Date.now().toString(36);
      await window.XF.set('users/' + cred.user.uid, { uid: cred.user.uid, displayName: cred.user.displayName || 'Member', handle, email: cred.user.email || '', bio: '', photoURL: cred.user.photoURL || '', verified: false, followersCount: 0, followingCount: 0, postsCount: 0, joinedAt: window.XF.ts() });
      await window.XF.set('handles/' + handle, cred.user.uid);
    }
  } catch (err) { console.error('[google auth]', err); showToast(friendlyError(err.code)); }
}

async function handleLogout() {
  try { sessionStorage.clear(); } catch (e) {}
  await window.XF.signOut(); window.location.href = "/index.html";
}

function friendlyError(code) {
  return ({
    'auth/user-not-found': 'No account found with that email',
    'auth/wrong-password': 'Incorrect password',
    'auth/invalid-credential': 'Incorrect email or password',
    'auth/email-already-in-use': 'Email already registered',
    'auth/weak-password': 'Password is too weak',
    'auth/invalid-email': 'Invalid email address',
    'auth/popup-closed-by-user': 'Sign-in was cancelled',
    'auth/network-request-failed': 'Network error — check your connection',
    'auth/operation-not-allowed': 'Email/password sign-in is not enabled for this project',
    'permission-denied': 'Permission denied — check Firestore security rules are published'
  }[code]) || ('Something went wrong' + (code ? ' (' + code + ')' : '') + '. Please try again.');
}

/* ══════════════════════════════════════════════
   AUTH STATE CHANGE
   Each page calls this. Each page knows what it needs.
══════════════════════════════════════════════ */
async function onAuthChange(user) {
  currentUser = user;
  const loc = (typeof pageFromLocation === 'function' && pageFromLocation()) || null;
  // admin.html is a separate, non-SPA document and sets window.__PAGE__
  // inline before boot.js runs; the merged SPA shell doesn't, and is
  // routed from the URL instead.
  const page = window.__PAGE__ || (loc ? loc.name : 'landing');
  const opts = loc ? loc.opts : {};
  window.__PAGE__ = page;
  console.log('[auth] onAuthChange:', { user: user ? user.uid : null, url: window.location.pathname + window.location.search, resolvedPage: page, opts });

  loadAppConfig();

  try {
    if (user) {
      if (user.email === ADMIN_EMAIL) {
        isAdmin = true;
        const snap = await window.XF.get('users/' + user.uid);
        currentProfile = snap.exists() ? snap.val() : { displayName: 'Admin', uid: user.uid };
        hideLoader();
        if (page === 'admin') { loadAdminUsers(); setTimeout(injectAdminTools, 400); }
        else { showPage('admin'); }
        return;
      }
      isAdmin = false;

      // Session-local cache: instant render on repeat views within this
      // tab's session, then a quiet background refresh for real changes.
      const _profCacheKey = 'xf_profile_' + user.uid;
      let _cachedProfile = null;
      try {
        const raw = sessionStorage.getItem(_profCacheKey);
        if (raw) _cachedProfile = JSON.parse(raw);
      } catch (e) {}

      if (_cachedProfile) {
        currentProfile = _cachedProfile;
      } else {
        const snap = await window.XF.get('users/' + user.uid);
        currentProfile = snap.exists() ? snap.val() : null;
        if (currentProfile) {
          try { sessionStorage.setItem(_profCacheKey, JSON.stringify(currentProfile)); } catch (e) {}
        }
      }

      // Global, one-time init — this used to re-run on every single page
      // load because every navigation WAS a fresh page load. In the SPA
      // model it only needs to happen once per session, which is a real
      // simplification, not just a port.
      updateNavUser(); typeof updateComposerAvatar === 'function' && updateComposerAvatar();
      typeof loadSuggested === 'function' && loadSuggested();
      typeof startNotifWatch === 'function' && startNotifWatch();
      typeof startMsgWatch === 'function' && startMsgWatch();
      typeof updateSidebarVerifyBtn === 'function' && updateSidebarVerifyBtn();
      typeof _updateMsgRequestBadge === 'function' && _updateMsgRequestBadge();
      typeof _initPresence === 'function' && _initPresence(user.uid);
      typeof _silentlyRefreshPushSubscription === 'function' && _silentlyRefreshPushSubscription();

      hideLoader();

      window.XF.get('users/' + user.uid).then(freshSnap => {
        const fresh = freshSnap.exists() ? freshSnap.val() : null;
        if (!fresh) return;
        const changed = JSON.stringify(fresh) !== JSON.stringify(currentProfile);
        currentProfile = fresh;
        try { sessionStorage.setItem(_profCacheKey, JSON.stringify(fresh)); } catch (e) {}
        if (changed) {
          updateNavUser();
          if (window.__PAGE__ === 'profile' && typeof renderOwnProfile === 'function') renderOwnProfile();
        }
      }).catch(err => console.error('[Auth] background profile refresh failed:', err));

      // Pending session profile redirect (e.g. just registered)
      if (!window._pendingProfileUid) {
        try { window._pendingProfileUid = sessionStorage.getItem('_pendingProfileUid') || null; } catch(e) {}
      }
      if (window._pendingProfileUid) {
        const pendingUid = window._pendingProfileUid;
        window._pendingProfileUid = null;
        try { sessionStorage.removeItem('_pendingProfileUid'); } catch(e) {}
        if (pendingUid === user.uid) showPage('profile');
        else showPage('user-profile', { uid: pendingUid });
        return; // showPage() triggers onPageActivated itself
      }

      if (['landing','login','register','reset'].includes(page)) {
        showPage('feed'); // triggers onPageActivated('feed') itself
      } else {
        showPage(page, opts); // makes the page div actually visible, then renders it
      }

    } else {
      isAdmin = false; currentProfile = null;
      updateNavUser && updateNavUser();
      typeof updateSidebarVerifyBtn === 'function' && updateSidebarVerifyBtn();
      hideLoader();

      // Pages that require auth — send to landing. Profile/post pages are
      // deliberately excluded: a shared link should be viewable by a guest;
      // any actual ACTION on that page (follow, message, like, comment) is
      // gated individually via requireVerified(), which shows a sign-in
      // prompt instead of blocking the view itself.
      const authRequired = ['feed','discover','notifications','messages','profile','settings','admin'];
      if (authRequired.includes(page)) {
        showPage('landing'); // triggers onPageActivated('landing') itself
      } else {
        showPage(page, opts); // e.g. a guest opening a shared profile/post link
      }
    }
  } catch (err) {
    // Without this, a Firestore error here (rules not published yet, API
    // not enabled, offline, etc.) leaves the loading screen up forever
    // with no visible error.
    console.error('[Auth] onAuthChange failed:', err);
    hideLoader();
    if (typeof showToast === 'function') showToast('Could not load your account — please refresh');
  }
}

// Called once at cold-boot (from onAuthChange, after the redirect checks
// above) AND every time the router switches to a new page thereafter.
// This is the ONE place that decides what a given page needs to load —
// keeping it separate from onAuthChange is what lets navigation skip
// re-running auth/profile/global-init on every click.
function onPageActivated(page, opts = {}) {
  if (currentUser) {
    if (page === 'feed')          { renderFeed(); setTimeout(runScheduledPosts, 5000); }
    if (page === 'discover')      renderDiscover();
    if (page === 'notifications') renderNotifications();
    if (page === 'messages') {
      const dmUid = opts.uid || new URLSearchParams(window.location.search).get('uid');
      if (dmUid) openDMWith(dmUid); else renderConversations();
    }
    if (page === 'profile')       renderOwnProfile();
    if (page === 'settings')      syncThemeSettingsUI();
    if (page === 'reels')         renderReels();
    if (page === 'channel')       renderChannelPage(opts.channelId);
    if (page === 'groups')        renderGroupsPage();
    if (page === 'group-detail')  renderGroupDetail(opts.groupId);
    if (page === 'user-profile') {
      const uid = opts.uid || new URLSearchParams(window.location.search).get('uid');
      if (uid) renderUserProfile(uid); else showPage('feed');
    }
    if (page === 'post-detail') {
      const postId = opts.postId || new URLSearchParams(window.location.search).get('postId');
      if (postId) renderPostDetail(postId); else showPage('feed');
    }
    if (page === 'bsky-profile') {
      const actor = opts.bskyActor || new URLSearchParams(window.location.search).get('actor');
      if (actor) renderBskyProfile(actor); else showPage('feed');
    }
    if (page === 'bsky-post') {
      const uri = opts.bskyUri || new URLSearchParams(window.location.search).get('uri');
      if (uri) renderBskyPost(uri); else showPage('feed');
    }
  } else {
    if (page === 'user-profile') {
      const uid = opts.uid || new URLSearchParams(window.location.search).get('uid');
      if (uid) renderUserProfile(uid);
    } else if (page === 'post-detail') {
      const postId = opts.postId || new URLSearchParams(window.location.search).get('postId');
      if (postId) renderPostDetail(postId);
    } else if (page === 'bsky-profile') {
      const actor = opts.bskyActor || new URLSearchParams(window.location.search).get('actor');
      if (actor) renderBskyProfile(actor);
    } else if (page === 'bsky-post') {
      const uri = opts.bskyUri || new URLSearchParams(window.location.search).get('uri');
      if (uri) renderBskyPost(uri);
    } else if (page === 'reels') {
      renderReels();
    } else if (page === 'channel') {
      renderChannelPage(opts.channelId);
    } else if (page === 'groups') {
      renderGroupsPage();
    } else if (page === 'group-detail') {
      const groupId = opts.groupId || new URLSearchParams(window.location.search).get('groupId');
      if (groupId) renderGroupDetail(groupId);
    }
  }
}

function updateNavUser() {
  const wrap = $('navUserWrap'); if (!wrap) return;
  if (currentUser && currentProfile) {
    wrap.style.display = 'flex';
    const nameEl = $('navUserName'); const handleEl = $('navUserHandle'); const avatarEl = $('navUserAvatar');
    if (nameEl) nameEl.textContent = currentProfile.displayName || '';
    if (handleEl) handleEl.textContent = '@' + (currentProfile.handle || '');
    if (avatarEl) {
      if (currentProfile.photoURL) avatarEl.innerHTML = `<img class="avatar avatar-md" src="${currentProfile.photoURL}" alt="">`;
      else avatarEl.textContent = (currentProfile.displayName || '?').charAt(0).toUpperCase();
    }
  } else {
    wrap.style.display = 'none';
  }
}

/* ══════════════════════════════════════════════
   DEEP LINK  (?post=ID)  — used by share button in feed.js
══════════════════════════════════════════════ */
function checkDeepLink() {
  const params = new URLSearchParams(window.location.search); const postId = params.get('post');
  if (postId && currentUser) { setTimeout(() => showPage('post-detail', { postId }), 800); }
}

/* ══════════════════════════════════════════════
   RESET PASSWORD
══════════════════════════════════════════════ */
async function sendReset() {
  const email = $('resetEmail').value.trim(); if (!email) return showToast('Enter your email');
  try { await window.XF.resetPw(email); showToast('Reset link sent — check your inbox'); showPage('login'); }
  catch (err) { showToast('Could not send reset link'); }
}

/* ══════════════════════════════════════════════
   PAYMENT / VERIFICATION
══════════════════════════════════════════════ */
function showPaywall() {
  const m = $('paywallModal'); if (m) m.classList.add('open');
}
function closePaywall() {
  const m = $('paywallModal'); if (m) m.classList.remove('open');
}
async function submitVerificationRequest() {
  if (!currentUser || !currentProfile) { showToast('Sign in first'); return; }
  const selfieInput = $('verifySelfieInput'), idInput = $('verifyIdInput');
  if (!selfieInput?.files[0] || !idInput?.files[0]) { showToast('Please add both photos'); return; }
  showToast('Uploading…');
  try {
    const [selfie, id] = await Promise.all([
      window.XCloud.upload(selfieInput.files[0], 'x_verification'),
      window.XCloud.upload(idInput.files[0], 'x_verification'),
    ]);
    await window.XF.set('verificationRequests/' + currentUser.uid, {
      uid: currentUser.uid,
      displayName: currentProfile.displayName || 'Member',
      handle: currentProfile.handle || '',
      selfieURL: selfie.url,
      idURL: id.url,
      status: 'pending',
      submittedAt: window.XF.ts(),
    });
    closePaywall();
    showToast('Submitted! We\'ll review it shortly.');
  } catch (err) {
    showToast('Upload failed — try again');
  }
}
