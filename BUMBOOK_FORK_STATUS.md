# Bum Book — Fork Status (Pass 3: Firestore-Only Simplification)

## Pass 3 (this pass) — dropped the dual-database bridge
X-Musk's `firebase.js` mirrored data across Realtime Database AND Firestore
simultaneously — that only existed to migrate X-Musk's years of existing
RTDB data without losing anything. Bum Book is a brand-new project with no
legacy data, so that whole bridge (self-migration-on-read, dual-read
merging, primitive wrapping for migration) was pure unnecessary complexity
here. Removed it entirely:
- **Firestore is now the only database for all app data** — users, posts,
  comments, connections, DMs, notifications, verification requests,
  everything.
- **Realtime Database is used ONLY for typing indicators and presence** —
  the one place a second database actually earns its keep (very frequent,
  throwaway, low-latency writes). Everything else was removed from
  `database.rules.json` — it now only has `typing`/`presence` rules.
- `firebase.js` shrank from ~450 lines of dual-database bridging logic to
  a much simpler direct-to-Firestore implementation. Same external API
  (`XF.get/set/push/...`) so nothing else in the app needed to change.
- Using two databases for the same data does NOT save storage — it roughly
  doubles it, since the same record sits duplicated in both places. This
  simplification is actually the storage-efficient version: each piece of
  data lives in exactly one place.

## What's done now
**Pass 1 (feature stripping + free verification)** — see git history / previous
notes: Flutterwave/investments fully removed, free selfie+ID verification
flow with admin review queue built.

**Pass 2 (this pass) — full single-page-app rebuild:**
- All 11 pages (landing, login, register, reset, feed, discover,
  notifications, messages, profile, user-profile, post-detail) now live in
  ONE `index.html`. Navigating between them no longer reloads the browser
  at all — `showPage()` just swaps which section is visible.
- Real, bookmarkable URLs via the History API: `/feed`, `/messages`,
  `/profile-view?uid=...`, `/post?postId=...`, etc. Back/forward buttons
  work correctly. Refreshing on any of these routes works too — added a
  Vercel rewrite so the server serves `index.html` for all of them.
- Pagination is untouched — the feed still loads posts in pages via
  `getPostsPage()`, exactly as before. SPA only changed navigation, not
  data-loading strategy.
- Push notification deep-links updated to the new route scheme (`/feed`,
  `/messages?uid=...`, `/post?postId=...` instead of `.html` files) —
  tapping a notification still opens the exact right conversation/post.
- `auth.js` was restructured: one-time global init (nav bar, notification
  watchers, presence) now genuinely only runs once per session instead of
  re-running on every navigation (a real SPA benefit, not just a port).
  Page-specific rendering was extracted into a reusable `onPageActivated()`
  function that the router calls on every view switch.
- **`admin.html` was deliberately left OUT of the merge** — it's still its
  own separate document for now, one step closer to the eventual separate
  admin app. `router.js` has an `ADMIN_APP_URL` constant (currently
  `/admin.html`) to update once that split actually happens.
- Cold-boot loading screen (the branded splash) now only appears ONCE ever
  per browser session — not on every navigation, since there's no more
  reloading. This directly solves the "flashing between tabs" complaint.

### A note on how this got built
The first two merge attempts had real bugs — duplicate element IDs from
overlapping page content, and a broken extraction that accidentally
duplicated the bottom nav bar 8 times. Both were caught by validation
before shipping (checked for duplicate IDs, verified each page/shell
element appears exactly once, confirmed HTML tags balance) rather than
being left for you to discover. Final state: 103 unique IDs, zero
duplicates, all 11 pages present exactly once.

## Still not done
1. **Visual identity** — still X-Musk's red/gold theme and copy. Next up.
2. **Admin split into its own deployment** — admin.html still lives in
   this project, just excluded from the SPA merge.
3. **iPhone install tutorial (admin-editable, with images)** — not built.
4. **New Firebase project** — still need to create it and fill in the
   `REPLACE_ME` spots in `firebase.js` and `push.js`.
5. **Push notifications on the new backend** — needs its own VAPID keys,
   service account, and cron job once the new Firebase project exists.
6. **Naming/branding/logo** — "Bum Book" text is in place (title, manifest,
   loading screen) but no actual logo/icon design yet — still using X-Musk's
   plain "✕" mark as a placeholder.

## To test this pass
1. Fill in the Firebase config placeholders, publish both rule files.
2. Deploy to Vercel.
3. Click between Home/Discover/Messages/Notifications/Profile — confirm no
   page reload happens (no flash, URL changes smoothly).
4. Refresh the browser while on `/messages` or `/profile` — confirm it
   loads correctly instead of 404ing.
5. Use browser back/forward buttons — confirm they move between views
   correctly.

