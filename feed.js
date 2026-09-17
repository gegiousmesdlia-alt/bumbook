// feed.js — X Club v7 — Feed, Posts, Comments, Likes, Scheduling
'use strict';

/* ══════════════════════════════════════════════
   FEED  (paginated scroll-to-load)
══════════════════════════════════════════════ */
let _feedUnsubscribe = null;
const FEED_PAGE_SIZE = 20;
let _feedOldestTs = null;
let _feedLoading = false;
let _feedExhausted = false;
let _feedScrollHandler = null;

function _teardownFeed() {
  if (_feedUnsubscribe) { try { _feedUnsubscribe(); } catch (e) {} _feedUnsubscribe = null; }
  if (_feedScrollHandler) {
    const mc = document.querySelector('.main-content');
    if (mc) mc.removeEventListener('scroll', _feedScrollHandler);
    window.removeEventListener('scroll', _feedScrollHandler);
    _feedScrollHandler = null;
  }
  _feedOldestTs = null; _feedLoading = false; _feedExhausted = false;
}

/* ═══════════════════════════════════════════════════════════════════════════
   "FOR YOU" REELS TRAY — a horizontal row of reel thumbnails at the top of
   the feed, Facebook-style (tap one → jump into the full Reels tab at that
   video). This is deliberately NOT a live embed sitting in the feed: full
   iframes there are heavier, and YouTube's own embed chrome (the logo/
   title in the paused thumbnail state) can hand off to the YouTube app on
   a tap — a plain thumbnail here sidesteps that entirely, and matches how
   Facebook actually shows its own Reels tray.
═══════════════════════════════════════════════════════════════════════════ */
async function _fetchForYouVideos(count) {
  try {
    const params = new URLSearchParams();
    const topic = (typeof _pickReelTopic === 'function') ? _pickReelTopic() : '';
    if (topic) params.set('q', topic);
    const resp = await fetch('/api/youtube-reels?' + params.toString());
    const data = await resp.json();
    if (!data.configured || data.error || !data.items) return [];
    return data.items.slice(0, count).map(v => ({ ...v, topic: data.topic || topic }));
  } catch (e) { return []; }
}

function forYouTrayHTML(videos) {
  if (!videos.length) return '';
  window._forYouTrayVideos = videos; // referenced by index below, avoids embedding raw JSON in HTML attributes
  const cards = videos.map((v, i) => `
    <div class="fy-reel-card" onclick="openReelsAt(window._forYouTrayVideos[${i}])">
      <img class="fy-reel-thumb" src="${escapeHTML(v.thumb)}" alt="" loading="lazy">
      <div class="fy-reel-play"><svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></div>
      <div class="fy-reel-title">${escapeHTML(v.title || '')}</div>
    </div>`).join('');
  return `<div class="fy-reel-tray">
    <div class="fy-reel-tray-header">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="10" y2="7"/><line x1="14" y1="2" x2="17" y2="7"/><line x1="2" y1="7" x2="22" y2="7"/><polygon points="10 12 15 14.5 10 17"/></svg>
      <span>Reels</span>
      <span class="fy-reel-tray-more" onclick="event.stopPropagation();showPage('reels')">See all</span>
    </div>
    <div class="fy-reel-tray-scroll">${cards}</div>
  </div>`;
}

async function renderFeed() {
  const container = $('feedPosts');
  if (!container) return;
  _teardownFeed();
  container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
  await _loadFeedPage(container, true);
  _attachFeedScrollListener(container);
  _feedUnsubscribe = window.XF.on('posts', async function (snap) {
    if (!_feedOldestTs) return;
    const topPost = container.querySelector('.post[data-id]');
    if (!topPost) return;
    let newestTs = 0;
    container.querySelectorAll('.post[data-id]').forEach(el => {
      const ts = parseInt(el.dataset.ts || '0');
      if (ts > newestTs) newestTs = ts;
    });
    if (!snap.exists()) return;
    const newPosts = [];
    snap.forEach(c => { const p = { id: c.key, ...c.val() }; if ((p.createdAt || 0) > newestTs) newPosts.push(p); });
    if (newPosts.length === 0) return;
    const blockedUids = await getBlockedUids();
    const filtered = newPosts.filter(p => !blockedUids.has(p.authorUid));
    if (filtered.length === 0) return;
    filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const uids = [...new Set(filtered.map(p => p.authorUid).filter(u => u && u !== CLAUDE_ENGINEER_UID))];
    const profiles = {};
    await Promise.allSettled(uids.map(async uid => { try { const s = await window.XF.get('users/' + uid); if (s.exists()) profiles[uid] = s.val(); } catch (e) {} }));
    const html = filtered.map(p => {
      
      if (p.authorUid === CLAUDE_ENGINEER_UID) return claudeEngineerPostHTML(p);
      return postHTML(p, profiles[p.authorUid]);
    }).join('');
    const sentinel = container.querySelector('#feedSentinel');
    const wrapper = document.createElement('div'); wrapper.innerHTML = html;
    while (wrapper.firstChild) {
      if (sentinel) container.insertBefore(wrapper.firstChild, sentinel);
      else container.prepend(wrapper.firstChild);
    }
  });
}

