/* api/bsky-oauth-callback.js
 *
 * GET target Bluesky redirects back to after the person approves (or
 * denies) the connection on Bluesky's own site — this is the exact URL
 * in oauth-client-metadata.json's redirect_uris.
 *
 * No Authorization header is possible here (it's Bluesky's server doing
 * the redirect, not our own client code) — instead, the bumbook uid that
 * started this travels via the OAuth "state" param (set in
 * bsky-connect-start.js) and the library validates it wasn't tampered
 * with as part of completing the exchange.
 *
 * On success: records { did, handle } under bskyConnections/{bumbookUid}
 * (the actual tokens/DPoP key live in bskyOAuthSessions, keyed by DID,
 * managed internally by the library via _bskyOAuthClient.js's
 * sessionStore — this doc is just the "which bumbook user owns which
 * Bluesky DID" lookup).
 */

const admin = require('firebase-admin');
const { getBskyOAuthClient } = require('./_bskyOAuthClient');
const db = admin.firestore();

const APP_URL = 'https://bumbook.vercel.app'; // MUST match your real deployed domain

module.exports = async (req, res) => {
  try {
    const client = await getBskyOAuthClient();
    const params = new URLSearchParams(req.query);
    // ⚠️ UNVERIFIED: exact return shape per docs is { session, state } —
    // session.did should be the connected account's DID. If this throws
    // or session.did is undefined, check the library's actual callback()
    // return type.
    const { session, state } = await client.callback(params);
    const bumbookUid = state;
    if (!bumbookUid || !session || !session.did) throw new Error('Missing state or session after callback');

    let handle = session.did;
    try {
      // Best-effort — a resolvable handle is nicer to show in the UI than
      // a bare DID, but the connection itself doesn't depend on this
      // succeeding.
      const { Agent } = await import('@atproto/api');
      const agent = new Agent(session);
      const profile = await agent.getProfile({ actor: session.did });
      if (profile && profile.data && profile.data.handle) handle = profile.data.handle;
    } catch (e) { /* fall back to showing the DID — not fatal */ }

    await db.collection('bskyConnections').doc(bumbookUid).set({
      did: session.did, handle, connectedAt: Date.now()
    });

    res.writeHead(302, { Location: `${APP_URL}/settings?bskyConnected=1` });
    res.end();
  } catch (err) {
    res.writeHead(302, { Location: `${APP_URL}/settings?bskyConnected=0&err=${encodeURIComponent(String(err && err.message || err))}` });
    res.end();
  }
};
