#!/usr/bin/env node
/* scripts/seed-engagement.js
 * ═══════════════════════════════════════════════════════════════════════
 * Adds ENGAGEMENT on top of whatever scripts/seed-test-users.js already
 * created (and on top of your own real posts/connection requests from
 * testing) — likes, comments, and connection follow-backs.
 *
 * RESUMABLE ACROSS THE DAILY WRITE CAP: progress checkpoints to a
 * `seedEngagementState/cursor` doc in Firestore after every batch. If you
 * hit DAILY_WRITE_SOFT_CAP partway through, the script stops cleanly (no
 * error, no half-committed batch) and prints exactly how far it got.
 * Running it again — later today once the cap resets, or tomorrow —
 * picks up from that exact point instead of redoing work or resampling
 * from scratch. A full pass through all three phases (likes+comments,
 * follow-backs, new seed-to-seed requests) is a "round"; once a round
 * finishes, the NEXT run starts a fresh round automatically.
 *
 * FIRST RUN NOTE: phase 2 (follow-backs) needs a Firestore composite index
 * (connectionRequests: status ASC, createdAt ASC) since it filters on
 * status and paginates by createdAt together. If you see an error
 * mentioning "requires an index" the first time this reaches that phase,
 * click the link in the error — it takes you straight to a pre-filled
 * "create index" page in the Firebase console. Takes a minute to build,
 * then just re-run the script.
 *
 * SAME SAFETY DESIGN AS seed-test-users.js:
 *   - every doc this writes is tagged seedTest: true (or seedTestEdge:
 *     true for connection edges specifically)
 *   - never runs on its own; you run it by hand, locally
 *   - fully covered by the admin panel's "Delete Load Test Data" button
 *
 * WHAT "FOLLOW-BACK" MEANS HERE: your own real test account sending a
 * connection request to a seed user currently just sits pending forever —
 * the seed account has no logic of its own to ever respond. The
 * follow-backs phase looks for pending requests aimed AT a seed user
 * (including ones you sent from your real account) and
 * accepts/declines/leaves them, running the exact same Firestore writes
 * discover.js's acceptConnection() does.
 *
 * USAGE (same credentials as seed-test-users.js):
 *   export GOOGLE_APPLICATION_CREDENTIALS=~/secrets/serviceAccountKey.json
 *   node scripts/seed-engagement.js
 * ═══════════════════════════════════════════════════════════════════════
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

/* ── Config ─────────────────────────────────────────────────────────────
   These describe a whole ROUND, spread across as many runs as it takes to
   stay under the daily cap — they're not "per run" numbers anymore. */
const LIKE_CHANCE_PER_USER = 0.10;
const MAX_LIKERS_PER_POST = 40;
const COMMENT_CHANCE_PER_POST = 0.20;
const CONNECTION_REQUEST_ACCEPT_CHANCE = 0.75;
const CONNECTION_REQUEST_DECLINE_CHANCE = 0.10; // remainder of the pool is left pending, like a real person who hasn't gotten to it yet
const NEW_SEED_TO_SEED_REQUESTS = 150; // per round
const DAILY_WRITE_SOFT_CAP = 18000;    // stays a bit under Firestore's real 20K/day so this can always stop itself cleanly
const POSTS_PAGE_SIZE = 25;            // posts read+processed per checkpoint in phase 1
const REQUESTS_PAGE_SIZE = 50;         // connection requests processed per checkpoint in phase 2

/* ── Load service account (same pattern as seed-test-users.js) ────────── */
let keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (keyPath) {
  if (!fs.existsSync(keyPath)) {
    console.error(`\nGOOGLE_APPLICATION_CREDENTIALS is set to ${keyPath} but that file doesn't exist.\n`);
    process.exit(1);
  }
} else {
  keyPath = path.join(__dirname, '..', 'serviceAccountKey.json');
  if (fs.existsSync(keyPath)) {
    console.warn('\n⚠️  WARNING: reading the service account key from inside the project folder.');
    console.warn('   Move it outside this project folder and set GOOGLE_APPLICATION_CREDENTIALS instead.\n');
  } else {
    console.error(`\nNo service account key found. Set GOOGLE_APPLICATION_CREDENTIALS (see seed-test-users.js header).\n`);
    process.exit(1);
  }
}
const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const STATE_REF = db.collection('seedEngagementState').doc('cursor');

