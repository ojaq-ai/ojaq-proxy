// ── Ojaq Preview — single-page prototype ────────────────────────────────
// Combining landing + playground in one DOM context. Production untouched.

import { Avatar } from '/playground/avatar.js';

const log = (msg) => console.log(`[preview] ${msg}`);

// Mount the orb canvas in idle (passive drift) mode.
// Reuses /playground/avatar.js — no code duplication.
const canvas = document.getElementById('orb-canvas');
const avatar = new Avatar(canvas);

// ── Session state machine — visual-only for now (commit 2) ──────────────
// Voice/audio/Gemini wiring lands in commit 3, slotted into activate()/deactivate().
let active = false;

function activate() {
  if (active) return;
  active = true;
  document.body.classList.add('session-active');
  log('session activated (visual only — voice in commit 3)');
}

function deactivate() {
  if (!active) return;
  active = false;
  document.body.classList.remove('session-active');
  log('session deactivated');
}

document.getElementById('orb-trigger').addEventListener('click', activate);
document.getElementById('end-session').addEventListener('click', deactivate);

log('preview ready');
