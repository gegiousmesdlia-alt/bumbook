/* api/bluesky-discover.js — real Bluesky ACCOUNTS (not individual posts)
 * for the "🦋 Discover on Bluesky" section. Pulls from the same public
 * "What's Hot" feed as bluesky-feed.js, classifies by the same niche
 * keywords, then dedupes down to one card per author instead of one per
 * post — someone posting 5 times in the batch shouldn't show up 5 times
 * in a people-discovery list.
 *
 * Same public, unauthenticated AppView as the other bluesky-*.js
 * endpoints — see bluesky-feed.js for why the request headers matter and
 * why this uses getFeed rather than searchPosts.
 *
 * GET /api/bluesky-discover?niche=tech
 */

const https = require('https');
const TIMEOUT_MS = 8000;
const APPVIEW = 'https://public.api.bsky.app';
const WHATS_HOT_FEED_URI = 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot';
const FETCH_SIZE = 100; // bigger pull than bluesky-feed.js since we need enough DISTINCT authors after dedup, not just enough posts
const MAX_ACCOUNTS = 12;

const NICHES = {
  tech:     ['tech', 'programming', 'software', ' ai ', 'coding', 'developer'],
  sports:   ['football', 'basketball', 'soccer', 'nba', 'nfl', 'match'],
  news:     ['breaking', 'news', 'report', 'election', 'government'],
  comedy:   ['funny', 'comedy', 'meme', 'lol', 'joke'],
  music:    ['music', 'album', 'concert', 'song', 'band'],
  gaming:   ['gaming', 'videogame', 'esports', 'playstation', 'xbox', 'nintendo'],
  fashion:  ['fashion', 'style', 'outfit', 'wardrobe'],
  food:     ['recipe', 'cooking', 'foodie', 'restaurant', 'baking']
};
const NICHE_KEYS = Object.keys(NICHES);
function _dayIndex() { return Math.floor(Date.now() / 86400000); }
function classifyNiche(text) {
  const lower = ' ' + (text || '').toLowerCase() + ' ';
  for (const key of NICHE_KEYS) {
    if (NICHES[key].some(kw => lower.includes(kw))) return key;
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400'); // accounts churn slower than posts — cache a bit longer

  const nicheParam = (req.query.niche || '').trim();
  const requestedNiche = NICHES[nicheParam] ? nicheParam : NICHE_KEYS[_dayIndex() % NICHE_KEYS.length];

  try {
    const feedParams = new URLSearchParams({ feed: WHATS_HOT_FEED_URI, limit: String(FETCH_SIZE) });
    const feedData = await getJSON(`${APPVIEW}/xrpc/app.bsky.feed.getFeed?${feedParams}`);
    if (feedData.error) {
      res.status(200).json({ accounts: [], configured: true, error: 'api', message: feedData.message || feedData.error });
      return;
    }

    const rawPosts = (feedData.feed || [])
      .map(entry => entry.post)
      .filter(p => p && p.record && typeof p.record.text === 'string' && p.record.text.trim() && p.author?.did);

    // One entry per distinct author, keeping only those whose (first-seen)
    // post matched the requested niche.
    const seenDids = new Set();
    const candidates = [];
    for (const p of rawPosts) {
      if (seenDids.has(p.author.did)) continue;
      if (classifyNiche(p.record.text) !== requestedNiche) continue;
      seenDids.add(p.author.did);
      candidates.push(p.author);
      if (candidates.length >= MAX_ACCOUNTS) break;
    }
    // Backfill with any distinct authors at all if the niche came up thin
    // (100 random trending posts won't evenly cover 8 niches by author).
    if (candidates.length < 6) {
      for (const p of rawPosts) {
        if (seenDids.has(p.author.did)) continue;
        seenDids.add(p.author.did);
        candidates.push(p.author);
        if (candidates.length >= MAX_ACCOUNTS) break;
      }
    }

    // Real follower counts, batched — getProfiles caps at 25 actors/call.
    const dids = candidates.map(a => a.did).slice(0, 25);
    const profileByDid = {};
    if (dids.length) {
      const profParams = new URLSearchParams();
      dids.forEach(d => profParams.append('actors', d));
      try {
        const profData = await getJSON(`${APPVIEW}/xrpc/app.bsky.actor.getProfiles?${profParams}`);
        (profData.profiles || []).forEach(p => { profileByDid[p.did] = p; });
      } catch (e) { /* follower counts are a nice-to-have — fall through without them */ }
    }

    const accounts = candidates.map(a => {
      const profile = profileByDid[a.did] || {};
      return {
        did: a.did,
        handle: a.handle || 'unknown',
        displayName: a.displayName || a.handle || 'Unknown',
        avatar: a.avatar || '',
        description: profile.description || '',
        followersCount: typeof profile.followersCount === 'number' ? profile.followersCount : null
      };
    });

    res.status(200).json({ accounts, configured: true, niche: requestedNiche });
  } catch (err) {
    res.status(200).json({ accounts: [], configured: true, error: 'fetch', message: String(err && err.message || err) });
  }
};

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const options = {
      timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BumBookApp/1.0; +https://bumbook.vercel.app)',
        'Accept': 'application/json'
      }
    };
    const r = https.get(url, options, resp => {
      let body = '';
      resp.on('data', c => { body += c; });
      resp.on('end', () => {
        if (resp.statusCode >= 400) { reject(new Error(`HTTP ${resp.statusCode}: ${body.slice(0, 200)}`)); return; }
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`Non-JSON response: ${body.slice(0, 200)}`)); }
      });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
  });
}
