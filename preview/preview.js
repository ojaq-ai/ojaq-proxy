// ── Ojaq Preview — single-page prototype ────────────────────────────────
// Combining landing + playground in one DOM context. Production untouched.

import { Avatar } from '/playground/avatar.js';
import { GeminiConnection } from '/playground/gemini.js';
import { MicCapture, AudioPlayer, arrayBufToBase64 } from '/playground/audio.js';
import { FRAMEWORKS, assemblePrompt } from '/playground/frameworks.js';
import { SessionConductor } from '/playground/conductor.js';
import { PresenceHistory } from '/playground/presence.js';
import { EmotionConnection } from '/playground/emotion.js';
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
let emotion = null;  // EmotionConnection — closed in teardownVoice
let lastUserText = '';
let lastModelText = '';
// Latest single-sentence observation from /analyze. Surfaced in the
// reflection screen as a real session summary (not a generated end-of-
// session call — just the model's most recent honest read).
let lastSignal = '';
let sessionStartedAt = 0;
// Remembered between sessions so "Start another" re-enters the same
// character. Falls back to coaching on first run.
let _lastFrameworkId = 'coaching';
// Throttle emotion logs — only print when the label changes
let _lastEmotionLabel = null;

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

async function activate(frameworkId = _lastFrameworkId || 'coaching') {
  const framework = FRAMEWORKS[frameworkId] || FRAMEWORKS.coaching;
  _lastFrameworkId = framework.id;
  if (state === 'active') return;
  // Allow character click during a lingering reflection to skip straight into a new session
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
      body: JSON.stringify({ framework: framework.id }),
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
    lastSignal = '';
    sessionStartedAt = Date.now();
    avatar.setMode('reflect');
    avatar.setPresence(SESSION_START_PRESENCE);
    if ($topicsHeader) $topicsHeader.textContent = framework.name;
    renderModalities(framework);
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
      // Voice character: request a turn-level prosody summary ONLY if
      // the user actually spoke this turn. turnComplete also fires after
      // our [PROSODY_REPORT] inject (Gemini treats the inject as another
      // user input and replies/acks); on those rounds `u` is empty
      // because sendText never produces a transcript. Gating on `u`
      // suppresses the spurious second summary request per round.
      if (framework.id === 'voice' && u) {
        emotion?.requestSummary();
      }
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

    // Realtime emotion stream — 16kHz int16 PCM piped to the Modal SER
    // service; predictions arrive at ~2/sec and tint the orb via Plutchik
    // hue. Mic provides the 16k chunk callback; emotion stream is fully
    // optional — failures here NEVER block the audio path to Gemini.
    emotion = new EmotionConnection();
    emotion.onEmotion = (data) => {
      avatar.setEmotion(data.emotion, data.intensity);
      // Log every emotion event so frequency is visible. The orb tween
      // smooths the visual side; the log is purely diagnostic and can
      // be re-throttled later if it gets noisy.
      const raw = data.raw_emotion ? ` <- ${data.raw_emotion}` : '';
      log(`emotion: ${data.emotion} (${data.intensity.toFixed(2)})${raw}`);
    };
    // Voice character only — receives turn-level prosody summaries and
    // injects them into Gemini's next turn so the AI can coach on HOW
    // the user spoke, not just WHAT they said. No-op for other chars.
    emotion.onSummary = (summary) => {
      if (framework.id !== 'voice' || !gemini) return;
      // Empty summaries (very short utterance below the 3s window or
      // a bookkeeping race) silently skip — the next user turn will
      // produce reads and we'll inject then.
      if (summary.empty || (summary.n_reads || 0) === 0) return;
      const top = (summary.top || []).map(t => `${t.emotion}(${t.score})`).join(' ');
      const inject =
        `[PROSODY_REPORT: confidence_index=${summary.confidence_index} ` +
        `dominant=${summary.dominant} top=${top} n_reads=${summary.n_reads}]`;
      gemini.sendText(inject);
      log(`-> ${inject}`);
    };
    emotion.onError = (err) => log(`emotion ws error: ${err?.message || err}`);
    emotion.connect();

    mic = new MicCapture(
      (buf) => gemini.sendAudio(arrayBufToBase64(buf)),
      (buf16k) => emotion?.sendPcm(buf16k),
    );
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
  emotion?.close(); emotion = null;
  // Fade the orb back to a neutral hue so the next session doesn't open
  // tinted by the prior session's last emotion read.
  avatar.setEmotion('neutral', 0, 600);
  _lastEmotionLabel = null;
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
    if (p.signal) lastSignal = p.signal;
    // Conductor reads the raw presence (we want its phase/mode logic to
    // see actual values, not the smoothed envelope).
    conductor?.onPresence(p, () => {});
    // Avatar reads the smoothed presence — softer transitions between turns.
    avatar.setPresence(blendPresence(p));
    log(`presence e=${p.energy} c=${p.confidence} r=${p.resistance} eng=${p.engagement} cong=${p.congruence} s=${p.sentiment}`);
    if (p.signal) log(`signal: ${p.signal}`);
  } catch {
    // Silent — never let presence interrupt anything
  }
}

