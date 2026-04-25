// ── Ojaq Preview — single-page prototype ────────────────────────────────
// Combining landing + playground in one DOM context. Production untouched.

import { Avatar } from '/playground/avatar.js';
import { GeminiConnection } from '/playground/gemini.js';
import { MicCapture, AudioPlayer, arrayBufToBase64 } from '/playground/audio.js';
import { FRAMEWORKS, assemblePrompt } from '/playground/frameworks.js';
import { SessionConductor } from '/playground/conductor.js';
import { PresenceHistory } from '/playground/presence.js';
import * as billing from '/playground/billing.js';

const log = (msg) => console.log(`[preview] ${msg}`);

// ── Language detection ────────────────────────────────────────────────
// Mirrors /playground/app.js so Gemini's ASR runs in the right locale and
// the framework prompt knows which language to respond in. Without this,
// Turkish (or any non-English) speech is transcribed as garbled English
// phonemes and the model misunderstands.
function detectLanguage() {
  const nav = (navigator.language || '').trim();
  if (!nav) return 'en-US';
  if (nav.includes('-') && nav.length >= 4) return nav;
  const map = {
    tr: 'tr-TR', en: 'en-US', ja: 'ja-JP', es: 'es-ES',
    fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR', ar: 'ar-SA',
    zh: 'zh-CN', it: 'it-IT', ru: 'ru-RU', ko: 'ko-KR',
  };
  const lang = nav.toLowerCase().split('-')[0];
  return map[lang] || `${lang}-${lang.toUpperCase()}`;
}
const userLanguage = detectLanguage();
const langBase = userLanguage.split('-')[0];

// Mount the orb canvas in idle (passive drift) mode.
const canvas = document.getElementById('orb-canvas');
const avatar = new Avatar(canvas);
// 'hold' mode further slows the drift — combined with the low-energy idle
// preset below, the orb settles into a meditative breath.
avatar.setMode('hold');

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
let conductor = null;
let presenceHistory = null;
let lastUserText = '';
let lastModelText = '';

// Idle preset: low energy + low engagement keep the orb's drift slow and
// meditative. The hero shouldn't feel like a busy screensaver while users
// read. Conductor takes over speed/depth once presence reads come in.
const IDLE_PRESENCE = { energy: 12, confidence: 50, resistance: 5, engagement: 25, congruence: 60, sentiment: 0.1 };

// Session-start preset: the orb visibly shifts to "listening" the moment
// activate runs — moderate energy, high engagement, neutral resistance.
// This carries the user from the meditative landing into a present-and-alert
// state during the 1–2 turns before /analyze returns its first read.
const SESSION_START_PRESENCE = { energy: 50, confidence: 65, resistance: 10, engagement: 70, congruence: 70, sentiment: 0.2 };

// Smoothed presence buffer — softens jumps between consecutive /analyze
// reads so a single noisy turn doesn't whip the orb. Each new presence
// blends 50/50 with the previous before we hand it to the avatar.
let _smoothedPresence = null;

function setBodyState(target) {
  document.body.classList.remove('session-active', 'session-reflecting', 'reflection-visible');
  if (target === 'active') document.body.classList.add('session-active');
  else if (target === 'reflecting') document.body.classList.add('session-reflecting');
}

