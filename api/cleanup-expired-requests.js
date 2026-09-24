/* api/cleanup-expired-requests.js
 *
 * Triggered by Vercel Cron (see vercel.json's "crons" entry) once daily.
 * Deletes any users/{uid}/messageRequests/{fromUid} doc whose expiresAt
 * has passed — a request that's sat unanswered for 30 days is treated as
 * abandoned rather than kept forever, which (a) matches how most
 * request-style inboxes behave and (b) keeps this collection from
 * growing without bound, which matters given the quota issues hit
 * elsewhere in this app from unbounded reads.
 *
 * Vercel Cron sends a GET to this URL on schedule with an
 * Authorization: Bearer <CRON_SECRET> header (when CRON_SECRET is set
 * in your Vercel project's env vars) — checked below so this endpoint
 * can't be triggered by anyone just visiting the URL. If you haven't
 * set CRON_SECRET yet: Vercel dashboard -> project -> Settings ->
 * Environment Variables -> add CRON_SECRET with any random value, then
 * Vercel automatically sends it as that header on scheduled invocations.
 *
 * Requests created BEFORE this feature shipped have no expiresAt field
 * at all — those are deliberately left alone here (undefined is not
 * "< now"), so nothing old gets swept away by surprise on first deploy.
 */

const admin = require('firebase-admin');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

module.exports = async (req, res) => {
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  try {
    const now = Date.now();
    const snap = await db.collectionGroup('messageRequests').where('expiresAt', '<', now).get();

    let deleted = 0;
    const batchSize = 400; // stay under Firestore's 500-op batch limit
    for (let i = 0; i < snap.docs.length; i += batchSize) {
      const batch = db.batch();
      snap.docs.slice(i, i + batchSize).forEach(doc => { batch.delete(doc.ref); deleted++; });
      await batch.commit();
    }

    res.status(200).json({ ok: true, deleted });
  } catch (err) {
    console.error('[cleanup-expired-requests] failed:', err);
    res.status(500).json({ error: 'cleanup_failed', message: String(err && err.message || err) });
  }
};
