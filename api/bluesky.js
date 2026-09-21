/* api/bluesky.js — consolidates what used to be four separate files
 * (bluesky-feed.js, bluesky-discover.js, bluesky-profile.js,
 * bluesky-post.js) into one, dispatched by a `?action=` param.
 *
 * WHY: Vercel's free Hobby plan caps a deployment at 12 serverless
 * functions total. Vercel counts FILES in /api, not URLs, so combining
 * these into one file cuts the count without changing what any of them
 * actually do. See api/youtube.js for the same treatment on that side.
 *
 * All four share the same public, unauthenticated Bluesky AppView, the
 * same niche-classification keywords, the same byte-accurate facet-to-HTML
 * parser, and the same "look like a browser, not a bot" fetch headers —
 * so consolidating also means those only need to exist once.
 *
 * GET /api/bluesky?action=feed&niche=tech&cursor=...
 * GET /api/bluesky?action=discover&niche=tech
 * GET /api/bluesky?action=profile&actor=handle-or-did
 * GET /api/bluesky?action=post&uri=at%3A%2F%2Fdid...
 */

const https = require('https');
const TIMEOUT_MS = 8000;
const APPVIEW = 'https://public.api.bsky.app';
const WHATS_HOT_FEED_URI = 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot';

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
  const action = req.query.action;
  if (action === 'feed') return handleFeed(req, res);
  if (action === 'discover') return handleDiscover(req, res);
  if (action === 'profile') return handleProfile(req, res);
  if (action === 'post') return handlePost(req, res);
  if (action === 'searchActors') return handleSearchActors(req, res);
  res.status(400).json({ error: 'action must be feed, discover, profile, post, or searchActors' });
};

/* ── searchActors: find real Bluesky accounts by name/handle, for the
   Discover page's unified search ─────────────────────────────────────── */
async function handleSearchActors(req, res) {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  const q = (req.query.q || '').trim();
  if (!q) { res.status(200).json({ accounts: [], configured: true }); return; }
  try {
    const params = new URLSearchParams({ q, limit: '10' });
    const data = await getJSON(`${APPVIEW}/xrpc/app.bsky.actor.searchActors?${params}`);
    if (data.error) { res.status(200).json({ accounts: [], configured: true, error: 'api', message: data.message || data.error }); return; }
    const accounts = (data.actors || []).map(a => ({
      did: a.did, handle: a.handle || 'unknown', displayName: a.displayName || a.handle || 'Unknown',
      avatar: a.avatar || '', description: a.description || '',
      followersCount: typeof a.followersCount === 'number' ? a.followersCount : null
    }));
    res.status(200).json({ accounts, configured: true });
  } catch (err) {
    res.status(200).json({ accounts: [], configured: true, error: 'fetch', message: String(err && err.message || err) });
  }
}

/* ── feed: posts mixed into the main timeline, bucketed by niche ──────── */
async function handleFeed(req, res) {
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  const nicheParam = (req.query.niche || '').trim();
  const requestedNiche = NICHES[nicheParam] ? nicheParam : NICHE_KEYS[_dayIndex() % NICHE_KEYS.length];
  const cursor = (req.query.cursor || '').trim();

  try {
    const feedParams = new URLSearchParams({ feed: WHATS_HOT_FEED_URI, limit: '50' });
    if (cursor) feedParams.set('cursor', cursor);
    const feedData = await getJSON(`${APPVIEW}/xrpc/app.bsky.feed.getFeed?${feedParams}`);
    if (feedData.error) { res.status(200).json({ items: [], configured: true, error: 'api', message: feedData.message || feedData.error }); return; }

    const rawPosts = (feedData.feed || [])
      .map(entry => entry.post)
      .filter(p => p && p.record && typeof p.record.text === 'string' && p.record.text.trim() && !p.record.reply);

    const matched = rawPosts.filter(p => classifyNiche(p.record.text) === requestedNiche);
    const unclassified = rawPosts.filter(p => classifyNiche(p.record.text) === null);
    const chosen = matched.length >= 3 ? matched : matched.concat(unclassified).slice(0, 8);

    const dids = [...new Set(chosen.map(p => p.author && p.author.did).filter(Boolean))].slice(0, 25);
    const profileByDid = await batchGetProfiles(dids);

    const items = chosen.map(p => {
      const uri = p.uri || '';
      const rkey = uri.split('/').pop();
      const profile = profileByDid[p.author?.did] || {};
      return {
        id: uri,
        niche: classifyNiche(p.record.text) || requestedNiche,
        textHTML: renderFacetedHTML(p.record.text, p.record.facets),
        createdAt: new Date(p.record.createdAt || p.indexedAt || Date.now()).getTime(),
        likeCount: p.likeCount || 0, repostCount: p.repostCount || 0, replyCount: p.replyCount || 0,
        author: {
          did: p.author?.did || '', handle: p.author?.handle || 'unknown',
          displayName: p.author?.displayName || p.author?.handle || 'Unknown', avatar: p.author?.avatar || '',
          followersCount: typeof profile.followersCount === 'number' ? profile.followersCount : null
        },
        url: p.author?.handle && rkey ? `https://bsky.app/profile/${p.author.handle}/post/${rkey}` : `https://bsky.app`
      };
    });
    res.status(200).json({ items, configured: true, niche: requestedNiche, cursor: feedData.cursor || null });
  } catch (err) {
    res.status(200).json({ items: [], configured: true, error: 'fetch', message: String(err && err.message || err) });
  }
}

