/* api/run-bot-engagement.js
 *
 * Automates what scripts/seed-engagement.js does manually: when a REAL
 * user posts, a random handful of seed accounts like it (staggered over
 * minutes/hours, not all at once), and ~60% of THOSE likers then send that
 * poster a connection request after a further random delay — same
 * two-step "like first, then maybe follow" pattern a real audience would
 * show, not everyone reacting in the same instant.
 *
 * SAME TRIGGER MECHANISM AS api/check-scheduled-pushes.js: Vercel's own
 * free-tier cron only fires once a day, so this is designed to be hit
 * every few minutes by an external free pinger (cron-job.org) instead —
 * see BOT_ENGAGEMENT_SETUP.md.
 *
 * OFF BY DEFAULT: requires BOT_ENGAGEMENT_ENABLED=true in your environment
 * variables. This is a pre-launch testing tool that keeps running in the
 * background once it's on a cron schedule — flip it off (or just stop
 * pinging this URL) before real users are ever on the site. It has no
 * effect at all on your Firestore usage while the env var is unset.
 *
 * WHAT IT WRITES (all tagged seedTest: true, all covered by the admin
 * panel's "Delete Load Test Data" button):
 *   - botState/seedUidPool   — cached list of seed user uids (refreshed at
 *                              most once/day — the read cost of the where()
 *                              query that finds them is the expensive
 *                              part, so it's deliberately not re-run every
 *                              tick)
 *   - botState/postCursor    — the last post createdAt this has scanned,
 *                              so the same post is never re-scheduled
 *   - botQueue/{autoId}      — one doc per pending scheduled action
 *                              (like/connect), deleted once it fires
 *   - posts/{id}.likes.{uid} — the like itself, once due (a map field on
 *                              the post doc — see seed-engagement.js's
 *                              comment on this for why it's not a
 *                              subcollection)
 *   - seedLikeIndex/{id}     — lookup doc so the admin tool can find and
 *                              remove that like later
 *   - connectionRequests/*, users/{uid}/notifications/*  — for the
 *                              connect step, written exactly like a real
 *                              sendConnectionRequest() call would
 */

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const CLAUDE_ENGINEER_UID = 'claude_engineer_bot'; // matches config.js — never targeted or used as a "liker"

/* ── Config ─────────────────────────────────────────────────────────────
   Minutes below, converted to ms where used. */
const SEED_POOL_REFRESH_HOURS = 24;
const POSTS_PER_RUN = 10;          // new posts scanned per invocation
const QUEUE_PROCESS_LIMIT = 100;   // due queue items processed per invocation
const LIKERS_MIN = 2, LIKERS_MAX = 12;         // per new post
const LIKE_DELAY_MIN_MIN = 1, LIKE_DELAY_MAX_MIN = 180;      // 1min–3h after the post
const CONNECT_CHANCE = 0.6;                     // of likers, this fraction also send a connect request
const CONNECT_DELAY_MIN_MIN = 10, CONNECT_DELAY_MAX_MIN = 240; // 10min–4h AFTER their like fires

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

module.exports = async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (process.env.BOT_ENGAGEMENT_ENABLED !== 'true') { res.status(200).json({ enabled: false }); return; }

  try {
    const seedUids = await _getSeedUidPool();
    if (!seedUids.length) { res.status(200).json({ enabled: true, error: 'no_seed_users', message: 'Run scripts/seed-test-users.js first.' }); return; }

    const scheduled = await _scanNewPosts(seedUids);
    const fired = await _processDueQueue();

    res.status(200).json({ enabled: true, seedPoolSize: seedUids.length, ...scheduled, ...fired });
  } catch (err) {
    res.status(200).json({ enabled: true, error: 'fetch', message: String(err && err.message || err) });
  }
};

/* ── Seed uid pool — cached, refreshed at most once/day ──────────────────
   The where('seedTest','==',true) query costs one read per matching user
   (thousands of them). Running that every 5-minute tick would burn the
   Spark plan's 50k-reads/day budget by itself. Caching it in one document
   means only the (at most) daily refresh pays that cost. */
async function _getSeedUidPool() {
  const ref = db.collection('botState').doc('seedUidPool');
  let data;
  try {
    const snap = await ref.get();
    data = snap.exists ? snap.data() : null;
  } catch (e) { return []; } // can't even read the cache — bail cheap rather than also attempting the expensive query below

  const stale = !data || (Date.now() - (data.refreshedAt || 0)) > SEED_POOL_REFRESH_HOURS * 3600000;
  if (!stale) return data.uids || [];

  // BUG FIX: this used to attempt the expensive full-collection query and
  // only mark the cache "refreshed" AFTER it succeeded — so if that query
  // OR the final cache write ever failed (large seed-user list hitting
  // Firestore's 1MB document limit, or quota already tight), the cache
  // never actually updated, and EVERY 5-minute tick would silently retry
  // the full expensive query again — 288x/day instead of once. That's
  // almost certainly what caused a 246K-read day from a job that should
  // cost a few thousand at most. Writing a short-backoff marker FIRST
  // means a failure here retries in ~1 hour, not in 5 minutes.
  try {
    await ref.set({ uids: (data && data.uids) || [], refreshedAt: Date.now() - (SEED_POOL_REFRESH_HOURS - 1) * 3600000 }, { merge: true });
  } catch (e) { return (data && data.uids) || []; }

  try {
    const usersSnap = await db.collection('users').where('seedTest', '==', true).select().get();
    const uids = usersSnap.docs.map(d => d.id);
    await ref.set({ uids, refreshedAt: Date.now() });
    return uids;
  } catch (e) {
    // Expensive query or the final write failed — the backoff marker
    // above already caps retries to ~hourly, so just fall back to
    // whatever (possibly stale, possibly empty) list we had.
    return (data && data.uids) || [];
  }
}

