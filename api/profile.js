// api/profile.js — Vercel Serverless Function
// Serves a dynamic Open Graph preview page for ?user=HANDLE links.
// When WhatsApp / iMessage / Twitter / Discord scrapes the URL, they hit
// this endpoint and get a proper preview card instead of a blank page.
//
// URL pattern:  /api/profile?user=HANDLE  (or /u/HANDLE via vercel.json rewrite)

const https = require('https');

const FIREBASE_DB_URL = 'https://bumbook-default-rtdb.firebaseio.com';
const FS_PROJECT_ID   = 'bumbook';
const SITE_NAME       = 'Bum Book';
const SITE_TAGLINE    = 'Bum Book';

// Fetch JSON from Firebase REST API (no auth needed for public read rules)
// FIX: a denied/unset RTDB rule doesn't reject the HTTP request — it
// returns 200 OK with a body like {"error":"Permission denied"}, which
// JSON.parse()s into a real, truthy object. Every caller below was
// treating that as "found a value" instead of "found nothing," which
// skipped the Firestore fallback entirely and made every profile link
// dead-end at the homepage once RTDB was no longer actually used for
// this data. Normalizing that shape to null here fixes it at the source.
function fbGet(path) {
  return new Promise((resolve, reject) => {
    const url = `${FIREBASE_DB_URL}/${path}.json`;
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === 'object' && 'error' in parsed) { resolve(null); return; }
          resolve(parsed);
        }
        catch (e) { resolve(null); }
      });
    }).on('error', reject);
  });
}

// ── Firestore REST fallback ────────────────────────────────────────────────
// Users created (or auto-migrated) after the Firestore switch may not exist
// in RTDB at all anymore for this lookup, so if RTDB comes back empty we
// also check Firestore's public REST API before giving up. Requires the
// Firestore rule for the path to allow `read: if true` (public), same as
// this endpoint has always relied on RTDB's public read rule.
function _fsValueToPlain(v) {
  if (!v) return null;
  if (v.stringValue !== undefined)  return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue !== undefined)  return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined)    return null;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.mapValue)   return _fsFieldsToPlain(v.mapValue.fields || {});
  if (v.arrayValue) return (v.arrayValue.values || []).map(_fsValueToPlain);
  return null;
}
function _fsFieldsToPlain(fields) {
  const out = {};
  for (const k in fields) out[k] = _fsValueToPlain(fields[k]);
  return out;
}
function fsGet(path) {
  return new Promise((resolve) => {
    const url = `https://firestore.googleapis.com/v1/projects/${FS_PROJECT_ID}/databases/(default)/documents/${path}`;
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.fields ? _fsFieldsToPlain(json.fields) : null);
        } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// Proxy a remote image through this function so crawlers (WhatsApp, Facebook,
// Discord) can fetch it — they often block Firebase Storage URLs directly.
function proxyImage(req, res) {
  const imgUrl = req.query.__img;
  if (!imgUrl) { res.statusCode = 400; res.end(); return; }
  try {
    const parsed = new URL(imgUrl);
    const allowed = ['firebasestorage.googleapis.com', 'lh3.googleusercontent.com'];
    if (!allowed.some(h => parsed.hostname.endsWith(h))) {
      res.statusCode = 403; res.end(); return;
    }
    https.get(imgUrl, imgRes => {
      res.statusCode = 200;
      res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      imgRes.pipe(res);
    }).on('error', () => { res.statusCode = 502; res.end(); });
  } catch (e) {
    res.statusCode = 400; res.end();
  }
}

function formatCount(n) {
  if (!n || isNaN(n)) return '0';
  n = Number(n);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// FIX: use pure Node http style throughout — mixing res.setHeader() with
// res.status().send() (Express style) crashes Vercel serverless functions.
function sendHtml(res, html) {
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
  });
  res.end(buf);
}

