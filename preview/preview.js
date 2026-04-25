// ── Ojaq Preview — single-page prototype ────────────────────────────────
// Combining landing + playground in one DOM context. Production untouched.

import { Avatar } from '/playground/avatar.js';
import { GeminiConnection } from '/playground/gemini.js';
import { MicCapture, AudioPlayer, arrayBufToBase64 } from '/playground/audio.js';
import { FRAMEWORKS, assemblePrompt } from '/playground/frameworks.js';
import * as billing from '/playground/billing.js';

const log = (msg) => console.log(`[preview] ${msg}`);

// Mount the orb canvas in idle (passive drift) mode.
const canvas = document.getElementById('orb-canvas');
const avatar = new Avatar(canvas);

// ── Session state machine ────────────────────────────────────────────────
//   idle ↔ active → reflecting → idle  (reflecting → active via "Start another")
//
//   While active or reflecting, all surrounding chrome (nav, hero text+button,
//   editorial, footer, auth chip) is hidden via body classes and CSS. The orb
//   stays centered as the constant visual anchor; it just sharpens (blur lifts)
//   when entering a session and dims again when returning to landing.
//
//   We pushState a synthetic history entry on activate so the browser back
//   button cleanly ends a live session. Pairing pop with state transitions
//   keeps the history stack tidy: a clean session leaves no entry behind.
let state = 'idle';
let gemini = null;
let mic = null;
let player = null;
let reflectionRevealTimer = null;
let _historyPushed = false;

const IDLE_PRESENCE = { energy: 30, confidence: 50, resistance: 5, engagement: 40, congruence: 60, sentiment: 0.1 };

function setBodyState(target) {
  document.body.classList.remove('session-active', 'session-reflecting', 'reflection-visible');
  if (target === 'active') document.body.classList.add('session-active');
  else if (target === 'reflecting') document.body.classList.add('session-reflecting');
}

async function activate() {
  if (state === 'active') return;
  // Allow Begin click during a lingering reflection to skip straight into a new session
  if (state === 'reflecting') resetReflection();
  state = 'active';
  setBodyState('active');
  billing.setSessionActive(true);
  // Snap to top so the orb is the only focal point — the editorial/nav are
  // visibility:hidden but laid out from the top, so without scrollTo the user
  // could resume mid-page on subsequent activations.
  window.scrollTo(0, 0);
  // Push a session entry so browser back ends the session cleanly
  if (!_historyPushed) {
    history.pushState({ session: true }, '');
    _historyPushed = true;
  }
  log('session activating…');

  try {
    gemini = new GeminiConnection();
    gemini.onAudio = (b64) => player?.play(b64);
    gemini.onInputTranscript = (t) => log(`user: ${t}`);
    gemini.onOutputTranscript = (t) => log(`ojaq: ${t}`);
    gemini.onClose = (code, reason) => {
      log(`ws closed ${code} ${reason || ''}`);
      if (state === 'active') endSession();
    };

    const framework = FRAMEWORKS.coaching;
    const prompt = assemblePrompt(framework);
    await gemini.connect(prompt, [], 'en-US');
    log('gemini connected');

    player = new AudioPlayer();
    player.init();
    mic = new MicCapture((buf) => gemini.sendAudio(arrayBufToBase64(buf)));
    await mic.start();
    log('mic active');

    setTimeout(() => {
      gemini?.sendText('[CMD:start]');
      log('-> [CMD:start]');
    }, 300);
  } catch (err) {
    log(`activate failed: ${err.message}`);
    state = 'idle';
    setBodyState('idle');
    billing.setSessionActive(false);
    teardownVoice();
    if (_historyPushed) { _historyPushed = false; history.back(); }
  }
}

function teardownVoice() {
  mic?.stop(); mic = null;
  player?.stop(); player = null;
  gemini?.close(); gemini = null;
}

function endSession() {
  if (state !== 'active') return;
  state = 'reflecting';
  teardownVoice();
  setBodyState('reflecting');
  // Keep the auth chip suppressed through the reflection moment too —
  // it's uncluttered intentionally. Restored in dismissReflection.
  avatar.settleToRest(2500);
  resetReflection();
  log('reflection began (2s hold)');
  // After the 2s exhale, fade in the soft offer.
  reflectionRevealTimer = setTimeout(() => {
    if (state === 'reflecting') document.body.classList.add('reflection-visible');
  }, 2000);
}