async function _loadFeedPage(container, isFirst) {
  if (_feedLoading || _feedExhausted) return;
  _feedLoading = true;
  let spinner = $('feedLoadMore');
  if (!spinner) { spinner = document.createElement('div'); spinner.id = 'feedLoadMore'; spinner.className = 'loading-center'; spinner.style.padding = '20px'; spinner.innerHTML = '<div class="spinner"></div>'; container.appendChild(spinner); }
  try {
    const blockedUids = await getBlockedUids();
    const snap = await window.XF.getPostsPage(FEED_PAGE_SIZE + 1, _feedOldestTs || undefined);
    let posts = [];
    if (snap.exists()) snap.forEach(c => posts.push({ id: c.key, ...c.val() }));
    posts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (posts.length <= FEED_PAGE_SIZE) _feedExhausted = true;
    posts = posts.slice(0, FEED_PAGE_SIZE);
    posts = posts.filter(p => !blockedUids.has(p.authorUid));
    // Group posts: public groups' posts appear in everyone's feed (members
    // and non-members alike). Private groups' posts are only visible to
    // that group's members — this is the feed-side half of that rule; the
    // Firestore rules are the authoritative half.
    const myGroups = (typeof myGroupIds === 'function') ? myGroupIds() : new Set();
    posts = posts.filter(p => !p.groupId || p.groupPrivacy !== 'private' || myGroups.has(p.groupId));
    if (posts.length > 0) _feedOldestTs = posts[posts.length - 1].createdAt || 0;
    spinner.remove();
    const uids = [...new Set(posts.map(p => p.authorUid).filter(u => u && u !== CLAUDE_ENGINEER_UID))];
    const profiles = {};
    await Promise.allSettled(uids.map(async uid => { try { const s = await window.XF.get('users/' + uid); if (s.exists()) profiles[uid] = s.val(); } catch (e) {} }));
    // Local posts, each carrying its own real timestamp for the merge below.
    const localItems = posts.map(p => ({
      ts: p.createdAt || 0,
      html: p.authorUid === CLAUDE_ENGINEER_UID ? claudeEngineerPostHTML(p) : postHTML(p, profiles[p.authorUid])
    }));

    // Mixed-in real Bluesky posts (see bluesky.js) — a small batch per
    // page load, merged into the timeline by actual post time rather than
    // just appended, so the feed doesn't read as "our posts, then a wad of
    // Bluesky posts at the end."
    let blueskyItems = [];
    if (typeof fetchBlueskyBatch === 'function') {
      try {
        const bskyPosts = await fetchBlueskyBatch(isFirst ? 6 : 3);
        blueskyItems = bskyPosts.map(p => ({ ts: p.createdAt || Date.now(), html: blueskyPostHTML(p) }));
      } catch (e) { /* Bluesky being unreachable should never break the real feed */ }
    }

    const mergedItems = localItems.concat(blueskyItems).sort((a, b) => b.ts - a.ts);
    if (isFirst && mergedItems.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">◪</div><div class="empty-state-title">Nothing here yet</div><div class="empty-state-desc">Be the first to post something</div></div>';
      _feedLoading = false; return;
    }
    const postHTMLs = mergedItems.map(item => item.html);

    // "For You" tray — a horizontal row of reel thumbnails above the feed,
    // first page only. Uses the same reels endpoint/cache and the same
    // personalization as the Reels tab.
    let html;
    if (isFirst) {
      const foryou = await _fetchForYouVideos(8);
      html = forYouTrayHTML(foryou) + postHTMLs.join('');
    } else {
      html = postHTMLs.join('');
    }

    let sentinel = $('feedSentinel');
    if (!sentinel) { sentinel = document.createElement('div'); sentinel.id = 'feedSentinel'; container.appendChild(sentinel); }
    const wrapper = document.createElement('div'); wrapper.innerHTML = html;
    while (wrapper.firstChild) container.insertBefore(wrapper.firstChild, sentinel);
    if (_feedExhausted) {
      sentinel.innerHTML = '<div style="text-align:center;color:var(--text-dim);font-size:0.8rem;padding:20px">You\'re all caught up ✓</div>';
    }
  } catch (err) {
    if (spinner) spinner.remove();
    if (isFirst) container.innerHTML = '<div class="empty-state"><div class="empty-state-desc">Could not load posts</div></div>';
  }
  _feedLoading = false;
}

