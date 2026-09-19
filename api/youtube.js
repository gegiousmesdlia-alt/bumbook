/* api/youtube.js — consolidates what used to be three separate files
 * (youtube-channel.js, youtube-reels.js, youtube-stats.js) into one.
 *
 * WHY: Vercel's free Hobby plan caps a deployment at 12 serverless
 * functions total, and this project crossed that line once Bluesky and
 * the OAuth endpoints were added. Vercel counts FILES in /api, not URLs,
 * so combining these three into one file — dispatched by a `?action=`
 * param — cuts the count without changing what any of them actually do.
 *
 * GET /api/youtube?action=channel&channelId=UC...&pageToken=...
 * GET /api/youtube?action=reels&q=...&pageToken=...
 * GET /api/youtube?action=stats&ids=id1,id2,id3
 */

const https = require('https');
const TIMEOUT_MS = 8000;

module.exports = async (req, res) => {
  const action = req.query.action;
  if (action === 'channel') return handleChannel(req, res);
  if (action === 'reels') return handleReels(req, res);
  if (action === 'stats') return handleStats(req, res);
  res.status(400).json({ error: 'action must be channel, reels, or stats' });
};

/* ── channel: browse a YouTube channel's videos inside Bum Book ─────────
 * WHY THIS IS CHEAP: fetching "all of a channel's videos" the obvious way
 * (search.list with channelId) costs 100 quota units per page. Every
 * channel has a hidden "uploads" playlist containing every video they've
 * posted, and listing a playlist's contents (playlistItems.list) costs
 * only 1 unit. So: one 1-unit call to find the uploads playlist ID, then
 * 1-unit calls to page through it — ~100x cheaper than search. */
async function handleChannel(req, res) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  res.setHeader('Cache-Control', 's-maxage=10800, stale-while-revalidate=172800'); // 3hrs
  if (!apiKey) { res.status(200).json({ configured: false }); return; }

  const channelId = (req.query.channelId || '').trim();
  if (!channelId) { res.status(400).json({ error: 'channelId required' }); return; }
  const pageToken = (req.query.pageToken || '').trim();

  try {
    const chParams = new URLSearchParams({ part: 'snippet,contentDetails,statistics', id: channelId, key: apiKey });
    const chData = await getJSON(`https://www.googleapis.com/youtube/v3/channels?${chParams}`);
    if (chData.error) return respondError(res, chData.error);

    const channel = chData.items && chData.items[0];
    if (!channel) { res.status(200).json({ configured: true, error: 'not_found' }); return; }

    const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
    let videos = [];
    let nextPageToken = null;

    if (uploadsPlaylistId) {
      const plParams = new URLSearchParams({ part: 'snippet', playlistId: uploadsPlaylistId, maxResults: '24', key: apiKey });
      if (pageToken) plParams.set('pageToken', pageToken);
      const plData = await getJSON(`https://www.googleapis.com/youtube/v3/playlistItems?${plParams}`);
      if (plData.error) return respondError(res, plData.error);

      videos = (plData.items || [])
        .filter(it => it.snippet?.resourceId?.videoId)
        .map(it => ({
          videoId: it.snippet.resourceId.videoId,
          title: it.snippet.title || '',
          thumb: it.snippet.thumbnails?.high?.url || it.snippet.thumbnails?.default?.url || '',
          publishedAt: it.snippet.publishedAt || ''
        }));
      nextPageToken = plData.nextPageToken || null;
    }

    res.status(200).json({
      configured: true,
      channel: {
        channelId,
        title: channel.snippet?.title || '',
        thumb: channel.snippet?.thumbnails?.high?.url || channel.snippet?.thumbnails?.default?.url || '',
        subscriberCount: channel.statistics?.hiddenSubscriberCount ? null : Number(channel.statistics?.subscriberCount || 0),
        description: channel.snippet?.description || ''
      },
      videos,
      nextPageToken
    });
  } catch (err) {
    res.status(200).json({ configured: true, error: 'fetch' });
  }
}

