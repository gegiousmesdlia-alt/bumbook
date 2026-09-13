# Firestore Migration — What Changed & What You Need To Do

## What was changed
- **`firebase.js`** — rewritten. Every `XF.*` function still has the exact same
  name/signature as before, but internally: reads now merge Realtime Database
  (old data) + Firestore (new data); anything created going forward
  (`XF.push(...)`) is written to Firestore only; single records (a user, post,
  message, etc.) auto-copy themselves into Firestore the first time they're
  read from RTDB.
- **`feed.js`** — the post-feed pagination used to query RTDB directly; it now
  calls a new `XF.getPostsPage()` helper that merges both sources.
- **`messages.js`** — the DM message list used to query RTDB directly; it now
  uses the merged `XF.on('dms/...')` listener. The **typing indicator** was
  left untouched — it still talks to RTDB directly on purpose, since it's
  throwaway presence data that doesn't need migrating.
- **Every `.html` page** — added the Firestore SDK script tag
  (`firebase-firestore-compat.js`) alongside the existing Firebase scripts.

## Before you deploy — one-time setup in the Firebase console
1. **Enable Firestore** on the `x-club-413fa` project (Firebase console →
   Firestore Database → Create database), if you haven't already. Pick the
   same region as your RTDB instance (`europe-west1`) to keep latency low.
2. **Set Firestore security rules.** Right now there are none written for
   this project — without rules, Firestore defaults to locked (no one can
   read/write). At minimum you'll want rules mirroring your current RTDB
   rules (e.g. a user can write their own `users/{uid}` doc, anyone signed in
   can read posts, etc.). I can draft these next if you'd like.
3. **Composite index heads-up**: `getPostsPage()` uses `orderBy('createdAt')`
   with a `where('createdAt', '<', ...)` for pagination — Firestore may ask
   you to create a composite index the first time this runs (it'll give you
   a direct link in the browser console error to auto-create it).

## What to test after deploying
- [ ] Load the feed as an existing user — old posts (from RTDB) and any new
      posts should appear together, sorted correctly.
- [ ] Create a new post — confirm it shows up (it's now in Firestore).
- [ ] Open an existing DM conversation — old + new messages should appear.
- [ ] Send a new DM — confirm delivery/read receipts still work.
- [ ] Log in as an existing user — profile data should load normally (it
      self-migrates into Firestore on this first read).
- [ ] Admin panel: verify user list, post moderation, and delete actions
      still work (deletes now clear both RTDB and Firestore copies).

## Not migrated (on purpose)
- `typing/...` and `presence/...` — ephemeral, stays on RTDB only.

## Nothing was deleted
No data was removed from Realtime Database. Old records simply get copied
into Firestore the first time they're touched; RTDB keeps its data as a
backup underneath.
