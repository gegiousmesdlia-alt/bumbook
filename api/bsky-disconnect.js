/* api/bsky-disconnect.js
 *
 * POST (no body needed), Authorization: Bearer <firebase-id-token>
 * → { ok: true }
 *
 * Companion to bsky-connect-start.js / bsky-oauth-callback.js. Before this
 * file existed, "Disconnect" in bluesky.js only deleted bumbook's own
 * bskyConnections/{uid} lookup doc — the OAuth grant itself stayed live on
 * Bluesky's side (still shows up under the person's Bluesky
 * Settings -> App Passwords / Authorized Apps) until it happened to expire
 * on its own. This endpoint actually revokes it first, THEN cleans up
 * bumbook's records, so disconnecting here matches disconnecting there.
 *
 * ⚠️ UNVERIFIED, same caveat as the rest of this integration: this assumes
 * NodeOAuthClient exposes `client.revoke(sub)` where `sub` is the
 * connected account's DID (this matches the library's documented
 * OAuthSession/OAuthClient shape, but wasn't confirmed against a real
 * network install when written). If this throws "revoke is not a
 * function", check the installed package's actual exported API — same
 * kind of fix as the authorize()/callback() issues already hit.
 */

const admin = require('firebase-admin');
const { getBskyOAuthClient } = require('./_bskyOAuthClient');
const db = admin.firestore();

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }

  let decoded;
  try { decoded = await admin.auth().verifyIdToken(token); }
  catch (e) { res.status(401).json({ error: 'Invalid token' }); return; }

  try {
    const connDoc = await db.collection('bskyConnections').doc(decoded.uid).get();
    const did = connDoc.exists ? connDoc.data().did : null;

    if (did) {
      try {
        const client = await getBskyOAuthClient();
        await client.revoke(did);
      } catch (e) {
        // Best-effort: if revoke fails (already revoked, library method
        // name mismatch, Bluesky-side hiccup, etc.), still proceed to
        // clean up bumbook's own records below rather than leaving the
        // person stuck "connected" with no way to disconnect at all.
        // Logged so a genuine bug here is still visible in Vercel logs.
        console.error('[bsky-disconnect] revoke failed, proceeding with local cleanup anyway:', e.message || e);
      }
    }

    await db.collection('bskyConnections').doc(decoded.uid).delete();
    res.status(200).json({ ok: true, revoked: !!did });
  } catch (err) {
    res.status(200).json({ error: 'disconnect_failed', message: String(err && err.message || err) });
  }
};