function _attachFeedScrollListener(container) {
  const mc = document.querySelector('.main-content');
  _feedScrollHandler = function () {
    if (_feedLoading || _feedExhausted) return;
    const sentinel = $('feedSentinel'); if (!sentinel) return;
    const rect = sentinel.getBoundingClientRect();
    if (rect.top < window.innerHeight + 300) _loadFeedPage(container, false);
  };
  if (mc) mc.addEventListener('scroll', _feedScrollHandler, { passive: true });
  window.addEventListener('scroll', _feedScrollHandler, { passive: true });
}

/* ══════════════════════════════════════════════
   POST HTML
══════════════════════════════════════════════ */
function claudeEngineerAvatarHTML(size = 'md') {
  const px = { sm: 32, md: 40, lg: 48, xl: 80 }[size] || 40;
  return `<div class="avatar avatar-${size}" style="background:#111;border:1.5px solid #333;flex-shrink:0;display:flex;align-items:center;justify-content:center;width:${px}px;height:${px}px;border-radius:50%"><svg width="${Math.round(px * 0.5)}" height="${Math.round(px * 0.5)}" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" fill="#e7e9ea" opacity="0.9"/></svg></div>`;
}

function postHTML(post, author) {
  const isLiked = currentUser && post.likes && post.likes[currentUser.uid];
  const likeCount = post.likes ? Object.keys(post.likes).length : 0;
  const commentCount = post.commentCount || 0;
  const isOwner = currentUser && post.authorUid === currentUser.uid;
  let mediaHTML = '';
  if (post.imageURL) mediaHTML = `<img class="post-image" src="${post.imageURL}" alt="Post image" loading="lazy">`;
  if (post.type === 'event') {
    mediaHTML += `<div class="post-event-card">
      <span class="post-event-badge ${post.eventPrivate ? 'badge-private' : 'badge-public'}">${post.eventPrivate ? '⊘ Private Event' : '◯ Open Event'}</span>
      <div class="post-event-title">${escapeHTML(post.eventTitle || '')}</div>
      <div class="post-event-meta">
        ${post.eventDate ? `<span>▦ ${post.eventDate}</span>` : ''}
        ${post.eventTime ? `<span>◷ ${post.eventTime}</span>` : ''}
        ${post.eventLocation ? `<span>◉ ${escapeHTML(post.eventLocation)}</span>` : ''}
      </div>
      <button class="btn btn-outline btn-sm" style="margin-top:10px;font-size:0.8rem" onclick="event.stopPropagation();rsvpEvent('${post.id}')">RSVP</button>
    </div>`;
  }
  return `<div class="post" data-id="${post.id}" data-ts="${post.createdAt || 0}" onclick="openPost('${post.id}',event)">
    <div onclick="openUserProfile('${post.authorUid}',event)">${avatarHTML(author, 'md')}</div>
    <div class="post-body">
      <div class="post-header">
        <span class="post-name">${escapeHTML(author?.displayName || 'Unknown')}</span>
        ${verifiedBadge(author?.verified)}
        <span class="post-handle">@${escapeHTML(author?.handle || 'unknown')}</span>
        <span class="post-time">· ${timeAgo(post.createdAt)}</span>
        ${isOwner ? `<span onclick="event.stopPropagation();deletePost('${post.id}')" style="margin-left:auto;color:var(--text-dim);cursor:pointer;font-size:0.8rem;padding:2px 8px;border-radius:4px" onmouseover="this.style.color='var(--danger)'" onmouseout="this.style.color='var(--text-dim)'">✕</span>` : ''}
      </div>
      ${post.groupId ? `<div class="post-group-tag" onclick="event.stopPropagation();openGroup('${post.groupId}')">→ Posted in <strong>${escapeHTML(post.groupName || 'a group')}</strong></div>` : ''}
      <div class="post-text">${escapeHTML(post.text || '')}</div>
      ${mediaHTML}
      ${post.linkPreview ? linkPreviewCardHTML(post.linkPreview) : ''}
      <div class="post-actions" onclick="event.stopPropagation()">
        <div class="post-action comment" onclick="openPost('${post.id}',event)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${commentCount > 0 ? ' ' + formatCount(commentCount) : ''}</div>
        <div class="post-action like${isLiked ? ' liked' : ''}" onclick="toggleLike('${post.id}',this)"><svg width="18" height="18" viewBox="0 0 24 24" fill="${isLiked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${likeCount > 0 ? ' ' + formatCount(likeCount) : ''}</div>
        <div class="post-action share" onclick="sharePost('${post.id}')"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg></div>
      </div>
    </div>
  </div>`;
}