function dismissReflection() {
  if (state !== 'reflecting') return;
  state = 'idle';
  if (reflectionRevealTimer) { clearTimeout(reflectionRevealTimer); reflectionRevealTimer = null; }
  setBodyState('idle');
  billing.setSessionActive(false);   // chip returns
  avatar.setPresence(IDLE_PRESENCE); // restore idle target so orbs resume natural drift
  resetReflection();
  // Clean slate — land at the top of the page on return
  window.scrollTo(0, 0);
  // Pop the synthetic session entry so back button doesn't replay the session
  if (_historyPushed) {
    _historyPushed = false;
    history.back();
  }
  log('returned to idle');
}

function resetReflection() {
  $reflectLine.textContent = 'Carry this with you.';
  $reflectForm.style.display = '';
  $reflectTertiary.style.display = '';
  $reflectEmail.value = '';
  $reflectEmail.disabled = false;
  $reflectSubmit.disabled = false;
}

async function onReflectionSubmit(e) {
  e.preventDefault();
  const email = ($reflectEmail.value || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
  $reflectEmail.disabled = true;
  $reflectSubmit.disabled = true;
  // Fire-and-forget — reuse /waitlist with a distinct source for analytics
  fetch('/waitlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, source: 'preview_reflection' }),
  }).catch(() => {});
  log(`reflection email submitted: ${email}`);
  // Soft thank-you, then dismiss
  $reflectLine.textContent = 'Thank you.';
  $reflectForm.style.display = 'none';
  $reflectTertiary.style.display = 'none';
  setTimeout(() => dismissReflection(), 1500);
}

// ── DOM handles ──────────────────────────────────────────────────────────
const $reflectLine = document.getElementById('reflect-line');
const $reflectForm = document.getElementById('reflect-form');
const $reflectEmail = document.getElementById('reflect-email');
const $reflectSubmit = document.querySelector('.reflect-submit');
const $reflectTertiary = document.getElementById('reflect-tertiary');

// ── Wiring ───────────────────────────────────────────────────────────────
document.getElementById('begin-btn').addEventListener('click', activate);
document.getElementById('end-session').addEventListener('click', endSession);
$reflectForm.addEventListener('submit', onReflectionSubmit);
$reflectTertiary.addEventListener('click', activate);  // Start another → directly into a new session
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state === 'reflecting') dismissReflection();
});

// Browser back during a live or reflecting session ends/dismisses cleanly.
// The pushed entry is already gone from the stack by the time popstate fires,
// so we clear the flag and route to the right transition.
window.addEventListener('popstate', () => {
  _historyPushed = false;
  if (state === 'active') endSession();
  else if (state === 'reflecting') dismissReflection();
});

// ── Waitlist form (mobile-launch capture) ──────────────────────────────
const $waitlistForm = document.getElementById('waitlist-form');
const $waitlistEmail = document.getElementById('waitlist-email');
const $waitlistNote = document.getElementById('waitlist-note');
$waitlistForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = ($waitlistEmail.value || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    $waitlistNote.textContent = 'Enter a valid email.';
    return;
  }
  // Local dedupe via the same key the production landing uses
  const sent = JSON.parse(localStorage.getItem('ojaq_wl_sent') || '[]');
  if (sent.includes(email.toLowerCase())) {
    $waitlistNote.textContent = "You're already on the list.";
    return;
  }
  try {
    const r = await fetch('/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, source: 'preview_mobile_waitlist' }),
    });
    const d = await r.json();
    if (d.ok) {
      sent.push(email.toLowerCase());
      localStorage.setItem('ojaq_wl_sent', JSON.stringify(sent));
      $waitlistEmail.value = '';
      $waitlistNote.textContent = "You're in. We'll be in touch.";
    } else {
      $waitlistNote.textContent = 'Something went wrong. Try again.';
    }
  } catch {
    $waitlistNote.textContent = 'Network error. Try again.';
  }
});

// ── Auth chip + login modal — reuses /playground/billing.js verbatim ───
billing.init().catch((e) => log(`billing init failed: ${e.message}`));

log('preview ready');
