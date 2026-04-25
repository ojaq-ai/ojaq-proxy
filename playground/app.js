// ── Ojaq Playground — Main Orchestrator ─────────────────────────────────

import { FRAMEWORKS, assemblePrompt } from './frameworks.js';
import { GeminiConnection } from './gemini.js';
import { MicCapture, AudioPlayer, arrayBufToBase64 } from './audio.js';
import { SortformerConnection } from './sortformer.js';
import { Avatar } from './avatar.js';
import { SessionConductor } from './conductor.js';
import { mapEmotion, PresenceHistory } from './presence.js';
import * as billing from './billing.js';

// ── DOM ─────────────────────────────────────────────────────────────────
const $tabs       = document.getElementById('tabs');
const $btn        = document.getElementById('btn');
const $btnIcon    = document.getElementById('btn-icon');
const $btnText    = document.getElementById('btn-text');
const $quickCmds  = document.getElementById('quick-cmds');
// emotion label removed from UI — orbs are the sole visualization
const $signal     = document.getElementById('signal');
const $tUser      = document.getElementById('t-user');
const $tModel     = document.getElementById('t-model');
const $timer      = document.getElementById('timer');

// ── state ───────────────────────────────────────────────────────────────
let currentFramework = FRAMEWORKS.coaching;
let gemini = null;
let mic = null;
let player = null;
let sortformer = null;
let sortformerDropLogged = false;
let sortformerReady = false;
let lastEmittedSpeaker = null;
let candidateSpeaker = null;
let candidateFrames = 0;
let lastSortformerSpeechMs = 0; // timestamp of last non-trivial Sortformer activity (max prob >= 0.3)
const SPEAKER_COLORS = ['#c9a0c9', '#a0c9c9', '#c9c9a0', '#c9b0a0'];
let avatar = null;
let conductor = null;
let presenceHistory = new PresenceHistory(20);
let running = false;
let timerInterval = null;
let startupTimer = null;
let sessionId = null;
let turnCount = 0;
let wakeLock = null;

// ── logging ─────────────────────────────────────────────────────────────
function log(msg) { console.log(`[ojaq] ${msg}`); }

// ── screen wake lock — prevents mobile sleep from freezing a live session ──
async function requestWakeLock() {
  try {
    if (!('wakeLock' in navigator)) { log('wake lock API not supported'); return; }
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => log('wake lock released'));
  } catch (err) {
    log(`wake lock failed: ${err.message}`);
  }
}

// iOS Safari auto-releases the wake lock on tab visibility change; re-request on return
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running) requestWakeLock();
});

