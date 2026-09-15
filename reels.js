// reels.js — TikTok/Facebook-style vertical reels feed backed by YouTube.
'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   HOW THIS WORKS
   ─────────────────────────────────────────────────────────────────────────
   Videos come from /api/youtube-reels (server-side so the API key stays
   secret and responses are CDN-cached — see that file for the quota math).

   Playback is a per-slide YouTube <iframe>. The important part is that we
   DON'T mount 25 iframes at once — that would be 25 video players loading
   simultaneously. Instead an IntersectionObserver mounts the iframe only
   for the slide currently on screen (plus neighbours for a smooth swipe)
   and unmounts the rest, so exactly one video is ever really playing.

   Autoplay note: browsers only allow autoplay when muted, so reels start
   muted with an obvious unmute control — same as every other reels feed.
═══════════════════════════════════════════════════════════════════════════ */

// Mirrors DEFAULT_TOPICS in api/youtube-reels.js. Kept here too so
// personalization (picking a topic weighted toward what the user likes)
// happens client-side, where we actually know currentProfile.reelInterests
// — the server stays a stateless fetcher.
const REEL_TOPICS = [
  'funny shorts', 'football skills', 'music shorts', 'comedy skits',
  'street food', 'life hacks', 'dance shorts', 'amazing facts',
  'movie scenes', 'satisfying videos'
];

let _reels = [];
let _reelsNextPage = null;
let _reelsTopic = '';       // explicit search override, from the search box
let _reelsLoading = false;
let _reelsObserver = null;
let _reelsMuted = true;
let _reelLikesCache = {};   // videoId -> { count, liked }

/* Weighted-random topic pick, favoring whatever the user has liked reels
   from before. Pure random when they have no history yet or when they're
   actively searching for something specific. */
function _pickReelTopic() {
  if (_reelsTopic) return _reelsTopic; // explicit search always wins
  const interests = (currentProfile && currentProfile.reelInterests) || [];
  // 65% of the time, if we have interest data, pick from what they've
  // liked before; otherwise (or the other 35%, for discovery) pick fresh.
  if (interests.length && Math.random() < 0.65) {
    return interests[Math.floor(Math.random() * interests.length)];
  }
  return REEL_TOPICS[Math.floor(Math.random() * REEL_TOPICS.length)];
}

/* Record that the user engaged with a topic, so future fetches lean
   toward it. Capped and de-duped — this is a lightweight taste signal,
   not a full watch-history log. */
async function _recordReelInterest(topic) {
  if (!currentUser || !topic) return;
  const current = (currentProfile.reelInterests || []).filter(t => t !== topic);
  current.unshift(topic);
  currentProfile.reelInterests = current.slice(0, 15);
  try {
    await window.XF.fs.collection('users').doc(currentUser.uid)
      .set({ reelInterests: currentProfile.reelInterests }, { merge: true });
  } catch (e) {}
}

async function renderReels() {
  const container = $('reelsContainer');
  if (!container) return;
  document.body.classList.add('reels-fullscreen');

  // Already loaded this session — just re-attach observers and leave the
  // user where they were rather than yanking them back to the top.
  if (_reels.length) { _attachReelObserver(); return; }

  container.innerHTML = '<div class="reels-msg"><div class="spinner"></div></div>';
  await _loadReels(true);
}