function endSession() {
  if (state !== 'active') return;
  state = 'reflecting';
  // Capture summary inputs BEFORE teardownVoice clears state
  const durationMs = sessionStartedAt ? Date.now() - sessionStartedAt : 0;
  const summarySignal = lastSignal;
  teardownVoice();
  setBodyState('reflecting');
  $modalitiesList?.querySelectorAll('.modality').forEach((b) => b.classList.remove('active'));
  // Keep the auth chip suppressed through the reflection moment too —
  // it's uncluttered intentionally. Restored in dismissReflection.
  avatar.settleToRest(1200);
  resetReflection();
  renderReflectionSummary(summarySignal, durationMs);
  log(`reflection began (signal="${summarySignal.slice(0, 40)}…" duration=${Math.round(durationMs / 1000)}s)`);
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
  if ($topicsHeader) $topicsHeader.textContent = '';
  if ($modalitiesList) $modalitiesList.replaceChildren();
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
  // Clear summary so prior session doesn't bleed into the new reflection
  if ($reflectSignal) { $reflectSignal.textContent = ''; $reflectSignal.style.display = 'none'; }
  if ($reflectDuration) { $reflectDuration.textContent = ''; $reflectDuration.style.display = 'none'; }
}

// Show the latest /analyze signal as the focal sentence + session length.
// Both lines hide if their data is missing — first turn of a brand-new
// session may end before /analyze ever returns, and that's fine.
function renderReflectionSummary(signal, durationMs) {
  if (signal && $reflectSignal) {
    $reflectSignal.textContent = signal;
    $reflectSignal.style.display = '';
  }
  const mins = Math.floor(durationMs / 60000);
  if (mins >= 1 && $reflectDuration) {
    $reflectDuration.textContent = `${mins} minute${mins > 1 ? 's' : ''}`;
    $reflectDuration.style.display = '';
  }
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
const $reflectSignal = document.getElementById('reflect-signal');
const $reflectDuration = document.getElementById('reflect-duration');
const $reflectForm = document.getElementById('reflect-form');
const $reflectEmail = document.getElementById('reflect-email');
const $reflectSubmit = document.querySelector('.reflect-submit');
const $reflectTertiary = document.getElementById('reflect-tertiary');
const $reflectHome = document.getElementById('reflect-home');
const $tUser = document.getElementById('t-user');
const $tModel = document.getElementById('t-model');
const $topicsHeader = document.getElementById('topics-header');
const $modalitiesList = document.getElementById('modalities-list');
const $characterBtns = document.querySelectorAll('.character-btn[data-framework]');

// ── Modality rail ────────────────────────────────────────────────────────
// Each character has its OWN modalities list (framework.modalities) —
// Coach offers life domains, Meditation offers practice forms, Friend
// offers emotional registers. The rail is rebuilt per-character.
//
// Click sends a natural-language inject; the model treats it as user
// input (not a [CMD:] marker), so it pivots inside the character's voice.
function renderModalities(framework) {
  if (!$modalitiesList) return;
  $modalitiesList.replaceChildren();
  for (const m of framework.modalities || []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modality';
    btn.textContent = m.label;
    btn.dataset.modality = m.id;
    btn.addEventListener('click', () => selectModality(btn, m));
    $modalitiesList.appendChild(btn);
  }
}

function selectModality(btn, m) {
  if (state !== 'active' || !gemini) return;
  $modalitiesList.querySelectorAll('.modality').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  if (m.inject) {
    gemini.sendText(m.inject);
    log(`-> modality: ${m.id}`);
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────
// Each character button is its own session-start path — picking the
// character IS the begin. The user's NEED is the entry point, not the
// framework as a feature toggle.
$characterBtns.forEach((b) => {
  b.addEventListener('click', () => activate(b.dataset.framework));
});
document.getElementById('end-session').addEventListener('click', endSession);
$reflectForm.addEventListener('submit', onReflectionSubmit);
// Start another → re-enters the same character the previous session used
$reflectTertiary.addEventListener('click', () => activate(_lastFrameworkId));
$reflectHome.addEventListener('click', dismissReflection);
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
