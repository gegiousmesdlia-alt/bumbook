// channel.js — follow a YouTube channel and browse its videos in-app.
'use strict';

/* Denormalized onto the user's own profile doc, same pattern as groupIds
   and reelInterests — avoids needing a separate followers collection for
   something this lightweight. */
function myFollowedChannels() {
  return new Set((currentProfile && currentProfile.followedChannels) || []);
}

function isChannelFollowed(channelId) {
  return myFollowedChannels().has(channelId);
}

async function followChannel(channelId, channelTitle) {
  if (!requireVerified('follow this channel')) return;
  if (!channelId) return;
  currentProfile.followedChannels = [...new Set([...(currentProfile.followedChannels || []), channelId])];
  _paintFollowButtons(channelId, true);
  try {
    await window.XF.fs.collection('users').doc(currentUser.uid)
      .set({ followedChannels: firebase.firestore.FieldValue.arrayUnion(channelId) }, { merge: true });
    showToast(channelTitle ? `Following ${channelTitle}` : 'Following channel');
  } catch (e) {
    currentProfile.followedChannels = currentProfile.followedChannels.filter(c => c !== channelId);
    _paintFollowButtons(channelId, false);
    showToast('Could not follow channel');
  }
}

async function unfollowChannel(channelId) {
  if (!currentUser || !channelId) return;
  currentProfile.followedChannels = (currentProfile.followedChannels || []).filter(c => c !== channelId);
  _paintFollowButtons(channelId, false);
  try {
    await window.XF.fs.collection('users').doc(currentUser.uid)
      .set({ followedChannels: firebase.firestore.FieldValue.arrayRemove(channelId) }, { merge: true });
  } catch (e) {
    currentProfile.followedChannels = [...(currentProfile.followedChannels || []), channelId];
    _paintFollowButtons(channelId, true);
    showToast('Could not unfollow channel');
  }
}

function toggleChannelFollow(channelId, channelTitle) {
  if (isChannelFollowed(channelId)) unfollowChannel(channelId);
  else followChannel(channelId, channelTitle);
}

function _paintFollowButtons(channelId, following) {
  document.querySelectorAll(`[data-channel-follow="${CSS.escape(channelId)}"]`).forEach(btn => {
    btn.textContent = following ? 'Following' : 'Follow';
    btn.classList.toggle('following', following);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   CHANNEL PAGE — auto-generated from live YouTube data (channel info +
   its uploads), so there's nothing to maintain per-channel on our side.
═══════════════════════════════════════════════════════════════════════════ */
let _activeChannel = null;
let _channelVideos = [];
let _channelNextPage = null;

function openChannel(channelId) {
  if (!channelId) return;
  showPage('channel', { channelId });
}

async function renderChannelPage(channelId) {
  const container = $('channelContent');
  if (!container || !channelId) return;
  container.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
  _channelVideos = []; _channelNextPage = null;

  try {
    const resp = await fetch('/api/youtube?action=channel&channelId=' + encodeURIComponent(channelId));
    const data = await resp.json();

    if (!data.configured) { container.innerHTML = _channelMsgHTML('Not set up yet', 'An admin needs to add a YouTube API key.'); return; }
    if (data.error === 'quota') { container.innerHTML = _channelMsgHTML('Taking a break', 'We\'ve hit today\'s YouTube limit — try again tomorrow.'); return; }
    if (data.error === 'not_found' || !data.channel) { container.innerHTML = _channelMsgHTML('Channel not found', ''); return; }
    if (data.error) { container.innerHTML = _channelMsgHTML('Could not load channel', ''); return; }

    _activeChannel = data.channel;
    _channelVideos = data.videos || [];
    _channelNextPage = data.nextPageToken || null;
    _renderChannelUI();
  } catch (e) {
    container.innerHTML = _channelMsgHTML('Could not load channel', 'Check your connection and try again.');
  }
}

function _channelMsgHTML(title, desc) {
  return `<div class="empty-state" style="padding:40px 16px"><div class="empty-state-title">${escapeHTML(title)}</div><div class="empty-state-desc">${escapeHTML(desc || '')}</div></div>`;
}

function _renderChannelUI() {
  const container = $('channelContent');
  const c = _activeChannel;
  const following = isChannelFollowed(c.channelId);
  const subs = c.subscriberCount != null ? formatCount(c.subscriberCount) + ' subscribers' : '';

  container.innerHTML = `
    <div class="channel-header">
      <img class="channel-avatar" src="${escapeHTML(c.thumb)}" alt="">
      <div class="channel-header-body">
        <div class="channel-name">${escapeHTML(c.title)}</div>
        ${subs ? `<div class="channel-meta">${subs}</div>` : ''}
      </div>
      <button class="btn ${following ? 'btn-outline following' : 'btn-primary'}" data-channel-follow="${escapeHTML(c.channelId)}" onclick="toggleChannelFollow('${escapeHTML(c.channelId)}','${escapeHTML((c.title||'').replace(/'/g,"\\'"))}')">${following ? 'Following' : 'Follow'}</button>
    </div>
    ${c.description ? `<div class="channel-desc">${escapeHTML(c.description.slice(0, 200))}${c.description.length > 200 ? '…' : ''}</div>` : ''}
    <div class="channel-video-grid" id="channelVideoGrid"></div>
    <div id="channelLoadMoreWrap" style="text-align:center;padding:16px"></div>
  `;
  _renderChannelVideoGrid();
}

function _renderChannelVideoGrid() {
  const grid = $('channelVideoGrid'); if (!grid) return;
  grid.innerHTML = _channelVideos.map((v, i) => `
    <div class="channel-video-card" onclick="playChannelVideo(${i})">
      <div class="channel-video-thumb"><img src="${escapeHTML(v.thumb)}" alt="" loading="lazy"></div>
      <div class="channel-video-title">${escapeHTML(v.title)}</div>
    </div>`).join('') || _channelMsgHTML('No videos found', '');

  const moreWrap = $('channelLoadMoreWrap');
  if (moreWrap) moreWrap.innerHTML = _channelNextPage
    ? `<button class="btn btn-outline btn-sm" onclick="loadMoreChannelVideos()">Load more</button>` : '';
}

async function loadMoreChannelVideos() {
  if (!_activeChannel || !_channelNextPage) return;
  try {
    const resp = await fetch(`/api/youtube?action=channel&channelId=${encodeURIComponent(_activeChannel.channelId)}&pageToken=${encodeURIComponent(_channelNextPage)}`);
    const data = await resp.json();
    if (data.videos) _channelVideos = _channelVideos.concat(data.videos);
    _channelNextPage = data.nextPageToken || null;
    _renderChannelVideoGrid();
  } catch (e) { showToast('Could not load more videos'); }
}

/* Play a channel video without leaving the page — a fullscreen in-app
   player overlay, same lightweight pattern as the image lightbox. */
function playChannelVideo(index) {
  const v = _channelVideos[index]; if (!v) return;
  const overlay = document.createElement('div');
  overlay.className = 'yt-player-overlay';
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `<div class="yt-player-modal">
    <button class="yt-player-close" onclick="this.closest('.yt-player-overlay').remove()">✕</button>
    ${youtubeEmbedHTML(v.videoId)}
    <div class="yt-player-title">${escapeHTML(v.title)}</div>
  </div>`;
  document.body.appendChild(overlay);
}
