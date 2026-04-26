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
// Concierge → module hand-off — set by either:
//   (a) the room presence observer (POST /room/observe)
//   (b) a direct module-chip click during concierge
// Applied at the next turnComplete so the concierge's closing line
// has time to land before we tear down.
let _pendingTransition = null;
// Rolling dialog history fed to the room presence observer. Cleared
// when a session ends or hands off.
let _conciergeHistory = [];

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

// Per-framework body class so CSS can show framework-specific UI
// (e.g., the modules nav rail only during Concierge). Cleared on idle.
function setFrameworkClass(id) {
  // Strip any prior framework-* class
  for (const c of [...document.body.classList]) {
    if (c.startsWith('framework-')) document.body.classList.remove(c);
  }
  if (id) document.body.classList.add(`framework-${id}`);
}

async function activate(frameworkId = _lastFrameworkId || 'coaching', contextSnippet = '') {
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
  setFrameworkClass(framework.id);
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
    _conciergeHistory = [];
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
      // Strip any leaked structured marker — [CMD:...], any future
      // [XXX:...] — before display + before /analyze sees them.
      lastModelText = lastModelText.replace(/\[[A-Z_]+:[^\]]*\]/g, '').trim();
      $tModel.textContent = lastModelText;
    };
    // No tool-call handler — routing decisions come from the room
    // presence observer (POST /room/observe), not from the model.
    // The model just talks; the meta-intelligence watches and routes.
    gemini.onTurnComplete = () => {
      // Async presence — never blocks the audio path
      const u = lastUserText, m = lastModelText;
      if (u) analyzePresence(u, m);
      // Build dialog history for room observer (concierge only)
      if (framework.id === 'concierge' && u) {
        _conciergeHistory.push({ role: 'user', text: u });
        if (m) _conciergeHistory.push({ role: 'ojaq', text: m });
        observeRoom(_conciergeHistory.slice(-12));  // last 12 turns
      }
      lastUserText = '';
      lastModelText = '';
      // Concierge handed off — turn is done, do the actual transition now
      if (_pendingTransition) {
        const next = _pendingTransition;
        _pendingTransition = null;
        handoffTo(next);
      }
    };
    gemini.onClose = (code, reason) => {
      log(`ws closed ${code} ${reason || ''}`);
      if (state === 'active') endSession();
    };

    // Optional handoff context — concierge's recent dialog. Prepended
    // to the system instruction at connect time so the module picks up
    // the thread without us having to inject text mid-session (which
    // Gemini Live treats as a user message).
    let prompt = assemblePrompt(framework);
    if (contextSnippet) {
      prompt = prompt + `\n\nPRIOR CONVERSATION (the user just arrived from Concierge — pick up the thread; do NOT re-greet from zero, acknowledge what was just said and continue):\n${contextSnippet}`;
    }
    await gemini.connect(prompt, [], userLanguage);
    log(`gemini connected (lang=${userLanguage}${contextSnippet ? ', with-context' : ''})`);

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
    // Note: emotion.onSummary intentionally not wired here. The summary
    // endpoint is kept on the server (src/emotion_proxy.py) for future
    // end-of-session reflection screen analytics — that path doesn't
    // inject text into the model, so it doesn't run into the
    // Gemini-Live "every text input triggers a response" issue. Live
    // prosody coaching during the Voice character relies on the model's
    // own audio listening; injecting structured text reports forces
    // spurious model responses that no amount of prompt hardening
    // suppresses (the API responds-to-every-text by design).
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

// Room presence observer — async, runs after each Concierge turn.
// Watches the dialog and decides whether the user has agreed to enter
// a module. This is the META-intelligence: separate from the Concierge
// (who speaks) and the Avatar (who breathes). Same per-turn cadence
// as analyzePresence, never blocks the audio path.
//
// Uses module-level _lastFrameworkId rather than the activate() closure
// `framework` because observeRoom is defined at module scope; the
// closure variable isn't in its lexical scope.
async function observeRoom(history) {
  if (state !== 'active' || _lastFrameworkId !== 'concierge') return;
  // Diagnostic — dump the last 2 turns the observer is actually seeing
  const recent = history.slice(-4).map(t =>
    `${t.role === 'user' ? 'U' : 'C'}:${(t.text || '').slice(0, 60)}`
  ).join(' | ');
  log(`observe -> ${recent}`);
  try {
    const r = await fetch('/room/observe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history }),
    });
    if (!r.ok) {
      log(`observe http ${r.status}`);
      return;
    }
    const d = await r.json();
    if (d?.action === 'route' && d?.module_id && FRAMEWORKS[d.module_id]) {
      const conf = (d.confidence ?? 0).toFixed(2);
      log(`room presence: route -> ${d.module_id} (conf=${conf})`);
      _pendingTransition = d.module_id;
      handoffTo(d.module_id);
    } else if (d?.action === 'wait') {
      log('room presence: wait');
    } else {
      log(`observe unknown action: ${JSON.stringify(d)}`);
    }
  } catch (e) {
    log(`observe failed: ${e?.message || e}`);
  }
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