// ── language detection ──────────────────────────────────────────────────
function detectLanguage() {
  const nav = (navigator.language || '').trim();
  if (!nav) return 'en-US';

  // Already has region: "tr-TR", "en-GB", "ja-JP"
  if (nav.includes('-') && nav.length >= 4) return nav;

  // Map bare language codes to sensible default regions
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
const presenceMode = new URLSearchParams(location.search).get('presence')
  || localStorage.getItem('ojaq_presence')
  || 'off';
let speakersActive = (new URLSearchParams(location.search).get('speakers')
  || localStorage.getItem('ojaq_speakers')
  || '0') === '1';

const frameworkParam = new URLSearchParams(location.search).get('framework')
  || localStorage.getItem('ojaq_framework');
if (frameworkParam && FRAMEWORKS[frameworkParam]) {
  currentFramework = FRAMEWORKS[frameworkParam];
}
// Two-person frameworks imply Sortformer — auto-activate even if URL omits ?speakers=1
const SPEAKER_FRAMEWORKS = new Set(['together', 'meet']);
if (SPEAKER_FRAMEWORKS.has(currentFramework.id)) speakersActive = true;

// ── avatar init ─────────────────────────────────────────────────────────
avatar = new Avatar(document.getElementById('avatar-canvas'));

// ── sortformer pre-warm / teardown helpers ──────────────────────────────
function prewarmSortformer() {
  if (sortformer) return;
  sortformer = new SortformerConnection();
  sortformer.onOpen = () => {
    sortformerReady = true;
    log('[sortformer] warmed');
    if (!running) updateStartButton();
  };
  sortformer.connect();
  log('[sortformer] pre-warming…');
  updateStartButton();
}

function teardownSortformer() {
  sortformer?.close(); sortformer = null;
  sortformerReady = false;
  avatar?.setSpeakerColor(null);
  lastEmittedSpeaker = null; candidateSpeaker = null; candidateFrames = 0;
  lastSortformerSpeechMs = 0;
  if (!running) updateStartButton();
}

// Reflect pre-warm state on the pre-session button. No-op while a session is active.
function updateStartButton() {
  if (running) return;
  if (speakersActive && sortformer && !sortformerReady) {
    $btn.disabled = true;
    $btnText.textContent = 'Preparing...';
  } else {
    $btn.disabled = false;
    $btnText.textContent = 'Start Session';
  }
}

function syncUrl() {
  const params = new URLSearchParams(location.search);
  if (currentFramework.id !== 'coaching') params.set('framework', currentFramework.id);
  else params.delete('framework');
  if (speakersActive) params.set('speakers', '1');
  else params.delete('speakers');
  const qs = params.toString();
  history.replaceState(null, '', `${location.pathname}${qs ? '?' + qs : ''}${location.hash}`);
}

// ── framework tabs ──────────────────────────────────────────────────────
// Hidden from tab UI but kept defined in FRAMEWORKS for URL backwards-compat —
// /playground/?framework=therapy or ?framework=meet still loads, just with no
// visible tab to switch back to.
//   - therapy (Reflection): cut to tighten the character set; overlapped Self-Discovery
//   - meet (Ojaq Meet): paused due to instability
const HIDDEN_TAB_FRAMEWORKS = new Set(['therapy', 'meet']);

function renderTabs() {
  $tabs.innerHTML = '';
  for (const fw of Object.values(FRAMEWORKS)) {
    if (HIDDEN_TAB_FRAMEWORKS.has(fw.id)) continue;
    const btn = document.createElement('button');
    btn.textContent = fw.name;
    btn.dataset.framework = fw.id;
    btn.className = fw.id === currentFramework.id ? 'active' : '';
    btn.style.borderColor = fw.id === currentFramework.id ? fw.color : '';
    btn.addEventListener('click', () => {
      if (fw.id === currentFramework.id) return;
      if (running) stop();
      const wasSpeakerFw = SPEAKER_FRAMEWORKS.has(currentFramework.id);
      const isSpeakerFw = SPEAKER_FRAMEWORKS.has(fw.id);
      currentFramework = fw;
      if (isSpeakerFw) {
        speakersActive = true;
        prewarmSortformer(); // no-op if already open — keeps WS warm across together↔meet switch
      } else if (wasSpeakerFw) {
        speakersActive = false;
        teardownSortformer();
      }
      syncUrl();
      renderTabs();
    });
    $tabs.appendChild(btn);
  }
}
renderTabs();

// Pre-warm on URL-direct load to a two-person framework (or explicit ?speakers=1) — cold-start overlaps with page read
if (speakersActive) prewarmSortformer();

// ── sparklines ──────────────────────────────────────────────────────────
// Dimension-specific colors
const DIM_COLORS = {
  energy:     '#e8c87a',
  confidence: '#88dd99',
  resistance: '#ff6b6b',
  engagement: '#88bbdd',
  congruence: '#b8a0ff',
};

function updateBars() {
  const latest = presenceHistory.entries[presenceHistory.entries.length - 1];
  if (!latest) return;

  document.querySelectorAll('.bar').forEach(el => {
    const dim = el.dataset.dim;
    const val = latest[dim] ?? 0;
    const fill = el.querySelector('.bar-fill');
    const color = DIM_COLORS[dim] || currentFramework.color;

    fill.style.width = `${val}%`;
    fill.style.background = color;
    fill.style.boxShadow = val > 50 ? `0 0 ${Math.round(val / 4)}px ${color}55` : 'none';
  });
}

// ── timer ───────────────────────────────────────────────────────────────
function updateTimer() {
  if (!conductor) return;
  const s = Math.floor(conductor.elapsed / 1000);
  const m = Math.floor(s / 60);
  $timer.textContent = `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ── send command helper ─────────────────────────────────────────────────
let cmdQueue = [];
let modelSpeaking = false;

function sendCmd(text) {
  if (!gemini || !text) return;
  if (modelSpeaking) {
    // Queue it — don't interrupt mid-speech
    cmdQueue.push(text);
    return;
  }
  gemini.sendText(text);
  log(`-> ${text}`);
}

function flushCmdQueue() {
  if (!gemini || cmdQueue.length === 0) return;
  // Dedupe by verb type — keep most recent of each.
  // Verbs: speaker, speakers, phase, focus, lang, start, ...
  const byVerb = new Map();
  for (const cmd of cmdQueue) {
    const match = cmd.match(/^\[CMD:([^:\]]+)/);
    const verb = match ? match[1] : cmd;
    byVerb.set(verb, cmd); // Map preserves insertion order; overwrite keeps latest
  }
  cmdQueue = [];
  for (const cmd of byVerb.values()) {
    gemini.sendText(cmd);
    log(`-> ${cmd}`);
  }
}

// ── async presence analysis — runs parallel, never blocks voice ──────────
async function analyzePresence(userText, modelText) {
  let p = null;
  let emotion = '';

  // Presence pipeline — only when mode != 'off'
  if (presenceMode !== 'off') {
    try {
      const resp = await fetch('/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: userText, model: modelText }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (!data.error) p = data;
      }
    } catch (e) {
      // Presence analysis failed — don't interrupt anything
    }

    if (p) {
      presenceHistory.push(p);
      avatar.setPresence(p);
      // Conductor callback: gated by presenceMode — 'on' sends to model, 'dry' logs, else no-op
      const conductorCallback =
        presenceMode === 'on'  ? sendCmd :
        presenceMode === 'dry' ? (cmd) => log(`[presence-dry] ${cmd}`) :
                                 () => {};
      if (conductor) conductor.onPresence(p, conductorCallback);

      const { emotion: mappedEmotion, intensity } = mapEmotion(p);
      emotion = mappedEmotion;
      // emotion label removed from UI
      if (p.signal) $signal.textContent = p.signal;
      updateBars();
      log(`presence ${emotion} ${intensity} | e=${p.energy} c=${p.confidence} r=${p.resistance} eng=${p.engagement} cong=${p.congruence} s=${p.sentiment}`);
      if (p.signal) log(`signal: ${p.signal}`);
    }
  }

  // Turn analytics — always fires, regardless of presenceMode
  turnCount++;
  fetch('/session/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId, user: userText, model: modelText,
      presence: p, emotion,
    }),
  }).catch(() => {});
}

// ── start / stop ────────────────────────────────────────────────────────
async function start() {
  $btn.disabled = true;
  log(`starting ${currentFramework.name} session...`);

  // Pre-flight credit check — for authed users with 0 credits and no evergreen,
  // show the paywall before doing any expensive setup (gemini connect, mic init).
  // Server-side /session/start returns 402 as the safety net for race conditions.
  const userState = billing.getState();
  if (userState && !userState.evergreenActive && (userState.credits ?? 0) <= 0) {
    log('pre-flight: authed but no credits — showing paywall');
    billing.showPaywall({ allowLogin: false });
    $btn.disabled = false;
    return;
  }

  try {
    // reset state
    presenceHistory = new PresenceHistory(20);

    // conductor
    conductor = new SessionConductor(currentFramework);
    conductor.onChange(({ phase, mode, depth }) => {
      // phase/mode tracked internally, avatar reflects it
      avatar.setMode(mode);
      avatar.setDepth(depth);
    });

    // gemini
    gemini = new GeminiConnection();
    gemini.onAudio = (b64) => { modelSpeaking = true; player.play(b64); };

    // Track transcripts — accumulate incremental deltas per turn
    let lastUserText = '';
    let lastModelText = '';
    gemini.onInputTranscript = (t) => {
      lastUserText += t;
      $tUser.textContent = lastUserText;
    };
    gemini.onOutputTranscript = (t) => {
      lastModelText += t;
      // Strip any leaked [CMD:*] markers before display and before anything downstream (/analyze, /session/turn) sees them
      lastModelText = lastModelText.replace(/\[CMD:[^\]]*\]/g, '').trim();
      $tModel.textContent = lastModelText;
    };

    gemini.onTurnComplete = () => {
      modelSpeaking = false;
      flushCmdQueue();
      // Fire async presence analysis with full turn text
      if (lastUserText) {
        analyzePresence(lastUserText, lastModelText);
      }
      // Re-assert current dominant speaker so Gemini's context doesn't drift
      // during long replies. THREE gates:
      //   1) lastUserText — rules out spurious turnCompletes with empty transcripts.
      //   2) lastEmittedSpeaker — skip until Sortformer has confirmed at least one speaker.
      //   3) Sortformer activity within last 3s — rules out cases where Gemini's ASR
      //      transcribes ambient noise as a short string (non-empty text but no real speech).
      const recentSpeech = Date.now() - lastSortformerSpeechMs < 3000;
      if (lastUserText && lastEmittedSpeaker !== null && recentSpeech) {
        sendCmd(`[CMD:speaker:${lastEmittedSpeaker}]`);
        log(`[speaker] turn-reassertion -> ${lastEmittedSpeaker}`);
      }
      // Reset for next turn
      lastUserText = '';
      lastModelText = '';
    };
    gemini.onInterrupted = () => {
      modelSpeaking = false;
      cmdQueue = [];
      player.clear();
    };
    gemini.onGoAway = (t) => log(`goAway: ${t}`);
    gemini.onClose = (code, reason) => {
      log(`ws closed ${code} ${reason || ''}`);
      if (running) stop();
    };

    const prompt = assemblePrompt(currentFramework);
    await gemini.connect(prompt, [], userLanguage);
    log(`language: ${userLanguage}`);
    log('session ready');

    // audio
    player = new AudioPlayer();
    player.init();

    // Optional: Sortformer diarization tap — non-blocking, fire-and-forget connect.
    // 16kHz PCM chunks are dropped silently until the WS opens.
    let onChunk16k = null;
    if (speakersActive) {
      sortformerDropLogged = false;
      if (!sortformer) sortformer = new SortformerConnection();
      sortformer.onOpen = () => { sortformerReady = true; log('[sortformer] connected'); };
      sortformer.onProbs = (probs) => {
        log(`[sortformer] probs=[${probs.map(p => p.toFixed(3)).join(', ')}]`);
        // Debounced argmax → [CMD:speaker:N] on confident change
        let maxIdx = 0, maxVal = probs[0] ?? 0;
        for (let i = 1; i < probs.length; i++) {
          if (probs[i] > maxVal) { maxVal = probs[i]; maxIdx = i; }
        }
        // Track any non-trivial speech activity (below the 0.65 confident-change threshold but above true silence)
        // so the onTurnComplete re-assertion gate can tell if someone's actually been speaking recently.
        if (maxVal >= 0.3) lastSortformerSpeechMs = Date.now();
        if (maxVal < 0.65) return;
        if (maxIdx === candidateSpeaker) {
          candidateFrames++;
        } else {
          candidateSpeaker = maxIdx;
          candidateFrames = 1;
        }
        if (candidateFrames >= 3 && candidateSpeaker !== lastEmittedSpeaker) {
          sendCmd(`[CMD:speaker:${candidateSpeaker}]`);
          avatar.setSpeakerColor(SPEAKER_COLORS[candidateSpeaker]);
          log(`[speaker] sortformer-change -> ${candidateSpeaker}`);
          lastEmittedSpeaker = candidateSpeaker;
        }
      };
      sortformer.onClose = (code, reason) => {
        log(`[sortformer] closed ${code} ${reason || ''}`);
        // Clear speaker state — a stale lastEmittedSpeaker after WS drop would cause
        // per-turn re-assertions to fire [CMD:speaker:N] for a speaker no longer tracked.
        sortformerReady = false;
        lastEmittedSpeaker = null;
        candidateSpeaker = null;
        candidateFrames = 0;
        lastSortformerSpeechMs = 0;
        avatar?.setSpeakerColor(null);
      };
      sortformer.onError = (err) => log(`[sortformer] error: ${err?.message || err}`);
      sortformer.connect();
      onChunk16k = (buf) => {
        if (!sortformer?.isOpen) {
          if (!sortformerDropLogged) { log('[sortformer] dropping pcm — ws not open yet'); sortformerDropLogged = true; }
          return;
        }
        sortformer.sendPcm(buf);
      };
    }

    mic = new MicCapture((buf) => gemini.sendAudio(arrayBufToBase64(buf)), onChunk16k);
    await mic.start();
    log('mic active');

    // go
    running = true;
    turnCount = 0;
    billing.setSessionActive(true); // hide account chip during the session
    await requestWakeLock();
    $btnIcon.innerHTML = '&#9632;';
    $btnText.textContent = 'End Session';
    $btn.classList.add('stop');

    // log session start (with rate limit + paywall checks)
    try {
      const r = await fetch('/session/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ framework: currentFramework.id }),
      });
      if (r.status === 429) {
        // Unauthed + IP rate limited — paywall with login option
        stop();
        billing.showPaywall({ allowLogin: true });
        return;
      }
      if (r.status === 402) {
        // Authed but no credits — paywall, no login option
        stop();
        billing.showPaywall({ allowLogin: false });
        return;
      }
      const d = await r.json();
      sessionId = d.session_id;
    } catch {};
    setControlsEnabled(true);
    timerInterval = setInterval(updateTimer, 1000);

    // Fire-and-forget credit deduct for authed users (unauthed users use IP rate limit instead)
    billing.deductCredit().catch(() => {});

    // opening greeting — small delay to ensure WS is fully ready
    startupTimer = setTimeout(() => {
      sendCmd(`[CMD:lang:${langBase}]`);
      sendCmd('[CMD:start]');
      startupTimer = null;
    }, 300);

  } catch (err) {
    log(`start failed: ${err.message}`);
    stop();
  } finally {
    $btn.disabled = false;
  }
}

function stop() {
  // Reset session-lifecycle flags FIRST — if stop() was called mid-speech,
  // a stale modelSpeaking=true would cause next session's [CMD:start] to
  // be silently queued instead of sent.
  modelSpeaking = false;
  cmdQueue = [];
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }

  wakeLock?.release();
  wakeLock = null;
  const lastSignal = $signal.textContent || '';
  const durationMs = conductor?.elapsed || 0;
  const frameworkId = currentFramework.id;
  const hadTurns = turnCount > 0;
  const endSessionId = sessionId;

  // Log session end
  if (endSessionId && conductor) {
    fetch('/session/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: endSessionId,
        duration_ms: durationMs,
        turns: turnCount,
        framework: frameworkId,
      }),
    }).catch(() => {});
  }

  sessionId = null;
  turnCount = 0;
  running = false;
  billing.setSessionActive(false); // restore account chip after the session
  mic?.stop(); mic = null;
  player?.stop(); player = null;
  gemini?.close(); gemini = null;
  teardownSortformer();
  conductor = null;
  clearInterval(timerInterval);

  $btnIcon.innerHTML = '&#9654;';
  $btnText.textContent = 'Start Session';
  $btn.classList.remove('stop');
  $tUser.textContent = '';
  $tModel.textContent = '';
  setControlsEnabled(false);
  log('stopped');

  // Show reflection if session had substance
  if (hadTurns) {
    showReflection(durationMs, lastSignal, frameworkId, endSessionId);
  }
}

function showReflection(durationMs, lastSignal, frameworkId, endSessionId) {
  // Settle orbs from wherever they are
  avatar.settleToRest(2500);

  const $ref = document.getElementById('reflection');
  const $dur = document.getElementById('reflect-duration');
  const $sig = document.getElementById('reflect-signal');
  const $email = document.getElementById('reflect-email');
  const $emailSubmit = document.getElementById('reflect-email-submit');
  const $note = document.getElementById('reflect-wl-note');
  const $fb = document.getElementById('reflect-fb');
  const $fbSubmit = document.getElementById('reflect-fb-submit');

  // Duration: skip under 60s
  const mins = Math.floor(durationMs / 60000);
  if (mins >= 1) {
    $dur.textContent = `${mins} minute${mins > 1 ? 's' : ''}`;
    $dur.style.display = '';
  } else {
    $dur.style.display = 'none';
  }

  // Signal: skip if empty
  if (lastSignal.trim()) {
    $sig.textContent = lastSignal;
    $sig.style.display = '';
  } else {
    $sig.style.display = 'none';
  }

  // Restore waitlist copy (showExperiencedState may have overwritten it in a prior render)
  const wl = document.getElementById('reflect-waitlist');
  const wlCta = wl.querySelector('.reflect-cta');
  const wlSub = wl.querySelector('.reflect-sub');
  if (wlCta) wlCta.textContent = 'Want to continue this?';
  if (wlSub) wlSub.textContent = "The mobile app is where Ojaq goes deeper. I'll email you when it's ready.";

  // Reset fields + re-show inputs/buttons in case a prior session hid them on success
  $email.value = '';
  $email.style.display = '';
  $emailSubmit.style.display = '';
  $emailSubmit.disabled = false;
  $note.textContent = '';
  $fb.value = '';
  $ref.style.display = 'flex';

  // Hide controls + sidebar during reflection
  document.getElementById('controls').style.display = 'none';
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('tabs').style.display = 'none';
  document.getElementById('overlay').style.display = 'none';

  // Waitlist email — submit on Enter or button click
  const submitEmail = async () => {
    const email = $email.value.trim();
    if (!email) return;

    const sent = JSON.parse(localStorage.getItem('ojaq_wl_sent') || '[]');
    if (sent.includes(email.toLowerCase())) {
      $note.textContent = "You're already on the list.";
      return;
    }

    $emailSubmit.disabled = true;
    try {
      const r = await fetch('/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source: 'post_session' }),
      });
      const d = await r.json();
      if (d.ok) {
        sent.push(email.toLowerCase());
        localStorage.setItem('ojaq_wl_sent', JSON.stringify(sent));
        $email.style.display = 'none';
        $emailSubmit.style.display = 'none';
        $note.textContent = "You're in. I'll find you when it's ready.";
        // Log action
        fetch('/session/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: endSessionId, action: 'waitlist' }),
        }).catch(() => {});
      } else {
        $emailSubmit.disabled = false;
      }
    } catch {
      $note.textContent = 'Something went wrong. Try again.';
      $emailSubmit.disabled = false;
    }
  };

  $email.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submitEmail(); } };
  $emailSubmit.onclick = submitEmail;

  // Feedback — submit on Enter, blur, or button click
  const submitFeedback = async () => {
    const text = $fb.value.trim();
    if (!text) return;
    try {
      await fetch('/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          duration_s: Math.round(durationMs / 1000),
          framework: frameworkId,
        }),
      });
      $fb.value = '';
      $fb.placeholder = 'Thank you.';
      setTimeout(() => { $fb.placeholder = 'What sticks with you?'; }, 4000);
      // Log action
      fetch('/session/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: endSessionId, action: 'feedback' }),
      }).catch(() => {});
    } catch {}
  };

  $fb.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submitFeedback(); } };
  $fb.onblur = () => submitFeedback();
  $fbSubmit.onclick = submitFeedback;

  // "Another session" — dismiss the overlay, restore playground chrome
  const $another = document.getElementById('reflect-another');
  $another.style.display = '';
  $another.onclick = () => {
    $ref.style.display = 'none';
    showNormalUI();
    document.getElementById('overlay').style.display = '';
    $signal.textContent = ''; // clear stale signal from prior session
  };
}

function setControlsEnabled(on) {
  $quickCmds.querySelectorAll('button').forEach(b => b.disabled = !on);
}

// ── event wiring ────────────────────────────────────────────────────────
$btn.addEventListener('click', () => running ? stop() : start());


$quickCmds.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => sendCmd(btn.dataset.cmd));
});

setControlsEnabled(false);

// ── page load: render UI, then decide whether to show paywall on top ────
function showNormalUI() {
  document.getElementById('tabs').style.display = '';
  document.getElementById('sidebar').style.display = '';
  document.getElementById('controls').style.display = '';
}

(async () => {
  // Resolve auth state first so the paywall decision below knows who's logged in
  await billing.init();

  let sessionsRemaining = null;
  try {
    const r = await fetch('/session/status');
    const d = await r.json();
    sessionsRemaining = d.sessions_remaining;
  } catch {}

  showNormalUI();

  // Page-load paywall: ONLY for unauthed users who've exhausted the IP free tier.
  // This matches the old showExperiencedState trigger — we don't want to confront
  // authed-no-credits users before they even click Start. Their paywall comes
  // from the start() pre-flight + the server's 402 fallback.
  const me = billing.getState();
  const unauthedAndExhausted = !me && sessionsRemaining === 0;
  if (unauthedAndExhausted) {
    billing.showPaywall({ allowLogin: true });
  }
})();

log('playground ready');
