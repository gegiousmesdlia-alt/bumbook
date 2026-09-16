# Reels (YouTube) — Setup

Reels pulls short videos from YouTube. One environment variable is all
it needs. Until it's set, the Reels tab shows a friendly "not set up yet"
message instead of breaking.

## 1. Get a YouTube Data API key (free)

1. Go to **https://console.cloud.google.com/**
2. Create a project (or pick an existing one).
3. **APIs & Services → Library** → search **"YouTube Data API v3"** → **Enable**.
4. **APIs & Services → Credentials → Create Credentials → API key**.
5. Copy the key.

**Restrict the key** (recommended, takes 20 seconds): click the key →
under *API restrictions* choose **Restrict key** → select **YouTube Data
API v3** → Save. Leave *Application restrictions* as **None** — this key
is used from the server, not the browser, so HTTP-referrer restrictions
would block it.

## 2. Add it to Vercel

Vercel project → **Settings → Environment Variables**:

| Name | Value |
|---|---|
| `YOUTUBE_API_KEY` | the key from step 1 |

Then **redeploy** — Vercel only picks up new env vars on a fresh deployment.

That's the whole setup. No cron, no service account, no billing.

---

## The quota, and why it matters

This is the one thing worth understanding, because it's the constraint
the whole feature is designed around.

The free YouTube Data API gives you **10,000 quota units per day**, and a
single search call costs **100 units**. That's only **~100 searches per
day for your entire site** — not per user. Naively, about 100 people
opening Reels once each would exhaust the daily quota and everyone else
would see errors until midnight Pacific.

So `api/youtube-reels.js` sets a CDN cache header:

```
Cache-Control: s-maxage=10800, stale-while-revalidate=172800
```

This means Vercel's CDN serves one cached response to everyone for **3
hours**, and keeps serving slightly-stale results for up to 2 days while
refreshing in the background. Thousands of users end up sharing a handful
of actual API calls. Each distinct search term is cached separately —
which is exactly why the section below matters as much as the cache
duration itself.

**Practical implications:**
- Normal browsing (people scrolling the default feed) is essentially free.
- Heavy use of the *search* box burns quota faster, since each new term is
  a fresh uncached call.
- If you do hit the cap, the app detects it and shows "Reels are taking a
  break" rather than a broken screen. It resets at midnight US Pacific.

## Reducing usage further

The single biggest lever isn't the cache duration — it's how many
*distinct* search terms get requested, since each one is its own cache
entry that needs its own periodic refresh. Personalization (showing
people topics they've liked before) naturally works against this, because
different users asking for different things can't share a cache entry.

What's already in place to manage that tradeoff:
- The "discovery" pick (used when there's no personalization match, or a
  new visitor with no history yet) is **time-bucketed to the same 3-hour
  window the cache uses**, not randomized per request — so everyone
  browsing in that window converges on the same topic and shares one
  cached call, instead of each visitor rolling their own topic and
  fragmenting the cache into many small pieces.
- Stats (`youtube-stats`) and channel pages (`youtube-channel`) cache for
  6 and 3 hours respectively — their data changes slowly, so there's no
  reason to refetch often.
- Both endpoints already use the cheapest API call available for what
  they do (1-2 units vs. the 100-unit search) — see the file headers.

**If usage still grows past comfortable levels, in rough order of effort:**

1. **Stretch the cache windows further** (e.g. 6-12 hours instead of 3).
   Free, one-line changes, at the cost of content feeling a bit less
   "live."
2. **Cap personalization's fragmancy** — right now a user's own interest
   list (up to 15 topics) can each become a distinct search. Narrowing
   that to their top 3-5 most-liked topics would cut it further while
   keeping most of the personalization value.
3. **Build a self-hosted video pool** (the real fix if the site gets
   genuinely busy): a scheduled job (reusing the cron setup from push
   notifications) fetches a batch of videos per topic every few hours and
   stores them in Firestore. The app then reads from Firestore instead of
   calling YouTube directly on every cache miss — so usage becomes
   entirely controlled by your own schedule (a fixed, predictable number
   of calls per day) instead of being at the mercy of traffic patterns and
   CDN cache eviction. This is a bigger lift than the others — ask if you
   want it built.
4. **Request a quota increase from Google** — free, via a compliance
   review form in Google Cloud Console, not a paid tier. Worth doing once
   the site has real traffic and a track record, since Google wants to see
   the app actually in use before granting more.

## Notes

- Videos are filtered to `videoDuration=short` (under 4 minutes),
  `videoEmbeddable=true`, and `videoSyndicated=true` so nothing unplayable
  makes it into the feed.
- `safeSearch=moderate` is on.
- Reels start **muted**, because browsers block autoplay with sound. The
  speaker button unmutes.
- Only the on-screen video is actually mounted as a player; the rest are
  static thumbnails. This keeps memory and bandwidth sane on long scrolls.
- The topics the default feed rotates through are the `DEFAULT_TOPICS`
  array at the top of `api/youtube-reels.js` — edit that list to change
  what kind of content shows up.
