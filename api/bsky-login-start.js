/* api/bsky-login-start.js
 *
 * POST { handle: "someone.bsky.social" }  (NO Authorization header — this
 * is for signing in, so there's no bumbook session yet)
 * → { url: "https://bsky.social/oauth/authorize?..." }
 *
 * Sibling to bsky-connect-start.js, which links Bluesky to an EXISTING
 * bumbook account. This one is for "Continue with Bluesky" on the
 * login/signup screen itself — same underlying OAuth client and
 * authorize() call, but the "state" param carries a `login:` prefixed
 * nonce instead of a bumbook uid, since none exists yet. See
 * bsky-oauth-callback.js for how it tells the two flows apart and what
 * each does once Bluesky redirects back.
 *
 * ⚠️ Same "unverified until tested against a real network" caveat as the
 * rest of this integration (see _bskyOAuthClient.js's header) — this is
 * new code, built the same way the rest of this OAuth flow was, on the
 * documented API shape rather than a confirmed live test.
 */

const crypto = require('crypto');
const { getBskyOAuthClient } = require('./_bskyOAuthClient');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const handle = ((req.body && req.body.handle) || '').trim().replace(/^@/, '');
  if (!handle) { res.status(400).json({ error: 'Missing Bluesky handle' }); return; }

  try {
    const client = await getBskyOAuthClient();
    const state = 'login:' + crypto.randomBytes(16).toString('hex');
    const url = await client.authorize(handle, { state });
    res.status(200).json({ url: url.toString() });
  } catch (err) {
    res.status(200).json({ error: 'oauth_start_failed', message: String(err && err.message || err) });
  }
};
