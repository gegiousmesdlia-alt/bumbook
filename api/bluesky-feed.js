/* api/bluesky-feed.js — pulls public Bluesky posts to mix into the feed.
 *
 * WHY "getFeed" INSTEAD OF "searchPosts": this originally called
 * app.bsky.feed.searchPosts with a keyword query per niche. Bluesky's own
 * docs actually flag that endpoint with "may require authentication...
 * for some service providers and implementations" — and in testing it
 * started returning a bare 403 HTML page (not even a JSON error) instead
 * of results, meaning it's not reliably public. app.bsky.feed.getFeed
 * against Bluesky's own official "What's Hot" discover feed has no such
 * caveat anywhere — it's the literal feed unauthenticated visitors see on
 * bsky.app itself, so it can't require auth without breaking Bluesky's own
 * homepage. Niches are now applied AFTER fetching: each post's text is
 * matched against per-niche keyword lists, so the "search per niche"
 * concept survives without depending on a flaky endpoint.
 *
 * WHY THIS NEEDS NO API KEY: unlike YouTube, Bluesky's AppView
 * (public.api.bsky.app) serves this endpoint with no auth at all. That
 * also means there's no per-key quota to protect — the thing worth
 * protecting instead is Bluesky's own rate limiting of our server's IP, so
 * this still caches at the CDN the same way the YouTube routes do.
 *
 * FOLLOWER COUNTS ARE REAL, NOT RANDOM: after getFeed returns authors, we
 * batch a getProfiles call (up to 25 actors per call) to pull each
 * author's actual public follower count. It's one extra cheap call and
 * means the number shown is really theirs, not made up.
 *
 * FACETS: Bluesky stores rich-text ranges (links/mentions/hashtags) as
 * BYTE offsets into the UTF-8 encoding of the post text, not character
 * offsets — a multi-byte emoji or accented character earlier in the post
 * shifts every later offset if you slice by character instead of byte.
 * Parsing happens here, server-side, with Buffer (byte-accurate), so the
 * client just drops in ready-made HTML instead of redoing this in the
 * browser with plain JS strings (UTF-16 there, wrong unit entirely).
 *
 * GET /api/bluesky-feed?niche=tech&cursor=...
 */

const https = require('https');
const TIMEOUT_MS = 8000;
const APPVIEW = 'https://public.api.bsky.app';
// Bluesky's own official "What's Hot" discover feed generator — public,
// unauthenticated, the same one bsky.app's own Discover tab uses.
const WHATS_HOT_FEED_URI = 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot';
const FETCH_SIZE = 50; // pulled once, then bucketed into niches client-of-this-function-side

// Keyword lists used to CLASSIFY fetched posts into a niche after the
// fact (not to query Bluesky — see file header for why that changed).
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

// Same trick as api/youtube-reels.js's _dayIndex(): a deterministic pick
// shared by everyone hitting the server the same day, so the no-niche
// fallback doesn't fragment the CDN cache into one entry per random pick.
function _dayIndex() { return Math.floor(Date.now() / 86400000); }

function classifyNiche(text) {
  const lower = ' ' + (text || '').toLowerCase() + ' ';
  for (const key of NICHE_KEYS) {
    if (NICHES[key].some(kw => lower.includes(kw))) return key;
  }
  return null; // no keyword match — still shown, just labeled "Trending" client-side
}

