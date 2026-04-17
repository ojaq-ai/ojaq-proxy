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
const $emotionName = document.getElementById('emotion-name');
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
    $emotionName.textContent = emotion;
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

    // Track transcripts for async presence analysis
    let lastUserText = '';
    let lastModelText = '';
    gemini.onInputTranscript = (t) => { $tUser.textContent = t; lastUserText = t; };
    gemini.onOutputTranscript = (t) => { $tModel.textContent = t; lastModelText = t; };

    gemini.onTurnComplete = () => {
      modelSpeaking = false;
      // Flush any queued conductor commands now that model is done
      flushCmdQueue();
      // Fire async presence analysis — never blocks voice
      if (lastUserText) {
        analyzePresence(lastUserText, lastModelText);
        lastUserText = '';
        lastModelText = '';
      }
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
    await gemini.connect(prompt);
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

    // log session start
    try {
      const r = await fetch('/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ framework: currentFramework.id }),
      });
      const d = await r.json();
      sessionId = d.session_id;
    } catch {};
    setControlsEnabled(true);
    timerInterval = setInterval(updateTimer, 1000);

    // opening greeting — small delay to ensure WS is fully ready
    setTimeout(() => sendCmd('[CMD:start]'), 300);

  } catch (err) {
    log(`start failed: ${err.message}`);
    stop();
  } finally {
    $btn.disabled = false;
  }
}

function stop() {
  // Log session end
  if (sessionId && conductor) {
    fetch('/session/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        duration_ms: conductor.elapsed,
        turns: turnCount,
        framework: currentFramework.id,
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
  $signal.textContent = '';
  $tUser.textContent = '';
  $tModel.textContent = '';
  $emotionName.textContent = 'neutral';
  setControlsEnabled(false);
  log('stopped');
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
log('playground ready');