/* ── Write budget tracker — no process.exit here. Hitting the cap is an
   expected, graceful stop now, not a failure. ─────────────────────────── */
let writesUsed = 0;
let capHit = false;
function trackWrites(n) {
  writesUsed += n;
  if (writesUsed >= DAILY_WRITE_SOFT_CAP) capHit = true;
}
async function commitBatch(ops) {
  if (!ops.length) return;
  const batch = db.batch();
  ops.forEach(op => op(batch));
  await batch.commit();
  trackWrites(ops.length);
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim().toLowerCase()); }));
}

const COMMENT_TEXTS = [
  'Great post! 👏', 'This is so relatable', 'Nice one', '😂😂😂', 'Interesting take',
  'Thanks for sharing', 'Well said', 'Came here to say this', 'Facts', '🔥🔥',
  'Never thought about it that way', 'Same here honestly'
];

function freshState() {
  return { phase: 'likes_comments', postsCursorCreatedAt: null, followbackCursorCreatedAt: null, newRequestsCreated: 0 };
}
async function loadState() {
  const snap = await STATE_REF.get();
  if (!snap.exists) return freshState();
  const s = snap.data();
  return s.phase === 'done' ? freshState() : s;
}
async function saveState(state) { await STATE_REF.set(state); }

async function main() {
  console.log('\nEngagement seeding — likes, comments, connection follow-backs (resumable)\n');
  const ans = await confirm('Proceed? (yes/no): ');
  if (ans !== 'yes' && ans !== 'y') { console.log('Cancelled.'); return; }

  const usersSnap = await db.collection('users').where('seedTest', '==', true).get();
  const seedUsers = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
  if (!seedUsers.length) {
    console.error('\nNo seedTest users found — run scripts/seed-test-users.js first.\n');
    return;
  }
  console.log(`Found ${seedUsers.length} seed users.`);
  const seedUidSet = new Set(seedUsers.map(u => u.uid));

  let state = await loadState();
  console.log(`Resuming at phase: ${state.phase}\n`);

  if (state.phase === 'likes_comments') {
    await runLikesAndComments(state, seedUsers);
    if (capHit) return stopForToday(state);
    state.phase = 'followbacks';
    await saveState(state);
  }

  if (state.phase === 'followbacks') {
    await runFollowbacks(state, seedUidSet);
    if (capHit) return stopForToday(state);
    state.phase = 'newRequests';
    await saveState(state);
  }

  if (state.phase === 'newRequests') {
    await runNewRequests(state, seedUsers);
    if (capHit) return stopForToday(state);
    state.phase = 'done';
    await saveState(state);
  }

  console.log(`\n✅ Full round complete. Total writes this run: ~${writesUsed}.`);
  console.log('Run this script again anytime for another round — it\'ll start fresh automatically.');
  console.log('Everything here is tagged seedTest: true (or seedTestEdge: true for connection');
  console.log('edges). Covered by the admin panel\'s "Delete Load Test Data" button.\n');
}

function stopForToday(state) {
  console.log(`\n⏸  Stopped — hit the ~${DAILY_WRITE_SOFT_CAP}-write daily cap (used ~${writesUsed} this run).`);
  console.log(`Progress saved (phase: ${state.phase}). Just run this script again — today once the`);
  console.log('cap resets, or tomorrow — and it\'ll pick up exactly where this left off.\n');
}