module.exports = async (req, res) => {
  // 15 min fresh, serve stale for up to a day while revalidating — plenty
  // fresh for a "recent posts" feed without hammering Bluesky's AppView.
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');

  const nicheParam = (req.query.niche || '').trim();
  const requestedNiche = NICHES[nicheParam] ? nicheParam : NICHE_KEYS[_dayIndex() % NICHE_KEYS.length];
  const cursor = (req.query.cursor || '').trim();

  try {
    const feedParams = new URLSearchParams({ feed: WHATS_HOT_FEED_URI, limit: String(FETCH_SIZE) });
    if (cursor) feedParams.set('cursor', cursor);
    const feedData = await getJSON(`${APPVIEW}/xrpc/app.bsky.feed.getFeed?${feedParams}`);

    if (feedData.error) {
      res.status(200).json({ items: [], configured: true, error: 'api', message: feedData.message || feedData.error });
      return;
    }

    const rawPosts = (feedData.feed || [])
      .map(entry => entry.post)
      .filter(p => p && p.record && typeof p.record.text === 'string' && p.record.text.trim() && !p.record.reply); // top-level posts only

    // Bucket by niche; if the requested niche came up short (keyword
    // matching won't evenly cover 50 random trending posts), backfill with
    // unclassified ones so the feed never ends up empty for a niche that
    // just didn't come up much in this particular batch.
    const matched = rawPosts.filter(p => classifyNiche(p.record.text) === requestedNiche);
    const unclassified = rawPosts.filter(p => classifyNiche(p.record.text) === null);
    const chosen = matched.length >= 3 ? matched : matched.concat(unclassified).slice(0, 8);

    // Batch-fetch real follower counts for every distinct author in this
    // selection. getProfiles caps at 25 actors per call.
    const dids = [...new Set(chosen.map(p => p.author && p.author.did).filter(Boolean))].slice(0, 25);
    const profileByDid = {};
    if (dids.length) {
      const profParams = new URLSearchParams();
      dids.forEach(d => profParams.append('actors', d));
      try {
        const profData = await getJSON(`${APPVIEW}/xrpc/app.bsky.actor.getProfiles?${profParams}`);
        (profData.profiles || []).forEach(p => { profileByDid[p.did] = p; });
      } catch (e) { /* follower counts are a nice-to-have — fall through without them */ }
    }

    const items = chosen.map(p => {
      const uri = p.uri || '';
      const rkey = uri.split('/').pop();
      const profile = profileByDid[p.author?.did] || {};
      return {
        id: uri,
        niche: classifyNiche(p.record.text) || requestedNiche,
        textHTML: renderFacetedHTML(p.record.text, p.record.facets),
        createdAt: new Date(p.record.createdAt || p.indexedAt || Date.now()).getTime(),
        likeCount: p.likeCount || 0,
        repostCount: p.repostCount || 0,
        replyCount: p.replyCount || 0,
        author: {
          did: p.author?.did || '',
          handle: p.author?.handle || 'unknown',
          displayName: p.author?.displayName || p.author?.handle || 'Unknown',
          avatar: p.author?.avatar || '',
          followersCount: typeof profile.followersCount === 'number' ? profile.followersCount : null
        },
        url: p.author?.handle && rkey ? `https://bsky.app/profile/${p.author.handle}/post/${rkey}` : `https://bsky.app`
      };
    });

    res.status(200).json({ items, configured: true, niche: requestedNiche, cursor: feedData.cursor || null });
  } catch (err) {
    res.status(200).json({ items: [], configured: true, error: 'fetch', message: String(err && err.message || err) });
  }
};

/* ── Facet parsing — byte-accurate, server-side ──────────────────────── */
function renderFacetedHTML(text, facets) {
  if (!facets || !facets.length) return escapeHTML(text);
  const bytes = Buffer.from(text, 'utf8');
  const sorted = [...facets]
    .filter(f => f.index && typeof f.index.byteStart === 'number' && typeof f.index.byteEnd === 'number')
    .sort((a, b) => a.index.byteStart - b.index.byteStart);

  let html = '';
  let cursor = 0;
  for (const f of sorted) {
    const { byteStart, byteEnd } = f.index;
    if (byteStart < cursor || byteEnd > bytes.length || byteStart >= byteEnd) continue; // skip overlapping/malformed ranges
    html += escapeHTML(bytes.slice(cursor, byteStart).toString('utf8'));
    const segment = bytes.slice(byteStart, byteEnd).toString('utf8');
    const feature = (f.features || [])[0] || {};
    if (feature.$type === 'app.bsky.richtext.facet#link' && feature.uri) {
      html += `<a href="${escapeAttr(feature.uri)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHTML(segment)}</a>`;
    } else if (feature.$type === 'app.bsky.richtext.facet#mention' && feature.did) {
      html += `<a href="${escapeAttr('https://bsky.app/profile/' + feature.did)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHTML(segment)}</a>`;
    } else if (feature.$type === 'app.bsky.richtext.facet#tag' && feature.tag) {
      html += `<a href="${escapeAttr('https://bsky.app/hashtag/' + feature.tag)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHTML(segment)}</a>`;
    } else {
      html += escapeHTML(segment);
    }
    cursor = byteEnd;
  }
  html += escapeHTML(bytes.slice(cursor).toString('utf8'));
  return html;
}

function escapeHTML(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHTML(s).replace(/"/g, '&quot;');
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    // No User-Agent/Accept headers made this look like a bare bot request
    // to Cloudflare (which fronts Bluesky's API) and it was returning an
    // HTML challenge page instead of JSON — these headers fix that.
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