/* ── discover: real ACCOUNTS (deduped authors), for the Discover page ─── */
async function handleDiscover(req, res) {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  const nicheParam = (req.query.niche || '').trim();
  const requestedNiche = NICHES[nicheParam] ? nicheParam : NICHE_KEYS[_dayIndex() % NICHE_KEYS.length];
  const MAX_ACCOUNTS = 12;

  try {
    const feedParams = new URLSearchParams({ feed: WHATS_HOT_FEED_URI, limit: '100' });
    const feedData = await getJSON(`${APPVIEW}/xrpc/app.bsky.feed.getFeed?${feedParams}`);
    if (feedData.error) { res.status(200).json({ accounts: [], configured: true, error: 'api', message: feedData.message || feedData.error }); return; }

    const rawPosts = (feedData.feed || [])
      .map(entry => entry.post)
      .filter(p => p && p.record && typeof p.record.text === 'string' && p.record.text.trim() && p.author?.did);

    const seenDids = new Set();
    const candidates = [];
    for (const p of rawPosts) {
      if (seenDids.has(p.author.did)) continue;
      if (classifyNiche(p.record.text) !== requestedNiche) continue;
      seenDids.add(p.author.did);
      candidates.push(p.author);
      if (candidates.length >= MAX_ACCOUNTS) break;
    }
    if (candidates.length < 6) {
      for (const p of rawPosts) {
        if (seenDids.has(p.author.did)) continue;
        seenDids.add(p.author.did);
        candidates.push(p.author);
        if (candidates.length >= MAX_ACCOUNTS) break;
      }
    }

    const dids = candidates.map(a => a.did).slice(0, 25);
    const profileByDid = await batchGetProfiles(dids);

    const accounts = candidates.map(a => {
      const profile = profileByDid[a.did] || {};
      return {
        did: a.did, handle: a.handle || 'unknown', displayName: a.displayName || a.handle || 'Unknown',
        avatar: a.avatar || '', description: profile.description || '',
        followersCount: typeof profile.followersCount === 'number' ? profile.followersCount : null
      };
    });
    res.status(200).json({ accounts, configured: true, niche: requestedNiche });
  } catch (err) {
    res.status(200).json({ accounts: [], configured: true, error: 'fetch', message: String(err && err.message || err) });
  }
}

