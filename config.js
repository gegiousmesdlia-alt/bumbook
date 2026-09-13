// config.js — X Club v7 — App-wide constants & shared state
// Load order: 1st (before everything else)
'use strict';

/* ══════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════ */
const ADMIN_EMAIL = 'admin@gmail.com';
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
let selectedInvestAmount = 0;
let isAdmin = false;
let allUsersCache = [];
