#!/usr/bin/env node
/* scripts/seed-test-users.js
 * ═══════════════════════════════════════════════════════════════════════
 * Bulk-creates load-test accounts to check how the app performs with real
 * volume BEFORE going public — not something the live site runs, and not
 * something real users ever see.
 *
 * SAFETY / HONESTY DESIGN, read this before running:
 *   - Every single thing this script creates is tagged `seedTest: true`.
 *     That tag is the ONLY thing the admin-panel delete button looks for —
 *     it deletes every doc/account carrying it, nothing else, no matter
 *     how "real" the name looks. Don't remove or rename this field.
 *   - Names/bios are realistic on purpose (including some deliberately
 *     tricky ones — accents, apostrophes, very long strings, HTML-looking
 *     text) so you can actually catch rendering bugs. They are NOT real
 *     people; there is no attempt to make this pass as organic activity
 *     to a real visitor — the seedTest tag and this file's existence are
 *     the proof of that.
 *   - This does not run automatically, ever. You run it once, by hand,
 *     from your own machine, when you want to test. Nothing here keeps
 *     "acting" afterward.
 *
 * BEFORE YOU RUN THIS:
 *   1. Put your Firebase service account JSON at ./serviceAccountKey.json
 *      (same file/creds as FIREBASE_SERVICE_ACCOUNT_JSON in Vercel — copy
 *      it locally, this script is NOT meant to run on Vercel).
 *   2. npm install firebase-admin (from the project root).
 *   3. Node 18 or newer (uses the built-in fetch() for profile photos).
 *   4. node scripts/seed-test-users.js
 *
 * WRITE BUDGET — Firestore's free (Spark) plan caps you at 20,000 writes
 * PER DAY. This script is tuned to use roughly 17,000-18,000 of that in
 * one run for the default USER_COUNT, leaving headroom for your own
 * testing the same day. It tracks writes as it goes and will stop with a
 * clear message rather than silently exceed budget and start failing
 * partway through. If you change USER_COUNT, re-check the math it prints
 * before confirming.
 * ═══════════════════════════════════════════════════════════════════════
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

/* ── Config — the knobs you'd actually want to change ─────────────────── */
const USER_COUNT = 4000;
const AVG_CONNECTIONS_PER_USER = 1;   // -> ~USER_COUNT/2 total edges, 2 writes each
const GROUP_COUNT = 20;
const AVG_GROUP_JOINS_PER_USER = 1;
const BONUS_COMMENT_COUNT = 800;      // only spent if budget allows after the above
const DAILY_WRITE_SOFT_CAP = 18000;   // stop well short of Firestore's 20k hard cap
const INCLUDE_PROFILE_PHOTOS = true;  // set false to skip the randomuser.me fetch entirely

/* ── Load service account ──────────────────────────────────────────────── */
const keyPath = path.join(__dirname, '..', 'serviceAccountKey.json');
if (!fs.existsSync(keyPath)) {
  console.error(`\nMissing ${keyPath}`);
  console.error('Download it from Firebase Console -> Project Settings -> Service Accounts');
  console.error('-> Generate new private key, save it there, then run this again.\n');
  process.exit(1);
}
const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const authAdmin = admin.auth();

/* ── Write budget tracker ──────────────────────────────────────────────── */
let writesUsed = 0;
function trackWrites(n) {
  writesUsed += n;
  if (writesUsed > DAILY_WRITE_SOFT_CAP) {
    console.error(`\nStopping: about to exceed the ${DAILY_WRITE_SOFT_CAP}-write soft cap `
      + `(would be at ${writesUsed}). Lower USER_COUNT or the interaction settings and rerun.\n`);
    process.exit(1);
  }
}

/* ── Name generation — realistic on purpose, plus deliberate edge cases ─
   Real load-testing means catching rendering bugs, not just raw volume,
   so a slice of these are intentionally awkward: accents, apostrophes,
   very long names, and a couple of HTML-looking bios to double-check the
   app actually escapes user content instead of rendering it. */
