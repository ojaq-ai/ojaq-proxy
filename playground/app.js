// ── Ojaq Playground — Main Orchestrator ─────────────────────────────────

import { FRAMEWORKS, assemblePrompt } from './frameworks.js';
import { GeminiConnection } from './gemini.js';
import { MicCapture, AudioPlayer, arrayBufToBase64 } from './audio.js';
import { Avatar } from './avatar.js';
import { SessionConductor } from './conductor.js';
import { mapEmotion, PresenceHistory } from './presence.js';

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
let avatar = null;
let conductor = null;
let presenceHistory = new PresenceHistory(20);
let running = false;
let timerInterval = null;
let sessionId = null;
let turnCount = 0;

// ── logging ─────────────────────────────────────────────────────────────
function log(msg) { console.log(`[ojaq] ${msg}`); }

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

// ── i18n strings ────────────────────────────────────────────────────────
const I18N = {
  en: {
    cta: 'Want to continue this?',
    sub: "The mobile app is where Ojaq goes deeper. I'll email you when it's ready.",
    fbPlaceholder: 'Anything you want me to know? (optional)',
    success: "You're in. I'll find you when it's ready.",
    thanks: 'Thank you.',
    expTitle: "You've spent time with Ojaq today.",
    expSub: "The mobile app is where it goes deeper. I'll find you when it's ready.",
    minutes: (n) => `${n} minute${n > 1 ? 's' : ''}`,
  },
  tr: {
    cta: 'Devam etmek ister misin?',
    sub: "Mobil uygulama, Ojaq'in daha derine indigi yer. Hazir oldugunda sana yazarim.",
    fbPlaceholder: 'Bana soylemek istedigin bir sey var mi? (istege bagli)',
    success: 'Listeye girdin. Hazir oldugunda seni bulurum.',
    thanks: 'Tesekkur ederim.',
    expTitle: "Bugun Ojaq ile zaman gecirdin.",
    expSub: "Mobil uygulama, Ojaq'in daha derine indigi yer. Hazir oldugunda seni bulurum.",
    minutes: (n) => `${n} dakika`,
  },
  de: {
    cta: 'Mochtest du das fortsetzen?',
    sub: 'Die mobile App ist der Ort, an dem Ojaq tiefer geht. Ich schreibe dir, wenn sie bereit ist.',
    fbPlaceholder: 'Mochtest du mir etwas mitteilen? (optional)',
    success: 'Du bist dabei. Ich melde mich, wenn es soweit ist.',
    thanks: 'Danke.',
    expTitle: 'Du hast heute Zeit mit Ojaq verbracht.',
    expSub: 'Die mobile App ist der Ort, an dem Ojaq tiefer geht. Ich finde dich, wenn sie bereit ist.',
    minutes: (n) => `${n} Minute${n > 1 ? 'n' : ''}`,
  },
  es: {
    cta: 'Quieres continuar esto?',
    sub: 'La aplicacion movil es donde Ojaq va mas profundo. Te escribire cuando este lista.',
    fbPlaceholder: 'Algo que quieras decirme? (opcional)',
    success: 'Estas dentro. Te encontrare cuando este lista.',
    thanks: 'Gracias.',
    expTitle: 'Has pasado tiempo con Ojaq hoy.',
    expSub: 'La aplicacion movil es donde va mas profundo. Te encontrare cuando este lista.',
    minutes: (n) => `${n} minuto${n > 1 ? 's' : ''}`,
  },
  fr: {
    cta: 'Veux-tu continuer?',
    sub: "L'application mobile, c'est la ou Ojaq va plus loin. Je t'ecrirai quand elle sera prete.",
    fbPlaceholder: 'Quelque chose a me dire? (facultatif)',
    success: "Tu es sur la liste. Je te retrouverai quand ce sera pret.",
    thanks: 'Merci.',
    expTitle: "Tu as passe du temps avec Ojaq aujourd'hui.",
    expSub: "L'application mobile, c'est la ou ca va plus loin. Je te retrouverai quand ce sera pret.",
    minutes: (n) => `${n} minute${n > 1 ? 's' : ''}`,
  },
};

const t = I18N[langBase] || I18N.en;

// ── avatar init ─────────────────────────────────────────────────────────
avatar = new Avatar(document.getElementById('avatar-canvas'));