async function _loadReels(isFirst = false) {
  if (_reelsLoading) return;
  _reelsLoading = true;
  try {
    const params = new URLSearchParams();
    const topic = _pickReelTopic();
    if (topic) params.set('q', topic);
    if (!isFirst && _reelsNextPage) params.set('pageToken', _reelsNextPage);

    const resp = await fetch('/api/youtube-reels?' + params.toString());
    const data = await resp.json();

    if (!data.configured) { _renderReelsMessage('Reels aren\'t set up yet', 'An admin needs to add a YouTube API key. See YOUTUBE_REELS_SETUP.md'); return; }
    if (data.error === 'quota') { _renderReelsMessage('Reels are taking a break', 'We\'ve hit today\'s YouTube limit. Try again tomorrow.'); return; }
    if (data.error) { _renderReelsMessage('Could not load reels', data.message || 'Something went wrong.'); return; }
    if (!data.items || !data.items.length) {
      if (isFirst) _renderReelsMessage('No reels found', 'Try a different search.');
      return;
    }

    // De-dupe — paging and topic rotation can repeat videos.
    const seen = new Set(_reels.map(r => r.videoId));
    const incoming = data.items.map(v => ({ ...v, topic: data.topic || topic }));
    const fresh = incoming.filter(v => !seen.has(v.videoId));
    _reels = isFirst ? incoming : _reels.concat(fresh);
    _reelsNextPage = data.nextPageToken || null;

    _renderReelSlides(isFirst);
  } catch (e) {
    if (isFirst) _renderReelsMessage('Could not load reels', 'Check your connection and try again.');
  } finally {
    _reelsLoading = false;
  }
}

function _renderReelsMessage(title, desc) {
  const container = $('reelsContainer'); if (!container) return;
  container.innerHTML = `<div class="reels-msg">
    <div class="reels-msg-title">${escapeHTML(title)}</div>
    <div class="reels-msg-desc">${escapeHTML(desc || '')}</div>
    <button class="btn btn-outline btn-sm" style="margin-top:14px" onclick="refreshReels()">Try again</button>
  </div>`;
}

function _renderReelSlides(replace) {
  const container = $('reelsContainer'); if (!container) return;
  const slides = _reels.map((v, i) => `
    <div class="reel-slide" data-index="${i}" data-vid="${escapeHTML(v.videoId)}">
      <div class="reel-player" id="reelPlayer${i}">
        <img class="reel-thumb" src="${escapeHTML(v.thumb)}" alt="" loading="lazy">
      </div>
      <div class="reel-overlay">
        <div class="reel-info">
          <div class="reel-channel">${escapeHTML(v.channel)}</div>
          <div class="reel-title">${escapeHTML(v.title)}</div>
        </div>
        <div class="reel-actions">
          <button class="reel-action reel-like-btn" id="reelLikeBtn${i}" onclick="toggleReelLike('${escapeHTML(v.videoId)}',${i})" title="Like">
            <span id="reelLikeIcon${i}">${ICON_HEART}</span>
            <span class="reel-like-count" id="reelLikeCount${i}"></span>
          </button>
          <button class="reel-action" onclick="toggleReelMute()" title="Sound">
            <span id="reelMuteIcon">${_reelsMuted ? ICON_MUTED : ICON_UNMUTED}</span>
          </button>
          <button class="reel-action" onclick="shareReel('${escapeHTML(v.videoId)}')" title="Share">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
          </button>
          <button class="reel-action" onclick="shareReelToFeed('${escapeHTML(v.videoId)}')" title="Post to feed">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>
      </div>
    </div>`).join('');

  if (replace) container.innerHTML = slides;
  else {
    const wrap = document.createElement('div');
    wrap.innerHTML = slides;
    // Only append the genuinely new ones
    const existing = container.querySelectorAll('.reel-slide').length;
    Array.from(wrap.children).slice(existing).forEach(c => container.appendChild(c));
  }
  _attachReelObserver();
}

const ICON_HEART = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
const ICON_HEART_FILLED = '<svg width="22" height="22" viewBox="0 0 24 24" fill="#ff3b5c" stroke="#ff3b5c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
const ICON_MUTED = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
const ICON_UNMUTED = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';

