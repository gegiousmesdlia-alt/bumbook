/* api/bluesky-profile.js — real Bluesky profile + their recent public
 * posts, for the in-app "view this Bluesky account" page. Tapping an
 * author name/avatar on a Bluesky post (see bluesky.js) lands here
 * instead of leaving the site.
 *
 * Public, unauthenticated endpoints (app.bsky.actor.getProfile and
 * app.bsky.feed.getAuthorFeed) — no key needed, same AppView as
 * bluesky-feed.js. See that file for why headers matter here.
 *
 * GET /api/bluesky-profile?actor=handle-or-did
 */

const https = require('https');
const TIMEOUT_MS = 8000;
const APPVIEW = 'https://public.api.bsky.app';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');

  const actor = (req.query.actor || '').trim();
  if (!actor) { res.status(200).json({ profile: null, posts: [], configured: true, error: 'missing_actor' }); return; }

  try {
    const [profileData, feedData] = await Promise.all([
      getJSON(`${APPVIEW}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`),
      getJSON(`${APPVIEW}/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actor)}&limit=25&filter=posts_no_replies`)
    ]);

    if (profileData.error) {
      res.status(200).json({ profile: null, posts: [], configured: true, error: 'api', message: profileData.message || profileData.error });
      return;
    }

    const profile = {
      did: profileData.did || '',
      handle: profileData.handle || 'unknown',
      displayName: profileData.displayName || profileData.handle || 'Unknown',
      avatar: profileData.avatar || '',
      banner: profileData.banner || '',
      description: profileData.description || '',
      followersCount: profileData.followersCount || 0,
      followsCount: profileData.followsCount || 0,
      postsCount: profileData.postsCount || 0
    };

    const rawPosts = ((feedData && feedData.feed) || [])
      .map(entry => entry.post)
      .filter(p => p && p.record && typeof p.record.text === 'string' && p.record.text.trim());

    const posts = rawPosts.map(p => {
      const uri = p.uri || '';
      const rkey = uri.split('/').pop();
      return {
        id: uri,
        textHTML: renderFacetedHTML(p.record.text, p.record.facets),
        createdAt: new Date(p.record.createdAt || p.indexedAt || Date.now()).getTime(),
        likeCount: p.likeCount || 0,
        repostCount: p.repostCount || 0,
        replyCount: p.replyCount || 0,
        author: { did: profile.did, handle: profile.handle, displayName: profile.displayName, avatar: profile.avatar, followersCount: profile.followersCount },
        url: `https://bsky.app/profile/${profile.handle}/post/${rkey}`
      };
    });

    res.status(200).json({ profile, posts, configured: true });
  } catch (err) {
    res.status(200).json({ profile: null, posts: [], configured: true, error: 'fetch', message: String(err && err.message || err) });
  }
};

/* ── Facet parsing — byte-accurate, server-side (see bluesky-feed.js for
   full explanation of why this can't just be done with JS string slicing) */
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

function escapeHTML(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHTML(s).replace(/"/g, '&quot;');
}

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
};
