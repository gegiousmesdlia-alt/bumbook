// boot.js — X Club — App Initialisation (fires on DOMContentLoaded)
'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  applyStoredTheme();
  if (typeof detectAndSetLanguage === 'function') detectAndSetLanguage(); // fire-and-forget — never blocks boot on a slow/failed IP lookup
  if (typeof initLandingParticles === 'function') initLandingParticles();
  updateNavActive();

  // Register the service worker (offline asset caching + push notification
  // support). This was present as a file but never actually registered
  // anywhere before now.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => console.error('[SW] registration failed:', err));
  }

  // Activate landing page immediately if we're on it
  const landingPage = document.getElementById('page-landing');
  if (landingPage) landingPage.classList.add('active');

  // Safety net: Firebase should report auth state within a couple of
  // seconds even on a slow connection. If it genuinely never fires (e.g.
  // a real network failure), don't just silently reveal the landing/login
  // screen after a short timeout — that was the bug causing people who
  // were still actually logged in to see a login prompt and re-enter
  // credentials unnecessarily on a slow refresh. Instead, wait far longer
  // before giving up, and when we do, show a clear retry option rather
  // than pretending we know they're signed out.
  const loaderFailsafe = setTimeout(() => {
    console.error('[boot] Firebase auth never responded after 15s');
    showLoaderRetry();
  }, 15000);

  try {
    // Guard against duplicate init (bfcache / hot reload)
    if (!firebase.apps.length) {
      await window.XFire.load();
    } else {
      // Re-attach XF to existing app
      window.XFire._reattach && window.XFire._reattach();
    }

    // "Continue with Bluesky" hands off here: the callback action in bsky-auth.js
    // can't sign the browser in directly (it's a server-side redirect
    // responding to Bluesky, with no access to this tab's Firebase SDK
    // instance) — instead it mints a short-lived custom token and
    // appends it to the URL it redirects back to. Pick that up here,
    // exactly once, before anything else needs auth state.
    const _bskyToken = new URLSearchParams(window.location.search).get('bskyLoginToken');
    if (_bskyToken) {
      // Strip it from the URL immediately regardless of outcome — it's
      // single-use and shouldn't linger in browser history/address bar.
      const cleanUrl = window.location.pathname + window.location.hash;
      window.history.replaceState({}, '', cleanUrl);
      try { await firebase.auth().signInWithCustomToken(_bskyToken); }
      catch (err) { console.error('[bsky login] signInWithCustomToken failed:', err); showToast('Bluesky sign-in failed — please try again'); }
    }

    // Track the auth state we last acted on, so we only skip TRUE duplicate
    // firings (e.g. a token refresh with the same user) — not the very real
    // transition from "not signed in" to "just signed in", which is exactly
    // what happens right after a login/register/Google sign-in on this page.
    let lastUid; // undefined until the first callback fires
    window.XF.onAuth(user => {
      const uid = user ? user.uid : null;
      if (lastUid !== undefined && lastUid === uid) return;
      lastUid = uid;
      clearTimeout(loaderFailsafe);
      onAuthChange(user);
    });
  } catch (err) {
    clearTimeout(loaderFailsafe);
    console.error('Firebase failed:', err);
    hideLoader();
  }
});
