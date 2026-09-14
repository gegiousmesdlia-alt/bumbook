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

const VAPID_PUBLIC_KEY = 'BDdYlwvs8vQQ4wmxl4Anp2kOjj_Ck8acv8ExWEScrXfDrSmyOfukhvMCrPgZF2TyioXFgwfSV1sGAo2odPNcLK4';

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

async function enablePushNotifications() {
  if (!pushSupported()) { showToast('Push notifications aren\'t supported on this browser/device'); return false; }
  if (!currentUser) { requireVerified('enable notifications'); return false; }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') { showToast('Notification permission was not granted'); return false; }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

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
