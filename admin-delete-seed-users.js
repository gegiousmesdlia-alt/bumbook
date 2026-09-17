/* api/admin-delete-seed-users.js
 *
 * Deletes load-test data created by scripts/seed-test-users.js — and
 * ONLY that data. It never touches anything without seedTest: true, so a
 * real user is never at risk from this running.
 *
 * Called repeatedly by the admin panel (one small batch per call, since a
 * Vercel serverless function has a time limit and there can be thousands
 * of records) with a `type` telling it what to clean up this pass:
 * 'users' | 'groups' | 'comments'. The frontend loops each type until the
 * response says nothing is left, then moves to the next type.
 *
 * Requires a valid Firebase ID token for the admin account (Authorization:
 * Bearer <token>) — the same admin identity check the app's own Firestore
 * rules use (ADMIN_EMAIL in config.js / isAdmin() in firestore.rules),
 * mirrored here since this needs privileged Admin SDK access that the
 * public Firestore rules deliberately don't allow.
 */

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const ADMIN_EMAIL = 'admin@gmail.com'; // matches config.js
const BATCH_SIZE = 300; // keeps each call comfortably inside a serverless function's time limit

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'Missing auth token' }); return; }

  let decoded;
  try { decoded = await admin.auth().verifyIdToken(token); }
  catch (e) { res.status(401).json({ error: 'Invalid token' }); return; }

  if (decoded.email !== ADMIN_EMAIL) { res.status(403).json({ error: 'Not authorized' }); return; }

  const type = (req.body && req.body.type) || req.query.type;

  try {
    let deleted = 0, remaining = 0;

    if (type === 'users') {
      const snap = await db.collection('users').where('seedTest', '==', true).limit(BATCH_SIZE).get();
      if (!snap.empty) {
        const batch = db.batch();
        const authUidsToDelete = [];
        for (const doc of snap.docs) {
          const data = doc.data();
          batch.delete(doc.ref);
          if (data.handle) batch.delete(db.collection('handles').doc(data.handle));
          authUidsToDelete.push(doc.id);
        }
        await batch.commit();
        // Connections subcollections aren't caught by the batch above —
        // clean each deleted user's own connections docs too.
        await Promise.allSettled(snap.docs.map(async doc => {
          const connSnap = await db.collection('users').doc(doc.id).collection('connections').limit(50).get();
          if (!connSnap.empty) {
            const cb = db.batch();
            connSnap.docs.forEach(c => cb.delete(c.ref));
            await cb.commit();
          }
        }));
        // Auth accounts — deleteUsers batches up to 1000 per call.
        for (let i = 0; i < authUidsToDelete.length; i += 1000) {
          await admin.auth().deleteUsers(authUidsToDelete.slice(i, i + 1000));
        }
        deleted = snap.docs.length;
      }
      const check = await db.collection('users').where('seedTest', '==', true).limit(1).get();
      remaining = check.empty ? 0 : 1; // 1 just means "more exist", exact count isn't needed here

    } else if (type === 'groups') {
      const snap = await db.collection('groups').where('seedTest', '==', true).limit(BATCH_SIZE).get();
      if (!snap.empty) {
        await Promise.allSettled(snap.docs.map(async doc => {
          const memSnap = await doc.ref.collection('members').limit(500).get();
          if (!memSnap.empty) {
            const mb = db.batch();
            memSnap.docs.forEach(m => mb.delete(m.ref));
            await mb.commit();
          }
        }));
        const batch = db.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        deleted = snap.docs.length;
      }
      const check = await db.collection('groups').where('seedTest', '==', true).limit(1).get();
      remaining = check.empty ? 0 : 1;

    } else if (type === 'comments') {
      const snap = await db.collectionGroup('comments').where('seedTest', '==', true).limit(BATCH_SIZE).get();
      if (!snap.empty) {
        const batch = db.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        deleted = snap.docs.length;
      }
      const check = await db.collectionGroup('comments').where('seedTest', '==', true).limit(1).get();
      remaining = check.empty ? 0 : 1;

    } else if (type === 'likes') {
      // From scripts/seed-engagement.js — posts/{id}/likes/{uid} docs.
      const snap = await db.collectionGroup('likes').where('seedTest', '==', true).limit(BATCH_SIZE).get();
      if (!snap.empty) {
        const batch = db.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        deleted = snap.docs.length;
      }
      const check = await db.collectionGroup('likes').where('seedTest', '==', true).limit(1).get();
      remaining = check.empty ? 0 : 1;

    } else if (type === 'connections') {
      // From scripts/seed-engagement.js — users/{uid}/connections/{otherUid}
      // docs tagged seedTestEdge, INCLUDING edges sitting on a real user's
      // own connections subcollection (e.g. your real test account, after
      // a seed account "followed back"). Follower/following counts are
      // decremented to match every edge actually removed.
      const snap = await db.collectionGroup('connections').where('seedTestEdge', '==', true).limit(BATCH_SIZE).get();
      if (!snap.empty) {
        const deltas = {}; // uid -> how many of their edges we're removing
        const batch = db.batch();
        snap.docs.forEach(doc => {
          batch.delete(doc.ref);
          const ownerUid = doc.ref.parent.parent?.id;
          if (ownerUid) deltas[ownerUid] = (deltas[ownerUid] || 0) + 1;
        });
        await batch.commit();
        deleted = snap.docs.length;
        if (Object.keys(deltas).length) {
          const countBatch = db.batch();
          Object.keys(deltas).forEach(uid => {
            countBatch.update(db.collection('users').doc(uid), {
              followersCount: admin.firestore.FieldValue.increment(-deltas[uid]),
              followingCount: admin.firestore.FieldValue.increment(-deltas[uid])
            });
          });
          await countBatch.commit().catch(() => {}); // best-effort — a since-deleted user doc just no-ops here
        }
      }
      const check = await db.collectionGroup('connections').where('seedTestEdge', '==', true).limit(1).get();
      remaining = check.empty ? 0 : 1;

    } else if (type === 'connectionRequests') {
      // From scripts/seed-engagement.js — top-level connectionRequests docs.
      const snap = await db.collection('connectionRequests').where('seedTest', '==', true).limit(BATCH_SIZE).get();
      if (!snap.empty) {
        const batch = db.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        deleted = snap.docs.length;
      }
      const check = await db.collection('connectionRequests').where('seedTest', '==', true).limit(1).get();
      remaining = check.empty ? 0 : 1;

    } else {
      res.status(400).json({ error: 'type must be users, groups, comments, likes, connections, or connectionRequests' });
      return;
    }

    res.status(200).json({ deleted, hasMore: remaining > 0 });
  } catch (err) {
    // A collectionGroup where() query needs a one-time composite index —
    // Firestore's error message includes a direct link to create it.
    // Surface that clearly instead of a bare 500.
    const needsIndex = String(err && err.message || '').includes('index');
    res.status(500).json({ error: needsIndex ? 'Needs a Firestore index — see server logs for the creation link.' : String(err && err.message || err) });
  }
};