// ── framework tabs ──────────────────────────────────────────────────────
function renderTabs() {
  $tabs.innerHTML = '';
  for (const fw of Object.values(FRAMEWORKS)) {
    const btn = document.createElement('button');
    btn.textContent = fw.name;
    btn.className = fw.id === currentFramework.id ? 'active' : '';
    btn.style.borderColor = fw.id === currentFramework.id ? fw.color : '';
    btn.addEventListener('click', () => {
      if (running) stop();
      currentFramework = fw;
      renderTabs();
    });
    $tabs.appendChild(btn);
  }
}
renderTabs();

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
  // Only send the last command of each type — skip stale ones
  const last = cmdQueue[cmdQueue.length - 1];
  cmdQueue = [];
  gemini.sendText(last);
  log(`-> ${last}`);
}

// ── async presence analysis — runs parallel, never blocks voice ──────────
async function analyzePresence(userText, modelText) {
  try {
    const resp = await fetch('/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: userText, model: modelText }),
    });
    if (!resp.ok) return;
    const p = await resp.json();
    if (p.error) return;

    presenceHistory.push(p);
    avatar.setPresence(p);
    // Conductor updates UI only — never sends text to model automatically
    if (conductor) conductor.onPresence(p, () => {});

    const { emotion, intensity } = mapEmotion(p);
    // emotion label removed from UI
    if (p.signal) $signal.textContent = p.signal;
    updateBars();
    log(`presence ${emotion} ${intensity} | e=${p.energy} c=${p.confidence} r=${p.resistance} eng=${p.engagement} cong=${p.congruence} s=${p.sentiment}`);
    if (p.signal) log(`signal: ${p.signal}`);

    // Log turn for analytics
    turnCount++;
    fetch('/session/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId, user: userText, model: modelText,
        presence: p, emotion,
      }),
    }).catch(() => {});
  } catch (e) {
    // Presence analysis failed — don't interrupt anything
  }
}

// ── start / stop ────────────────────────────────────────────────────────
async function start() {
  $btn.disabled = true;
  log(`starting ${currentFramework.name} session...`);

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
      $tModel.textContent = lastModelText;
    };

    gemini.onTurnComplete = () => {
      modelSpeaking = false;
      flushCmdQueue();
      // Fire async presence analysis with full turn text
      if (lastUserText) {
        analyzePresence(lastUserText, lastModelText);
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
    mic = new MicCapture((buf) => gemini.sendAudio(arrayBufToBase64(buf)));
    await mic.start();
    log('mic active');

    // go
    running = true;
    turnCount = 0;
    $btnIcon.innerHTML = '&#9632;';
    $btnText.textContent = 'End Session';
    $btn.classList.add('stop');

    // log session start (with rate limit check)
    try {
      const r = await fetch('/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ framework: currentFramework.id }),
      });
      if (r.status === 429) {
        stop();
        showExperiencedState();
        return;
      }
      const d = await r.json();
      sessionId = d.session_id;
    } catch {};
    setControlsEnabled(true);
    timerInterval = setInterval(updateTimer, 1000);

    // opening greeting — small delay to ensure WS is fully ready
    setTimeout(() => {
      sendCmd(`[CMD:lang:${langBase}]`);
      sendCmd('[CMD:start]');
    }, 300);

  } catch (err) {
    log(`start failed: ${err.message}`);
    stop();
  } finally {
    $btn.disabled = false;
  }
}

