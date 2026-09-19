/* api/bsky-connect-start.js
 *
 * POST { handle: "someone.bsky.social" }, Authorization: Bearer <firebase-id-token>
 * → { url: "https://bsky.social/oauth/authorize?..." }
 *
 * The bumbook client then does window.location.href = url itself — this
 * endpoint returns the URL rather than redirecting directly, because a
 * plain browser navigation can't carry an Authorization header, and we
 * need to know WHICH bumbook user is connecting before handing back the
 * Bluesky login URL.
 *
 * The bumbook uid is threaded through as the OAuth "state" param, and
 * read back out of it in bsky-oauth-callback.js once Bluesky redirects
 * the person back — that's what lets the callback know which bumbook
 * account to attach the resulting Bluesky session to.
 */

const admin = require('firebase-admin');
const { getBskyOAuthClient } = require('./_bskyOAuthClient');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }

  let decoded;
  try { decoded = await admin.auth().verifyIdToken(token); }
  catch (e) { res.status(401).json({ error: 'Invalid token' }); return; }

  const handle = ((req.body && req.body.handle) || '').trim().replace(/^@/, '');
  if (!handle) { res.status(400).json({ error: 'Missing Bluesky handle' }); return; }

  try {
    const client = await getBskyOAuthClient();
    // ⚠️ UNVERIFIED: exact call signature per @atproto/oauth-client-node's
    // docs is authorize(handle, { state }) returning a URL object/string.
    // If this throws "authorize is not a function" or similar, check the
    // installed package's actual exported API — this is the single most
    // likely line to need adjusting on first real test.
    const url = await client.authorize(handle, { state: decoded.uid });
    res.status(200).json({ url: url.toString() });
  } catch (err) {
    res.status(200).json({ error: 'oauth_start_failed', message: String(err && err.message || err) });
  }
};
