// i18n.js — language detection + translation
// Load order: after config.js, before utils.js (needs to run its
// detection before the app starts rendering, but doesn't depend on
// anything else itself).
'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   HONEST SCOPE NOTE: this covers the nav bar and a few Settings labels as
   a REAL, working v1 — not a stub. Translating every string in the app
   (post composer placeholders, every button, every empty-state message —
   several hundred strings across ~20 files) is genuinely a much bigger,
   incremental undertaking, not something that fits in one pass. Adding a
   new translated string going forward just means: add the key to
   TRANSLATIONS below for each language, then add data-i18n="key" to that
   element in index.html (or call t('key') from JS-generated HTML).
═══════════════════════════════════════════════════════════════════════════ */

const SUPPORTED_LANGS = ['en', 'de', 'pt', 'es', 'fr'];
const LANG_NAMES = { en: 'English', de: 'Deutsch', pt: 'Português', es: 'Español', fr: 'Français' };
let currentLang = 'en';

const TRANSLATIONS = {
  en: {
    nav_home: 'Home', nav_discover: 'Discover', nav_reels: 'Reels', nav_groups: 'Groups',
    nav_notifs: 'Notifs', nav_profile: 'Profile',
    settings_appearance: 'Appearance', settings_notifications: 'Notifications',
    settings_connected_accounts: 'Connected accounts',
    settings_language: 'Language', settings_language_auto: 'Auto-detect'
  },
  de: {
    nav_home: 'Start', nav_discover: 'Entdecken', nav_reels: 'Reels', nav_groups: 'Gruppen',
    nav_notifs: 'Mitteilungen', nav_profile: 'Profil',
    settings_appearance: 'Erscheinungsbild', settings_notifications: 'Benachrichtigungen',
    settings_connected_accounts: 'Verknüpfte Konten',
    settings_language: 'Sprache', settings_language_auto: 'Automatisch erkennen'
  },
  pt: {
    nav_home: 'Início', nav_discover: 'Descobrir', nav_reels: 'Reels', nav_groups: 'Grupos',
    nav_notifs: 'Notificações', nav_profile: 'Perfil',
    settings_appearance: 'Aparência', settings_notifications: 'Notificações',
    settings_connected_accounts: 'Contas conectadas',
    settings_language: 'Idioma', settings_language_auto: 'Detetar automaticamente'
  },
  es: {
    nav_home: 'Inicio', nav_discover: 'Descubrir', nav_reels: 'Reels', nav_groups: 'Grupos',
    nav_notifs: 'Notificaciones', nav_profile: 'Perfil',
    settings_appearance: 'Apariencia', settings_notifications: 'Notificaciones',
    settings_connected_accounts: 'Cuentas conectadas',
    settings_language: 'Idioma', settings_language_auto: 'Detección automática'
  },
  fr: {
    nav_home: 'Accueil', nav_discover: 'Découvrir', nav_reels: 'Reels', nav_groups: 'Groupes',
    nav_notifs: 'Notifs', nav_profile: 'Profil',
    settings_appearance: 'Apparence', settings_notifications: 'Notifications',
    settings_connected_accounts: 'Comptes connectés',
    settings_language: 'Langue', settings_language_auto: 'Détection automatique'
  }
};

function t(key) {
  return (TRANSLATIONS[currentLang] && TRANSLATIONS[currentLang][key]) || TRANSLATIONS.en[key] || key;
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.documentElement.lang = currentLang;
}

/* Manual override (from Settings) — always wins from here on, this
   session and future ones, until the person changes it again. */
function setLanguage(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) return;
  currentLang = lang;
  try { localStorage.setItem('bumbook_lang', lang); } catch (e) {}
  applyTranslations();
}

function clearLanguageOverride() {
  try { localStorage.removeItem('bumbook_lang'); } catch (e) {}
  detectAndSetLanguage();
}

/* Detection order:
   1. A manual choice saved earlier (always wins, forever, until changed)
   2. The browser's own language setting (navigator.language) — this is
      the RIGHT primary signal, not IP: it's what the person's device is
      actually configured for, works instantly with no network call, and
      isn't fooled by VPNs, mobile carrier routing, or someone traveling.
   3. IP-based geolocation, ONLY as a fallback when the browser reports a
      language this app doesn't support — inherently less reliable
      (shared/corporate IPs, VPNs, and travel all give a wrong answer),
      which is exactly why it's the fallback, not the primary check. */
async function detectAndSetLanguage() {
  try {
    const saved = localStorage.getItem('bumbook_lang');
    if (saved && SUPPORTED_LANGS.includes(saved)) { currentLang = saved; applyTranslations(); return; }
  } catch (e) {}

  const browserLangs = navigator.languages || [navigator.language || 'en'];
  for (const bl of browserLangs) {
    const code = (bl || '').slice(0, 2).toLowerCase();
    if (SUPPORTED_LANGS.includes(code)) { currentLang = code; applyTranslations(); return; }
  }

  // Browser language isn't one of our five — try IP geolocation as a
  // best-effort fallback. Never blocks app boot on this: if it's slow or
  // fails (rate-limited, offline, blocked by a privacy extension), this
  // just quietly stays on English rather than holding up the page.
  try {
    const resp = await fetch('https://ipapi.co/json/');
    const data = await resp.json();
    const countryToLang = { DE: 'de', AT: 'de', CH: 'de', PT: 'pt', BR: 'pt', ES: 'es', MX: 'es', AR: 'es', FR: 'fr', BE: 'fr' };
    const lang = countryToLang[data.country_code];
    if (lang) { currentLang = lang; applyTranslations(); }
  } catch (e) { /* stay on English default */ }
}
