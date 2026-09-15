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
Cache-Control: s-maxage=1800, stale-while-revalidate=86400
```

This means Vercel's CDN serves one cached response to everyone for 30
minutes, and keeps serving slightly-stale results for up to a day while
refreshing in the background. Thousands of users end up sharing a handful
of actual API calls. Each distinct search term is cached separately.

**Practical implications:**
- Normal browsing (people scrolling the default feed) is essentially free.
- Heavy use of the *search* box burns quota faster, since each new term is
  a fresh uncached call.
- If you do hit the cap, the app detects it and shows "Reels are taking a
  break" rather than a broken screen. It resets at midnight US Pacific.

**If you outgrow the free quota**, you can request more from Google
(free, but requires a compliance review), or reduce the cost by caching
results in Firestore for longer — e.g. refresh each topic once a day and
serve everything else from your own database.

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
