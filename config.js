// config.js — X Club v7 — App-wide constants & shared state
// Load order: 1st (before everything else)
'use strict';

/* ══════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════ */
const ADMIN_EMAIL = 'admin@gmail.com';
// API_BASE: the /api serverless functions only exist in the main site's
// deployment (bumbook.vercel.app). The main app is served from that same
// origin, so relative '/api/...' calls already work there (API_BASE ''
// there). The admin app is a SEPARATE Vercel project (bumadmin.vercel.app)
// with no /api of its own, so its calls must go cross-origin instead —
// admin-app/index.html sets window.__PAGE__ = 'admin' inline before this
// file loads, which is what this check relies on. The main site's
// vercel.json already sets Access-Control-Allow-Origin: * on /api/(.*),
// so the cross-origin calls work with no extra CORS setup.
const API_BASE = (typeof window !== 'undefined' && window.__PAGE__ === 'admin') ? 'https://bumbook.vercel.app' : '';
// Verification is free (selfie + ID review) — no payment constants needed.
const CLAUDE_ENGINEER_UID = 'claude_engineer_bot';

/* ══════════════════════════════════════════════
   SHARED STATE
══════════════════════════════════════════════ */
let currentUser = null;
let currentProfile = null;
let activePage = 'feed';
let feedTab = 'for-you';
let activeConvUid = null;
let msgUnsubscribe = null;
let _postDateMode = 'now';
let isAdmin = false;
let allUsersCache = [];
