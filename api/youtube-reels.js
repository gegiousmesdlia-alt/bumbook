/* api/youtube-reels.js — fetches short-form YouTube videos to power the
 * Reels feed.
 *
 * WHY THIS IS A SERVER ROUTE AND NOT A DIRECT BROWSER CALL:
 *   1. The API key stays server-side. A key shipped in frontend JS is
 *      public, and anyone can lift it and burn your quota.
 *   2. It lets us cache. The YouTube Data API gives 10,000 quota units a
 *      day, and a single search.list call costs 100 units — that's only
 *      ~100 searches per DAY for the entire site. Without caching, roughly
 *      100 users opening Reels once would exhaust the whole quota. With the
 *      CDN cache below, thousands of users share the same handful of calls.
 *
 * SETUP (see YOUTUBE_REELS_SETUP.md):
 *   Set YOUTUBE_API_KEY in Vercel → Settings → Environment Variables.
 *   Without it, this route returns an empty list and the app shows a
 *   friendly "not configured yet" message rather than breaking.
 */

const https = require('https');

const TIMEOUT_MS = 8000;

// Topics the reels feed pulls from. Rotating across these gives variety
// without needing a per-user recommendation engine.
const DEFAULT_TOPICS = [
  'funny shorts', 'football skills', 'music shorts', 'comedy skits',
  'street food', 'life hacks', 'dance shorts', 'amazing facts',
  'movie scenes', 'satisfying videos'
];

module.exports = async (req, res) => {
  const apiKey = process.env.YOUTUBE_API_KEY;

  // CDN cache: one shared upstream fetch serves everyone for 30 min, and
  // keeps serving slightly-stale results for a day while it refreshes in
  // the background. This is what keeps the daily quota survivable.
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');

  if (!apiKey) {
    res.status(200).json({ items: [], configured: false });
    return;
  }

  const q = (req.query.q || '').trim();
  const pageToken = (req.query.pageToken || '').trim();
  const topic = q || DEFAULT_TOPICS[Math.floor(Math.random() * DEFAULT_TOPICS.length)];

  try {
    const params = new URLSearchParams({
      part: 'snippet',
      q: topic,
      type: 'video',
      videoDuration: 'short',          // < 4 minutes — reel-length
      videoEmbeddable: 'true',         // skip anything we can't actually play
      videoSyndicated: 'true',         // playable outside youtube.com
      maxResults: '25',
      safeSearch: 'moderate',
      key: apiKey
    });
    if (pageToken) params.set('pageToken', pageToken);

    const data = await getJSON(`https://www.googleapis.com/youtube/v3/search?${params}`);

    if (data.error) {
      const reason = data.error?.errors?.[0]?.reason || '';
      const quotaHit = reason === 'quotaExceeded' || reason === 'dailyLimitExceeded';
      res.status(200).json({
        items: [], configured: true,
        error: quotaHit ? 'quota' : 'api',
        message: data.error.message || 'YouTube API error'
      });
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

    res.status(200).json({
      items,
      configured: true,
      topic,
      nextPageToken: data.nextPageToken || null
    });
  } catch (err) {
    res.status(200).json({ items: [], configured: true, error: 'fetch', message: String(err && err.message || err) });
  }
};

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const r = https.get(url, { timeout: TIMEOUT_MS }, resp => {
      let body = '';
      resp.on('data', chunk => { body += chunk; });
      resp.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Bad JSON from YouTube')); }
      });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('YouTube request timed out')); });
    r.on('error', reject);
  });
}
