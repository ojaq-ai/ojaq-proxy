// ── Ojaq Preview — single-page prototype ────────────────────────────────
// Combining landing + playground in one DOM context. Production untouched.

import { Avatar } from '/playground/avatar.js';

const log = (msg) => console.log(`[preview] ${msg}`);

// Mount the orb canvas in idle (passive drift) mode.
// Reuses /playground/avatar.js — no code duplication.
const canvas = document.getElementById('orb-canvas');
const avatar = new Avatar(canvas);

// Click handler for the orb trigger button — voice/session wiring lands in commit 2+.
const trigger = document.getElementById('orb-trigger');
trigger.addEventListener('click', () => {
  log('orb clicked — voice/session wiring not yet present (commit 2+)');
});

log('preview ready (visual shell only)');
