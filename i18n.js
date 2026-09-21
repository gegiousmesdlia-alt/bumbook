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
    nav_notifs: 'Notifs', nav_profile: 'Profile', nav_notifications: 'Notifications', nav_messages: 'Messages',
    settings_appearance: 'Appearance', settings_notifications: 'Notifications',
    settings_connected_accounts: 'Connected accounts',
    settings_language: 'Language', settings_language_auto: 'Auto-detect',
    hdr_discover: 'Discover', hdr_notifications: 'Notifications', hdr_messages: 'Messages',
    hdr_settings: 'Settings', hdr_channel: 'Channel', hdr_groups: 'Groups', hdr_group: 'Group',
    hdr_profile: 'Profile', hdr_post: 'Post', hdr_bsky_profile: 'Bluesky profile',
    btn_post: 'Post', btn_signin: 'Sign in', btn_signup: 'Sign up', btn_create_account: 'Create account',
    btn_send_reset: 'Send reset link', btn_google: 'Continue with Google',
    landing_badge: 'Free to join · Verify to unlock more',
    landing_welcome: 'Welcome to',
    landing_tagline: 'Connect, share, and chat<br>with people who matter to you.',
    landing_cta_create: 'Create your account',
    landing_cta_signin: '<span>Already have an account? </span><strong>Sign in →</strong>',
    landing_feature_posts: 'Posts, photos & events', landing_feature_dm: 'Direct messaging',
    landing_feature_verified: 'Verified profiles',
    auth_signin_title: 'Sign in to Bum Book', auth_join_title: 'Join Bum Book',
    auth_join_sub: 'Create your account — free to join, verify to unlock everything',
    auth_reset_title: 'Reset password', auth_reset_sub: "Enter your email and we'll send you a reset link",
    auth_no_account: "Don't have an account?", auth_already_member: 'Already a member?',
    auth_forgot_password: 'Forgot password?', auth_back_to_signin: '← Back to sign in',
    form_email: 'Email', form_password: 'Password', form_fullname: 'Full Name', form_username: 'Username',
    divider_or: 'or',
    discover_search_title: 'Search Discover', discover_search_desc: 'Find people, posts, hashtags, videos, and groups',
    btn_accept: 'Accept', btn_connect: 'Connect', btn_connected: 'Connected', btn_decline: 'Decline',
    btn_message: 'Message', btn_pending: 'Pending', btn_request_sent: 'Request sent', btn_share: 'Share',
    groups_discover_hdr: 'Discover', groups_empty_desc: 'Be the first to start one', groups_empty_title: 'No groups yet',
    groups_mine: 'My Groups', groups_no_other: 'No other groups to show',
    lbl_followers: 'Followers', lbl_following: 'Following', lbl_posts: 'Posts', lbl_private: 'Private', lbl_public: 'Public',
    messages_empty_desc: 'Connect with members to start chatting', messages_empty_title: 'No messages yet',
    notifs_empty: 'No notifications yet'
  },
  de: {
    nav_home: 'Start', nav_discover: 'Entdecken', nav_reels: 'Reels', nav_groups: 'Gruppen',
    nav_notifs: 'Mitteilungen', nav_profile: 'Profil', nav_notifications: 'Mitteilungen', nav_messages: 'Nachrichten',
    settings_appearance: 'Erscheinungsbild', settings_notifications: 'Benachrichtigungen',
    settings_connected_accounts: 'Verknüpfte Konten',
    settings_language: 'Sprache', settings_language_auto: 'Automatisch erkennen',
    hdr_discover: 'Entdecken', hdr_notifications: 'Mitteilungen', hdr_messages: 'Nachrichten',
    hdr_settings: 'Einstellungen', hdr_channel: 'Kanal', hdr_groups: 'Gruppen', hdr_group: 'Gruppe',
    hdr_profile: 'Profil', hdr_post: 'Beitrag', hdr_bsky_profile: 'Bluesky-Profil',
    btn_post: 'Posten', btn_signin: 'Anmelden', btn_signup: 'Registrieren', btn_create_account: 'Konto erstellen',
    btn_send_reset: 'Link zum Zurücksetzen senden', btn_google: 'Mit Google fortfahren',
    landing_badge: 'Kostenloser Beitritt · Verifizieren für mehr',
    landing_welcome: 'Willkommen bei',
    landing_tagline: 'Verbinde dich, teile und chatte<br>mit Menschen, die dir wichtig sind.',
    landing_cta_create: 'Konto erstellen',
    landing_cta_signin: '<span>Bereits ein Konto? </span><strong>Anmelden →</strong>',
    landing_feature_posts: 'Beiträge, Fotos & Events', landing_feature_dm: 'Direktnachrichten',
    landing_feature_verified: 'Verifizierte Profile',
    auth_signin_title: 'Bei Bum Book anmelden', auth_join_title: 'Bum Book beitreten',
    auth_join_sub: 'Erstelle dein Konto — kostenlos beitreten, verifizieren für alles',
    auth_reset_title: 'Passwort zurücksetzen', auth_reset_sub: 'Gib deine E-Mail ein und wir senden dir einen Link',
    auth_no_account: 'Noch kein Konto?', auth_already_member: 'Bereits Mitglied?',
    auth_forgot_password: 'Passwort vergessen?', auth_back_to_signin: '← Zurück zur Anmeldung',
    form_email: 'E-Mail', form_password: 'Passwort', form_fullname: 'Vollständiger Name', form_username: 'Benutzername',
    divider_or: 'oder',
    discover_search_title: 'Discover durchsuchen', discover_search_desc: 'Finde Personen, Beiträge, Hashtags, Videos und Gruppen',
    btn_accept: 'Annehmen', btn_connect: 'Verbinden', btn_connected: 'Verbunden', btn_decline: 'Ablehnen',
    btn_message: 'Nachricht', btn_pending: 'Ausstehend', btn_request_sent: 'Anfrage gesendet', btn_share: 'Teilen',
    groups_discover_hdr: 'Entdecken', groups_empty_desc: 'Sei die erste Person, die eine Gruppe erstellt', groups_empty_title: 'Noch keine Gruppen',
    groups_mine: 'Meine Gruppen', groups_no_other: 'Keine weiteren Gruppen',
    lbl_followers: 'Follower', lbl_following: 'Folge ich', lbl_posts: 'Beiträge', lbl_private: 'Privat', lbl_public: 'Öffentlich',
    messages_empty_desc: 'Verbinde dich mit Mitgliedern, um zu chatten', messages_empty_title: 'Noch keine Nachrichten',
    notifs_empty: 'Noch keine Mitteilungen'
  },
  pt: {
    nav_home: 'Início', nav_discover: 'Descobrir', nav_reels: 'Reels', nav_groups: 'Grupos',
    nav_notifs: 'Notificações', nav_profile: 'Perfil', nav_notifications: 'Notificações', nav_messages: 'Mensagens',
    settings_appearance: 'Aparência', settings_notifications: 'Notificações',
    settings_connected_accounts: 'Contas conectadas',
    settings_language: 'Idioma', settings_language_auto: 'Detetar automaticamente',
    hdr_discover: 'Descobrir', hdr_notifications: 'Notificações', hdr_messages: 'Mensagens',
    hdr_settings: 'Definições', hdr_channel: 'Canal', hdr_groups: 'Grupos', hdr_group: 'Grupo',
    hdr_profile: 'Perfil', hdr_post: 'Publicação', hdr_bsky_profile: 'Perfil do Bluesky',
    btn_post: 'Publicar', btn_signin: 'Entrar', btn_signup: 'Registar', btn_create_account: 'Criar conta',
    btn_send_reset: 'Enviar link de redefinição', btn_google: 'Continuar com o Google',
    landing_badge: 'Grátis para participar · Verifique para desbloquear mais',
    landing_welcome: 'Bem-vindo ao',
    landing_tagline: 'Conecte-se, partilhe e converse<br>com as pessoas que importam para si.',
    landing_cta_create: 'Criar a sua conta',
    landing_cta_signin: '<span>Já tem uma conta? </span><strong>Entrar →</strong>',
    landing_feature_posts: 'Publicações, fotos e eventos', landing_feature_dm: 'Mensagens diretas',
    landing_feature_verified: 'Perfis verificados',
    auth_signin_title: 'Entrar no Bum Book', auth_join_title: 'Junte-se ao Bum Book',
    auth_join_sub: 'Crie a sua conta — grátis para participar, verifique para desbloquear tudo',
    auth_reset_title: 'Redefinir palavra-passe', auth_reset_sub: 'Introduza o seu email e enviaremos um link de redefinição',
    auth_no_account: 'Não tem uma conta?', auth_already_member: 'Já é membro?',
    auth_forgot_password: 'Esqueceu-se da palavra-passe?', auth_back_to_signin: '← Voltar ao início de sessão',
    form_email: 'Email', form_password: 'Palavra-passe', form_fullname: 'Nome completo', form_username: 'Nome de utilizador',
    divider_or: 'ou',
    discover_search_title: 'Pesquisar no Discover', discover_search_desc: 'Encontre pessoas, publicações, hashtags, vídeos e grupos',
    btn_accept: 'Aceitar', btn_connect: 'Conectar', btn_connected: 'Conectado', btn_decline: 'Recusar',
    btn_message: 'Mensagem', btn_pending: 'Pendente', btn_request_sent: 'Pedido enviado', btn_share: 'Partilhar',
    groups_discover_hdr: 'Descobrir', groups_empty_desc: 'Seja o primeiro a criar um', groups_empty_title: 'Ainda sem grupos',
    groups_mine: 'Meus Grupos', groups_no_other: 'Sem mais grupos para mostrar',
    lbl_followers: 'Seguidores', lbl_following: 'A seguir', lbl_posts: 'Publicações', lbl_private: 'Privado', lbl_public: 'Público',
    messages_empty_desc: 'Conecte-se com membros para começar a conversar', messages_empty_title: 'Ainda sem mensagens',
    notifs_empty: 'Ainda sem notificações'
  },
  es: {
    nav_home: 'Inicio', nav_discover: 'Descubrir', nav_reels: 'Reels', nav_groups: 'Grupos',
    nav_notifs: 'Notificaciones', nav_profile: 'Perfil', nav_notifications: 'Notificaciones', nav_messages: 'Mensajes',
    settings_appearance: 'Apariencia', settings_notifications: 'Notificaciones',
    settings_connected_accounts: 'Cuentas conectadas',
    settings_language: 'Idioma', settings_language_auto: 'Detección automática',
    hdr_discover: 'Descubrir', hdr_notifications: 'Notificaciones', hdr_messages: 'Mensajes',
    hdr_settings: 'Ajustes', hdr_channel: 'Canal', hdr_groups: 'Grupos', hdr_group: 'Grupo',
    hdr_profile: 'Perfil', hdr_post: 'Publicación', hdr_bsky_profile: 'Perfil de Bluesky',
    btn_post: 'Publicar', btn_signin: 'Iniciar sesión', btn_signup: 'Registrarse', btn_create_account: 'Crear cuenta',
    btn_send_reset: 'Enviar enlace de restablecimiento', btn_google: 'Continuar con Google',
    landing_badge: 'Gratis para unirse · Verifica para desbloquear más',
    landing_welcome: 'Bienvenido a',
    landing_tagline: 'Conecta, comparte y chatea<br>con las personas que te importan.',
    landing_cta_create: 'Crea tu cuenta',
    landing_cta_signin: '<span>¿Ya tienes una cuenta? </span><strong>Iniciar sesión →</strong>',
    landing_feature_posts: 'Publicaciones, fotos y eventos', landing_feature_dm: 'Mensajes directos',
    landing_feature_verified: 'Perfiles verificados',
    auth_signin_title: 'Inicia sesión en Bum Book', auth_join_title: 'Únete a Bum Book',
    auth_join_sub: 'Crea tu cuenta — gratis para unirte, verifica para desbloquear todo',
    auth_reset_title: 'Restablecer contraseña', auth_reset_sub: 'Introduce tu email y te enviaremos un enlace',
    auth_no_account: '¿No tienes una cuenta?', auth_already_member: '¿Ya eres miembro?',
    auth_forgot_password: '¿Olvidaste tu contraseña?', auth_back_to_signin: '← Volver a iniciar sesión',
    form_email: 'Email', form_password: 'Contraseña', form_fullname: 'Nombre completo', form_username: 'Nombre de usuario',
    divider_or: 'o',
    discover_search_title: 'Buscar en Discover', discover_search_desc: 'Encuentra personas, publicaciones, hashtags, videos y grupos',
    btn_accept: 'Aceptar', btn_connect: 'Conectar', btn_connected: 'Conectado', btn_decline: 'Rechazar',
    btn_message: 'Mensaje', btn_pending: 'Pendiente', btn_request_sent: 'Solicitud enviada', btn_share: 'Compartir',
    groups_discover_hdr: 'Descubrir', groups_empty_desc: 'Sé el primero en crear uno', groups_empty_title: 'Aún no hay grupos',
    groups_mine: 'Mis Grupos', groups_no_other: 'No hay más grupos para mostrar',
    lbl_followers: 'Seguidores', lbl_following: 'Siguiendo', lbl_posts: 'Publicaciones', lbl_private: 'Privado', lbl_public: 'Público',
    messages_empty_desc: 'Conéctate con miembros para empezar a chatear', messages_empty_title: 'Aún no hay mensajes',
    notifs_empty: 'Aún no hay notificaciones'
  },
  fr: {
    nav_home: 'Accueil', nav_discover: 'Découvrir', nav_reels: 'Reels', nav_groups: 'Groupes',
    nav_notifs: 'Notifs', nav_profile: 'Profil', nav_notifications: 'Notifications', nav_messages: 'Messages',
    settings_appearance: 'Apparence', settings_notifications: 'Notifications',
    settings_connected_accounts: 'Comptes connectés',
    settings_language: 'Langue', settings_language_auto: 'Détection automatique',
    hdr_discover: 'Découvrir', hdr_notifications: 'Notifications', hdr_messages: 'Messages',
    hdr_settings: 'Paramètres', hdr_channel: 'Chaîne', hdr_groups: 'Groupes', hdr_group: 'Groupe',
    hdr_profile: 'Profil', hdr_post: 'Publication', hdr_bsky_profile: 'Profil Bluesky',
    btn_post: 'Publier', btn_signin: 'Se connecter', btn_signup: "S'inscrire", btn_create_account: 'Créer un compte',
    btn_send_reset: 'Envoyer le lien de réinitialisation', btn_google: 'Continuer avec Google',
    landing_badge: 'Gratuit · Vérifiez pour débloquer plus',
    landing_welcome: 'Bienvenue sur',
    landing_tagline: 'Connectez-vous, partagez et discutez<br>avec les gens qui comptent pour vous.',
    landing_cta_create: 'Créer votre compte',
    landing_cta_signin: '<span>Vous avez déjà un compte ? </span><strong>Se connecter →</strong>',
    landing_feature_posts: 'Publications, photos et événements', landing_feature_dm: 'Messagerie directe',
    landing_feature_verified: 'Profils vérifiés',
    auth_signin_title: 'Connexion à Bum Book', auth_join_title: 'Rejoindre Bum Book',
    auth_join_sub: 'Créez votre compte — gratuit, vérifiez pour tout débloquer',
    auth_reset_title: 'Réinitialiser le mot de passe', auth_reset_sub: 'Entrez votre email et nous vous enverrons un lien',
    auth_no_account: "Pas encore de compte ?", auth_already_member: 'Déjà membre ?',
    auth_forgot_password: 'Mot de passe oublié ?', auth_back_to_signin: '← Retour à la connexion',
    form_email: 'Email', form_password: 'Mot de passe', form_fullname: 'Nom complet', form_username: "Nom d'utilisateur",
    divider_or: 'ou',
    discover_search_title: 'Rechercher dans Discover', discover_search_desc: 'Trouvez des personnes, publications, hashtags, vidéos et groupes',
    btn_accept: 'Accepter', btn_connect: 'Se connecter', btn_connected: 'Connecté', btn_decline: 'Refuser',
    btn_message: 'Message', btn_pending: 'En attente', btn_request_sent: 'Demande envoyée', btn_share: 'Partager',
    groups_discover_hdr: 'Découvrir', groups_empty_desc: 'Soyez le premier à en créer un', groups_empty_title: 'Aucun groupe pour le moment',
    groups_mine: 'Mes Groupes', groups_no_other: 'Aucun autre groupe à afficher',
    lbl_followers: 'Abonnés', lbl_following: 'Abonnements', lbl_posts: 'Publications', lbl_private: 'Privé', lbl_public: 'Public',
    messages_empty_desc: 'Connectez-vous avec des membres pour discuter', messages_empty_title: 'Aucun message pour le moment',
    notifs_empty: 'Aucune notification pour le moment'
  }
};

function t(key) {
  return (TRANSLATIONS[currentLang] && TRANSLATIONS[currentLang][key]) || TRANSLATIONS.en[key] || key;
}

function applyTranslations() {
  // innerHTML, not textContent — some translated strings (like the
  // landing tagline) intentionally contain a <br> for line-breaking.
  // Every value in TRANSLATIONS is developer-authored, never user input,
  // so this is safe from injection the same way any other static markup
  // in this file is.
  document.querySelectorAll('[data-i18n]').forEach(el => { el.innerHTML = t(el.dataset.i18n); });
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