/* ── reels: short-form YouTube videos for the Reels feed ─────────────── */
const DEFAULT_TOPICS = [
  'funny shorts', 'football skills', 'music shorts', 'comedy skits',
  'street food', 'life hacks', 'dance shorts', 'amazing facts',
  'movie scenes', 'satisfying videos'
];
function _dayIndex() { return Math.floor(Date.now() / 86400000); }

async function handleReels(req, res) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  res.setHeader('Cache-Control', 's-maxage=10800, stale-while-revalidate=172800');
  if (!apiKey) { res.status(200).json({ items: [], configured: false }); return; }

  const q = (req.query.q || '').trim();
  const pageToken = (req.query.pageToken || '').trim();
  const topic = q || DEFAULT_TOPICS[_dayIndex() % DEFAULT_TOPICS.length];

  try {
    const params = new URLSearchParams({
      part: 'snippet', q: topic, type: 'video',
      videoDuration: 'short', videoEmbeddable: 'true', videoSyndicated: 'true',
      maxResults: '25', safeSearch: 'moderate', key: apiKey
    });
    if (pageToken) params.set('pageToken', pageToken);

    const data = await getJSON(`https://www.googleapis.com/youtube/v3/search?${params}`);
    if (data.error) {
      const reason = data.error?.errors?.[0]?.reason || '';
      const quotaHit = reason === 'quotaExceeded' || reason === 'dailyLimitExceeded';
      res.status(200).json({ items: [], configured: true, error: quotaHit ? 'quota' : 'api', message: data.error.message || 'YouTube API error' });
      return;
    }

    const items = (data.items || [])
      .filter(it => it.id && it.id.videoId)
      .map(it => ({
        videoId: it.id.videoId,
        title: it.snippet?.title || '',
        channel: it.snippet?.channelTitle || '',
        channelId: it.snippet?.channelId || '',
        publishedAt: it.snippet?.publishedAt || '',
        thumb: it.snippet?.thumbnails?.high?.url || it.snippet?.thumbnails?.default?.url || ''
      }));

    res.status(200).json({ items, configured: true, topic, nextPageToken: data.nextPageToken || null });
  } catch (err) {
    res.status(200).json({ items: [], configured: true, error: 'fetch', message: String(err && err.message || err) });
  }
}

/* ── stats: real view/like counts for videos already shown in the app ── */
async function handleStats(req, res) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=172800'); // 6hrs
  if (!apiKey) { res.status(200).json({ stats: {}, configured: false }); return; }

  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
  if (!ids.length) { res.status(200).json({ stats: {}, configured: true }); return; }

  try {
    const params = new URLSearchParams({ part: 'statistics', id: ids.join(','), key: apiKey });
    const data = await getJSON(`https://www.googleapis.com/youtube/v3/videos?${params}`);
    if (data.error) {
      const reason = data.error?.errors?.[0]?.reason || '';
      res.status(200).json({ stats: {}, configured: true, error: (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') ? 'quota' : 'api' });
      return;
    }
    const stats = {};
    (data.items || []).forEach(it => {
      stats[it.id] = {
        viewCount: Number(it.statistics?.viewCount || 0),
        likeCount: it.statistics?.likeCount != null ? Number(it.statistics.likeCount) : null
      };
    });
    res.status(200).json({ stats, configured: true });
  } catch (err) {
    res.status(200).json({ stats: {}, configured: true, error: 'fetch' });
  }
}

function respondError(res, error) {
  const reason = error?.errors?.[0]?.reason || '';
  res.status(200).json({ configured: true, error: (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') ? 'quota' : 'api' });
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const r = https.get(url, { timeout: TIMEOUT_MS }, resp => {
      let body = '';
      resp.on('data', c => { body += c; });
      resp.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
  });
}
