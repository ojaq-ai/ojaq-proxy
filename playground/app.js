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
const $cmdInput   = document.getElementById('cmd-input');
const $cmdSend    = document.getElementById('cmd-send');
const $quickCmds  = document.getElementById('quick-cmds');
const $emotionName = document.getElementById('emotion-name');
const $emotionVal  = document.getElementById('emotion-val');
const $signal     = document.getElementById('signal');
const $phaseTag   = document.getElementById('phase-tag');
const $modeTag    = document.getElementById('mode-tag');
const $tUser      = document.getElementById('t-user');
const $tModel     = document.getElementById('t-model');
const $timer      = document.getElementById('timer');
const $log        = document.getElementById('log');

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

// ── logging ─────────────────────────────────────────────────────────────
function log(msg) {
  const d = document.createElement('div');
  d.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
  $log.appendChild(d);
  $log.scrollTop = $log.scrollHeight;
}

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

function drawSparklines() {
  const latest = presenceHistory.entries[presenceHistory.entries.length - 1];
  if (!latest) return;

  document.querySelectorAll('.spark').forEach(el => {
    const dim = el.dataset.dim;
    const val = latest[dim] ?? 0;
    const bar = el.querySelector('.spark-bar');
    const valEl = el.querySelector('.spark-val');
    const color = DIM_COLORS[dim] || currentFramework.color;

    bar.style.width = `${val}%`;
    bar.style.background = color;
    bar.style.boxShadow = val > 50 ? `0 0 ${val / 5}px ${color}66` : 'none';
    valEl.textContent = val;
    valEl.style.color = val > 60 ? color : 'var(--muted)';
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
function sendCmd(text) {
  if (!gemini || !text) return;
  gemini.sendText(text);
  log(`-> ${text}`);
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
    if (conductor) conductor.onPresence(p, sendCmd);

    const { emotion, intensity } = mapEmotion(p);
    $emotionName.textContent = emotion;
    $emotionVal.textContent = intensity;
    if (p.signal) $signal.textContent = p.signal;
    drawSparklines();
    log(`presence ${emotion} ${intensity} | e=${p.energy} c=${p.confidence} r=${p.resistance} eng=${p.engagement} cong=${p.congruence} s=${p.sentiment}`);
    if (p.signal) log(`signal: ${p.signal}`);
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
      $phaseTag.textContent = phase;
      $modeTag.textContent = mode;
      avatar.setMode(mode);
      avatar.setDepth(depth);
    });

    // gemini
    gemini = new GeminiConnection();
    gemini.onAudio = (b64) => player.play(b64);

    // Track transcripts for async presence analysis
    let lastUserText = '';
    let lastModelText = '';
    gemini.onInputTranscript = (t) => { $tUser.textContent = t; lastUserText = t; };
    gemini.onOutputTranscript = (t) => { $tModel.textContent = t; lastModelText = t; };

    gemini.onTurnComplete = () => {
      // Fire async presence analysis — never blocks voice
      if (lastUserText) {
        analyzePresence(lastUserText, lastModelText);
        lastUserText = '';
        lastModelText = '';
      }
    };
    gemini.onInterrupted = () => {
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
    $btn.textContent = 'Stop';
    $btn.classList.add('stop');
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
  running = false;
  mic?.stop(); mic = null;
  player?.stop(); player = null;
  gemini?.close(); gemini = null;
  conductor = null;
  clearInterval(timerInterval);

  $btn.textContent = 'Start';
  $btn.classList.remove('stop');
  $signal.textContent = '';
  $tUser.textContent = '';
  $tModel.textContent = '';
  $phaseTag.textContent = 'arrival';
  $modeTag.textContent = 'reflect';
  $emotionName.textContent = 'neutral';
  $emotionVal.textContent = '0';
  setControlsEnabled(false);
  log('stopped');
}

function setControlsEnabled(on) {
  $cmdInput.disabled = !on;
  $cmdSend.disabled = !on;
  $quickCmds.querySelectorAll('button').forEach(b => b.disabled = !on);
}

// ── event wiring ────────────────────────────────────────────────────────
$btn.addEventListener('click', () => running ? stop() : start());

$cmdSend.addEventListener('click', () => {
  const v = $cmdInput.value.trim();
  if (v) { sendCmd(v); $cmdInput.value = ''; }
});
$cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const v = $cmdInput.value.trim(); if (v) { sendCmd(v); $cmdInput.value = ''; } }
});

$quickCmds.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => sendCmd(btn.dataset.cmd));
});

setControlsEnabled(false);
log('playground ready');
