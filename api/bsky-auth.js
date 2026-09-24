/* api/bsky-auth.js — consolidates what used to be four separate files
 * (bsky-connect-start.js, bsky-disconnect.js, bsky-login-start.js,
 * bsky-oauth-callback.js) into one, dispatched by an `?action=` param.
 *
 * WHY: Vercel's free Hobby plan caps a deployment at 12 serverless
 * functions total. Vercel counts FILES in /api, not URLs, so combining
 * these into one file cuts the count without changing what any of them
 * actually do. See api/bluesky.js and api/youtube.js for the same
 * treatment on those sides.
 *
 * POST /api/bsky-auth?action=connect-start   (Authorization: Bearer <token>, body { handle })
 * POST /api/bsky-auth?action=disconnect      (Authorization: Bearer <token>)
 * POST /api/bsky-auth?action=login-start     (body { handle })
 * GET  /api/bsky-auth?action=callback        (Bluesky's OAuth redirect target —
 *                                              this exact URL must be the one
 *                                              listed in oauth-client-metadata.json's
 *                                              redirect_uris AND in
 *                                              _bskyOAuthClient.js's clientMetadata)
 *
 * ⚠️ UNVERIFIED, same caveat as before consolidation: none of the
 * @atproto/oauth-client-node call shapes below (authorize(), callback(),
 * revoke()) have been confirmed against a real network install. See each
 * action's body for the specific line most likely to need fixing first.
 */

const admin = require('firebase-admin');
const crypto = require('crypto');
const { getBskyOAuthClient } = require('./_bskyOAuthClient');
const db = admin.firestore();

const APP_URL = 'https://bumbook.vercel.app'; // MUST match your real deployed domain

async function _getToken(req) {
  const authHeader = req.headers.authorization || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

// ── action: connect-start ──────────────────────────────────────────────
// POST { handle: "someone.bsky.social" }, Authorization: Bearer <firebase-id-token>
// → { url: "https://bsky.social/oauth/authorize?..." }
//
// The bumbook client then does window.location.href = url itself — this
// action returns the URL rather than redirecting directly, because a
// plain browser navigation can't carry an Authorization header, and we
// need to know WHICH bumbook user is connecting before handing back the
// Bluesky login URL. The bumbook uid is threaded through as the OAuth
// "state" param, and read back out of it in the callback action once
// Bluesky redirects the person back.
async function connectStart(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const token = await _getToken(req);
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
    // installed package's actual exported API.
    const url = await client.authorize(handle, { state: decoded.uid });
    res.status(200).json({ url: url.toString() });
  } catch (err) {
    res.status(200).json({ error: 'oauth_start_failed', message: String(err && err.message || err) });
  }
}

// ── action: disconnect ─────────────────────────────────────────────────
// POST (no body needed), Authorization: Bearer <firebase-id-token>
// → { ok: true }
//
// Revokes the OAuth grant on Bluesky's side first, THEN cleans up
// bumbook's own bskyConnections/{uid} lookup doc, so disconnecting here
// matches disconnecting there (rather than leaving the grant live under
// the person's Bluesky Settings -> App Passwords / Authorized Apps).
//
// ⚠️ UNVERIFIED: assumes NodeOAuthClient exposes `client.revoke(sub)`
// where `sub` is the connected account's DID. If this throws "revoke is
// not a function", check the installed package's actual exported API.
async function disconnect(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const token = await _getToken(req);
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
        console.error('[bsky-auth:disconnect] revoke failed, proceeding with local cleanup anyway:', e.message || e);
      }
    }

    await db.collection('bskyConnections').doc(decoded.uid).delete();
    res.status(200).json({ ok: true, revoked: !!did });
  } catch (err) {
    res.status(200).json({ error: 'disconnect_failed', message: String(err && err.message || err) });
  }
}

// ── action: login-start ────────────────────────────────────────────────
// POST { handle: "someone.bsky.social" }  (NO Authorization header — this
// is for signing in, so there's no bumbook session yet)
// → { url: "https://bsky.social/oauth/authorize?..." }
//
// Sibling to connect-start, which links Bluesky to an EXISTING bumbook
// account. This one is for "Continue with Bluesky" on the login/signup
// screen itself — same underlying OAuth client and authorize() call, but
// the "state" param carries a `login:` prefixed nonce instead of a
// bumbook uid, since none exists yet. See the callback action for how it
// tells the two flows apart and what each does once Bluesky redirects back.
async function loginStart(req, res) {
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
}

// ── action: callback ───────────────────────────────────────────────────
// GET target Bluesky redirects back to after the person approves (or
// denies) the connection/login on Bluesky's own site — this is the exact
// URL in oauth-client-metadata.json's redirect_uris. Shared by TWO
// different flows, told apart by the "state" param's shape:
//
//  - state == a bumbook uid          -> CONNECT flow (connect-start
//    action): links Bluesky to the bumbook account the person was
//    already logged into. Records { did, handle } under
//    bskyConnections/{bumbookUid}.
//
//  - state starts with "login:"      -> LOGIN flow (login-start action):
//    "Continue with Bluesky" from the login screen, no bumbook session
//    existed yet. Looks up whether this Bluesky DID is already linked to
//    a bumbook account (reverse lookup on bskyConnections); if so, signs
//    into THAT account. If this DID has never been seen before, creates
//    a brand-new bumbook account for it (mirroring the same
//    users/{uid} + handles/{handle} shape handleGoogleAuth() creates in
//    auth.js, so it behaves like any other account afterward) and links
//    it. Either way, since a GET redirect from Bluesky can't hand the
//    browser an already-signed-in Firebase session directly, it mints a
//    short-lived Firebase custom token and redirects with it in the URL
//    — auth.js picks that up and calls signInWithCustomToken() to
//    actually complete sign-in client-side.
//
// ⚠️ UNVERIFIED (login branch): client.callback()'s return shape, and
// specifically whether the `state` value survives the round-trip
// completely unmodified (needed for the "login:" prefix check to work at
// all), is per-docs, not confirmed against a real network test.
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

async function callback(req, res) {
  try {
    const client = await getBskyOAuthClient();
    const params = new URLSearchParams(req.query);
    params.delete('action'); // ours, not the OAuth library's
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
}

module.exports = async (req, res) => {
  const action = req.query && req.query.action;
  switch (action) {
    case 'connect-start': return connectStart(req, res);
    case 'disconnect':    return disconnect(req, res);
    case 'login-start':   return loginStart(req, res);
    case 'callback':      return callback(req, res);
    default:
      res.status(400).json({ error: 'Unknown or missing action', validActions: ['connect-start', 'disconnect', 'login-start', 'callback'] });
  }
};