/* ── profile: real Bluesky profile + their recent public posts ────────── */
async function handleProfile(req, res) {
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  const actor = (req.query.actor || '').trim();
  if (!actor) { res.status(200).json({ profile: null, posts: [], configured: true, error: 'missing_actor' }); return; }

  try {
    const [profileData, feedData] = await Promise.all([
      getJSON(`${APPVIEW}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`),
      getJSON(`${APPVIEW}/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actor)}&limit=25`)
    ]);
    if (profileData.error) { res.status(200).json({ profile: null, posts: [], configured: true, error: 'api', message: profileData.message || profileData.error }); return; }

    const profile = {
      did: profileData.did || '', handle: profileData.handle || 'unknown',
      displayName: profileData.displayName || profileData.handle || 'Unknown',
      avatar: profileData.avatar || '', banner: profileData.banner || '', description: profileData.description || '',
      followersCount: profileData.followersCount || 0, followsCount: profileData.followsCount || 0, postsCount: profileData.postsCount || 0
    };

    const rawPosts = ((feedData && feedData.feed) || [])
      .map(entry => entry.post)
      .filter(p => p && p.record && typeof p.record.text === 'string' && p.record.text.trim());

    const posts = rawPosts.map(p => {
      const uri = p.uri || '';
      const rkey = uri.split('/').pop();
      return {
        id: uri, textHTML: renderFacetedHTML(p.record.text, p.record.facets),
        createdAt: new Date(p.record.createdAt || p.indexedAt || Date.now()).getTime(),
        likeCount: p.likeCount || 0, repostCount: p.repostCount || 0, replyCount: p.replyCount || 0,
        author: { did: profile.did, handle: profile.handle, displayName: profile.displayName, avatar: profile.avatar, followersCount: profile.followersCount },
        url: `https://bsky.app/profile/${profile.handle}/post/${rkey}`
      };
    });
    res.status(200).json({ profile, posts, configured: true });
  } catch (err) {
    res.status(200).json({ profile: null, posts: [], configured: true, error: 'fetch', message: String(err && err.message || err) });
  }
}

/* ── post: a single post + its direct replies ("comments") ────────────── */
async function handlePost(req, res) {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  const uri = (req.query.uri || '').trim();
  if (!uri) { res.status(200).json({ post: null, replies: [], configured: true, error: 'missing_uri' }); return; }

  try {
    const params = new URLSearchParams({ uri, depth: '1' });
    const data = await getJSON(`${APPVIEW}/xrpc/app.bsky.feed.getPostThread?${params}`);
    if (data.error) { res.status(200).json({ post: null, replies: [], configured: true, error: 'api', message: data.message || data.error }); return; }

    const thread = data.thread;
    if (!thread || thread.notFound || !thread.post) { res.status(200).json({ post: null, replies: [], configured: true, error: 'not_found' }); return; }

    const post = normalizePost(thread.post);
    const replies = (thread.replies || [])
      .filter(r => r && r.post)
      .map(r => normalizePost(r.post))
      .sort((a, b) => b.likeCount - a.likeCount);
    res.status(200).json({ post, replies, configured: true });
  } catch (err) {
    res.status(200).json({ post: null, replies: [], configured: true, error: 'fetch', message: String(err && err.message || err) });
  }
}

function normalizePost(p) {
  const uri = p.uri || '';
  const rkey = uri.split('/').pop();
  return {
    id: uri,
    textHTML: renderFacetedHTML(p.record?.text || '', p.record?.facets),
    createdAt: new Date(p.record?.createdAt || p.indexedAt || Date.now()).getTime(),
    likeCount: p.likeCount || 0, repostCount: p.repostCount || 0, replyCount: p.replyCount || 0,
    author: { did: p.author?.did || '', handle: p.author?.handle || 'unknown', displayName: p.author?.displayName || p.author?.handle || 'Unknown', avatar: p.author?.avatar || '' },
    url: p.author?.handle && rkey ? `https://bsky.app/profile/${p.author.handle}/post/${rkey}` : `https://bsky.app`
  };
}

/* ── Shared: batch real follower counts (getProfiles caps at 25/call) ─── */
async function batchGetProfiles(dids) {
  const profileByDid = {};
  if (!dids.length) return profileByDid;
  const profParams = new URLSearchParams();
  dids.forEach(d => profParams.append('actors', d));
  try {
    const profData = await getJSON(`${APPVIEW}/xrpc/app.bsky.actor.getProfiles?${profParams}`);
    (profData.profiles || []).forEach(p => { profileByDid[p.did] = p; });
  } catch (e) { /* follower counts are a nice-to-have — fall through without them */ }
  return profileByDid;
}

/* ── Shared: facet parsing — byte-accurate, server-side ────────────────
   Bluesky stores rich-text ranges (links/mentions/hashtags) as BYTE
   offsets into the UTF-8 encoding of the post text, not character
   offsets — Buffer gives byte-accurate slicing here, so clients just drop
   in ready-made HTML instead of redoing this with plain JS strings. */
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
    if (byteStart < cursor || byteEnd > bytes.length || byteStart >= byteEnd) continue;
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

function escapeHTML(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeAttr(s) { return escapeHTML(s).replace(/"/g, '&quot;'); }

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
