/* api/bluesky-post.js — a single real Bluesky post plus its direct
 * replies, for the in-app post-detail page. Tapping a Bluesky post in the
 * feed (see bluesky.js) lands here instead of leaving the site — this is
 * what makes "fetch comments" possible without needing the visitor's own
 * Bluesky login (we're only ever reading, never posting as them).
 *
 * Public, unauthenticated endpoint (app.bsky.feed.getPostThread) — no key
 * needed, same AppView as bluesky-feed.js. See that file for why the
 * request headers matter here.
 *
 * Only DIRECT replies are returned (not nested reply-to-a-reply threads)
 * — plenty for a flat "comments" list, and avoids building a full
 * recursive thread-tree UI for content that isn't even interactive here.
 *
 * GET /api/bluesky-post?uri=at%3A%2F%2Fdid...
 */

const https = require('https');
const TIMEOUT_MS = 8000;
const APPVIEW = 'https://public.api.bsky.app';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600'); // shorter than the feed — reply counts move faster

  const uri = (req.query.uri || '').trim();
  if (!uri) { res.status(200).json({ post: null, replies: [], configured: true, error: 'missing_uri' }); return; }

  try {
    const params = new URLSearchParams({ uri, depth: '1' }); // depth 1 = direct replies only
    const data = await getJSON(`${APPVIEW}/xrpc/app.bsky.feed.getPostThread?${params}`);

    if (data.error) {
      res.status(200).json({ post: null, replies: [], configured: true, error: 'api', message: data.message || data.error });
      return;
    }

    const thread = data.thread;
    if (!thread || thread.notFound || !thread.post) {
      res.status(200).json({ post: null, replies: [], configured: true, error: 'not_found' });
      return;
    }

    const post = normalizePost(thread.post);
    const replies = (thread.replies || [])
      .filter(r => r && r.post) // skip notFound/blocked reply nodes
      .map(r => normalizePost(r.post))
      .sort((a, b) => b.likeCount - a.likeCount); // most-liked replies first, like a real comments section

    res.status(200).json({ post, replies, configured: true });
  } catch (err) {
    res.status(200).json({ post: null, replies: [], configured: true, error: 'fetch', message: String(err && err.message || err) });
  }
};

function normalizePost(p) {
  const uri = p.uri || '';
  const rkey = uri.split('/').pop();
  return {
    id: uri,
    textHTML: renderFacetedHTML(p.record?.text || '', p.record?.facets),
    createdAt: new Date(p.record?.createdAt || p.indexedAt || Date.now()).getTime(),
    likeCount: p.likeCount || 0,
    repostCount: p.repostCount || 0,
    replyCount: p.replyCount || 0,
    author: {
      did: p.author?.did || '',
      handle: p.author?.handle || 'unknown',
      displayName: p.author?.displayName || p.author?.handle || 'Unknown',
      avatar: p.author?.avatar || ''
    },
    url: p.author?.handle && rkey ? `https://bsky.app/profile/${p.author.handle}/post/${rkey}` : `https://bsky.app`
  };
}

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
}
