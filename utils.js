// utils.js — X Club v7 — Helpers, Theme, Lightbox, PWA, Particles, Loader
'use strict';

/* ─── DOM HELPER ─── */
function $(id) { return document.getElementById(id); }

/* ─── TIME ─── */
function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

/* ─── AVATAR ─── */
function avatarHTML(p, size = 'md') {
  if (p?.photoURL) return `<img class="avatar avatar-${size}" src="${p.photoURL}" alt="">`;
  return `<div class="avatar avatar-${size}">${p?.displayName ? p.displayName.charAt(0).toUpperCase() : '?'}</div>`;
}

/* ─── VERIFIED BADGE ─── */
function verifiedBadge(v, lg = false) {
  if (!v) return '';
  return `<span class="verified-badge${lg ? ' lg' : ''}" title="Verified"><svg viewBox="0 0 12 12" fill="none" style="width:60%;height:60%"><polyline points="2,6 5,9 10,3" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
}

/* ─── TOAST ─── */
function showToast(msg) {
  const c = $('toastContainer'); if (!c) return;
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; c.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 3000);
}

/* ─── HTML ESCAPE ─── */
function escapeHTML(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ─── FORMAT COUNT ─── */
function formatCount(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

/* ─── CURRENCY SYMBOL ─── */
function currencySymbol(c) {
  return { NGN: '₦', USD: '$', GBP: '£', EUR: '€', GHS: '₵', KES: 'KSh', ZAR: 'R', TZS: 'TSh', UGX: 'USh', RWF: 'RF' }[c] || c || '€';
}

/* ─── REQUIRE AUTH ─── shows a sign-in/register popup instead of a hard
   redirect, so a guest browsing a shared profile/post isn't yanked away —
   they just get prompted the moment they try to DO something. ─────────── */
function requireVerified(action) {
  if (currentUser) return true;
  showAuthPrompt(action);
  return false;
}

function showAuthPrompt(action) {
  let modal = document.getElementById('authPromptModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'authPromptModal';
    modal.className = 'modal-overlay';
    modal.setAttribute('onclick', "if(event.target===this)this.classList.remove('open')");
    modal.innerHTML = `
      <div class="modal-card" style="max-width:360px;text-align:center;padding:32px 24px">
        <div style="font-size:2rem;margin-bottom:12px">🔒</div>
        <div id="authPromptText" style="font-weight:700;font-size:1.05rem;margin-bottom:8px">Sign in to continue</div>
        <div style="color:var(--text-dim);font-size:0.9rem;margin-bottom:24px">You'll need an account for that.</div>
        <div style="display:flex;flex-direction:column;gap:10px">
          <button class="btn btn-primary" onclick="document.getElementById('authPromptModal').classList.remove('open'); showPage('login')">Sign in</button>
          <button class="btn btn-outline" onclick="document.getElementById('authPromptModal').classList.remove('open'); showPage('register')">Create account</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }
  const textEl = document.getElementById('authPromptText');
  if (textEl) textEl.textContent = action ? `Sign in to ${action}` : 'Sign in to continue';
  modal.classList.add('open');
}

/* ─── LOADER ─── */
function hideLoader() {
  const l = $('appLoader');
  if (l) {
    l.classList.add('gone');
    setTimeout(() => { if (l && l.parentNode) l.remove(); }, 600);
    // Hard fallback — force gone if still in DOM after transition
    setTimeout(() => { if (l && l.parentNode) { l.style.display = 'none'; l.remove(); } }, 800);
  }
  // For pages that use #app wrapper
  const a = $('app');
  if (a) a.classList.add('visible');
  // For landing page specifically
  const lp = document.getElementById('page-landing');
  if (lp) lp.classList.add('active');
}

