// boot.js — X Club — App Initialisation (fires on DOMContentLoaded)
'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  applyStoredTheme();
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

  // Safety net: if Firebase auth never fires within 4s, just hide loader
  const loaderFailsafe = setTimeout(() => { hideLoader(); }, 4000);

  try {
    // Guard against duplicate init (bfcache / hot reload)
    if (!firebase.apps.length) {
      await window.XFire.load();
    } else {
      // Re-attach XF to existing app
      window.XFire._reattach && window.XFire._reattach();
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
    if (typeof loadBizFeed === 'function') setTimeout(loadBizFeed, 3000);
  } catch (err) {
    clearTimeout(loaderFailsafe);
    console.error('Firebase failed:', err);
    hideLoader();
  }
});