function stop() {
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
  mic?.stop(); mic = null;
  player?.stop(); player = null;
  gemini?.close(); gemini = null;
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
  const $note = document.getElementById('reflect-wl-note');
  const $fb = document.getElementById('reflect-fb');

  // Duration: skip under 60s
  const mins = Math.floor(durationMs / 60000);
  if (mins >= 1) {
    $dur.textContent = t.minutes(mins);
    $dur.style.display = '';
  } else {
    $dur.style.display = 'none';
  }

  // Set i18n copy
  const cta = $ref.querySelector('.reflect-cta');
  const sub = $ref.querySelector('.reflect-sub');
  if (cta) cta.textContent = t.cta;
  if (sub) sub.textContent = t.sub;
  $fb.placeholder = t.fbPlaceholder;

  // Signal: skip if empty
  if (lastSignal.trim()) {
    $sig.textContent = lastSignal;
    $sig.style.display = '';
  } else {
    $sig.style.display = 'none';
  }

  // Reset fields
  $email.value = '';
  $note.textContent = '';
  $fb.value = '';
  $ref.style.display = 'flex';

  // Hide controls + sidebar during reflection
  document.getElementById('controls').style.display = 'none';
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('tabs').style.display = 'none';
  document.getElementById('overlay').style.display = 'none';

  // Waitlist email — submit on Enter
  $email.onkeydown = async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const email = $email.value.trim();
    if (!email) return;

    const sent = JSON.parse(localStorage.getItem('ojaq_wl_sent') || '[]');
    if (sent.includes(email.toLowerCase())) {
      $note.textContent = "You're already on the list.";
      return;
    }

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
        $note.textContent = t.success;
        // Log action
        fetch('/session/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: endSessionId, action: 'waitlist' }),
        }).catch(() => {});
      }
    } catch {
      $note.textContent = 'Something went wrong. Try again.';
    }
  };

  // Feedback — submit on Enter or blur if has content
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
      $fb.placeholder = t.thanks;
      setTimeout(() => { $fb.placeholder = t.fbPlaceholder; }, 4000);
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

// ── experienced state (rate limited) ─────────────────────────────────────
function showExperiencedState() {
  // Hide normal UI
  document.getElementById('controls').style.display = 'none';
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('tabs').style.display = 'none';
  document.getElementById('overlay').style.display = 'none';

  // Settle orbs to calm idle
  avatar.settleToRest(2500);

  // Show reflection screen with rate-limit copy
  const $ref = document.getElementById('reflection');
  const $dur = document.getElementById('reflect-duration');
  const $sig = document.getElementById('reflect-signal');
  const $email = document.getElementById('reflect-email');
  const $note = document.getElementById('reflect-wl-note');
  const $fb = document.getElementById('reflect-fb');

  $dur.style.display = 'none';
  $sig.style.display = 'none';

  // Override waitlist copy
  const cta = $ref.querySelector('.reflect-cta');
  const sub = $ref.querySelector('.reflect-sub');
  if (cta) cta.textContent = t.expTitle;
  if (sub) sub.textContent = t.expSub;

  $email.value = '';
  $note.textContent = '';
  $fb.value = '';
  $fb.placeholder = t.fbPlaceholder;
  $ref.style.display = 'flex';

  // Email — submit on Enter
  $email.onkeydown = async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const email = $email.value.trim();
    if (!email) return;

    const sent = JSON.parse(localStorage.getItem('ojaq_wl_sent') || '[]');
    if (sent.includes(email.toLowerCase())) {
      $note.textContent = "You're already on the list.";
      return;
    }

    try {
      const r = await fetch('/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source: 'rate_limit' }),
      });
      const d = await r.json();
      if (d.ok) {
        sent.push(email.toLowerCase());
        localStorage.setItem('ojaq_wl_sent', JSON.stringify(sent));
        $email.style.display = 'none';
        $note.textContent = t.success;
      }
    } catch {
      $note.textContent = 'Something went wrong. Try again.';
    }
  };

  // Feedback
  const submitFb = async () => {
    const text = $fb.value.trim();
    if (!text) return;
    try {
      await fetch('/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, duration_s: 0, framework: 'rate_limit' }),
      });
      $fb.value = '';
      $fb.placeholder = t.thanks;
      setTimeout(() => { $fb.placeholder = t.fbPlaceholder; }, 4000);
    } catch {}
  };
  $fb.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submitFb(); } };
  $fb.onblur = () => submitFb();
}

// ── page load: check rate limit status before showing UI ────────────────
function showNormalUI() {
  document.getElementById('tabs').style.display = '';
  document.getElementById('sidebar').style.display = '';
  document.getElementById('controls').style.display = '';
}

(async () => {
  try {
    const r = await fetch('/session/status');
    const d = await r.json();
    if (d.sessions_remaining === 0) {
      showExperiencedState();
    } else {
      showNormalUI();
    }
  } catch {
    // If status check fails, show normal UI as fallback
    showNormalUI();
  }
})();

log('playground ready');