/* ── Phase 1: likes + comments, paginated by post createdAt ────────────── */
async function runLikesAndComments(state, seedUsers) {
  console.log('Phase: likes + comments...');
  let cursor = state.postsCursorCreatedAt;

  while (!capHit) {
    let q = db.collection('posts').orderBy('createdAt').limit(POSTS_PAGE_SIZE);
    if (cursor != null) q = q.startAfter(cursor);
    const pageSnap = await q.get();
    if (pageSnap.empty) { console.log('  No more posts — phase complete.'); break; }

    const ops = [];
    const commentCountBumps = {};
    pageSnap.docs.forEach(postDoc => {
      const likers = seedUsers.filter(() => Math.random() < LIKE_CHANCE_PER_USER).slice(0, MAX_LIKERS_PER_POST);
      likers.forEach(u => {
        ops.push(batch => batch.update(postDoc.ref, { [`likes.${u.uid}`]: true }));
        ops.push(batch => batch.set(db.collection('seedLikeIndex').doc(`${postDoc.id}_${u.uid}`), {
          postId: postDoc.id, uid: u.uid, seedTest: true, likedAt: Date.now()
        }));
      });
      if (Math.random() < COMMENT_CHANCE_PER_POST) {
        const u = pick(seedUsers);
        ops.push(batch => batch.set(postDoc.ref.collection('comments').doc(), {
          authorUid: u.uid, text: pick(COMMENT_TEXTS), createdAt: Date.now(), seedTest: true
        }));
        commentCountBumps[postDoc.id] = (commentCountBumps[postDoc.id] || 0) + 1;
      }
    });
    Object.keys(commentCountBumps).forEach(postId => {
      ops.push(batch => batch.update(db.collection('posts').doc(postId), { commentCount: FieldValue.increment(commentCountBumps[postId]) }));
    });

    // A page of 25 posts × up to 40 likers × 2 ops could in theory exceed
    // Firestore's 500-ops-per-batch limit — split defensively if so.
    for (let i = 0; i < ops.length && !capHit; i += 450) {
      await commitBatch(ops.slice(i, i + 450));
    }

    cursor = pageSnap.docs[pageSnap.docs.length - 1].data().createdAt;
    state.postsCursorCreatedAt = cursor;
    await saveState(state);
    process.stdout.write(`\r  ...through post batch ending ${new Date(cursor).toLocaleString()} (writes used: ~${writesUsed})   `);
  }
  console.log('');
}

/* ── Phase 2: follow-backs — resolve requests pending toward seed users ──
   Paginated by createdAt so requests deliberately left "pending" (which
   never disappear from a plain pending query) don't cause an infinite
   loop re-visiting the same page forever — the cursor always moves
   forward regardless of what was decided for each item. ───────────────── */
async function runFollowbacks(state, seedUidSet) {
  console.log('Phase: follow-backs (pending requests aimed at seed users)...');
  let cursor = state.followbackCursorCreatedAt;

  while (!capHit) {
    let q = db.collection('connectionRequests').where('status', '==', 'pending').orderBy('createdAt').limit(REQUESTS_PAGE_SIZE);
    if (cursor != null) q = q.startAfter(cursor);
    let pageSnap;
    try {
      pageSnap = await q.get();
    } catch (e) {
      if (String(e.message || e).includes('requires an index')) {
        console.log('\n  Needs a one-time Firestore composite index — click the link in this error,');
        console.log('  create it in the Firebase console (~1 min to build), then re-run this script:\n');
        console.log('  ' + e.message + '\n');
        capHit = true; // stop cleanly, state already safe to resume from
        return;
      }
      throw e;
    }
    if (pageSnap.empty) { console.log('  No more pending requests — phase complete.'); break; }

    const ops = [];
    pageSnap.docs.forEach(reqDoc => {
      const { from, to } = reqDoc.data();
      if (!seedUidSet.has(to)) return; // not aimed at a seed user — nothing for us to do, cursor still advances past it
      const roll = Math.random();
      if (roll < CONNECTION_REQUEST_ACCEPT_CHANCE) {
        ops.push(batch => batch.update(reqDoc.ref, { status: 'accepted' }));
        ops.push(batch => batch.set(db.collection('users').doc(to).collection('connections').doc(from), { seedTestEdge: true, createdAt: Date.now() }));
        ops.push(batch => batch.set(db.collection('users').doc(from).collection('connections').doc(to), { seedTestEdge: true, createdAt: Date.now() }));
        ops.push(batch => batch.update(db.collection('users').doc(to), { followersCount: FieldValue.increment(1), followingCount: FieldValue.increment(1) }));
        ops.push(batch => batch.update(db.collection('users').doc(from), { followersCount: FieldValue.increment(1), followingCount: FieldValue.increment(1) }));
      } else if (roll < CONNECTION_REQUEST_ACCEPT_CHANCE + CONNECTION_REQUEST_DECLINE_CHANCE) {
        ops.push(batch => batch.update(reqDoc.ref, { status: 'declined' }));
      } // else: left pending on purpose — this round won't re-roll it, but a future round will
    });

    for (let i = 0; i < ops.length && !capHit; i += 450) {
      await commitBatch(ops.slice(i, i + 450));
    }

    cursor = pageSnap.docs[pageSnap.docs.length - 1].data().createdAt;
    state.followbackCursorCreatedAt = cursor;
    await saveState(state);
    process.stdout.write(`\r  ...through request batch ending ${new Date(cursor).toLocaleString()} (writes used: ~${writesUsed})   `);
  }
  console.log('');
}

