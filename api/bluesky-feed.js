/* api/bluesky-feed.js — pulls public Bluesky posts to mix into the feed.
 *
 * WHY THIS NEEDS NO API KEY: unlike YouTube, Bluesky's AppView
 * (public.api.bsky.app) serves public read endpoints with no auth at all.
 * That also means there's no per-key quota to protect — the thing worth
 * protecting instead is Bluesky's own rate limiting of our server's IP, so
 * this still caches at the CDN the same way the YouTube routes do.
 *
 * NICHES: rather than one generic firehose, each niche is its own search
 * query, so a post gets tagged with the niche it was fetched for (shown as
 * a small pill in the UI) instead of being dumped in undifferentiated.
 *
 * FOLLOWER COUNTS ARE REAL, NOT RANDOM: after searchPosts returns authors,
 * we batch a getProfiles call (up to 25 actors per call) to pull each
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

// Each niche is a search query. Rotating across these is what makes the
// mixed-in content feel like it's covering different corners of Bluesky
// rather than one repetitive topic. Add more here any time.
const NICHES = {
  tech:     'tech OR programming OR software OR ai',
  sports:   'football OR basketball OR soccer OR nba',
  news:     'breaking news',
  comedy:   'funny OR comedy OR meme',
  music:    'new music OR album OR concert',
  gaming:   'gaming OR videogames OR esports',
  fashion:  'fashion OR style OR outfit',
  food:     'recipe OR cooking OR foodie'
};
const NICHE_KEYS = Object.keys(NICHES);

// Same trick as api/youtube-reels.js's _dayIndex(): a deterministic pick
// shared by everyone hitting the server the same day, so the no-niche
// fallback doesn't fragment the CDN cache into one entry per random pick.
function _dayIndex() { return Math.floor(Date.now() / 86400000); }

module.exports = async (req, res) => {
  // 15 min fresh, serve stale for up to a day while revalidating — plenty
  // fresh for a "recent posts" feed without hammering Bluesky's AppView.
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');

  const nicheParam = (req.query.niche || '').trim();
  const niche = NICHES[nicheParam] ? nicheParam : NICHE_KEYS[_dayIndex() % NICHE_KEYS.length];
  const cursor = (req.query.cursor || '').trim();

  try {
    const searchParams = new URLSearchParams({ q: NICHES[niche], limit: '25', sort: 'latest' });
    if (cursor) searchParams.set('cursor', cursor);
    const searchData = await getJSON(`${APPVIEW}/xrpc/app.bsky.feed.searchPosts?${searchParams}`);

    if (searchData.error) {
      res.status(200).json({ items: [], configured: true, error: 'api', message: searchData.message || searchData.error });
      return;
    }

    const rawPosts = (searchData.posts || [])
      .filter(p => p.record && typeof p.record.text === 'string' && p.record.text.trim() && !p.record.reply); // top-level posts only

    // Batch-fetch real follower counts for every distinct author in this
    // page. getProfiles caps at 25 actors per call, which conveniently
    // matches our own page size, so this is always exactly one extra call.
    const dids = [...new Set(rawPosts.map(p => p.author && p.author.did).filter(Boolean))].slice(0, 25);
    const profileByDid = {};
    if (dids.length) {
      const profParams = new URLSearchParams();
      dids.forEach(d => profParams.append('actors', d));
      try {
        const profData = await getJSON(`${APPVIEW}/xrpc/app.bsky.actor.getProfiles?${profParams}`);
        (profData.profiles || []).forEach(p => { profileByDid[p.did] = p; });
      } catch (e) { /* follower counts are a nice-to-have — fall through without them */ }
    }

    const items = rawPosts.map(p => {
      const uri = p.uri || '';
      const rkey = uri.split('/').pop();
      const profile = profileByDid[p.author?.did] || {};
      return {
        id: uri,
        niche,
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

    res.status(200).json({ items, configured: true, niche, cursor: searchData.cursor || null });
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
    const r = https.get(url, { timeout: TIMEOUT_MS }, resp => {
      let body = '';
      resp.on('data', c => { body += c; });
      resp.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.on('error', reject);
  });
}