function claudeEngineerPostHTML(post) {
  const isLiked = currentUser && post.likes && post.likes[currentUser.uid];
  const likeCount = post.likes ? Object.keys(post.likes).length : 0;
  const commentCount = post.commentCount || 0;
  return `<div class="post" data-id="${post.id}" data-ts="${post.createdAt || 0}" onclick="openPost('${post.id}',event)">
    ${claudeEngineerAvatarHTML('md')}
    <div class="post-body">
      <div class="post-header">
        <span class="post-name">Claude Engineer</span>${verifiedBadge(true)}
        <span class="post-handle">@claudeengineer</span>
        <span class="post-time">· ${timeAgo(post.createdAt)}</span>
      </div>
      <div class="post-text">${escapeHTML(post.text || '')}</div>
      <div class="post-actions" onclick="event.stopPropagation()">
        <div class="post-action comment" onclick="openPost('${post.id}',event)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>${commentCount > 0 ? ' ' + formatCount(commentCount) : ''}</div>
        <div class="post-action like${isLiked ? ' liked' : ''}" onclick="toggleLike('${post.id}',this)"><svg width="18" height="18" viewBox="0 0 24 24" fill="${isLiked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>${likeCount > 0 ? ' ' + formatCount(likeCount) : ''}</div>
        <div class="post-action share" onclick="sharePost('${post.id}')"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg></div>
      </div>
    </div>
  </div>`;
}

/* ══════════════════════════════════════════════
   SUBMIT POST
══════════════════════════════════════════════ */
async function submitPost() {
  if (!requireVerified('post')) return;
  const isEvent = $('postTypeEvent')?.classList.contains('active');
  if (_postDateMode === 'schedule') {
    const ts = resolvePostTimestamp();
    if (ts <= Date.now()) { showToast('Pick a future date/time for scheduling'); return; }
    await _saveScheduledPost(ts); return;
  }
  const textarea = $('postText'), text = textarea.value.trim(), imageInput = $('postImageInput');
  if (!text && !imageInput?.files[0]) return showToast('Write something first');
  const btn = $('postSubmitBtn'); btn.disabled = true; btn.textContent = 'Posting…';
  try {
    let imageURL = '';
    if (imageInput?.files[0]) { showToast('Uploading image…'); imageURL = (await window.XCloud.upload(imageInput.files[0], 'x_posts')).url; }
    const ts = _postDateMode === 'backdate' ? resolvePostTimestamp() : Date.now();
    const postData = { authorUid: currentUser.uid, text, imageURL, type: isEvent ? 'event' : 'post', createdAt: ts, commentCount: 0 };
    if (!imageURL) {
      const firstUrl = detectFirstUrl(text);
      if (firstUrl) {
        const cached = window._composerPreviews['postLinkPreview'];
        const preview = (cached && cached.url === firstUrl) ? cached : await fetchLinkPreview(firstUrl);
        if (preview) postData.linkPreview = preview;
      }
    }
    if (isEvent) {
      postData.eventTitle = $('eventTitle').value.trim(); postData.eventDate = $('eventDate').value;
      postData.eventTime = $('eventTime').value; postData.eventLocation = $('eventLocation').value.trim();
      postData.eventPrivate = $('eventPrivate').checked; postData.rsvps = {};
    }
    await window.XF.push('posts', postData);
    await window.XF.update('users/' + currentUser.uid, { postsCount: (currentProfile.postsCount || 0) + 1 });
    currentProfile.postsCount = (currentProfile.postsCount || 0) + 1;
    textarea.value = ''; if (imageInput) imageInput.value = '';
    $('postImagePreview').innerHTML = '';
    removeComposerPreview('postLinkPreview');
    if (isEvent) togglePostType('post');
    setPostDateMode('now'); showToast('Posted!'); renderFeed();
  } catch (err) { showToast('Failed to post — ' + err.message); }
  finally { btn.disabled = false; btn.textContent = 'Post'; }
}

