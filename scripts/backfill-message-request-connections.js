#!/usr/bin/env node
/* scripts/backfill-message-request-connections.js
 * ═══════════════════════════════════════════════════════════════════════
 * ONE-TIME FIX for message requests accepted BEFORE the acceptMsgRequest
 * patch that adds both users to connections/. Those conversations already
 * have real messages sitting in Firestore under
 * conversations/{convId}/messages — they just never got wired into
 * connections/, so they can never show up in the Messages list or be
 * found again (the app only knows to watch a DM for uids that appear in
 * connections/{uid}).
 *
 * This script:
 *   1. Walks every doc in the `messages` collection group (i.e. every DM
 *      ever sent, across every conversation).
 *   2. Derives each conversation's two participant uids from its convId
 *      ("<uidA>_<uidB>", sorted — see firebase.js).
 *   3. For any pair that isn't already connected both ways, writes
 *      connections/{uidA}/{uidB} = true and connections/{uidB}/{uidA} = true
 *      — exactly what acceptConnection() in discover.js does normally.
 *
 * Safe to run more than once — every write is a no-op if the connection
 * already exists. It does NOT touch messages, message requests, or
 * anything else; it only adds missing connections/ docs.
 *
 * BEFORE YOU RUN THIS (same as the other scripts/ tools):
 *   1. Download your Firebase service account JSON (Firebase Console ->
 *      Project Settings -> Service Accounts -> Generate new private key)
 *      and save it OUTSIDE this project folder (e.g. ~/secrets/) so it
 *      never gets zipped/committed/deployed.
 *   2. export GOOGLE_APPLICATION_CREDENTIALS=~/secrets/serviceAccountKey.json
 *      (Windows PS: $env:GOOGLE_APPLICATION_CREDENTIALS="C:\secrets\serviceAccountKey.json")
 *   3. npm install firebase-admin   (from the project root, if not already)
 *   4. node scripts/backfill-message-request-connections.js
 * ═══════════════════════════════════════════════════════════════════════
 */

const admin = require('firebase-admin');
const fs = require('fs');

/* ── Load service account (same fallback pattern as the other scripts) ── */
let keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (keyPath) {
  if (!fs.existsSync(keyPath)) {
    console.error(`\nGOOGLE_APPLICATION_CREDENTIALS is set to ${keyPath} but that file doesn't exist.\n`);
    process.exit(1);
  }
} else {
  const fallback = require('path').join(__dirname, '..', 'serviceAccountKey.json');
  if (fs.existsSync(fallback)) {
    console.warn('\n⚠️  Using serviceAccountKey.json from inside the project folder. Prefer GOOGLE_APPLICATION_CREDENTIALS instead — see the header of this file.\n');
    keyPath = fallback;
  } else {
    console.error('\nNo service account found. Set GOOGLE_APPLICATION_CREDENTIALS — see the header of this file.\n');
    process.exit(1);
  }
}

admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });
const db = admin.firestore();

async function main() {
  console.log('Scanning every conversation for missing connections…\n');

  const convIds = new Set();
  const snap = await db.collectionGroup('messages').select().get(); // select() with no args = doc refs only, minimal read cost
  snap.forEach(doc => {
    const convRef = doc.ref.parent.parent; // conversations/{convId}
    if (convRef) convIds.add(convRef.id);
  });

  console.log(`Found ${convIds.size} conversation(s) with at least one message.\n`);

  let checked = 0, fixed = 0, skippedBadId = 0, writes = 0;

  for (const convId of convIds) {
    checked++;
    const parts = convId.split('_');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      skippedBadId++;
      continue;
    }
    const [uidA, uidB] = parts;

    const [aHasB, bHasA] = await Promise.all([
      db.collection('users').doc(uidA).collection('connections').doc(uidB).get(),
      db.collection('users').doc(uidB).collection('connections').doc(uidA).get(),
    ]);

    if (aHasB.exists && bHasA.exists) continue; // already connected both ways — nothing to do

    const batch = db.batch();
    if (!aHasB.exists) {
      batch.set(db.collection('users').doc(uidA).collection('connections').doc(uidB), { value: true });
      writes++;
    }
    if (!bHasA.exists) {
      batch.set(db.collection('users').doc(uidB).collection('connections').doc(uidA), { value: true });
      writes++;
    }
    await batch.commit();
    fixed++;
    console.log(`  ✓ Reconnected ${uidA} <-> ${uidB}`);
  }

  console.log(`\nDone. Checked ${checked} conversation(s), fixed ${fixed}, ${writes} write(s), skipped ${skippedBadId} with an unexpected id format.`);
  console.log('Affected users should now see those conversations in their Messages list.\n');
}

main().catch(e => { console.error('\nBackfill failed:', e); process.exit(1); });