async function activate() {
  if (state === 'active') return;
  // Allow Begin click during a lingering reflection to skip straight into a new session
  if (state === 'reflecting') resetReflection();

  // ── Pre-flight: client-side credit gate ─────────────────────────────
  // Authed users with no credits + no evergreen get the paywall before
  // any network round-trip. /session/start would catch this server-side
  // too, but failing fast saves a request and feels snappier.
  const userState = billing.getState();
  if (userState && !userState.evergreenActive && (userState.credits ?? 0) <= 0) {
    log('pre-flight: authed but no credits — showing paywall');
    billing.showPaywall({ allowLogin: false });
    return;
  }

  // ── Server-side gate: /session/start ────────────────────────────────
  // Enforces IP-based rate limit for unauthed users (free tier) AND
  // re-checks credits for authed users (defense against stale client
  // state). Called BEFORE the visual transition so a paywall surface
  // never leaves the landing page in a half-torn-down limbo.
  let sessionId = null;
  try {
    const r = await fetch('/session/start', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ framework: 'coaching' }),
    });
    if (r.status === 429) {
      log('rate limited (unauthed) — paywall with login');
      billing.showPaywall({ allowLogin: true });
      return;
    }
    if (r.status === 402) {
      log('no credits (authed) — paywall');
      billing.showPaywall({ allowLogin: false });
      return;
    }
    if (r.ok) {
      const d = await r.json();
      sessionId = d.session_id;
      log(`session_id=${sessionId}`);
    }
  } catch {
    // Network blip on /session/start shouldn't block the user from
    // their session — analytics is best-effort, not a hard gate.
  }

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
    // Reset per-session presence pipeline + lift the orb from idle drift
    // into "listening" right now, before the first /analyze even fires.
    presenceHistory = new PresenceHistory(20);
    _smoothedPresence = null;
    avatar.setMode('reflect');
    avatar.setPresence(SESSION_START_PRESENCE);
    const framework = FRAMEWORKS.coaching;
    conductor = new SessionConductor(framework);
    conductor.onChange(({ phase, mode, depth }) => {
      avatar.setMode(mode);
      avatar.setDepth(depth);
    });

    lastUserText = '';
    lastModelText = '';
    $tUser.textContent = '';
    $tModel.textContent = '';

    gemini = new GeminiConnection();
    gemini.onAudio = (b64) => player?.play(b64);
    // Barge-in: when Gemini detects the user starting to speak mid-reply
    // it sends an interrupted signal. Flushing the audio queue immediately
    // is what makes the AI actually stop talking — without this, queued
    // chunks keep playing and the user feels unheard.
    gemini.onInterrupted = () => {
      player?.clear();
      lastModelText = '';
      $tModel.textContent = '';
    };
    gemini.onInputTranscript = (t) => {
      lastUserText += t;
      $tUser.textContent = lastUserText;
    };
    gemini.onOutputTranscript = (t) => {
      lastModelText += t;
      // Strip any leaked [CMD:*] markers before display and before /analyze sees them
      lastModelText = lastModelText.replace(/\[CMD:[^\]]*\]/g, '').trim();
      $tModel.textContent = lastModelText;
    };
    gemini.onTurnComplete = () => {
      // Async presence — never blocks the audio path
      const u = lastUserText, m = lastModelText;
      if (u) analyzePresence(u, m);
      lastUserText = '';
      lastModelText = '';
    };
    gemini.onClose = (code, reason) => {
      log(`ws closed ${code} ${reason || ''}`);
      if (state === 'active') endSession();
    };

    const prompt = assemblePrompt(framework);
    await gemini.connect(prompt, [], userLanguage);
    log(`gemini connected (lang=${userLanguage})`);

    player = new AudioPlayer();
    player.init();
    mic = new MicCapture((buf) => gemini.sendAudio(arrayBufToBase64(buf)));
    await mic.start();
    log('mic active');

    setTimeout(() => {
      // Tell the framework which language to respond in BEFORE the
      // start signal — otherwise the opening greeting can land in
      // the wrong language.
      gemini?.sendText(`[CMD:lang:${langBase}]`);
      gemini?.sendText('[CMD:start]');
      log(`-> [CMD:lang:${langBase}] [CMD:start]`);
    }, 300);

    // Deduct one credit on successful start. Fire-and-forget — the chip
    // will reflect the new balance once /wallet/deduct returns. Server
    // is the source of truth; if the deduct fails, the chip simply won't
    // update (no double-charge, no aborted session).
    billing.deductCredit().catch(() => {});
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
  conductor = null;
  presenceHistory = null;
}

// Blend a fresh presence read 50/50 with the previous smoothed value so
// the avatar tween doesn't get a sudden new target every turn. The
// avatar still does its own 4%/frame ease-in toward target, but a damped
// target halves the perceived velocity of presence-driven reactions.
function blendPresence(newP) {
  const keys = ['energy', 'confidence', 'resistance', 'engagement', 'congruence', 'sentiment'];
  if (!_smoothedPresence) {
    _smoothedPresence = {};
    for (const k of keys) _smoothedPresence[k] = newP[k] ?? 0;
    return { ..._smoothedPresence };
  }
  const a = 0.5; // 0 = no change, 1 = instant
  for (const k of keys) {
    if (typeof newP[k] === 'number') {
      _smoothedPresence[k] = _smoothedPresence[k] * (1 - a) + newP[k] * a;
    }
  }
  return { ..._smoothedPresence };
}