/* Mount/unmount iframes as slides scroll in and out of view. */
function _attachReelObserver() {
  const container = $('reelsContainer'); if (!container) return;
  if (_reelsObserver) _reelsObserver.disconnect();

  _reelsObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      const slide = entry.target;
      const idx = Number(slide.dataset.index);
      if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
        _mountReel(idx);
        // Prefetch more when nearing the end of the loaded set
        if (idx >= _reels.length - 3 && _reelsNextPage) _loadReels(false);
      } else {
        _unmountReel(idx);
      }
    });
  }, { threshold: [0, 0.6, 1] });

  container.querySelectorAll('.reel-slide').forEach(s => _reelsObserver.observe(s));
}

function _mountReel(index) {
  const host = $('reelPlayer' + index);
  if (!host || host.querySelector('iframe')) return;
  const vid = _reels[index]?.videoId;
  if (!vid) return;
  const params = new URLSearchParams({
    autoplay: '1',
    mute: _reelsMuted ? '1' : '0',
    controls: '0',
    rel: '0',
    playsinline: '1',
    loop: '1',
    playlist: vid            // required for loop=1 to work on a single video
  });
  host.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(vid)}?${params}"
    title="Reel" allow="autoplay; encrypted-media; picture-in-picture"
    allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  _loadReelLikeState(vid, index);
}