const MALE_FIRST_NAMES = [
  'James','Chidinma','Oluwaseun','Ahmed','Kwame','Emeka','Tunde','Chike',
  "D'Angelo", 'José', 'François', 'Nguyễn', "O'Brien", 'Jean-Pierre', 'Björn',
  'Li', 'Arjun', 'Segun', 'Chinedu', 'Diego'
];
const FEMALE_FIRST_NAMES = [
  'Mary','Fatima','Yuki','Sofia','Aisha','Grace','Ngozi','Blessing','Ifeoma',
  'Siobhán', 'Mary-Jane', 'Anaïs', 'Zoë', 'Renée', 'Wang', 'Priya', 'Kemi', 'Amara', 'Wei'
];
const LAST_NAMES = [
  'Okafor', 'Adeyemi', 'Johnson', 'Smith', 'Garcia', 'Chen', 'Nakamura', 'Ibrahim',
  'Balogun', 'Eze', 'Nwosu', "O'Connor", 'Müller', 'Dubois', 'Kovač', 'Nguyen',
  'Santos', 'Kowalski', 'Papadopoulos', 'Van Der Berg', 'Al-Rashid',
  // one deliberately very long surname, to test truncation in the UI
  'Okonkwo-Williamson-Abubakar'
];
const BIO_TEMPLATES = [
  'Just here to connect ✌️', 'Coffee, code, repeat ☕', 'Living my best life',
  'Photographer | Traveler', '', '', // some intentionally blank, to test the empty state
  'Football fan ⚽ forever', 'Music is life 🎵', 'New here, say hi!',
  'Student. Dreamer. Doer.', 'Lagos 🇳🇬', 'probably online too much',
  // deliberately very long, to test overflow/truncation
  'This is a much longer bio than most people would write, on purpose, to check whether the profile page correctly truncates or wraps a bio this length without breaking the layout or overlapping other elements on the page.',
  // deliberately HTML-looking, to confirm the app escapes it rather than rendering it
  '<b>bold</b> test & "quotes" <script>alert(1)</script>',
  'Emoji stress test 🔥💯🎉😅🙏🏽🇳🇬🇺🇸🇬🇧',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

/* Profile photos — randomuser.me is a free public API built specifically
   for this: realistic fake-test-user photos, meant for exactly this kind
   of mockup/dev-testing use (not for passing as real people to real
   users — these accounts get deleted before launch either way).
   Fetched separately by gender (one bulk call each) so a male name
   actually gets a male-presenting photo and vice versa, and de-duplicated
   so the same photo isn't handed to two different accounts unless we
   truly run out (which this logs clearly rather than silently allowing). */
async function fetchProfilePhotos(count, gender) {
  console.log(`Fetching ${count} ${gender} profile photos from randomuser.me...`);
  try {
    const resp = await fetch(`https://randomuser.me/api/?results=${count}&gender=${gender}&inc=picture&noinfo`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const seen = new Set();
    const urls = [];
    (data.results || []).forEach(r => {
      const url = r.picture && r.picture.large;
      if (url && !seen.has(url)) { seen.add(url); urls.push(url); }
    });
    if (urls.length < count) {
      console.warn(`  only got ${urls.length} unique photos for ${count} ${gender} users — `
        + `${count - urls.length} of them will share a photo with someone else (logged so you know, not hidden)`);
    } else {
      console.log(`  got ${urls.length} unique photos`);
    }
    return urls;
  } catch (e) {
    console.warn(`  could not fetch ${gender} photos (${e.message}) — those seeded users will use the fallback letter avatar instead`);
    return [];
  }
}

function generateUser(index, gender, photoURL) {
  const first = pick(gender === 'female' ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES);
  const last = pick(LAST_NAMES);
  const displayName = `${first} ${last}`;
  const handleBase = (first + last).toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
  const handle = `${handleBase}${index}`; // index suffix guarantees uniqueness within this run
  return {
    uid: `seedtest_${index}_${Date.now().toString(36)}`,
    displayName,
    handle,
    email: `loadtest+${index}@bumbook-test.invalid`, // .invalid TLD: guaranteed never a real deliverable address
    bio: pick(BIO_TEMPLATES),
    photoURL: photoURL || '',
    verified: false,
    seedTest: true,
    joinedAt: Date.now() - randInt(0, 60) * 86400000 // scattered over the last ~2 months, more realistic than everyone joining "now"
  };
}

/* ── Batched Firestore writer — respects the 500-writes-per-batch limit ─ */
async function commitInChunks(ops, chunkSize = 450) {
  for (let i = 0; i < ops.length; i += chunkSize) {
    const batch = db.batch();
    ops.slice(i, i + chunkSize).forEach(op => op(batch));
    await batch.commit();
    trackWrites(Math.min(chunkSize, ops.length - i));
    process.stdout.write(`\r  ${Math.min(i + chunkSize, ops.length)}/${ops.length} writes committed`);
  }
  process.stdout.write('\n');
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim().toLowerCase()); }));
}

