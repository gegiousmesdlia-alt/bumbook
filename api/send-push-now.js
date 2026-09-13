/* api/send-push-now.js
 *
 * Sends a push notification immediately (no polling delay), for real-time
 * events like a new DM — unlike api/check-scheduled-pushes.js, which is
 * for FUTURE reminders and only runs once a minute.
 *
 * SECURITY: the caller must include their Firebase ID token, which we
 * verify server-side with the Admin SDK before doing anything. Without
 * this, anyone could POST here claiming to be any user and spam push
 * notifications to any other user's phone.
 */

const webpush = require('web-push');
const admin   = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

webpush.setVapidDetails(
  'mailto:you@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { idToken, targetUid, title, body, url } = req.body || {};
  if (!idToken || !targetUid || !title) {
    res.status(400).json({ error: 'Missing idToken, targetUid, or title' });
    return;
  }

  // Verify the caller is who they claim to be. We don't actually need to
  // use the resulting uid for anything except proving it's a real,
  // logged-in user of this app — anyone can send anyone else a
  // notification (same as a real DM notify), so no extra ownership check
  // is needed beyond "this is a genuine authenticated request".
  try {
    await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  try {
    const subsSnap = await db.collection('pushSubscriptions').where('uid', '==', targetUid).get();
    if (subsSnap.empty) { res.status(200).json({ sent: 0, reason: 'recipient has no active subscriptions' }); return; }

    let sentCount = 0;
    await Promise.all(subsSnap.docs.map(async (doc) => {
      try {
        await webpush.sendNotification(
          doc.data().subscription,
          JSON.stringify({ title, body: body || '', url: url || '/messages' })
        );
        sentCount++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await doc.ref.delete().catch(() => {}); // stale subscription — clean up
        }
      }
    }));

    res.status(200).json({ sent: sentCount });
  } catch (err) {
    console.error('[send-push-now] failed:', err);
    res.status(500).json({ error: 'Failed to send' });
  }
};
