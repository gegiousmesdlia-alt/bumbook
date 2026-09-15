# Push Notifications — Live Setup (Vercel Hobby-compatible)

This makes real, scheduled push notifications work on your actual live
site, entirely on free tiers. Three things need setting up: a Firebase
service account, environment variables in Vercel, and a free external
cron pinger.

## 1. Get a Firebase service account key (free)
1. Firebase console → your project → ⚙️ Project Settings → **Service Accounts** tab.
2. Click **Generate new private key**. This downloads a `.json` file.
3. Keep this file secret — it grants full admin access to your Firebase project. Never commit it to GitHub.

## 2. Set environment variables in Vercel
Go to your Vercel project → **Settings → Environment Variables** and add:

| Name | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | `BN6f53e4P_MXd96Tt-dKivlD3lm5MCJ-pqpyE38F6HXV5Vo6aw7T3Ot5V2Ej3xFFEAh0cxRyTmO52dHqH13dYiQ` |
| `VAPID_PRIVATE_KEY` | `takoK09aHbKZ5_Ub6U18P03BCcF9Q2KF_2sVvUM_iNs` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | the ENTIRE contents of the service account `.json` file from step 1, pasted as one line |
| `CRON_SECRET` | `8d06af9b5a82915a732f37de2cf6b6c225442c60807bf9f0b5b53dbf2185d58e` (or generate your own with `openssl rand -hex 32`) |

This is a fresh, real, working VAPID key pair generated specifically for
Bum Book — not reused from any other project. Treat `VAPID_PRIVATE_KEY`
like a password (it's server-only, never shipped to the browser); the
public key is safe to expose and is also read from this same env var by
the frontend.

Redeploy after adding the environment variables — Vercel only picks them up on a new deployment.

**Important — the public key also lives in the frontend code, separately
from the env var.** `push.js` has its own `const VAPID_PUBLIC_KEY = '...'`
used when the browser subscribes. It must be *byte-for-byte identical* to
the `VAPID_PUBLIC_KEY` env var the server signs with — if they ever
diverge (e.g. you regenerate a new key pair later), every push silently
fails, because the browser subscribed under a different key than the one
the server is now signing with. If you swap keys in the future, update
both places in the same commit.

## 3. Set up the free cron pinger
1. Go to **cron-job.org** and create a free account.
2. Create a new cron job:
   - **URL:** `https://YOUR-BUMBOOK-DOMAIN.vercel.app/api/check-scheduled-pushes?secret=YOUR_CRON_SECRET` (use the same value you set for `CRON_SECRET`)
   - **Schedule:** every 1 minute
3. Save it. That's it — cron-job.org will now hit that URL every minute, and your endpoint checks Firestore for anything due and sends it.

## How it works end-to-end

**Scheduled reminders** (e.g. RSVP → 1-hour-before reminder):
1. A user turns on "Push notifications on this device" in Settings (Profile → Settings) → `enablePushNotifications()` in `push.js` runs → browser asks for permission → subscribes → the subscription is saved to Firestore (`pushSubscriptions/{id}`, tagged with the owner's uid — a user can have more than one, e.g. desktop + phone).
2. Something schedules a reminder — right now this happens automatically when someone RSVPs to an event (1 hour before start) via `maybeScheduleEventReminder()` in `feed.js`. This just writes a plain record to `scheduledPushes/{id}: { uid: targetUid, title, body, sendAt, sent:false }`.
3. Once a minute, cron-job.org calls `/api/check-scheduled-pushes`. That function (using the Firebase Admin SDK + your service account) checks for anything due, looks up ALL of that target user's subscriptions, sends via `web-push` to each, and marks it sent.

**Instant notifications** (e.g. new DM — no polling delay):
1. When a DM is sent, `_dmNotifyRecipient()` in `messages.js` calls `sendPushNow(targetUid, ...)`.
2. That calls `/api/send-push-now` directly, right away — no waiting for the next cron tick. The endpoint verifies the sender's Firebase ID token server-side before doing anything, so this can't be abused to spam push notifications to someone else's phone by forging a request.
3. It looks up the target's subscriptions and sends immediately via `web-push`.

Either path ends the same way: the browser's service worker (`sw.js`) receives the push and shows the notification — even if every tab is closed.

## Adding your own notification moments
For a FUTURE reminder (polled once a minute — fine for anything not time-critical to the second):
```js
schedulePushNotification(targetUid, title, body, sendAtMs, url);
```
For something that should arrive right away (like a DM):
```js
sendPushNow(targetUid, title, body, url);
```
Both silently do nothing if the target hasn't enabled notifications, so they're always safe to call.

## Notes / limits
- Firestore Spark (free) plan limits: 50K reads / 20K writes per day. A once-a-minute check that finds nothing due is still 1 read — 1,440 reads/day just from the cron job, which is nowhere near the free limit.
- `check-scheduled-pushes.js` processes up to 50 due notifications per run to stay well inside Vercel's function time limit — fine for normal use, but if you ever have bursts of hundreds scheduled for the exact same minute, some would roll to the next run instead.
- If a subscription becomes invalid (user cleared browser data, uninstalled, etc.), the send fails with a 404/410 and the code automatically deletes that subscription — no manual cleanup needed.