async function deletePost(postId) {
  if (!confirm('Delete this post?')) return;
  try {
    await window.XF.remove('posts/' + postId); await window.XF.remove('comments/' + postId);
    if (currentProfile) { await window.XF.update('users/' + currentUser.uid, { postsCount: Math.max(0, (currentProfile.postsCount || 1) - 1) }); currentProfile.postsCount = Math.max(0, (currentProfile.postsCount || 1) - 1); }
    showToast('Post deleted'); renderFeed();
  } catch (err) { showToast('Could not delete post'); }
}

function previewPostImage(input) {
  const preview = $('postImagePreview');
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = e => { preview.innerHTML = `<div class="img-preview-wrap"><img src="${e.target.result}"><div class="img-preview-remove" onclick="removePostImage()">✕</div></div>`; };
    reader.readAsDataURL(input.files[0]);
  }
}
function removePostImage() { $('postImageInput').value = ''; $('postImagePreview').innerHTML = ''; }

function togglePostType(type) {
  const ef = $('eventFields');
  const bp = $('postTypePost'), be = $('postTypeEvent');
  [bp, be].forEach(b => b?.classList.remove('active'));
  if (ef) ef.style.display = 'none';
  if (type === 'event') { if (ef) ef.style.display = 'block'; be?.classList.add('active'); }
  else bp?.classList.add('active');
}

async function toggleLike(postId, el) {
  if (!requireVerified('like this post')) return;
  const uid = currentUser.uid, snap = await window.XF.get('posts/' + postId + '/likes/' + uid);
  const heartSVG = (filled) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
  function parseFormatted(txt) {
    const s = (txt || '').trim().replace(/[^0-9.KMBkmb]/g, '');
    if (!s) return 0;
    if (/k/i.test(s)) return Math.round(parseFloat(s) * 1000);
    if (/m/i.test(s)) return Math.round(parseFloat(s) * 1e6);
    if (/b/i.test(s)) return Math.round(parseFloat(s) * 1e9);
    return parseInt(s) || 0;
  }
  if (snap.exists()) {
    await window.XF.remove('posts/' + postId + '/likes/' + uid);
    el.classList.remove('liked');
    const c = parseFormatted(el.textContent) || 1;
    el.innerHTML = heartSVG(false) + (Math.max(0, c - 1) > 0 ? ' ' + formatCount(Math.max(0, c - 1)) : '');
  } else {
    await window.XF.set('posts/' + postId + '/likes/' + uid, true);
    el.classList.add('liked');
    const c = parseFormatted(el.textContent) || 0;
    el.innerHTML = heartSVG(true) + ' ' + formatCount(c + 1);
  }
}

async function rsvpEvent(postId) {
  if (!requireVerified('RSVP to this event')) return;
  const uid = currentUser.uid, snap = await window.XF.get('posts/' + postId + '/rsvps/' + uid);
  if (snap.exists()) { await window.XF.remove('posts/' + postId + '/rsvps/' + uid); showToast('RSVP removed'); }
  else {
    await window.XF.set('posts/' + postId + '/rsvps/' + uid, { name: currentProfile?.displayName || 'Member', at: window.XF.ts() });
    showToast('RSVP confirmed!');
    maybeScheduleEventReminder(postId);
  }
}

