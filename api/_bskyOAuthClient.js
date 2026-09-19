/* api/_bskyOAuthClient.js — shared by bsky-connect-start.js and
 * bsky-oauth-callback.js (and later bsky-send-message.js). Filename
 * starts with "_" so Vercel does NOT turn this into its own route —
 * confirmed via Vercel's own docs: files starting with "_" inside /api
 * are skipped and never become functions.
 *
 * ⚠️ UNVERIFIED — READ BEFORE DEBUGGING ⚠️
 * This was written against @atproto/oauth-client-node's documented API
 * shape, but I have no network access to actually run `npm install` or
 * test a real OAuth round-trip against Bluesky's servers from where this
 * was written. Two specific things most likely to need correcting on
 * first real test:
 *   1. Package name: if `npm install` fails on @atproto/oauth-client-node,
 *      try @bluesky-social/oauth-client-node instead — the org appears to
 *      be mid-migration between npm scopes.
 *   2. Store method names: the get/set/del names below are my best
 *      understanding of the library's expected interface, not confirmed
 *      against its actual TypeScript types. If the client throws on
 *      construction, this is the first place to check.
 *
 * WHAT THIS FILE HOLDS: two Firestore-backed stores the OAuth client
 * needs internally —
 *   - stateStore:   short-lived (minutes), one entry per in-progress
 *                   OAuth attempt (PKCE verifier, DPoP key, the
 *                   bumbook uid who started it). Collection: bskyOAuthState
 *   - sessionStore: long-lived, one entry per Bluesky account someone has
 *                   connected (tokens + DPoP key, keyed by their DID).
 *                   Collection: bskyOAuthSessions
 * Both store RAW OAuth material (tokens, keys) — this is exactly the
 * "bumbook now holds live credentials" responsibility flagged earlier.
 * Firestore's own access rules already block ALL client-side access to
 * these two collections (see firestore.rules) — only this Admin-SDK code
 * can ever read them.
 */

const admin = require('firebase-admin');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const CLIENT_ID = 'https://bumbook.vercel.app/oauth-client-metadata.json'; // MUST exactly match oauth-client-metadata.json AND your real deployed domain

class FirestoreStore {
  constructor(collectionName) { this.coll = db.collection(collectionName); }
  async get(key) {
    const snap = await this.coll.doc(_safeKey(key)).get();
    return snap.exists ? snap.data().value : undefined;
  }
  async set(key, value) {
    await this.coll.doc(_safeKey(key)).set({ value, updatedAt: Date.now() });
  }
  async del(key) {
    await this.coll.doc(_safeKey(key)).delete();
  }
}
// OAuth state/session keys can contain characters Firestore doc IDs
// don't allow (like "/") — base64url-encoding keeps this collision-safe
// and always valid regardless of what the library uses as a key.
function _safeKey(key) {
  return Buffer.from(String(key), 'utf8').toString('base64url');
}

let _clientPromise = null;
/* Lazily builds the OAuth client once per serverless instance (cheap to
   reuse across invocations on a warm start, per the library's own
   recommended pattern). Dynamic import() rather than require() because
   @atproto packages are commonly ESM-only — require() would throw
   ERR_REQUIRE_ESM even though this file itself is CommonJS. */
async function getBskyOAuthClient() {
  if (_clientPromise) return _clientPromise;
  _clientPromise = (async () => {
    const { NodeOAuthClient } = await import('@atproto/oauth-client-node');
    return new NodeOAuthClient({
      clientMetadata: {
        client_id: CLIENT_ID,
        client_name: 'Bum Book',
        client_uri: 'https://bumbook.vercel.app',
        redirect_uris: ['https://bumbook.vercel.app/api/bsky-oauth-callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'web',
        token_endpoint_auth_method: 'none',
        dpop_bound_access_tokens: true,
        scope: 'atproto transition:generic transition:chat.bsky'
      },
      stateStore: new FirestoreStore('bskyOAuthState'),
      sessionStore: new FirestoreStore('bskyOAuthSessions')
    });
  })();
  return _clientPromise;
}

module.exports = { getBskyOAuthClient, CLIENT_ID };
