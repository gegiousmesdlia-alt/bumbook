/* api/bsky-oauth-callback.js
 *
 * GET target Bluesky redirects back to after the person approves (or
 * denies) the connection/login on Bluesky's own site — this is the
 * exact URL in oauth-client-metadata.json's redirect_uris. Shared by
 * TWO different flows, told apart by the "state" param's shape:
 *
 *  - state == a bumbook uid          -> CONNECT flow (bsky-connect-
 *    start.js): links Bluesky to the bumbook account the person was
 *    already logged into. Records { did, handle } under
 *    bskyConnections/{bumbookUid}.
 *
 *  - state starts with "login:"      -> LOGIN flow (bsky-login-
 *    start.js): "Continue with Bluesky" from the login screen, no
 *    bumbook session existed yet. Looks up whether this Bluesky DID is
 *    already linked to a bumbook account (reverse lookup on
 *    bskyConnections); if so, signs into THAT account. If this DID has
 *    never been seen before, creates a brand-new bumbook account for
 *    it (mirroring the same users/{uid} + handles/{handle} shape
 *    handleGoogleAuth() creates in auth.js, so it behaves like any
 *    other account afterward) and links it. Either way, since a GET
 *    redirect from Bluesky can't hand the browser an already-signed-in
 *    Firebase session directly, it mints a short-lived Firebase custom
 *    token and redirects with it in the URL — auth.js picks that up and
 *    calls signInWithCustomToken() to actually complete sign-in
 *    client-side.
 *
 * ⚠️ UNVERIFIED (login branch is new, same caveat as the rest of this
 * integration): client.callback()'s return shape, and specifically
 * whether the `state` value survives the round-trip completely
 * unmodified (needed for the "login:" prefix check to work at all), is
 * per-docs, not confirmed against a real network test when written.
 */

const admin = require('firebase-admin');
const crypto = require('crypto');
const { getBskyOAuthClient } = require('./_bskyOAuthClient');
const db = admin.firestore();

const APP_URL = 'https://bumbook.vercel.app'; // MUST match your real deployed domain

async function _resolveHandle(session, fallback) {
  try {
    const { Agent } = await import('@atproto/api');
    const agent = new Agent(session);
    const profile = await agent.getProfile({ actor: session.did });
    if (profile && profile.data && profile.data.handle) return profile.data.handle;
  } catch (e) { /* not fatal — caller already has a DID to fall back to */ }
  return fallback;
}

// Deterministic, filesystem/Firestore-safe uid for a first-time Bluesky
// login — same DID always maps to the same bumbook uid, so a reverse
// lookup failing to find bskyConnections (e.g. it was somehow deleted)
// doesn't create a second duplicate account for the same person.
function _uidForDid(did) {
  return 'bsky_' + crypto.createHash('sha256').update(did).digest('hex').slice(0, 32);
}

async function _uniqueHandleFrom(rawHandle) {
  let base = String(rawHandle || 'member').split('.')[0].toLowerCase().replace(/[^a-z0-9_]/g, '') || 'member';
  let handle = base;
  let tries = 0;
  while ((await db.collection('handles').doc(handle).get()).exists && tries < 5) {
    handle = base + '_' + crypto.randomBytes(3).toString('hex');
    tries++;
  }
  return handle;
}

module.exports = async (req, res) => {
  try {
    const client = await getBskyOAuthClient();
    const params = new URLSearchParams(req.query);
    // ⚠️ UNVERIFIED: exact return shape per docs is { session, state } —
    // session.did should be the connected account's DID. If this throws
    // or session.did is undefined, check the library's actual callback()
    // return type.
    const { session, state } = await client.callback(params);
    if (!state || !session || !session.did) throw new Error('Missing state or session after callback');

    if (String(state).startsWith('login:')) {
      // ── LOGIN / SIGNUP flow ──────────────────────────────────────
      const existing = await db.collection('bskyConnections').where('did', '==', session.did).limit(1).get();
      let bumbookUid;

      if (!existing.empty) {
        bumbookUid = existing.docs[0].id;
      } else {
        bumbookUid = _uidForDid(session.did);
        const handle = await _resolveHandle(session, session.did);
        const uniqueHandle = await _uniqueHandleFrom(handle);

        // Mirror handleGoogleAuth()'s account shape in auth.js so a
        // Bluesky-created account behaves identically to any other from
        // here on — nothing downstream needs to know how it was made.
        await admin.auth().createUser({ uid: bumbookUid, displayName: handle }).catch(err => {
          // "already exists" is fine (e.g. this DID's account was
          // created by a previous run whose bskyConnections write
          // failed) — anything else is a real problem.
          if (err.code !== 'auth/uid-already-exists') throw err;
        });
        await db.collection('users').doc(bumbookUid).set({
          uid: bumbookUid, displayName: handle, handle: uniqueHandle, email: '',
          bio: '', photoURL: '', verified: false,
          followersCount: 0, followingCount: 0, postsCount: 0,
          joinedAt: Date.now(),
        }, { merge: true });
        await db.collection('handles').doc(uniqueHandle).set({ value: bumbookUid });
        await db.collection('bskyConnections').doc(bumbookUid).set({ did: session.did, handle, connectedAt: Date.now() });
      }

      const customToken = await admin.auth().createCustomToken(bumbookUid);
      res.writeHead(302, { Location: `${APP_URL}/?bskyLoginToken=${encodeURIComponent(customToken)}` });
      res.end();
      return;
    }

    // ── CONNECT flow (existing bumbook session) ──────────────────────
    const bumbookUid = state;
    const handle = await _resolveHandle(session, session.did);
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