/* ── Scan for new real posts, schedule staggered likes + connects ────── */
async function _scanNewPosts(seedUids) {
  const cursorRef = db.collection('botState').doc('postCursor');
  const cursorSnap = await cursorRef.get();
  const lastCreatedAt = cursorSnap.exists ? (cursorSnap.data().lastCreatedAt || 0) : 0;

  const seedUidSet = new Set(seedUids);
  const postsSnap = await db.collection('posts')
    .orderBy('createdAt')
    .where('createdAt', '>', lastCreatedAt)
    .limit(POSTS_PER_RUN)
    .get();

  if (postsSnap.empty) return { postsScanned: 0, likesScheduled: 0, connectsScheduled: 0 };

  let likesScheduled = 0, connectsScheduled = 0;
  const ops = [];
  let maxSeen = lastCreatedAt;

  postsSnap.docs.forEach(doc => {
    const post = doc.data();
    maxSeen = Math.max(maxSeen, post.createdAt || 0);
    // Only react to REAL users' posts — a seed account posting (shouldn't
    // normally happen) or the Claude Engineer virtual post are skipped.
    if (!post.authorUid || seedUidSet.has(post.authorUid) || post.authorUid === CLAUDE_ENGINEER_UID) return;

    const likerCount = Math.min(randInt(LIKERS_MIN, LIKERS_MAX), seedUids.length);
    const likers = [...seedUids].sort(() => Math.random() - 0.5).slice(0, likerCount);
    const postCreatedAt = post.createdAt || Date.now();

    likers.forEach(uid => {
      const likeDueAt = postCreatedAt + randInt(LIKE_DELAY_MIN_MIN, LIKE_DELAY_MAX_MIN) * 60000;
      ops.push(batch => batch.set(db.collection('botQueue').doc(), {
        type: 'like', postId: doc.id, uid, dueAt: likeDueAt, seedTest: true
      }));
      likesScheduled++;

      if (Math.random() < CONNECT_CHANCE) {
        const connectDueAt = likeDueAt + randInt(CONNECT_DELAY_MIN_MIN, CONNECT_DELAY_MAX_MIN) * 60000;
        ops.push(batch => batch.set(db.collection('botQueue').doc(), {
          type: 'connect', fromUid: uid, toUid: post.authorUid, dueAt: connectDueAt, seedTest: true
        }));
        connectsScheduled++;
      }
    });
  });

  // One batch is plenty here — POSTS_PER_RUN(10) × LIKERS_MAX(12) × 2 is
  // well under Firestore's 500-writes-per-batch limit.
  if (ops.length) {
    const batch = db.batch();
    ops.forEach(op => op(batch));
    await batch.commit();
  }
  await cursorRef.set({ lastCreatedAt: maxSeen });

  return { postsScanned: postsSnap.size, likesScheduled, connectsScheduled };
}

/* ── Fire whatever's due ──────────────────────────────────────────────── */
async function _processDueQueue() {
  const now = Date.now();
  const dueSnap = await db.collection('botQueue').where('dueAt', '<=', now).limit(QUEUE_PROCESS_LIMIT).get();
  if (dueSnap.empty) return { liked: 0, connected: 0 };

  let liked = 0, connected = 0;
  for (const doc of dueSnap.docs) {
    const item = doc.data();
    try {
      if (item.type === 'like') {
        await db.collection('posts').doc(item.postId).update({ [`likes.${item.uid}`]: true });
        await db.collection('seedLikeIndex').doc(`${item.postId}_${item.uid}`).set({
          postId: item.postId, uid: item.uid, seedTest: true, likedAt: now
        });
        liked++;
      } else if (item.type === 'connect') {
        await _fireConnect(item.fromUid, item.toUid);
        connected++;
      }
    } catch (e) { /* target post/user may be gone by now — just drop this queued action */ }
    await doc.ref.delete();
  }
  return { liked, connected };
}

async function _fireConnect(fromUid, toUid) {
  // Skip if already connected or a request already exists either
  // direction — mirrors what sendConnectionRequest()'s UI already
  // prevents for a real user, so a bot doesn't spam duplicate requests.
  const [alreadyConnected, reqAB, reqBA] = await Promise.all([
    db.collection('users').doc(toUid).collection('connections').doc(fromUid).get(),
    db.collection('connectionRequests').doc(`${fromUid}_${toUid}`).get(),
    db.collection('connectionRequests').doc(`${toUid}_${fromUid}`).get()
  ]);
  if (alreadyConnected.exists || reqAB.exists || reqBA.exists) return;

  const fromProfile = await db.collection('users').doc(fromUid).get();
  const fromName = fromProfile.exists ? (fromProfile.data().displayName || 'Member') : 'Member';
  const reqId = `${fromUid}_${toUid}`;

  await db.collection('connectionRequests').doc(reqId).set({
    from: fromUid, to: toUid, status: 'pending', createdAt: Date.now(), seedTest: true
  });
  await db.collection('users').doc(toUid).collection('notifications').doc().set({
    type: 'connection_request', fromUid, fromName, reqId, createdAt: Date.now(), read: false, seedTest: true
  });
}