/* ─── PWA INSTALL ─── */
let _deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); _deferredInstall = e;
  const b = $('pwaInstallBtn'); if (b) b.style.display = 'flex';
});
window.addEventListener('appinstalled', () => {
  _deferredInstall = null;
  const b = $('pwaInstallBtn'); if (b) b.style.display = 'none';
  showToast('Bum Book installed!');
});
function triggerPwaInstall() {
  if (!_deferredInstall) { showToast('Open in your browser to install'); return; }
  _deferredInstall.prompt();
  _deferredInstall.userChoice.then(r => { if (r.outcome === 'accepted') showToast('Installing…'); _deferredInstall = null; });
}

/* ─── LANDING PARTICLES ─── */
function initLandingParticles() {
  const container = document.getElementById('landingParticles');
  if (!container) return;
  container.innerHTML = '';
  const count = window.innerWidth < 480 ? 18 : 30;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'landing-particle';
    p.style.cssText = `left:${Math.random() * 100}%;top:${20 + Math.random() * 75}%;--dur:${4 + Math.random() * 8}s;--delay:${Math.random() * 8}s;width:${1 + Math.random() * 2}px;height:${1 + Math.random() * 2}px;opacity:0;`;
    container.appendChild(p);
  }
}

/* ─── THEME ───
   Three modes: 'auto' (default — follow the device's OS setting live),
   'light', 'dark'. Stored per-device only (localStorage), never synced
   to the account. */
function getThemeMode() {
  return localStorage.getItem('xclub_theme') || 'auto';
}
function computeIsLight(mode) {
  if (mode === 'light') return true;
  if (mode === 'dark') return false;
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
}
function applyTheme(isLight) {
  document.body.classList.toggle('theme-light', isLight);
  ['themeToggleIcon', 'mobileThemeIcon'].forEach(id => { const el = $(id); if (el) el.textContent = isLight ? '🌙' : '☀'; });
}
function setThemeMode(mode) {
  if (mode === 'auto') localStorage.removeItem('xclub_theme');
  else localStorage.setItem('xclub_theme', mode);
  applyTheme(computeIsLight(mode));
}
function syncThemeSettingsUI() {
  const mode = getThemeMode();
  document.querySelectorAll('input[name="themeMode"]').forEach(r => { r.checked = (r.value === mode); });
  const pushCheckbox = $('settingsPushToggle');
  if (pushCheckbox && typeof isPushEnabled === 'function') pushCheckbox.checked = isPushEnabled();
}
// Quick nav toggle button: cycles between light/dark explicitly (same as
// before) — full three-way control lives in Settings.
function toggleTheme() {
  setThemeMode(document.body.classList.contains('theme-light') ? 'dark' : 'light');
}
function applyStoredTheme() {
  applyTheme(computeIsLight(getThemeMode()));

  // Keep following the OS setting live whenever mode is 'auto' — attached
  // once at boot; the guard inside checks the CURRENT mode on every OS
  // change, so switching back to Auto later (without a reload) resumes
  // live-following correctly.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
      if (getThemeMode() !== 'auto') return; // explicit choice in effect — stop following
      applyTheme(e.matches);
    });
  }
}

/* ─── PAID FEATURE FLAGS ── admin-controlled, so the whole site can run on
/* ─── APP CONFIG ── general settings (kept simple — no paid-feature flags
   here, since Bum Book has no payment features at all). */
window._appConfig = window._appConfig || {};

async function loadAppConfig() {
  try {
    const snap = await window.XF.get('appConfig');
    window._appConfig = snap.exists() ? snap.val() : {};
  } catch (e) { window._appConfig = {}; }
}

/* ─── LIGHTBOX ─── */
function openLightbox(url) {
  if (!url) return;
  const lb = document.createElement('div'); lb.className = 'photo-lightbox';
  lb.innerHTML = `<div class="photo-lightbox-close" onclick="this.parentElement.remove()">✕</div><img src="${escapeHTML(url)}" alt="Photo">`;
  lb.onclick = function (e) { if (e.target === lb) lb.remove(); };
  document.body.appendChild(lb);
}

