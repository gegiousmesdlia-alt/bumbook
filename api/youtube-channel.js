/* api/youtube-channel.js — lets a user browse a YouTube channel's videos
 * inside Bum Book, so they never have to leave the site.
 *
 * WHY THIS IS CHEAP: fetching "all of a channel's videos" the obvious way
 * (search.list with channelId) costs 100 quota units per page. Every
 * channel actually has a hidden "uploads" playlist containing every video
 * they've posted, and listing a playlist's contents (playlistItems.list)
 * costs only 1 unit. So: one 1-unit call to find the channel's uploads
 * playlist ID, then 1-unit calls to page through it. ~100x cheaper than
 * search for the exact same result.
 *
 * GET /api/youtube-channel?channelId=UC...&pageToken=...
 */

const https = require('https');
const TIMEOUT_MS = 8000;

module.exports = async (req, res) => {
  const apiKey = process.env.YOUTUBE_API_KEY;
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');

  if (!apiKey) { res.status(200).json({ configured: false }); return; }

  const channelId = (req.query.channelId || '').trim();
  if (!channelId) { res.status(400).json({ error: 'channelId required' }); return; }
  const pageToken = (req.query.pageToken || '').trim();

  try {
    // Channel info + its uploads playlist ID — one call, cheap.
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
};

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
