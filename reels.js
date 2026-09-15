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

let _reels = [];
let _reelsNextPage = null;
let _reelsTopic = '';
let _reelsLoading = false;
let _reelsObserver = null;
let _reelsMuted = true;

async function renderReels() {
  const container = $('reelsContainer');
  if (!container) return;

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
    if (_reelsTopic) params.set('q', _reelsTopic);
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
    const fresh = data.items.filter(v => !seen.has(v.videoId));
    _reels = isFirst ? data.items : _reels.concat(fresh);
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
  if (_reelsObserver) { _reelsObserver.disconnect(); _reelsObserver = null; }
  const container = $('reelsContainer'); if (!container) return;
  container.querySelectorAll('.reel-slide').forEach(s => _unmountReel(Number(s.dataset.index)));
}