// Async presence analysis — runs parallel to the voice loop. Never awaited
// from anything on the audio path, so a slow /analyze never adds latency.
// Mirrors the production pipeline in /playground/app.js.
async function analyzePresence(userText, modelText) {
  try {
    const r = await fetch('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: userText, model: modelText }),
    });
    if (!r.ok) return;
    const p = await r.json();
    if (!p || p.error) return;
    presenceHistory?.push(p);
    // Conductor reads the raw presence (we want its phase/mode logic to
    // see actual values, not the smoothed envelope).
    conductor?.onPresence(p, () => {});
    // Avatar reads the smoothed presence — softer transitions between turns.
    avatar.setPresence(blendPresence(p));
    log(`presence e=${p.energy} c=${p.confidence} r=${p.resistance} eng=${p.engagement} cong=${p.congruence} s=${p.sentiment}`);
  } catch {
    // Silent — never let presence interrupt anything
  }
}

function endSession() {
  if (state !== 'active') return;
  state = 'reflecting';
  teardownVoice();
  setBodyState('reflecting');
  $topics.forEach((b) => b.classList.remove('active'));
  // Keep the auth chip suppressed through the reflection moment too —
  // it's uncluttered intentionally. Restored in dismissReflection.
  avatar.settleToRest(1200);
  resetReflection();
  log('reflection began');
  // Brief pause then reveal the soft offer — quicker than the prior 2s,
  // still long enough to feel like a breath rather than a snap.
  reflectionRevealTimer = setTimeout(() => {
    if (state === 'reflecting') document.body.classList.add('reflection-visible');
  }, 700);
}

function dismissReflection() {
  if (state !== 'reflecting') return;
  state = 'idle';
  if (reflectionRevealTimer) { clearTimeout(reflectionRevealTimer); reflectionRevealTimer = null; }
  setBodyState('idle');
  billing.setSessionActive(false);   // chip returns
  avatar.setPresence(IDLE_PRESENCE); // restore idle target so orbs resume natural drift
  avatar.setMode('hold');            // back to slow meditative drift
  avatar.setDepth(0);                // clear any depth the conductor accumulated
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
const $reflectHome = document.getElementById('reflect-home');
const $tUser = document.getElementById('t-user');
const $tModel = document.getElementById('t-model');
const $topics = document.querySelectorAll('.topic');

// ── Topic switcher ──────────────────────────────────────────────────────
// Each click sends a brief natural-language inject to Gemini so the model
// pivots to the chosen domain. Inject phrasing intentionally reads as user
// input — the model treats it as a redirect from the speaker, not a system
// command, which keeps responses grounded in the framework's voice.
const TOPIC_INJECTS = {
  work:         "Let's shift focus to my work — career, projects, what I'm building.",
  relationship: "Let's talk about my relationships — connection, family, friends.",
  growth:       "Let's focus on my personal growth — change, becoming, inner work.",
  couple:       "Let's talk about my partnership — what's alive between us.",
};

function selectTopic(topic) {
  if (state !== 'active' || !gemini) return;
  $topics.forEach((b) => b.classList.toggle('active', b.dataset.topic === topic));
  const inject = TOPIC_INJECTS[topic];
  if (inject) {
    gemini.sendText(inject);
    log(`-> topic: ${topic}`);
  }
}

$topics.forEach((b) => {
  b.addEventListener('click', () => selectTopic(b.dataset.topic));
});

// ── Wiring ───────────────────────────────────────────────────────────────
document.getElementById('begin-btn').addEventListener('click', activate);
document.getElementById('end-session').addEventListener('click', endSession);
$reflectForm.addEventListener('submit', onReflectionSubmit);
$reflectTertiary.addEventListener('click', activate);  // Start another → directly into a new session
$reflectHome.addEventListener('click', dismissReflection);  // Back to home → idle landing
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

// Editorial pack cards — same checkout flow as the paywall modal.
// Anchors fall back to /playground if JS fails; with JS, we intercept,
// route unauthed users through the login modal first, then redirect to
// Stripe with return_path=/preview/ so they come back here.
document.querySelectorAll('.pack[data-package]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    billing.startCheckout(el.dataset.package);
  });
});

// Fade the orb backdrop to near-invisible once the user scrolls past the
// hero. Avoids competing with editorial reading; restored via CSS
// session-active rule when a session starts (where the orb IS the focus).
const heroEl = document.querySelector('.hero');
if (heroEl && 'IntersectionObserver' in window) {
  new IntersectionObserver((entries) => {
    for (const entry of entries) {
      document.body.classList.toggle('hero-out-of-view', !entry.isIntersecting);
    }
  }, { threshold: 0.15 }).observe(heroEl);
}

log('preview ready');