// Concierge → module hand-off. Ceremonial transition:
//   1. Orb hue cross-fades to target framework's color (avatar already
//      supports speakerColor tween — we hijack it as a transition tint)
//   2. Modules nav rail fades out (CSS via body class change)
//   3. Brief "going to <Module>" caption flashes
//   4. Gemini disconnects, brief beat, reconnects with new framework
//   5. Module's modality rail fades in (CSS via framework class)
// The user sees the orb stay alive throughout — the soul changes,
// not the body.
async function handoffTo(targetFrameworkId) {
  if (state !== 'active') return;
  const target = FRAMEWORKS[targetFrameworkId];
  if (!target) { log(`unknown handoff target: ${targetFrameworkId}`); return; }
  // Re-entry guard — observer may fire twice in quick succession
  if (_lastFrameworkId === targetFrameworkId) {
    log(`handoff skipped: already on ${targetFrameworkId}`);
    return;
  }
  const fromId = _lastFrameworkId || 'concierge';
  log(`handoff: ${fromId} -> ${targetFrameworkId}`);

  // Mark transition state for CSS cross-fade
  document.body.classList.add('session-transitioning');
  // Tease the target framework's hue NOW so the orb starts shifting
  // BEFORE the new connection lands — masks the audio gap.
  if (target.color) {
    avatar.setSpeakerColor(target.color, 400);
  }
  // Caption reveal — module name fades in during transition AND stays
  // visible into the first ~1.5s of the new session as an orientation cue.
  showHandoffCaption(target.name);

  // Build a context snippet from the concierge's last few turns so the
  // module picks up the thread instead of starting from zero.
  let contextSnippet = '';
  if (fromId === 'concierge' && _conciergeHistory.length) {
    contextSnippet = _conciergeHistory.slice(-6).map(t =>
      `${t.role === 'user' ? 'User' : 'Concierge'}: ${t.text}`
    ).join('\n');
  }

  teardownVoice();
  $modalitiesList?.replaceChildren();
  if ($topicsHeader) $topicsHeader.textContent = '';
  state = 'idle';

  // Snappy hold — quick beat for the visual to register, no longer
  // ceremonial. Total perceived gap is dominated by gemini.connect
  // (~600-1000ms cold), this is just the visual handshake.
  await new Promise(r => setTimeout(r, 250));

  document.body.classList.remove('session-transitioning');
  await activate(targetFrameworkId, contextSnippet);
  // Caption persists ~1.5s into the new session as orientation cue,
  // then fades. Combined with the modality rail's character pill
  // (visible immediately on activate), the user sees clearly where
  // they landed.
  setTimeout(hideHandoffCaption, 1500);
  setTimeout(() => avatar.setSpeakerColor(null, 600), 1800);
}

// Brief on-screen caption that flashes the target module name during
// the hand-off — gives the user a tactile sense of "passing through".
function showHandoffCaption(name) {
  let cap = document.getElementById('handoff-caption');
  if (!cap) {
    cap = document.createElement('div');
    cap.id = 'handoff-caption';
    document.body.appendChild(cap);
  }
  cap.textContent = name;
  // Reflow so the CSS transition triggers
  void cap.offsetWidth;
  cap.classList.add('visible');
}

function hideHandoffCaption() {
  const cap = document.getElementById('handoff-caption');
  if (cap) cap.classList.remove('visible');
}

function dismissReflection() {
  if (state !== 'reflecting') return;
  state = 'idle';
  if (reflectionRevealTimer) { clearTimeout(reflectionRevealTimer); reflectionRevealTimer = null; }
  setBodyState('idle');
  setFrameworkClass(null);           // hide modules nav etc.
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
const $reflectConcierge = document.getElementById('reflect-concierge');
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
// Enter → Concierge. The concierge then routes to a module, either via
// voice (it emits [CMD:open:<id>]) or via the user clicking a module
// chip on the side rail (handoffTo).
const $enterBtn = document.getElementById('enter-btn');
$enterBtn?.addEventListener('click', () => activate('concierge'));

// Module nav chips — visible during concierge session via CSS body class.
// Click during concierge: hand off to that module (skip voice route).
// Click outside concierge (e.g., direct deep-link): start that module
// fresh, like the old chip-grid behavior.
const $moduleChips = document.querySelectorAll('.module-chip[data-framework]');
$moduleChips.forEach((b) => {
  b.addEventListener('click', () => {
    const targetId = b.dataset.framework;
    if (state === 'active' && _lastFrameworkId === 'concierge') {
      handoffTo(targetId);
    } else {
      activate(targetId);
    }
  });
});

// Backwards-compat: if the old .character-btn[data-framework] chips are
// somewhere in the DOM (e.g. a future re-introduced grid), they still
// work as direct module activators.
$characterBtns.forEach((b) => {
  b.addEventListener('click', () => activate(b.dataset.framework));
});
document.getElementById('end-session').addEventListener('click', endSession);
$reflectForm.addEventListener('submit', onReflectionSubmit);
// Start another → re-enters the same character the previous session used
$reflectTertiary.addEventListener('click', () => activate(_lastFrameworkId));
// Talk to concierge → return to the routing front-door, pick a different module
$reflectConcierge?.addEventListener('click', () => activate('concierge'));
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