async function maybeScheduleEventReminder(postId) {
  if (typeof isPushEnabled !== 'function' || !isPushEnabled()) return; // not subscribed — nothing to do
  try {
    const snap = await window.XF.get('posts/' + postId);
    const post = snap.val();
    if (!post?.eventDate) return;
    const eventMs = new Date(post.eventDate + 'T' + (post.eventTime || '09:00')).getTime();
    const reminderMs = eventMs - 60 * 60 * 1000; // 1 hour before
    if (isNaN(eventMs) || reminderMs <= Date.now()) return; // already past — nothing to schedule
    await schedulePushNotification(
      currentUser.uid,
      `Starting soon: ${post.eventTitle || 'Event'}`,
      `${post.eventTitle || 'Your event'} starts in 1 hour${post.eventLocation ? ' at ' + post.eventLocation : ''}.`,
      reminderMs,
      '/post?postId=' + postId
    );
  } catch (e) {}
}

function sharePost(postId) {
  const url = window.location.origin + '/post?postId=' + encodeURIComponent(postId);
  if (navigator.clipboard) navigator.clipboard.writeText(url); showToast('Link copied!');
}

async function openPost(postId, e) {
  if (e) e.stopPropagation();
  showPage('post-detail', { postId });
}

async function renderPostDetail(postId) {
  const container = $('postDetailContent'); if (!container || !postId) return;
  container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
  try {
    const snap = await window.XF.get('posts/' + postId); if (!snap.exists()) { container.innerHTML = '<div class="empty-state"><div class="empty-state-title">Post not found</div></div>'; return; }
    const post = { id: postId, ...snap.val() };
    let author = null;
    if (post.authorUid === CLAUDE_ENGINEER_UID) { author = { displayName: 'Claude Engineer', handle: 'claudeengineer', verified: true, photoURL: '' }; }
    else { const as = await window.XF.get('users/' + post.authorUid); author = as.exists() ? as.val() : null; }
    const postCard = post.authorUid === CLAUDE_ENGINEER_UID ? claudeEngineerPostHTML(post) : postHTML(post, author);
    const staticPost = postCard.replace(/onclick="openPost\('[^']*',event\)"/g, '');
    container.innerHTML = `
      <div style="border-bottom:1px solid var(--border)">${staticPost}</div>
      <div id="commentsArea"></div>
      <div class="post-reply-bar">
        ${avatarHTML(currentProfile, 'sm')}
        <input id="commentInput" class="comment-input" placeholder="Post your reply" onkeydown="if(event.key==='Enter')submitComment('${postId}')">
        <button class="btn btn-accent btn-sm" onclick="submitComment('${postId}')">Reply</button>
      </div>`;
    loadComments(postId);
  } catch (err) { container.innerHTML = '<div class="empty-state"><div class="empty-state-desc">Could not load post</div></div>'; }
}

async function loadComments(postId) {
  const area = $('commentsArea'); if (!area) return;
  area.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
  const snap = await window.XF.get('comments/' + postId);
  const comments = []; if (snap.exists()) snap.forEach(c => comments.push({ id: c.key, ...c.val() }));
  comments.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (comments.length === 0) { area.innerHTML = '<div style="padding:20px 16px;color:var(--text-dim);font-size:0.9rem;text-align:center">No replies yet — be the first!</div>'; return; }
  const uids = [...new Set(comments.map(c => c.authorUid))]; const profiles = {};
  await Promise.all(uids.map(async uid => { const s = await window.XF.get('users/' + uid); if (s.exists()) profiles[uid] = s.val(); }));
  area.innerHTML = '<div class="comments-section">' + comments.map(c => {
    const a = profiles[c.authorUid]; const isOwner = currentUser && c.authorUid === currentUser.uid;
    return `<div class="comment">
      ${avatarHTML(a, 'sm')}
      <div class="comment-body">
        <div class="comment-header">
          <span class="comment-name">${escapeHTML(a?.displayName || 'Unknown')}</span>${verifiedBadge(a?.verified)}
          <span class="comment-time">${timeAgo(c.createdAt)}</span>
          ${isOwner ? `<span onclick="deleteComment('${postId}','${c.id}')" style="margin-left:auto;cursor:pointer;color:var(--text-dim);font-size:0.78rem;padding:2px 6px" title="Delete">✕</span>` : ''}
        </div>
        <div class="comment-text">${escapeHTML(c.text || '')}</div>
      </div>
    </div>`;
  }).join('') + '</div>';
}

