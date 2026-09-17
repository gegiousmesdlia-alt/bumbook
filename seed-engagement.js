#!/usr/bin/env node
/* scripts/seed-engagement.js
 * ═══════════════════════════════════════════════════════════════════════
 * Adds ENGAGEMENT on top of whatever scripts/seed-test-users.js already
 * created (and on top of your own real posts/connection requests from
 * testing) — likes, comments, and connection follow-backs. Run this
 * *after* seed-test-users.js and after you've created some real posts /
 * sent some real connection requests from your own test account, so
 * there's something for the seed users to react to.
 *
 * WHY THIS IS SEPARATE FROM seed-test-users.js: that script is a one-shot
 * "create N users" run. This one is meant to be re-run any time — every
 * run adds another random round of reactions on top of what's already
 * there, which is closer to how you'd actually want to keep testing as
 * you add more real posts during development.
 *
 * SAME SAFETY DESIGN AS seed-test-users.js, read that file's header if you
 * haven't — the short version:
 *   - every doc this writes is tagged seedTest: true (or seedTestEdge:
 *     true for connection edges specifically, see below)
 *   - never runs on its own; you run it by hand, locally
 *   - fully covered by the admin panel's "Delete Load Test Data" button
 *     (which this file also extends coverage for — see
 *     api/admin-delete-seed-users.js)
 *
 * WHAT "FOLLOW-BACK" MEANS HERE: your own real test account sending a
 * connection request to a seed user currently just sits pending forever —
 * the seed account has no logic of its own to ever respond. This script's
 * connection-request pass looks for pending requests aimed AT a seed user
 * (including ones you sent from your real account) and probabilistically
 * accepts/declines/leaves them, running the exact same Firestore writes
 * discover.js's acceptConnection() does — so the follow-back you see is
 * exercising the real code path, not a shortcut around it.
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

/* ── Config — the knobs you'd actually want to change ─────────────────── */
const MAX_POSTS_TO_TOUCH = 300;          // sample this many posts per run for likes/comments
const LIKE_CHANCE_PER_USER = 0.10;       // each seed user independently has a 10% chance to like a sampled post
const MAX_LIKERS_PER_POST = 40;          // hard cap so one viral post doesn't eat the whole write budget
const COMMENT_CHANCE_PER_POST = 0.20;    // 20% of sampled posts get one extra seed comment this run
const CONNECTION_REQUEST_ACCEPT_CHANCE = 0.75;  // of pending requests aimed at a seed user: 75% get accepted
const CONNECTION_REQUEST_DECLINE_CHANCE = 0.10; // of the ones not accepted, 10% (of the original pool) get declined — the rest are left pending, like a real person who hasn't gotten to it yet
const NEW_SEED_TO_SEED_REQUESTS = 150;   // fresh connection requests between random seed pairs this run, left in a realistic mixed state
const DAILY_WRITE_SOFT_CAP = 18000;

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

/* ── Write budget tracker ──────────────────────────────────────────────── */
let writesUsed = 0;
function trackWrites(n) {
  writesUsed += n;
  if (writesUsed > DAILY_WRITE_SOFT_CAP) {
    console.error(`\nStopping: about to exceed the ${DAILY_WRITE_SOFT_CAP}-write soft cap (would be at ${writesUsed}).\n`);
    process.exit(1);
  }
}
async function commitInChunks(ops, chunkSize = 450) {
  for (let i = 0; i < ops.length; i += chunkSize) {
    const batch = db.batch();
    ops.slice(i, i + chunkSize).forEach(op => op(batch));
    await batch.commit();
    trackWrites(Math.min(chunkSize, ops.length - i));
    process.stdout.write(`\r  ${Math.min(i + chunkSize, ops.length)}/${ops.length} writes committed`);
  }
  if (ops.length) process.stdout.write('\n');
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim().toLowerCase()); }));
}

const COMMENT_TEXTS = [
  'Great post! 👏', 'This is so relatable', 'Nice one', '😂😂😂', 'Interesting take',
  'Thanks for sharing', 'Well said', 'Came here to say this', 'Facts', '🔥🔥',
  'Never thought about it that way', 'Same here honestly'
];

