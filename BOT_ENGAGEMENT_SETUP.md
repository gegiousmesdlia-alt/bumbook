# Bot Engagement — Setup

Automates what `scripts/seed-engagement.js` does by hand: when a real user
posts, a few seed accounts like it over the following minutes/hours, and
~60% of those likers send a connection request some time after that. See
the header of `api/run-bot-engagement.js` for exactly what it writes and
why.

**This reuses the same `FIREBASE_SERVICE_ACCOUNT_JSON` and `CRON_SECRET`
env vars from `PUSH_NOTIFICATIONS_SETUP.md` — if push notifications are
already set up, you don't need to touch those again.**

## 1. Turn it on
Add one new environment variable in Vercel (**Settings → Environment
Variables**):

| Name | Value |
|---|---|
| `BOT_ENGAGEMENT_ENABLED` | `true` |

Redeploy after adding it. **This is the master switch** — set it to
anything other than `true` (or just delete it) to turn the whole thing
off instantly; the endpoint will no-op without touching Firestore at all.

## 2. Add a second free cron job
On the same cron-job.org account from the push-notifications setup:
1. Create another cron job:
   - **URL:** `https://YOUR-BUMBOOK-DOMAIN.vercel.app/api/run-bot-engagement?secret=YOUR_CRON_SECRET`
   - **Schedule:** every 5 minutes (no need for every-1-minute here — the
     whole point is staggered, not instant, reactions)
2. Save it.

That's the entire setup. From here it runs on its own: every 5 minutes it
checks for new real posts and fires whatever scheduled likes/connects are
due.

## Before you ever go live
Three separate things to check, since this is explicitly a pre-launch
testing tool:
1. **Delete the cron job on cron-job.org** (or set `BOT_ENGAGEMENT_ENABLED`
   to anything but `true`) — either alone stops all future activity.
2. **Admin panel → Delete Load Test Data** — now also cleans up everything
   this created (likes, connection requests, the bot's own notifications,
   and any actions still sitting in its queue waiting to fire).
3. Double check nothing's left with the `botqueue` type finishing at 0
   remaining — it also deletes the two small cached state docs
   (`botState/seedUidPool`, `botState/postCursor`) so a future re-enable
   starts clean instead of picking up stale state.

## Tuning
All the knobs (how many seed users react per post, how spread out the
delays are, what fraction of likers go on to request a connection) are
constants at the top of `api/run-bot-engagement.js` — `LIKERS_MIN`/`MAX`,
`LIKE_DELAY_MIN_MIN`/`MAX_MIN`, `CONNECT_CHANCE`,
`CONNECT_DELAY_MIN_MIN`/`MAX_MIN`. No redeploy-and-guess needed for the
seed user pool size, either — it's read from Firestore, not hardcoded.

## Notes / limits
- The `where('seedTest','==',true)` query over all seed users is
  deliberately cached for 24 hours (`botState/seedUidPool`) instead of
  run every tick — running it every 5 minutes against thousands of seed
  users would burn through the Spark plan's 50K-reads/day budget by
  itself.
- Scans up to 10 new posts and fires up to 100 due queue actions per
  invocation — plenty for normal testing volume; if you're posting in
  bursts of dozens at once, some reactions will just land on the next
  5-minute tick instead.
- A connect request is skipped (silently, no error) if that pair is
  already connected or already has a pending request either direction —
  it won't spam duplicates.
