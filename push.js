/* push.js — X Club — Web Push subscribe + schedule + instant send
 *
 * How this fits together:
 *  - enablePushNotifications() registers the service worker, subscribes
 *    via the browser's Push API, and saves the subscription to Firestore
 *    (pushSubscriptions/{id}, tagged with the owner's uid) using the app's
 *    normal client-side write — same as any other user data. A user can
 *    have more than one subscription doc (e.g. desktop + phone).
 *
 *  - schedulePushNotification(targetUid, ...) is for FUTURE reminders
 *    (e.g. "1 hour before this event"). It just writes a plain record to
 *    scheduledPushes/{id}. Nothing sends anything at write time — it's
 *    picked up later by api/check-scheduled-pushes.js, which an external
 *    free cron service (cron-job.org) triggers once a minute. That ~60s
 *    worst-case delay is fine for a reminder, but too slow for a chat
 *    message notification.
 *
 *  - sendPushNow(targetUid, ...) is for things that should arrive
 *    immediately — right now, a new DM. It calls api/send-push-now
 *    directly at send-time, no polling delay. The endpoint verifies the
 *    caller's Firebase ID token server-side before sending, so this can't
 *    be used to spam arbitrary push content to someone else's phone.
 *
 *  Either way, the actual SENDING always happens server-side — this file
 *  never touches the VAPID private key or service account, it can't.
 */

'use strict';

const VAPID_PUBLIC_KEY = 'BN6f53e4P_MXd96Tt-dKivlD3lm5MCJ-pqpyE38F6HXV5Vo6aw7T3Ot5V2Ej3xFFEAh0cxRyTmO52dHqH13dYiQ';

function _urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window;
}

function isPushEnabled() {
  return !!localStorage.getItem('xclub_push_sub_id');
}

/* Warns on the Messages page when push is off, since that's the one place
   missing a notification has the most direct consequence — a message sits
   unseen with no other signal. Dismissible per session (sessionStorage),
   re-checked and re-shown on the next full app load if still off. */
function renderPushOffBanner() {
  const el = $('pushOffBanner'); if (!el) return;
  const dismissed = sessionStorage.getItem('xclub_push_banner_dismissed');
  if (!currentUser || dismissed || !pushSupported() || isPushEnabled()) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="push-off-banner">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
    <span>Your notifications are off — if you get a message, you won't know unless you check the app.</span>
    <button onclick="_pushOffBannerEnable()">Turn on</button>
    <span class="push-off-banner-close" onclick="dismissPushOffBanner()">✕</span>
  </div>`;
}
async function _pushOffBannerEnable() {
  await enablePushNotifications();
  renderPushOffBanner();
}
function dismissPushOffBanner() {
  sessionStorage.setItem('xclub_push_banner_dismissed', '1');
  const el = $('pushOffBanner'); if (el) el.innerHTML = '';
}

/* Silently re-subscribes on load if push was previously enabled, without
   any toast or user interaction — this is what actually repairs an
   already-stale subscription sitting in someone's browser (like the one
   this exact bug just caused), since the person has no way to know it's
   stale and nothing here should nag them about a problem they didn't
   cause. Safe/cheap to run every login: if the subscription is already
   correct, unsubscribe+resubscribe just recreates the same thing. */
let _pushRefreshedThisSession = false;
async function _silentlyRefreshPushSubscription() {
  if (_pushRefreshedThisSession) return;
  _pushRefreshedThisSession = true;
  if (!isPushEnabled() || !pushSupported() || !currentUser) return;
  if (Notification.permission !== 'granted') return; // don't re-prompt; if they revoked it, respect that
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (existing) await existing.unsubscribe();
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    const ref = await window.XF.push('pushSubscriptions', {
      uid: currentUser.uid,
      subscription: JSON.parse(JSON.stringify(subscription)),
      createdAt: Date.now(),
    });
    localStorage.setItem('xclub_push_sub_id', ref.key);
  } catch (e) { /* fail silently — worst case, still stale until next attempt */ }
}

async function enablePushNotifications() {
  if (!pushSupported()) { showToast('Push notifications aren\'t supported on this browser/device'); return false; }
  if (!currentUser) { requireVerified('enable notifications'); return false; }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') { showToast('Notification permission was not granted'); return false; }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    // Always start fresh rather than reusing whatever subscription the
    // browser already has. A subscription is cryptographically tied to
    // the VAPID public key it was created under — if that key ever
    // changes (e.g. moving off a previous project's keys), an old
    // subscription silently stops working even though it still "exists,"
    // and the app has no way to tell just by looking at it. Unsubscribing
    // and resubscribing here guarantees the subscription always matches
    // the key actually in use right now.
    const existing = await registration.pushManager.getSubscription();
    if (existing) await existing.unsubscribe();
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    const ref = await window.XF.push('pushSubscriptions', {
      uid: currentUser.uid,
      subscription: JSON.parse(JSON.stringify(subscription)),
      createdAt: Date.now(),
    });
    localStorage.setItem('xclub_push_sub_id', ref.key);
    showToast('Notifications enabled!');
    return true;
  } catch (err) {
    console.error('[push] enable failed:', err);
    showToast('Could not enable notifications — try again');
    return false;
  }
}

async function disablePushNotifications() {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
  } catch (e) {}
  const subId = localStorage.getItem('xclub_push_sub_id');
  if (subId) { window.XF.remove('pushSubscriptions/' + subId).catch(() => {}); }
  localStorage.removeItem('xclub_push_sub_id');
  showToast('Notifications turned off');
}

// For FUTURE reminders. targetUid: whoever should receive it (often
// currentUser.uid for a self-reminder). sendAtMs: epoch ms in the future.
async function schedulePushNotification(targetUid, title, body, sendAtMs, url) {
  try {
    await window.XF.push('scheduledPushes', {
      uid: targetUid,
      title, body,
      sendAt: sendAtMs,
      url: url || '/feed',
      sent: false,
      createdAt: Date.now(),
    });
    return true;
  } catch (err) {
    console.error('[push] schedule failed:', err);
    return false;
  }
}

// For things that should arrive right away — e.g. "you got a new message".
// Fire-and-forget is fine here: never block or fail the action that
// triggered it (sending a DM should never fail just because a push didn't
// go through).
async function sendPushNow(targetUid, title, body, url) {
  if (!currentUser) return;
  try {
    const idToken = await currentUser.getIdToken();
    fetch('/api/send-push-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, targetUid, title, body, url }),
    }).catch(() => {}); // best-effort — a failed push should never surface to the user
  } catch (err) {
    console.error('[push] instant send failed:', err);
  }
}

/* ── Nav bell button (desktop top-bar + mobile floating button) ────────── */
function updatePushNavIcon() {
  const on = isPushEnabled();
  const dot = document.getElementById('pushToggleIcon');
  if (dot) dot.classList.toggle('on', on);
  const dotMobile = document.getElementById('pushToggleIconMobile');
  if (dotMobile) dotMobile.classList.toggle('on', on);
  const settingsToggle = document.getElementById('settingsPushToggle');
  if (settingsToggle) settingsToggle.checked = on;
}

async function togglePushFromNav() {
  if (isPushEnabled()) {
    await disablePushNotifications();
  } else {
    await enablePushNotifications();
  }
  updatePushNavIcon();
}

document.addEventListener('DOMContentLoaded', updatePushNavIcon);