module.exports = async (req, res) => {
  // Derive the site URL from the actual request instead of a hardcoded
  // domain — the hardcoded value (x-club-one.vercel.app) no longer matches
  // the live domain (x-musk.vercel.app), which would send shared links to
  // the wrong place.
  const host    = req.headers['x-forwarded-host'] || req.headers.host;
  const proto   = req.headers['x-forwarded-proto'] || 'https';
  const SITE_URL = `${proto}://${host}`;

  // ── Image proxy mode ─────────────────────────────────────────────────────
  if (req.query.__img) { proxyImage(req, res); return; }

  const handle   = (req.query.user || '').toLowerCase().trim();
  const uidParam = (req.query.uid  || '').trim();

  // ── Resolve UID from handle (RTDB first, Firestore fallback) ────────────
  let uid = uidParam;
  if (!uid && handle) {
    uid = await fbGet(`handles/${handle}`);
    if (!uid) {
      const fsHandle = await fsGet(`handles/${handle}`);
      // handles docs are wrapped as { value: uid } by the app's migration bridge
      uid = fsHandle ? (fsHandle.value || null) : null;
    }
  }

  // ── Load user profile (RTDB first, Firestore fallback) ──────────────────
  let profile = null;
  if (uid && typeof uid === 'string') {
    profile = await fbGet(`users/${uid}`);
    if (!profile || typeof profile !== 'object') {
      profile = await fsGet(`users/${uid}`);
    }
  }

  // ── Fallback if user not found ───────────────────────────────────────────
  if (!profile || typeof profile !== 'object') {
    res.writeHead(302, { Location: SITE_URL });
    res.end();
    return;
  }

  const displayName  = escapeHtml(profile.displayName || 'Member');
  const userHandle   = escapeHtml(profile.handle || handle || '');
  const photoURL     = profile.photoURL || '';
  const followers    = formatCount(profile.followersCount || 0);
  const following    = formatCount(profile.followingCount || 0);
  const isVerified   = profile.verified === true;
  const verifiedMark = isVerified ? ' ✓' : '';

  // The link the user will actually open in the browser. This MUST point to
  // user-profile.html (the page that actually renders a profile and is
  // guest-viewable) — index.html?user=... was silently doing nothing with
  // that query param and just showing the plain landing/sign-in screen,
  // which meant every shared profile link dead-ended there instead of
  // showing the profile.
  const profileAppURL = `${SITE_URL}/profile-view?uid=${encodeURIComponent(uid)}`;

  // FIX: ogImage was defined but NEVER used in the OG meta tags (template used
  // bare photoURL directly, so users without a photo got no og:image at all).
  // Now always set — avatar is proxied so crawlers can actually fetch it.
  const ogImage = photoURL
    ? `${SITE_URL}/api/profile?__img=${encodeURIComponent(photoURL)}`
    : `${SITE_URL}/og-default.png`;

  const title       = `${displayName}${verifiedMark} — ${SITE_NAME}`;
  const description = `${followers} followers · ${following} following${profile.bio ? ' · ' + profile.bio.slice(0, 100) : ''} · Follow ${profile.displayName || 'them'} on ${SITE_NAME}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>

  <!-- ── Primary Meta ── -->
  <meta name="description" content="${escapeHtml(description)}">

  <!-- ── Open Graph (Facebook, WhatsApp, iMessage, LinkedIn, Discord) ── -->
  <meta property="og:type"         content="profile">
  <meta property="og:site_name"    content="${escapeHtml(SITE_NAME)}">
  <meta property="og:url"          content="${escapeHtml(profileAppURL)}">
  <meta property="og:title"        content="${escapeHtml(title)}">
  <meta property="og:description"  content="${escapeHtml(description)}">
  <meta property="og:image"        content="${escapeHtml(ogImage)}">
  <meta property="og:image:width"  content="400">
  <meta property="og:image:height" content="400">
  <meta property="profile:username" content="${escapeHtml(userHandle)}">

  <!-- ── Twitter / X Card ── -->
  <meta name="twitter:card"        content="summary">
  <meta name="twitter:title"       content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image"       content="${escapeHtml(ogImage)}">

  <!-- ── Redirect to the SPA (bots won't follow this) ── -->
  <meta http-equiv="refresh" content="0;url=${escapeHtml(profileAppURL)}">
  <link rel="canonical" href="${escapeHtml(profileAppURL)}">

  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#000;color:#e7e9ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{background:#111;border:1px solid #2f3336;border-radius:16px;padding:32px;
      max-width:400px;width:100%;text-align:center}
    .avatar{width:80px;height:80px;border-radius:50%;object-fit:cover;border:3px solid #1d9bf0;margin-bottom:16px}
    .avatar-placeholder{width:80px;height:80px;border-radius:50%;background:#1d9bf0;
      display:inline-flex;align-items:center;justify-content:center;font-size:2rem;
      color:#fff;margin-bottom:16px}
    .name{font-size:1.3rem;font-weight:800;margin-bottom:4px}
    .handle{color:#71767b;font-size:0.9rem;margin-bottom:10px}
    .verified{color:#1d9bf0;font-size:0.85rem;margin-bottom:12px}
    .bio{color:#e7e9ea;font-size:0.9rem;line-height:1.5;margin-bottom:16px}
    .stats{display:flex;gap:24px;justify-content:center;margin-bottom:20px}
    .stat strong{display:block;font-size:1.1rem;font-weight:800}
    .stat span{font-size:0.78rem;color:#71767b}
    .cta{display:inline-block;background:#1d9bf0;color:#fff;padding:10px 28px;
      border-radius:9999px;font-weight:700;font-size:0.95rem;text-decoration:none;
      transition:background 0.15s}
    .cta:hover{background:#1a8cd8}
    .brand{margin-top:20px;font-size:0.75rem;color:#71767b}
  </style>
</head>
<body>
  <div class="card">
    ${photoURL
      ? `<img class="avatar" src="${escapeHtml(photoURL)}" alt="${displayName}" onerror="this.style.display='none'">`
      : `<div class="avatar-placeholder">${(profile.displayName || 'M')[0].toUpperCase()}</div>`
    }
    <div class="name">${displayName}${isVerified ? ' <span style="color:#1d9bf0">✓</span>' : ''}</div>
    <div class="handle">@${escapeHtml(userHandle)}</div>
    ${isVerified ? '<div class="verified">✓ Verified Member</div>' : ''}
    ${profile.bio ? `<div class="bio">${escapeHtml(profile.bio)}</div>` : ''}
    <div class="stats">
      <div class="stat"><strong>${followers}</strong><span>Followers</span></div>
      <div class="stat"><strong>${following}</strong><span>Following</span></div>
    </div>
    <a class="cta" href="${escapeHtml(profileAppURL)}">Follow ${displayName} →</a>
    <div class="brand">${escapeHtml(SITE_NAME)}</div>
  </div>
  <script>window.location.replace(${JSON.stringify(profileAppURL)});</script>
</body>
</html>`;

  sendHtml(res, html);
};
