// sidebar.js — X Club v7 — Sidebar: Suggested Members, Business Feed, Groq AI
'use strict';

/* ══════════════════════════════════════════════
   GROQ AI
══════════════════════════════════════════════ */
let _groqKey = null;

async function getGroqKey() {
  if (_groqKey) return _groqKey;
  try { const s = await window.XF.get('config/groqKey'); if (s.exists()) { _groqKey = s.val(); return _groqKey; } } catch (e) {}
  return null;
}

async function callGroq({ system, user, maxTokens = 1024 }) {
  const key = await getGroqKey(); if (!key) throw new Error('No Groq key');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
  });
  if (!res.ok) throw new Error('Groq ' + res.status);
  const d = await res.json(); return d.choices?.[0]?.message?.content?.trim() || '';
}

/* ══════════════════════════════════════════════
   SIDEBAR: SUGGESTED MEMBERS
══════════════════════════════════════════════ */
async function loadSuggested() {
  const c = $('suggestedMembers'); if (!c || !window.XF) return;
  try {
    const snap = await window.XF.get('users'); const people = [];
    if (snap.exists()) snap.forEach(s => { if (s.key !== currentUser?.uid) people.push(s.val()); });
    const shown = people.filter(p => p.verified).slice(0, 3).concat(people.filter(p => !p.verified).slice(0, 2)).slice(0, 4);
    if (shown.length === 0) { c.innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem">No members yet</div>'; return; }
    c.innerHTML = shown.map(p => `<div class="sidebar-item" onclick="openUserProfile('${p.uid}',event)" style="display:flex;align-items:center;gap:10px">${avatarHTML(p, 'sm')}<div style="min-width:0;flex:1"><div style="font-weight:700;font-size:0.88rem;display:flex;align-items:center;gap:3px">${escapeHTML(p.displayName || 'Member')}${verifiedBadge(p.verified)}</div><div style="color:var(--text-dim);font-size:0.78rem">@${escapeHTML(p.handle || 'member')}</div></div>${p.uid !== currentUser?.uid ? `<button class="btn btn-outline btn-sm" onclick="event.stopPropagation();sendConnectionRequest('${p.uid}')" style="font-size:0.75rem;padding:4px 10px">Connect</button>` : ''}</div>`).join('');
  } catch (e) {}
}

/* ══════════════════════════════════════════════
   SIDEBAR: BUSINESS PULSE (AI)
══════════════════════════════════════════════ */
async function loadBizFeed() {
  const container = $('bizFeedContainer'); if (!container) return;
  container.innerHTML = '<div class="bizfeed-loading"><div class="spinner"></div> Loading…</div>';
  try {
    const raw = await callGroq({ system: `You are a business intelligence service. Generate exactly 4 short business news snippets about oil & gas, emerging markets, tech, real estate, or global finance. Each: 1-2 sentences, confident insider tone. Respond ONLY with raw JSON array, no markdown: [{"tag":"oil","text":"..."},{"tag":"investment","text":"..."},{"tag":"tech","text":"..."},{"tag":"market","text":"..."}]. Valid tags: oil, investment, tech, market`, user: 'Generate 4 fresh business intelligence snippets.', maxTokens: 800 });
    const items = JSON.parse(raw.replace(/```json|```/g, '').trim());
    container.innerHTML = items.map(item => `<div class="bizfeed-item"><div class="bizfeed-author">${claudeEngineerAvatarHTML('sm')}<div><div class="bizfeed-name">Claude Engineer <span style="color:var(--accent);font-size:0.72rem">✓</span></div><div class="bizfeed-time">@claudeengineer</div></div></div><span class="bizfeed-tag ${escapeHTML(item.tag)}">${escapeHTML(item.tag.toUpperCase())}</span><div class="bizfeed-text">${escapeHTML(item.text)}</div></div>`).join('');
  } catch (err) { container.innerHTML = '<div style="font-size:0.8rem;color:var(--text-dim);padding:8px">Could not load insights — add Groq key in Admin panel.</div>'; }
}

async function postClaudeEngineerToFeed() {
  try {
    const text = await callGroq({ system: `You are Claude Engineer, a business intelligence account on X Club. Write ONE sharp post (2-4 sentences) about something interesting in business, finance, tech, oil & gas, real estate, or emerging markets. Confident, analytical tone. No hashtags. No emojis. Respond with ONLY the post text.`, user: 'Write a sharp business post.', maxTokens: 512 });
    if (!text) return;
    await window.XF.push('posts', { authorUid: CLAUDE_ENGINEER_UID, text, type: 'post', isBot: true, createdAt: Date.now(), commentCount: 0 });
  } catch (err) { console.warn('Claude Engineer post failed:', err); }
}
