/* firebase.js — Bum Book
 *
 * Firestore is the single source of truth for all app data. Realtime
 * Database is used ONLY for typing indicators and online presence
 * (accessed directly via window.XF.db in messages.js/push.js) — those are
 * high-frequency, throwaway writes that RTDB is genuinely better suited
 * for, and it's the ONE place using two databases actually earns its
 * keep. Everything else lives in exactly one place, not mirrored across
 * two — unlike X-Musk's version of this file, Bum Book has no legacy data
 * to migrate, so there's no dual-read/self-migration bridge here at all.
 */

'use strict';

/* databaseURL below is a placeholder — it's NOT part of the config
   snippet Firebase shows you by default. Go to Firebase console →
   Realtime Database → (create the database if you haven't) → the URL
   shown at the top of that page (looks like
   https://bumbook-default-rtdb.REGION.firebasedatabase.app) goes here.
   RTDB is still needed even in this simplified setup, purely for
   typing/presence. */
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyCd3gjcLJILFb4oizd9gJSbLFQhs46w54k',
  authDomain:        'bumbook.firebaseapp.com',
  databaseURL:       'https://bumbook-default-rtdb.firebaseio.com',
  projectId:         'bumbook',
  storageBucket:     'bumbook.firebasestorage.app',
  messagingSenderId: '599534793874',
  appId:             '1:599534793874:web:9cb7a3f0843fd8b13a624b'
};

let _auth, _rtdb, _fs;

/* ═══════════════════════════════════════════════════════════════════════
   FakeSnapshot — mimics the old RTDB DataSnapshot API (.exists/.val/
   .forEach) purely so every existing call site across the app (feed.js,
   profile.js, messages.js, ...) keeps working unmodified. This has
   nothing to do with which database is behind it — it's just a
   convenient shape for the rest of the app to consume.
   ═══════════════════════════════════════════════════════════════════════ */
class FakeSnapshot {
  constructor(data, isList) {
    this._data = data;
    this._isList = isList;
  }
  exists() {
    if (this._isList) return !!this._data && Object.keys(this._data).length > 0;
    return this._data !== null && this._data !== undefined;
  }
  val() { return this._data; }
  forEach(cb) {
    if (!this._isList || !this._data) return;
    const entries = Object.entries(this._data);
    entries.sort((a, b) => {
      const ca = (a[1] && a[1].createdAt) || 0;
      const cb_ = (b[1] && b[1].createdAt) || 0;
      if (ca !== cb_) return ca - cb_;
      return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0);
    });
    for (const [key, val] of entries) cb({ key, val: () => val });
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   Path router — translates the app's RTDB-style path strings
   ("users/uid123", "comments/postId/commentId", ...) into the equivalent
   Firestore location:
     comments/{postId}[/{id}]      -> posts/{postId}/comments[/{id}]
     connections/{uid}[/{id}]      -> users/{uid}/connections[/{id}]
     blocks/{uid}[/{id}]           -> users/{uid}/blocks[/{id}]
     dms/{convId}[/{id}]           -> conversations/{convId}/messages[/{id}]
     messageRequests/{uid}[/{id}]  -> users/{uid}/messageRequests[/{id}]
     notifications/{uid}[/{id}]    -> users/{uid}/notifications[/{id}]
     profileViews/{uid}[/{id}]     -> users/{uid}/profileViews[/{id}]
   ═══════════════════════════════════════════════════════════════════════ */
const SIMPLE_ROOTS = new Set(['users', 'posts', 'handles', 'scheduledPosts', 'connectionRequests', 'pushSubscriptions', 'scheduledPushes', 'verificationRequests']);
const FIXED_DOC_ROOTS = { appConfig: 'appConfig', config: 'config' }; // -> settings/{fixedDocId}
const SUB_ROOTS = {
  comments:        { parentColl: 'posts', sub: 'comments' },
  connections:     { parentColl: 'users', sub: 'connections' },
  blocks:          { parentColl: 'users', sub: 'blocks' },
  dms:             { parentColl: 'conversations', sub: 'messages' },
  messageRequests: { parentColl: 'users', sub: 'messageRequests' },
  notifications:   { parentColl: 'users', sub: 'notifications' },
  profileViews:    { parentColl: 'users', sub: 'profileViews' },
};

function _resolve(path) {
  const segs = String(path).split('/').filter(Boolean);
  const root = segs[0];

  if (SIMPLE_ROOTS.has(root)) {
    const fsColl = _fs.collection(root);
    if (segs.length === 1) return { kind: 'list', fsColl };
    if (segs.length === 2) return { kind: 'doc', fsRef: fsColl.doc(segs[1]) };
    return { kind: 'field', fsRef: fsColl.doc(segs[1]), fieldPath: segs.slice(2).join('.') };
  }

  if (FIXED_DOC_ROOTS[root]) {
    const fsRef = _fs.collection('settings').doc(FIXED_DOC_ROOTS[root]);
    if (segs.length === 1) return { kind: 'doc', fsRef };
    return { kind: 'field', fsRef, fieldPath: segs.slice(1).join('.') };
  }

  const subMeta = SUB_ROOTS[root];
  if (subMeta && segs.length >= 2) {
    const parentDoc = _fs.collection(subMeta.parentColl).doc(segs[1]);
    const subColl = parentDoc.collection(subMeta.sub);
    if (segs.length === 2) return { kind: 'list', fsColl: subColl };
    if (segs.length === 3) return { kind: 'doc', fsRef: subColl.doc(segs[2]) };
    return { kind: 'field', fsRef: subColl.doc(segs[2]), fieldPath: segs.slice(3).join('.') };
  }

  return null; // unmapped path — caller should treat as an error
}

function _getByFieldPath(obj, fieldPath) {
  if (!obj) return null;
  return fieldPath.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : null), obj);
}

