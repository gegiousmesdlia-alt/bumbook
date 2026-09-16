/* api/youtube-stats.js — real view/like counts for videos already shown
 * in the app, fetched via videos.list.
 *
 * WHY THIS IS CHEAP: videos.list costs 1 quota unit per call — REGARDLESS
 * of how many video IDs or parts you ask for, up to 50 IDs in one call.
 * That's 100x cheaper than the search.list call that finds the videos in
 * the first place (100 units). Batch every request instead of one call
 * per video and this is close to free even at real traffic.
 *
 * GET /api/youtube-stats?ids=id1,id2,id3
 */

const https = require('https');
const TIMEOUT_MS = 8000;

module.exports = async (req, res) => {
  const apiKey = process.env.YOUTUBE_API_KEY;
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=172800'); // 6hrs — view/like counts don't need to be minute-fresh

  if (!apiKey) { res.status(200).json({ stats: {}, configured: false }); return; }

  const ids = String(req.query.ids || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 50); // videos.list's own hard cap per call

  if (!ids.length) { res.status(200).json({ stats: {}, configured: true }); return; }

  try {
    const params = new URLSearchParams({
      part: 'statistics',
      id: ids.join(','),
      key: apiKey
    });
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
        likeCount: it.statistics?.likeCount != null ? Number(it.statistics.likeCount) : null // some videos hide their like count
      };
    });
    res.status(200).json({ stats, configured: true });
  } catch (err) {
    res.status(200).json({ stats: {}, configured: true, error: 'fetch' });
  }
};

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
};