async function submitComment(postId) {
  if (!requireVerified('comment')) return;
  const input = $('commentInput'); const text = input.value.trim(); if (!text) return;
  input.value = '';
  await window.XF.push('comments/' + postId, { authorUid: currentUser.uid, text, createdAt: window.XF.ts() });
  const snap = await window.XF.get('posts/' + postId + '/commentCount');
  await window.XF.set('posts/' + postId + '/commentCount', (snap.val() || 0) + 1);
  loadComments(postId);
}

async function deleteComment(postId, commentId) {
  try {
    await window.XF.remove('comments/' + postId + '/' + commentId);
    const snap = await window.XF.get('posts/' + postId + '/commentCount');
    await window.XF.set('posts/' + postId + '/commentCount', Math.max(0, (snap.val() || 1) - 1));
    loadComments(postId);
  } catch (e) { showToast('Could not delete comment'); }
}

function openPostModal() { if (!requireVerified('post')) return; $('newPostModal').classList.add('open'); }

async function submitModalPost() {
  const textarea = $('modalPostText'); const text = textarea.value.trim();
  if (!text) return showToast('Write something first'); if (!requireVerified('post')) return;
  const btn = document.querySelector('#newPostModal .composer-submit');
  btn.disabled = true; btn.textContent = 'Posting…';
  try {
    await window.XF.push('posts', { authorUid: currentUser.uid, text, type: 'post', createdAt: Date.now(), commentCount: 0 });
    textarea.value = ''; closeModal('newPostModal'); showToast('Posted!'); if (activePage === 'feed') renderFeed();
  } catch (e) { showToast('Failed to post'); }
  finally { btn.disabled = false; btn.textContent = 'Post'; }
}

function setPostDateMode(mode) {
  _postDateMode = mode;
  ['now', 'backdate', 'schedule'].forEach(m => { const b = $('opt' + m.charAt(0).toUpperCase() + m.slice(1)); b?.classList.toggle('active', m === mode); });
  const row = $('postDateRow'), hint = $('postDateHint'), input = $('postCustomDate'); if (!row) return;
  row.style.display = mode === 'now' ? 'none' : 'block';
  if (input) {
    if (mode === 'backdate') { input.max = new Date().toISOString().slice(0, 16); input.removeAttribute('min'); if (hint) hint.textContent = 'Post will appear with this historical date'; }
    else { input.min = new Date().toISOString().slice(0, 16); input.removeAttribute('max'); if (hint) hint.textContent = 'Post will go live automatically at this time'; }
  }
}

function resolvePostTimestamp() { const input = $('postCustomDate'); if (!input || !input.value) return Date.now(); const ts = new Date(input.value).getTime(); return isNaN(ts) ? Date.now() : ts; }

/* ══════════════════════════════════════════════
   SCHEDULED POSTS
══════════════════════════════════════════════ */
async function _saveScheduledPost(fireAt) {
  if (!currentUser) return; const text = $('postText')?.value.trim(); if (!text) { showToast('Write something first'); return; }
  await window.XF.push('scheduledPosts', { text, uid: currentUser.uid, displayName: currentProfile.displayName, handle: currentProfile.handle || '', photoURL: currentProfile.photoURL || null, verified: currentProfile.verified || false, fireAt, createdAt: Date.now(), status: 'scheduled' });
  if ($('postText')) $('postText').value = ''; setPostDateMode('now');
  showToast('◷ Post scheduled for ' + new Date(fireAt).toLocaleString());
}

async function runScheduledPosts() {
  if (!currentUser) return;
  try {
    const snap = await window.XF.get('scheduledPosts'); if (!snap.exists()) return;
    const now = Date.now();
    for (const [key, post] of Object.entries(snap.val())) {
      if (post.status === 'scheduled' && post.fireAt <= now && post.uid === currentUser.uid) {
        await window.XF.push('posts', { authorUid: post.uid, text: post.text, type: 'post', createdAt: post.fireAt, commentCount: 0 });
        await window.XF.set('scheduledPosts/' + key + '/status', 'published');
        showToast('◷ Scheduled post published!');
      }
    }
  } catch (e) {}
}
setInterval(runScheduledPosts, 60_000);
