// ── Ojaq Playground — Main Orchestrator ─────────────────────────────────

import { FRAMEWORKS, assemblePrompt } from './frameworks.js';
import { GeminiConnection } from './gemini.js';
import { MicCapture, AudioPlayer, arrayBufToBase64 } from './audio.js';
import { Avatar } from './avatar.js';
import { SessionConductor } from './conductor.js';
import { extractPresence, mapEmotion, PresenceHistory } from './presence.js';

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
let textBuf = '';
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
function drawSparklines() {
  document.querySelectorAll('.spark').forEach(el => {
    const dim = el.dataset.dim;
    const canvas = el.querySelector('.spark-canvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const data = presenceHistory.series(dim);
    if (data.length < 2) return;

    ctx.beginPath();
    ctx.strokeStyle = currentFramework.color + '88';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < data.length; i++) {
      const x = (i / (data.length - 1)) * w;
      const y = h - (data[i] / 100) * h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
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

// ── start / stop ────────────────────────────────────────────────────────
async function start() {
  $btn.disabled = true;
  log(`starting ${currentFramework.name} session...`);

  try {
    // reset state
    textBuf = '';
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
    gemini.onText = (chunk) => { textBuf += chunk; };
    gemini.onTurnComplete = () => {
      if (textBuf) {
        const obj = extractPresence(textBuf);
        if (obj?.presence) {
          const p = obj.presence;
          presenceHistory.push(p);
          avatar.setPresence(p);
          conductor.onPresence(p, sendCmd);

          const { emotion, intensity } = mapEmotion(p);
          $emotionName.textContent = emotion;
          $emotionVal.textContent = intensity;
          if (p.signal) $signal.textContent = p.signal;
          if (obj.transcript) $tUser.textContent = obj.transcript;
          drawSparklines();
          log(`presence ${emotion} ${intensity} | ${p.signal || ''}`);
        }
        textBuf = '';
      }
    };
    gemini.onInterrupted = () => {
      player.clear();
      log('interrupted');
    };
    gemini.onInputTranscript = (t) => { $tUser.textContent = t; };
    gemini.onOutputTranscript = (t) => { $tModel.textContent = t; };
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

    // opening greeting
    sendCmd('[CMD:start]');

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
  textBuf = '';
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
