/* api/check-scheduled-pushes.js
 *
 * Called on a schedule by an EXTERNAL free cron pinger (cron-job.org),
 * once a minute — see PUSH_NOTIFICATIONS_SETUP.md for setup steps. Vercel's
 * own free-tier cron only fires once a day, which isn't precise enough for
 * "notify me at 3:15pm", so this route is designed to be triggered from
 * outside Vercel instead.
 *
 * Uses the Firebase Admin SDK (not the app's normal client-side Firestore
 * access) because this needs to read/write data across ALL users — a
 * privileged, server-only operation that should never be reachable via the
 * public Firestore rules the app's frontend uses.
 *
 * Protected by a shared secret (CRON_SECRET) so randos can't hit this URL
 * and force early sends.
 */

const webpush = require('web-push');
const admin   = require('firebase-admin');

// ── One-time setup (runs once per warm serverless instance) ──────────────
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

webpush.setVapidDetails(
  'mailto:you@example.com', // change to a real contact address
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

module.exports = async (req, res) => {
  if (req.query.secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const now = Date.now();
  const dueSnap = await db.collection('scheduledPushes')
    .where('sent', '==', false)
    .where('sendAt', '<=', now)
    .limit(50) // stay well under the 10s function time limit per run
    .get();

  if (dueSnap.empty) {
    res.status(200).json({ checked: 0, sent: 0 });
    return;
  }

  let sentCount = 0;
  const results = [];

  for (const doc of dueSnap.docs) {
    const item = doc.data();
    try {
      const subsSnap = await db.collection('pushSubscriptions').where('uid', '==', item.uid).get();
      if (subsSnap.empty) { await doc.ref.update({ sent: true, error: 'no active subscriptions' }); continue; }

      let sentToAny = false;
      for (const subDoc of subsSnap.docs) {
        try {
          await webpush.sendNotification(subDoc.data().subscription, JSON.stringify({
            title: item.title || 'Bum Book',
            body: item.body || '',
            url: item.url || '/',
          }));
          sentToAny = true;
        } catch (err) {
          // 404/410 means the browser unsubscribed — clean up so we stop trying.
          if (err.statusCode === 404 || err.statusCode === 410) {
            await subDoc.ref.delete().catch(() => {});
          }
        }
      }
      await doc.ref.update({ sent: true, sentAt: now });
      if (sentToAny) sentCount++;
      results.push({ id: doc.id, status: sentToAny ? 'sent' : 'failed' });
    } catch (err) {
      await doc.ref.update({ sent: true, error: String(err.message || err) }).catch(() => {});
      results.push({ id: doc.id, status: 'failed', error: String(err.message || err) });
    }
  }

  res.status(200).json({ checked: dueSnap.size, sent: sentCount, results });
};