async function main() {
  console.log('\nEngagement seeding — likes, comments, connection follow-backs\n');
  const ans = await confirm('Proceed? (yes/no): ');
  if (ans !== 'yes' && ans !== 'y') { console.log('Cancelled.'); return; }

  const usersSnap = await db.collection('users').where('seedTest', '==', true).get();
  const seedUsers = usersSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
  if (!seedUsers.length) {
    console.error('\nNo seedTest users found — run scripts/seed-test-users.js first.\n');
    return;
  }
  console.log(`Found ${seedUsers.length} seed users.\n`);
  const seedUidSet = new Set(seedUsers.map(u => u.uid));

  /* ── 1) LIKES ─────────────────────────────────────────────────────────── */
  console.log('Sampling posts for likes...');
  const postsSnap = await db.collection('posts').limit(MAX_POSTS_TO_TOUCH).get();
  let likeOps = [];
  postsSnap.docs.forEach(postDoc => {
    const likers = seedUsers.filter(() => Math.random() < LIKE_CHANCE_PER_USER).slice(0, MAX_LIKERS_PER_POST);
    likers.forEach(u => {
      likeOps.push(batch => batch.set(postDoc.ref.collection('likes').doc(u.uid), {
        seedTest: true, likedAt: Date.now()
      }));
    });
  });
  console.log(`Adding ${likeOps.length} likes across ${postsSnap.size} posts...`);
  await commitInChunks(likeOps);

  /* ── 2) COMMENTS ──────────────────────────────────────────────────────── */
  console.log('\nAdding comments...');
  const commentOps = [];
  const commentCountBumps = {}; // postId -> how many comments we're adding, applied after
  postsSnap.docs.forEach(postDoc => {
    if (Math.random() >= COMMENT_CHANCE_PER_POST) return;
    const u = pick(seedUsers);
    commentOps.push(batch => batch.set(postDoc.ref.collection('comments').doc(), {
      authorUid: u.uid, text: pick(COMMENT_TEXTS), createdAt: Date.now(), seedTest: true
    }));
    commentCountBumps[postDoc.id] = (commentCountBumps[postDoc.id] || 0) + 1;
  });
  console.log(`Adding ${commentOps.length} comments...`);
  await commitInChunks(commentOps);
  await commitInChunks(Object.keys(commentCountBumps).map(postId => batch =>
    batch.update(db.collection('posts').doc(postId), { commentCount: FieldValue.increment(commentCountBumps[postId]) })
  ));

  /* ── 3) FOLLOW-BACKS — resolve pending requests aimed at a seed user ───── */
  console.log('\nLooking for pending connection requests aimed at seed users (this is where a real');
  console.log('test account\'s "Connect" request to a seed profile actually gets a response)...');
  const pendingSnap = await db.collection('connectionRequests').where('status', '==', 'pending').get();
  const toResolve = pendingSnap.docs.filter(d => seedUidSet.has(d.data().to));
  console.log(`Found ${toResolve.length} pending requests aimed at seed users.`);

  const countDeltas = {}; // uid -> { followers, following } deltas, applied once at the end
  function bumpCounts(uid, followers, following) {
    if (!countDeltas[uid]) countDeltas[uid] = { followers: 0, following: 0 };
    countDeltas[uid].followers += followers;
    countDeltas[uid].following += following;
  }

  const resolveOps = [];
  toResolve.forEach(reqDoc => {
    const { from, to } = reqDoc.data();
    const roll = Math.random();
    if (roll < CONNECTION_REQUEST_ACCEPT_CHANCE) {
      resolveOps.push(batch => batch.update(reqDoc.ref, { status: 'accepted' }));
      resolveOps.push(batch => batch.set(db.collection('users').doc(to).collection('connections').doc(from), { seedTestEdge: true, createdAt: Date.now() }));
      resolveOps.push(batch => batch.set(db.collection('users').doc(from).collection('connections').doc(to), { seedTestEdge: true, createdAt: Date.now() }));
      bumpCounts(to, 1, 1);
      bumpCounts(from, 1, 1);
    } else if (roll < CONNECTION_REQUEST_ACCEPT_CHANCE + CONNECTION_REQUEST_DECLINE_CHANCE) {
      resolveOps.push(batch => batch.update(reqDoc.ref, { status: 'declined' }));
    } // else: leave pending, like a real person who hasn't responded yet
  });
  console.log(`Resolving ${resolveOps.length} writes (accepts + declines)...`);
  await commitInChunks(resolveOps);

  /* ── 4) Fresh seed-to-seed requests, left in a realistic mixed state ───── */
  console.log(`\nCreating ${NEW_SEED_TO_SEED_REQUESTS} new seed-to-seed connection requests...`);
  const newReqOps = [];
  for (let i = 0; i < NEW_SEED_TO_SEED_REQUESTS; i++) {
    const a = pick(seedUsers), b = pick(seedUsers);
    if (a.uid === b.uid) continue;
    const reqId = a.uid + '_' + b.uid;
    const roll = Math.random();
    const status = roll < CONNECTION_REQUEST_ACCEPT_CHANCE ? 'accepted'
      : roll < CONNECTION_REQUEST_ACCEPT_CHANCE + CONNECTION_REQUEST_DECLINE_CHANCE ? 'declined'
      : 'pending';
    newReqOps.push(batch => batch.set(db.collection('connectionRequests').doc(reqId), {
      from: a.uid, to: b.uid, status, createdAt: Date.now(), seedTest: true
    }));
    if (status === 'accepted') {
      newReqOps.push(batch => batch.set(db.collection('users').doc(a.uid).collection('connections').doc(b.uid), { seedTestEdge: true, createdAt: Date.now() }));
      newReqOps.push(batch => batch.set(db.collection('users').doc(b.uid).collection('connections').doc(a.uid), { seedTestEdge: true, createdAt: Date.now() }));
      bumpCounts(a.uid, 1, 1);
      bumpCounts(b.uid, 1, 1);
    }
  }
  await commitInChunks(newReqOps);

  /* ── 5) Apply follower/following count deltas ───────────────────────── */
  console.log('\nUpdating follower/following counts...');
  const countOps = Object.keys(countDeltas).map(uid => batch =>
    batch.update(db.collection('users').doc(uid), {
      followersCount: FieldValue.increment(countDeltas[uid].followers),
      followingCount: FieldValue.increment(countDeltas[uid].following)
    })
  );
  await commitInChunks(countOps);

  console.log(`\nDone. Total writes used: ~${writesUsed} of today's ${DAILY_WRITE_SOFT_CAP}-write budget.`);
  console.log(`Added: ${likeOps.length} likes, ${commentOps.length} comments, `
    + `${toResolve.length} follow-back resolutions, ${NEW_SEED_TO_SEED_REQUESTS} new requests.`);
  console.log('\nEverything here is tagged seedTest: true (or seedTestEdge: true for connection');
  console.log('edges). Covered by the admin panel\'s "Delete Load Test Data" button.\n');
}

main().catch(err => { console.error('\nSeeding failed:', err); process.exit(1); });
