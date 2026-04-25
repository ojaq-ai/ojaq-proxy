// ── Ojaq Preview — single-page prototype ────────────────────────────────
// Combining landing + playground in one DOM context. Production untouched.

import { Avatar } from '/playground/avatar.js';
import { GeminiConnection } from '/playground/gemini.js';
import { MicCapture, AudioPlayer, arrayBufToBase64 } from '/playground/audio.js';
import { FRAMEWORKS, assemblePrompt } from '/playground/frameworks.js';

const log = (msg) => console.log(`[preview] ${msg}`);

// Mount the orb canvas in idle (passive drift) mode.
const canvas = document.getElementById('orb-canvas');
const avatar = new Avatar(canvas);

// ── Session state machine ────────────────────────────────────────────────
//   idle ↔ active → reflecting → idle  (reflecting → active via "Start another")
let state = 'idle';
let gemini = null;
let mic = null;
let player = null;
let reflectionRevealTimer = null;

const IDLE_PRESENCE = { energy: 30, confidence: 50, resistance: 5, engagement: 40, congruence: 60, sentiment: 0.1 };

function setBodyState(target) {
  document.body.classList.remove('session-active', 'session-reflecting', 'reflection-visible');
  if (target === 'active') document.body.classList.add('session-active');
  else if (target === 'reflecting') document.body.classList.add('session-reflecting');
}

async function activate() {
  if (state === 'active') return;
  // Allow orb-click to skip a lingering reflection straight into a new session
  if (state === 'reflecting') resetReflection();
  state = 'active';
  setBodyState('active');
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
    teardownVoice();
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
  avatar.setPresence(IDLE_PRESENCE); // restore idle target so orbs resume natural drift
  resetReflection();
  log('returned to idle');
}

function resetReflection() {
  $reflectLine.textContent = 'Save this thread to come back to it.';
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
document.getElementById('orb-trigger').addEventListener('click', activate);
document.getElementById('end-session').addEventListener('click', endSession);
$reflectForm.addEventListener('submit', onReflectionSubmit);
$reflectTertiary.addEventListener('click', activate);  // Start another → directly into a new session
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state === 'reflecting') dismissReflection();
});

log('preview ready');