/* ── Phase 3: fresh seed-to-seed requests, up to NEW_SEED_TO_SEED_REQUESTS
   this round, resumable via a simple counter ─────────────────────────── */
async function runNewRequests(state, seedUsers) {
  console.log('Phase: new seed-to-seed connection requests...');
  let created = state.newRequestsCreated || 0;

  while (created < NEW_SEED_TO_SEED_REQUESTS && !capHit) {
    const pageTarget = Math.min(REQUESTS_PAGE_SIZE, NEW_SEED_TO_SEED_REQUESTS - created);
    const ops = [];
    let madeThisPage = 0;
    for (let i = 0; i < pageTarget; i++) {
      const a = pick(seedUsers), b = pick(seedUsers);
      if (a.uid === b.uid) continue;
      const reqId = `${a.uid}_${b.uid}`;
      const roll = Math.random();
      const status = roll < CONNECTION_REQUEST_ACCEPT_CHANCE ? 'accepted'
        : roll < CONNECTION_REQUEST_ACCEPT_CHANCE + CONNECTION_REQUEST_DECLINE_CHANCE ? 'declined'
        : 'pending';
      ops.push(batch => batch.set(db.collection('connectionRequests').doc(reqId), {
        from: a.uid, to: b.uid, status, createdAt: Date.now(), seedTest: true
      }));
      if (status === 'accepted') {
        ops.push(batch => batch.set(db.collection('users').doc(a.uid).collection('connections').doc(b.uid), { seedTestEdge: true, createdAt: Date.now() }));
        ops.push(batch => batch.set(db.collection('users').doc(b.uid).collection('connections').doc(a.uid), { seedTestEdge: true, createdAt: Date.now() }));
        ops.push(batch => batch.update(db.collection('users').doc(a.uid), { followersCount: FieldValue.increment(1), followingCount: FieldValue.increment(1) }));
        ops.push(batch => batch.update(db.collection('users').doc(b.uid), { followersCount: FieldValue.increment(1), followingCount: FieldValue.increment(1) }));
      }
      madeThisPage++;
    }

    for (let i = 0; i < ops.length && !capHit; i += 450) {
      await commitBatch(ops.slice(i, i + 450));
    }

    created += madeThisPage;
    state.newRequestsCreated = created;
    await saveState(state);
    process.stdout.write(`\r  ...${created}/${NEW_SEED_TO_SEED_REQUESTS} created (writes used: ~${writesUsed})   `);
  }
  console.log('');
}

main().catch(err => { console.error('\nSeeding failed:', err); process.exit(1); });
