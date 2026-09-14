// router.js — Bum Book — Single-Page App Router
// showPage() swaps which .page section is visible — no browser reload.
// Real, bookmarkable URLs are maintained via the History API, so deep
// links (including push notification taps) still land on the exact
// right view.
'use strict';

// ⚠️ Once the separate admin app is deployed (a future pass), point this
// at its real URL. Until then, admin.html still lives in this same app.
const ADMIN_APP_URL = '/admin.html';

const PAGE_ROUTES = {
  landing:        '/',
  login:          '/login',
  register:       '/register',
  reset:          '/reset',
  feed:           '/feed',
  discover:       '/discover',
  notifications:  '/notifications',
  messages:       '/messages',
  profile:        '/profile',
  settings:       '/settings',
  groups:         '/groups',
  'group-detail': '/group',
  'user-profile': '/profile-view',
  'post-detail':  '/post',
};
const ROUTE_TO_PAGE = Object.fromEntries(Object.entries(PAGE_ROUTES).map(([k, v]) => [v, k]));

function pageFromLocation() {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const name = ROUTE_TO_PAGE[path];
  if (!name) return null;
  const params = new URLSearchParams(window.location.search);
  const opts = {};
  if (params.get('uid')) opts.uid = params.get('uid');
  if (params.get('postId')) opts.postId = params.get('postId');
  if (params.get('groupId')) opts.groupId = params.get('groupId');
  return { name, opts };
}

const AUTH_PAGES = new Set(['landing', 'login', 'register', 'reset']);

function showPage(name, opts = {}) {
  if (name === 'admin') { window.location.href = ADMIN_APP_URL; return; }

  const target = document.getElementById('page-' + name);
  if (!target) { console.error('[router] no page found for', name); return; }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  target.classList.add('active');
  window.__PAGE__ = name;

  // The app shell (left nav, right sidebar, bottom mobile nav, push FAB)
  // only exists for logged-in app pages — auth pages (landing/login/etc.)
  // are plain standalone screens with none of that chrome.
  const isAuthPage = AUTH_PAGES.has(name);
  const appShell = document.getElementById('app');
  const mobileNav = document.querySelector('.mobile-nav');
  const pushFab = document.getElementById('navPushBtnMobile');
  if (appShell)  appShell.style.display  = isAuthPage ? 'none' : '';
  if (mobileNav) mobileNav.style.display = isAuthPage ? 'none' : '';
  if (pushFab)   pushFab.style.display   = isAuthPage ? 'none' : '';

  let url = PAGE_ROUTES[name] || '/';
  const params = new URLSearchParams();
  if (opts.uid) params.set('uid', opts.uid);
  if (opts.postId) params.set('postId', opts.postId);
  if (opts.groupId) params.set('groupId', opts.groupId);
  const qs = params.toString();
  if (qs) url += '?' + qs;

  if (window.location.pathname + window.location.search !== url) {
    history.pushState({ page: name, opts }, '', url);
  }

  updateNavActive();
  window.scrollTo(0, 0);

  // Re-run this page's data loading every time it's switched to — same
  // effect as a fresh page load used to have, just without the reload.
  if (typeof onPageActivated === 'function') onPageActivated(name, opts);
}

// Browser back/forward
window.addEventListener('popstate', (e) => {
  const state = e.state;
  if (state?.page) { showPage(state.page, state.opts || {}); return; }
  const loc = pageFromLocation();
  if (loc) showPage(loc.name, loc.opts);
});

function goBack() {
  if (window.history.length > 1) window.history.back();
  else showPage('feed');
}

function updateNavActive() {
  const current = window.__PAGE__ || 'landing';
  document.querySelectorAll('.nav-link, .mobile-nav-link').forEach(l => {
    const page = l.dataset.page;
    const match =
      (page === 'feed' && (current === 'feed' || current === 'index')) ||
      page === current;
    l.classList.toggle('active', match);
  });
}

/* Mobile scroll-hide: scrolling down (reading further into a page) hides
   the top bar + bottom nav for a fuller screen; scrolling up brings them
   back immediately. Small DOWN_THRESHOLD avoids hiding on tiny scroll
   jitter (e.g. iOS rubber-banding). */
(function initNavScrollHide() {
  const topbar = document.querySelector('.mobile-topbar');
  const bottomNav = document.querySelector('.mobile-nav');
  if (!topbar || !bottomNav) return;

  let lastY = window.scrollY;
  const DOWN_THRESHOLD = 8;
  let ticking = false;

  function onScroll() {
    const y = window.scrollY;
    const delta = y - lastY;
    if (y <= 0) {
      topbar.classList.remove('nav-hidden');
      bottomNav.classList.remove('nav-hidden');
    } else if (delta > DOWN_THRESHOLD) {
      topbar.classList.add('nav-hidden');
      bottomNav.classList.add('nav-hidden');
    } else if (delta < -DOWN_THRESHOLD) {
      topbar.classList.remove('nav-hidden');
      bottomNav.classList.remove('nav-hidden');
    }
    lastY = y;
    ticking = false;
  }

  window.addEventListener('scroll', () => {
    if (!ticking) {
      window.requestAnimationFrame(onScroll);
      ticking = true;
    }
  }, { passive: true });
})();