function _unmountReel(index) {
  const host = $('reelPlayer' + index);
  if (!host) return;
  const frame = host.querySelector('iframe');
  if (frame) {
    // Removing the iframe is what actually stops playback and frees memory.
    frame.remove();
    const v = _reels[index];
    if (v) host.innerHTML = `<img class="reel-thumb" src="${escapeHTML(v.thumb)}" alt="" loading="lazy">`;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   LIKES — shared logic, used by both the Reels tab and the main feed's
   "For You" YouTube cards (see reelLikeHTML() below and feed.js).
   Count + "did I like it" live in Firestore under reels/{videoId}, only
   fetched lazily (on mount / on render), never for the whole batch upfront.
═══════════════════════════════════════════════════════════════════════════ */
async function _loadReelLikeState(videoId, uiIndex) {
  if (_reelLikesCache[videoId] !== undefined) { _paintReelLike(videoId, uiIndex); return; }
  try {
    const snap = await window.XF.get('reels/' + videoId);
    const count = snap.exists() ? (snap.val().likeCount || 0) : 0;
    let liked = false;
    if (currentUser) {
      const likeSnap = await window.XF.get('reelLikes/' + videoId + '/' + currentUser.uid);
      liked = likeSnap.exists();
    }
    _reelLikesCache[videoId] = { count, liked };
  } catch (e) {
    _reelLikesCache[videoId] = { count: 0, liked: false };
  }
  _paintReelLike(videoId, uiIndex);
}

function _paintReelLike(videoId, uiIndex) {
  const state = _reelLikesCache[videoId]; if (!state) return;
  if (uiIndex !== undefined) {
    const icon = $('reelLikeIcon' + uiIndex);
    const count = $('reelLikeCount' + uiIndex);
    const btn = $('reelLikeBtn' + uiIndex);
    if (icon) icon.innerHTML = state.liked ? ICON_HEART_FILLED : ICON_HEART;
    if (count) count.textContent = state.count > 0 ? formatCount(state.count) : '';
    if (btn) btn.classList.toggle('liked', state.liked);
  }
  // Also paint any For You feed card for this same video, if present.
  document.querySelectorAll(`[data-yt-like="${CSS.escape(videoId)}"]`).forEach(el => {
    const icon = el.querySelector('.yt-like-icon');
    const count = el.querySelector('.yt-like-count');
    if (icon) icon.innerHTML = state.liked ? ICON_HEART_FILLED : ICON_HEART;
    if (count) count.textContent = state.count > 0 ? formatCount(state.count) : '';
    el.classList.toggle('liked', state.liked);
  });
}

async function toggleReelLike(videoId, uiIndex) {
  if (!requireVerified('like this')) return;
  const state = _reelLikesCache[videoId] || { count: 0, liked: false };
  const wasLiked = state.liked;
  // Optimistic update — feels instant, corrected below if the write fails.
  state.liked = !wasLiked;
  state.count = Math.max(0, state.count + (wasLiked ? -1 : 1));
  _reelLikesCache[videoId] = state;
  _paintReelLike(videoId, uiIndex);

  try {
    if (wasLiked) {
      await window.XF.fs.collection('reels').doc(videoId).collection('likes').doc(currentUser.uid).delete();
      await window.XF.update('reels/' + videoId, { likeCount: firebase.firestore.FieldValue.increment(-1) });
    } else {
      await window.XF.set('reelLikes/' + videoId + '/' + currentUser.uid, { uid: currentUser.uid, likedAt: Date.now() });
      await window.XF.update('reels/' + videoId, { likeCount: firebase.firestore.FieldValue.increment(1) });
      const v = _reels.find(r => r.videoId === videoId);
      if (v && v.topic) _recordReelInterest(v.topic);
    }
  } catch (e) {
    // Roll back on failure
    state.liked = wasLiked;
    state.count = Math.max(0, state.count + (wasLiked ? 1 : -1));
    _reelLikesCache[videoId] = state;
    _paintReelLike(videoId, uiIndex);
    showToast('Could not save like');
  }
}

function toggleReelMute() {
  _reelsMuted = !_reelsMuted;
  const icon = $('reelMuteIcon');
  if (icon) icon.innerHTML = _reelsMuted ? ICON_MUTED : ICON_UNMUTED;
  // Remount whatever is currently on screen so the new mute state applies.
  const container = $('reelsContainer'); if (!container) return;
  container.querySelectorAll('.reel-slide').forEach(slide => {
    const idx = Number(slide.dataset.index);
    if (slide.querySelector('iframe')) { _unmountReel(idx); _mountReel(idx); }
  });
  document.querySelectorAll('#reelMuteIcon').forEach(el => { el.innerHTML = _reelsMuted ? ICON_MUTED : ICON_UNMUTED; });
}

function refreshReels() {
  _reels = []; _reelsNextPage = null;
  const c = $('reelsContainer'); if (c) c.innerHTML = '<div class="reels-msg"><div class="spinner"></div></div>';
  _loadReels(true);
}

function searchReels(q) {
  _reelsTopic = (q || '').trim();
  refreshReels();
}

function shareReel(videoId) {
  const url = 'https://www.youtube.com/watch?v=' + videoId;
  if (navigator.share) navigator.share({ url }).catch(() => {});
  else navigator.clipboard?.writeText(url).then(() => showToast('Link copied')).catch(() => showToast(url));
}

/* Post a reel to your own Bum Book feed — it'll render with the normal
   inline YouTube player via linkPreviewCardHTML(). */
async function shareReelToFeed(videoId) {
  if (!requireVerified('post this')) return;
  const v = _reels.find(r => r.videoId === videoId);
  try {
    await window.XF.push('posts', {
      authorUid: currentUser.uid,
      text: v?.title ? v.title : '',
      createdAt: Date.now(),
      commentCount: 0,
      linkPreview: {
        url: 'https://www.youtube.com/watch?v=' + videoId,
        title: v?.title || '',
        siteName: 'YouTube',
        image: v?.thumb || '',
        description: v?.channel || ''
      }
    });
    await window.XF.update('users/' + currentUser.uid, { postsCount: (currentProfile.postsCount || 0) + 1 });
    currentProfile.postsCount = (currentProfile.postsCount || 0) + 1;
    showToast('Shared to your feed');
  } catch (e) { showToast('Could not share'); }
}

/* Stop playback when navigating away — otherwise audio keeps running. */
function stopAllReels() {
  document.body.classList.remove('reels-fullscreen');
  if (_reelsObserver) { _reelsObserver.disconnect(); _reelsObserver = null; }
  const container = $('reelsContainer'); if (!container) return;
  container.querySelectorAll('.reel-slide').forEach(s => _unmountReel(Number(s.dataset.index)));
}