// Firestore documents must be objects; handles/{handle} stores a bare
// primitive (a uid string) by the app's own convention. Wrap on write,
// unwrap on read.
function _wrapPrimitive(val) {
  return (val !== null && typeof val === 'object' && !Array.isArray(val)) ? val : { value: val };
}
function _unwrapPrimitive(val) {
  if (val && typeof val === 'object' && Object.keys(val).length === 1 && 'value' in val) return val.value;
  return val;
}

const _listeners = new Map();
let _listenerSeq = 0;

async function loadFirebase() {
  if (!window.firebase) throw new Error('[XF] Firebase SDK not loaded');

  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  _auth = firebase.auth();
  _rtdb = firebase.database(); // typing/presence only — see file header
  _fs   = firebase.firestore();

  window.XF = {
    auth: _auth,
    db:   _rtdb,   // raw handle, used directly for typing/presence only
    fs:   _fs,

    /* ── Auth ──────────────────────────────────────────────────────────── */
    onAuth:        (cb)      => _auth.onAuthStateChanged(cb),
    signIn:        (e, p)    => _auth.signInWithEmailAndPassword(e, p),
    signUp:        (e, p)    => _auth.createUserWithEmailAndPassword(e, p),
    signOut:       ()        => { window.XF.offAll(); return _auth.signOut(); },
    resetPw:       (e)       => _auth.sendPasswordResetEmail(e),
    googleAuth:    ()        => _auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()),
    register:      (e, p)    => _auth.createUserWithEmailAndPassword(e, p),
    googleSignIn:  ()        => _auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()),
    updateProfile: (data)    => _auth.currentUser.updateProfile(data),
    currentUser:   ()        => _auth.currentUser,

    /* ── One-shot reads ──────────────────────────────────────────────── */
    async get(path) {
      const r = _resolve(path);
      if (!r) throw new Error(`[XF] Unmapped path: ${path}`);
      if (r.kind === 'doc') {
        const snap = await r.fsRef.get();
        return new FakeSnapshot(snap.exists ? _unwrapPrimitive(snap.data()) : null, false);
      }
      if (r.kind === 'list') {
        const qs = await r.fsColl.get();
        const merged = {};
        qs.forEach(d => { merged[d.id] = d.data(); });
        return new FakeSnapshot(merged, true);
      }
      // field
      const snap = await r.fsRef.get();
      const val = snap.exists ? _getByFieldPath(snap.data(), r.fieldPath) : null;
      return new FakeSnapshot(val, false);
    },

    async getLast(path, n = 1) {
      const r = _resolve(path);
      if (!r || r.kind !== 'list') throw new Error(`[XF] getLast requires a list path: ${path}`);
      const qs = await r.fsColl.get();
      const entries = qs.docs
        .map(d => [d.id, d.data()])
        .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0))
        .slice(-n);
      return new FakeSnapshot(Object.fromEntries(entries), true);
    },

    /* ── Feed pagination ─────────────────────────────────────────────── */
    async getPostsPage(limit, beforeTs) {
      let q = _fs.collection('posts').orderBy('createdAt', 'desc');
      if (beforeTs) q = q.where('createdAt', '<', beforeTs);
      const qs = await q.limit(limit).get();
      const merged = {};
      qs.forEach(d => { merged[d.id] = d.data(); });
      return new FakeSnapshot(merged, true);
    },

    /* ── DM pagination ───────────────────────────────────────────────── */
    async getDmMessages(convId, limit = 100) {
      const qs = await _fs.collection('conversations').doc(convId).collection('messages')
        .orderBy('createdAt', 'desc').limit(limit).get();
      const merged = {};
      qs.forEach(d => { merged[d.id] = d.data(); });
      return new FakeSnapshot(merged, true);
    },

    /* ── Writes ──────────────────────────────────────────────────────── */
    async set(path, val) {
      const r = _resolve(path);
      if (!r) throw new Error(`[XF] Unmapped path: ${path}`);
      if (r.kind === 'field') return r.fsRef.set({ [r.fieldPath]: val }, { merge: true });
      return r.fsRef.set(_wrapPrimitive(val));
    },

    async update(path, val) {
      const r = _resolve(path);
      if (!r) throw new Error(`[XF] Unmapped path: ${path}`);
      if (r.kind === 'field') return r.fsRef.set({ [r.fieldPath]: val }, { merge: true });
      return r.fsRef.set(val, { merge: true });
    },

    // Creating something NEW (a post, comment, message, notification...).
    async push(path, val) {
      const r = _resolve(path);
      if (!r || r.kind !== 'list') throw new Error(`[XF] push requires a list path: ${path}`);
      const docRef = r.fsColl.doc();
      await docRef.set(val);
      return { key: docRef.id };
    },

    async remove(path) {
      const r = _resolve(path);
      if (!r) throw new Error(`[XF] Unmapped path: ${path}`);
      if (r.kind === 'field') return r.fsRef.update({ [r.fieldPath]: firebase.firestore.FieldValue.delete() });
      if (r.kind === 'doc') return r.fsRef.delete();
      const qs = await r.fsColl.get();
      return Promise.all(qs.docs.map(d => d.ref.delete()));
    },

    // Multi-path atomic-ish update (used for DM readBy/deliveredTo fan-out).
    async multiUpdate(updates) {
      const byDoc = new Map(); // fsRef -> { fieldPath: value }
      for (const [path, val] of Object.entries(updates)) {
        const r = _resolve(path);
        if (!r || r.kind !== 'field') continue;
        if (!byDoc.has(r.fsRef)) byDoc.set(r.fsRef, {});
        byDoc.get(r.fsRef)[r.fieldPath] = val;
      }
      return Promise.all([...byDoc.entries()].map(([ref, fields]) => ref.set(fields, { merge: true })));
    },

    ts: () => firebase.firestore.FieldValue.serverTimestamp(),

    /* ── Realtime listener ───────────────────────────────────────────── */
    on(path, cb) {
      const key = `${path}::${++_listenerSeq}`;
      const r = _resolve(path);
      if (!r) throw new Error(`[XF] Unmapped path: ${path}`);

      let unsub;
      if (r.kind === 'list') {
        unsub = r.fsColl.onSnapshot(qs => {
          const merged = {};
          qs.forEach(d => { merged[d.id] = d.data(); });
          cb(new FakeSnapshot(merged, true));
        }, err => console.error(`[XF] onSnapshot(${path}) failed:`, err));
      } else {
        unsub = r.fsRef.onSnapshot(doc => {
          cb(new FakeSnapshot(doc.exists ? doc.data() : null, false));
        }, err => console.error(`[XF] onSnapshot(${path}) failed:`, err));
      }
      _listeners.set(key, unsub);
      return () => { unsub(); _listeners.delete(key); };
    },

    onChild(path, event, cb) {
      // Diff-based child events synthesised from the live listener, kept
      // for API compatibility (not currently used by the app).
      const key = `${path}::${event}::${++_listenerSeq}`;
      let prevKeys = new Set();
      const unsubList = window.XF.on(path, snap => {
        const data = snap.val() || {};
        const keys = new Set(Object.keys(data));
        if (event === 'child_added') {
          keys.forEach(k => { if (!prevKeys.has(k)) cb({ key: k, val: () => data[k] }); });
        } else if (event === 'child_removed') {
          prevKeys.forEach(k => { if (!keys.has(k)) cb({ key: k, val: () => data[k] }); });
        } else if (event === 'child_changed') {
          keys.forEach(k => { if (prevKeys.has(k)) cb({ key: k, val: () => data[k] }); });
        }
        prevKeys = keys;
      });
      const unsub = () => { unsubList(); _listeners.delete(key); };
      _listeners.set(key, unsub);
      return unsub;
    },

    offAll() {
      _listeners.forEach(unsub => { try { unsub(); } catch (_) {} });
      _listeners.clear();
    },
  };
}

window.XFire = {
  load: loadFirebase,
  _reattach: function() {
    _auth = firebase.auth();
    _rtdb = firebase.database();
    _fs   = firebase.firestore();
  }
};
