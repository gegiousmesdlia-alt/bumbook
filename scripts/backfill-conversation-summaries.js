#!/usr/bin/env node
/* scripts/backfill-conversation-summaries.js
 * ═══════════════════════════════════════════════════════════════════════
 * ONE-TIME FIX for conversations that existed BEFORE the conv-list
 * redesign (see notifications.js's _watchConv header comment). The conv
 * list and unread badge now read from a maintained conversations/{convId}
 * doc — { unread: {uid: n}, lastMessage: {...} } — kept up to date by
 * _dmNotifyRecipient on every NEW send. Conversations that already
 * existed before that change has no such doc yet, so until someone sends
 * a fresh message in them, they'd show a blank preview and 0 unread even
 * if there are genuinely unread messages sitting there.
 *
 * This script computes the correct lastMessage + unread count for every
 * existing conversation from its REAL message history (readBy field,
 * same definition the old full-history-scan code used) and writes it
 * once into conversations/{convId}, so old conversations start showing
 * correctly immediately, without waiting on a new message to "wake"
 * them.
 *
 * ⚠️ UNLIKE backfill-message-request-connections.js, this one reads
 * every existing message's FULL data (not just refs) — that's
 * unavoidable here since computing accurate historical unread counts
 * genuinely requires looking at readBy on every message. This costs
 * roughly 1 Firestore read per message that has EVER been sent across
 * the whole app. If you're on the Spark (free) plan, run this on its own
 * — not combined with other admin scripts the same day — right after
 * your daily quota resets (midnight Pacific), so it has the best chance
 * of finishing in one run. If it's interrupted partway by a quota limit,
 * it's safe to just run it again later: every write is idempotent
 * (recomputed fresh from source data each time, not incremented).
 *
 * Safe to run more than once. Does NOT touch messages, connections, or
 * message requests — only conversations/{convId} summary docs.
 *
 * BEFORE YOU RUN THIS (same as the other scripts/ tools):
 *   1. Download your Firebase service account JSON (Firebase Console ->
 *      Project Settings -> Service Accounts -> Generate new private key)
 *      and save it OUTSIDE this project folder (e.g. ~/secrets/).
 *   2. export GOOGLE_APPLICATION_CREDENTIALS=~/secrets/serviceAccountKey.json
 *      (Windows PS: $env:GOOGLE_APPLICATION_CREDENTIALS="C:\secrets\serviceAccountKey.json")
 *   3. npm install firebase-admin   (from the project root, if not already)
 *   4. node scripts/backfill-conversation-summaries.js
 * ═══════════════════════════════════════════════════════════════════════
 */

const admin = require('firebase-admin');
const fs = require('fs');

let keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (keyPath) {
  if (!fs.existsSync(keyPath)) {
    console.error(`\nGOOGLE_APPLICATION_CREDENTIALS is set to ${keyPath} but that file doesn't exist.\n`);
    process.exit(1);
  }
} else {
  const fallback = require('path').join(__dirname, '..', 'serviceAccountKey.json');
  if (fs.existsSync(fallback)) {
    console.warn('\n⚠️  Using serviceAccountKey.json from inside the project folder. Prefer GOOGLE_APPLICATION_CREDENTIALS instead.\n');
    keyPath = fallback;
  } else {
    console.error('\nNo service account found. Set GOOGLE_APPLICATION_CREDENTIALS — see the header of this file.\n');
    process.exit(1);
  }
}

admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });
const db = admin.firestore();

async function main() {
  console.log('Reading every existing message to compute conversation summaries…');
  console.log('(This is a one-time full scan — see the cost warning in this file\'s header.)\n');

  // convId -> { messages: [{senderUid, createdAt, readBy}], uidA, uidB }
  const byConv = new Map();

  const snap = await db.collectionGroup('messages').get();
  snap.forEach(doc => {
    const convRef = doc.ref.parent.parent;
    if (!convRef) return;
    const convId = convRef.id;
    const parts = convId.split('_');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return;

    if (!byConv.has(convId)) byConv.set(convId, { uidA: parts[0], uidB: parts[1], messages: [] });
    const m = doc.data();
    byConv.get(convId).messages.push({
      senderUid: m.senderUid,
      createdAt: m.createdAt || 0,
      readBy: m.readBy || {},
      text: m.text,
      imageUrl: m.imageUrl,
      imageUrls: m.imageUrls,
      fileName: m.fileName,
    });
  });

  console.log(`Found ${byConv.size} conversation(s) with at least one message.\n`);

  let written = 0;
  for (const [convId, { uidA, uidB, messages }] of byConv) {
    messages.sort((a, b) => a.createdAt - b.createdAt);
    const latest = messages[messages.length - 1];

    const unreadFor = uid => messages.filter(m => m.senderUid !== uid && !m.readBy[uid]).length;

    const lastMessage = latest ? {
      text: (latest.imageUrl || latest.imageUrls || latest.fileName) ? '' : (latest.text || ''),
      senderUid: latest.senderUid,
      createdAt: latest.createdAt,
      ...(latest.imageUrl || latest.imageUrls ? { imageUrls: true } : {}),
      ...(latest.fileName ? { fileName: latest.fileName } : {}),
    } : null;

    await db.collection('conversations').doc(convId).set({
      lastMessage,
      unread: { [uidA]: unreadFor(uidA), [uidB]: unreadFor(uidB) },
    }, { merge: true });

    written++;
    console.log(`  ✓ ${convId}: ${messages.length} message(s), unread ${uidA.slice(0,6)}…=${unreadFor(uidA)} ${uidB.slice(0,6)}…=${unreadFor(uidB)}`);
  }

  console.log(`\nDone. Wrote summaries for ${written} conversation(s).`);
  console.log('Old conversations should now show correct previews and unread counts immediately.\n');
}

main().catch(e => { console.error('\nBackfill failed:', e); process.exit(1); });