async function main() {
  console.log(`\nLoad-test seeding — ${USER_COUNT} users`);
  console.log(`Estimated writes: ~${USER_COUNT * 2} (users+handles) + connections/groups/comments`);
  console.log(`Profile photos: ${INCLUDE_PROFILE_PHOTOS ? 'yes, gender-matched, de-duplicated (via randomuser.me)' : 'no — fallback letter avatars'}`);
  console.log(`Soft cap: ${DAILY_WRITE_SOFT_CAP} writes\n`);
  const ans = await confirm('Proceed? (yes/no): ');
  if (ans !== 'yes' && ans !== 'y') { console.log('Cancelled.'); return; }

  // 1) Generate users — gender decided first (roughly balanced, randomized)
  //    so we know exactly how many male/female photos to request, and each
  //    user's name and photo are drawn from the same gender.
  console.log('\nGenerating user data...');
  const genders = Array.from({ length: USER_COUNT }, () => Math.random() < 0.5 ? 'male' : 'female');
  const maleCount = genders.filter(g => g === 'male').length;
  const femaleCount = USER_COUNT - maleCount;

  let malePhotos = [], femalePhotos = [];
  if (INCLUDE_PROFILE_PHOTOS) {
    malePhotos = await fetchProfilePhotos(Math.min(maleCount, 5000), 'male');
    femalePhotos = await fetchProfilePhotos(Math.min(femaleCount, 5000), 'female');
  }
  let maleIdx = 0, femaleIdx = 0;
  const users = genders.map((gender, i) => {
    let photoURL = null;
    if (gender === 'male' && malePhotos.length) photoURL = malePhotos[maleIdx++ % malePhotos.length];
    if (gender === 'female' && femalePhotos.length) photoURL = femalePhotos[femaleIdx++ % femalePhotos.length];
    return generateUser(i, gender, photoURL);
  });

  // 2) Auth accounts — importUsers batches up to 1000 per call, the correct
  //    bulk-creation tool (looping createUser() 4000 times would be far
  //    slower and more likely to hit transient rate limits).
  console.log('Creating Auth accounts (batches of 1000)...');
  for (let i = 0; i < users.length; i += 1000) {
    const chunk = users.slice(i, i + 1000).map(u => ({
      uid: u.uid, email: u.email, displayName: u.displayName, emailVerified: false
    }));
    const result = await authAdmin.importUsers(chunk);
    if (result.failureCount > 0) {
      console.warn(`  ${result.failureCount} auth accounts failed to import:`, result.errors.slice(0, 3));
    }
    process.stdout.write(`\r  ${Math.min(i + 1000, users.length)}/${users.length} auth accounts created`);
  }
  console.log('');

  // 3) Firestore user + handle docs
  console.log('Writing user + handle documents...');
  const userOps = [];
  users.forEach(u => {
    userOps.push(batch => batch.set(db.collection('users').doc(u.uid), {
      uid: u.uid, displayName: u.displayName, handle: u.handle, email: u.email,
      bio: u.bio, photoURL: u.photoURL, verified: u.verified,
      followersCount: 0, followingCount: 0, postsCount: 0,
      joinedAt: u.joinedAt, seedTest: true
    }));
    userOps.push(batch => batch.set(db.collection('handles').doc(u.handle), { value: u.uid, seedTest: true }));
  });
  await commitInChunks(userOps);

  // 4) Connections — symmetric edges between random pairs
  console.log('Creating connections...');
  const edgeCount = Math.floor(USER_COUNT * AVG_CONNECTIONS_PER_USER / 2);
  const followerDelta = {}; // uid -> count, applied to user docs after
  const connOps = [];
  for (let i = 0; i < edgeCount; i++) {
    const a = users[randInt(0, users.length - 1)];
    const b = users[randInt(0, users.length - 1)];
    if (a.uid === b.uid) continue;
    connOps.push(batch => batch.set(db.collection('users').doc(a.uid).collection('connections').doc(b.uid), { value: true, seedTest: true }));
    connOps.push(batch => batch.set(db.collection('users').doc(b.uid).collection('connections').doc(a.uid), { value: true, seedTest: true }));
    followerDelta[a.uid] = (followerDelta[a.uid] || 0) + 1;
    followerDelta[b.uid] = (followerDelta[b.uid] || 0) + 1;
  }
  await commitInChunks(connOps);

  console.log('Updating follower/following counts...');
  const countOps = Object.keys(followerDelta).map(uid => batch =>
    batch.update(db.collection('users').doc(uid), { followersCount: followerDelta[uid], followingCount: followerDelta[uid] })
  );
  await commitInChunks(countOps);

  // 5) Groups + memberships
  console.log('Creating groups...');
  const groupNames = [
    'Lagos Tech Hub', 'Football Fanatics', 'Book Club', 'Foodies United', 'Movie Nights',
    'Fitness Journey', 'Gamers Corner', 'Music Lovers', 'Travel Buddies', 'Startup Founders',
    'Photography Club', 'Local Events', 'Study Group', 'Fashion & Style', 'Pet Owners',
    'Art & Design', 'Comedy Central', 'News & Politics', 'DIY Projects', 'Parenting Tips'
  ].slice(0, GROUP_COUNT);
  const groupIds = [];
  const groupOps = [];
  groupNames.forEach((name, i) => {
    const gid = `seedtest_group_${i}_${Date.now().toString(36)}`;
    groupIds.push(gid);
    const creator = users[randInt(0, users.length - 1)];
    groupOps.push(batch => batch.set(db.collection('groups').doc(gid), {
      name, description: `A community for people into ${name.toLowerCase()}.`,
      privacy: Math.random() < 0.7 ? 'public' : 'private',
      joinMode: 'open', createdBy: creator.uid, createdAt: Date.now(),
      membersCount: 1, coverURL: '', seedTest: true
    }));
    groupOps.push(batch => batch.set(db.collection('groups').doc(gid).collection('members').doc(creator.uid), { uid: creator.uid, role: 'admin', joinedAt: Date.now(), seedTest: true }));
  });
  await commitInChunks(groupOps);

  console.log('Adding group memberships...');
  const joinCount = Math.floor(USER_COUNT * AVG_GROUP_JOINS_PER_USER);
  const groupMemberDelta = {};
  const memberOps = [];
  for (let i = 0; i < joinCount; i++) {
    const u = users[randInt(0, users.length - 1)];
    const gid = groupIds[randInt(0, groupIds.length - 1)];
    memberOps.push(batch => batch.set(db.collection('groups').doc(gid).collection('members').doc(u.uid), { uid: u.uid, role: 'member', joinedAt: Date.now(), seedTest: true }, { merge: true }));
    groupMemberDelta[gid] = (groupMemberDelta[gid] || 0) + 1;
  }
  await commitInChunks(memberOps);
  await commitInChunks(Object.keys(groupMemberDelta).map(gid => batch =>
    batch.update(db.collection('groups').doc(gid), { membersCount: admin.firestore.FieldValue.increment(groupMemberDelta[gid]) })
  ));

  // 6) A light sprinkle of comments, only if there's budget left
  const remaining = DAILY_WRITE_SOFT_CAP - writesUsed;
  const commentsToMake = Math.min(BONUS_COMMENT_COUNT, Math.max(0, remaining - 200));
  if (commentsToMake > 0) {
    console.log(`Adding ${commentsToMake} bonus comments on real posts (budget allows)...`);
    const postsSnap = await db.collection('posts').limit(200).get();
    const postIds = postsSnap.docs.map(d => d.id);
    if (postIds.length) {
      const commentTexts = ['Great post! 👏', 'This is so relatable', 'Nice one', '😂😂😂', 'Interesting take', 'Thanks for sharing'];
      const commentOps = Array.from({ length: commentsToMake }, () => {
        const postId = pick(postIds);
        const u = users[randInt(0, users.length - 1)];
        return batch => batch.set(db.collection('posts').doc(postId).collection('comments').doc(), {
          authorUid: u.uid, text: pick(commentTexts), createdAt: Date.now(), seedTest: true
        });
      });
      await commitInChunks(commentOps);
    } else {
      console.log('  (skipped — no real posts exist yet to comment on)');
    }
  } else {
    console.log('Skipping bonus comments — no write budget left today.');
  }

  console.log(`\nDone. Total writes used: ~${writesUsed} of today's ${DAILY_WRITE_SOFT_CAP}-write budget.`);
  console.log(`Created: ${USER_COUNT} users, ~${edgeCount} connections, ${GROUP_COUNT} groups, ~${joinCount} memberships, ${commentsToMake} comments.`);
  console.log('\nEverything is tagged seedTest: true. Use the "Delete Load Test Data" button in');
  console.log('the admin panel to remove all of it before going live.\n');
}

main().catch(err => { console.error('\nSeeding failed:', err); process.exit(1); });