/* ─── LINK PREVIEWS ── posts / DMs / bio ─────────────────────────────────
   detectFirstUrl() finds the first http(s) URL in a block of text.
   fetchLinkPreview() calls our own /api/link-preview endpoint (Open Graph
   scraper) — cheap, no API key, cached server-side for an hour.
   linkPreviewCardHTML() renders the result the same way everywhere. ────── */
const URL_REGEX = /\bhttps?:\/\/[^\s<]+[^\s<.,:;!?'")\]]/i;

function detectFirstUrl(text) {
  if (!text) return null;
  const m = text.match(URL_REGEX);
  return m ? m[0] : null;
}

async function fetchLinkPreview(url) {
  if (!url) return null;
  try {
    const res = await fetch('/api/link-preview?url=' + encodeURIComponent(url));
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || (!data.title && !data.image)) return null;
    return data;
  } catch (e) { return null; }
}

function linkPreviewCardHTML(preview, opts = {}) {
  if (!preview || !preview.url) return '';
  const img = preview.image
    ? `<div class="link-preview-img" style="background-image:url('${escapeHTML(preview.image)}')"></div>`
    : '';
  const body = `
      ${img}
      <div class="link-preview-body">
        <div class="link-preview-site">${escapeHTML(preview.siteName || '')}</div>
        ${preview.title ? `<div class="link-preview-title">${escapeHTML(preview.title)}</div>` : ''}
        ${preview.description ? `<div class="link-preview-desc">${escapeHTML(preview.description)}</div>` : ''}
      </div>`;

  if (opts.dismissible) {
    return `<div class="link-preview-card composer-preview">
      ${body}
      <button type="button" class="link-preview-remove" onclick="removeComposerPreview('${opts.containerId}')" title="Remove preview">✕</button>
    </div>`;
  }
  return `<a class="link-preview-card" href="${escapeHTML(preview.url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${body}</a>`;
}

/* ─── Live composer preview ── shows a preview card while composing a
   post/DM, before you submit, debounced so it doesn't fetch on every
   keystroke. The same fetched preview is then reused at submit time
   instead of fetching twice. ────────────────────────────────────────── */
window._composerPreviews = window._composerPreviews || {};
let _composerPreviewTimers = {};

function debouncedComposerPreview(text, containerId) {
  clearTimeout(_composerPreviewTimers[containerId]);
  _composerPreviewTimers[containerId] = setTimeout(() => updateComposerPreview(text, containerId), 600);
}

async function updateComposerPreview(text, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const url = detectFirstUrl(text);

  if (!url) { el.innerHTML = ''; delete window._composerPreviews[containerId]; return; }
  if (window._composerPreviews[containerId]?.url === url) return; // unchanged, don't refetch

  el.innerHTML = `<div class="link-preview-loading">Loading preview…</div>`;
  const preview = await fetchLinkPreview(url);

  // The text may have changed again while we were fetching — bail if so.
  if (detectFirstUrl(text) !== url) return;

  if (!preview) { el.innerHTML = ''; delete window._composerPreviews[containerId]; return; }
  window._composerPreviews[containerId] = preview;
  el.innerHTML = linkPreviewCardHTML(preview, { dismissible: true, containerId });
}

function removeComposerPreview(containerId) {
  const el = document.getElementById(containerId);
  if (el) el.innerHTML = '';
  delete window._composerPreviews[containerId];
}

// Bio has no natural "creation" moment to cache a preview against (unlike a
// post/message), so fetch it lazily right after the profile renders, and
// drop it into the placeholder container left in the markup.
async function injectBioLinkPreview(containerId, bio) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const url = detectFirstUrl(bio);
  if (!url) return;
  const preview = await fetchLinkPreview(url);
  if (preview) el.innerHTML = linkPreviewCardHTML(preview);
}

/* ─── MODAL CLOSE ─── */
function closeModal(id) { const m = $(id); if (m) m.classList.remove('open'); }
