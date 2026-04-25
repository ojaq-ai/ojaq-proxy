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

// ── Session state ────────────────────────────────────────────────────────
let active = false;
let gemini = null;
let mic = null;
let player = null;

async function activate() {
  if (active) return;
  active = true;
  document.body.classList.add('session-active');
  log('session activating…');

  try {
    // Gemini Live WS
    gemini = new GeminiConnection();
    gemini.onAudio = (b64) => player?.play(b64);
    gemini.onInputTranscript = (t) => log(`user: ${t}`);
    gemini.onOutputTranscript = (t) => log(`ojaq: ${t}`);
    gemini.onClose = (code, reason) => {
      log(`ws closed ${code} ${reason || ''}`);
      if (active) deactivate();
    };

    const framework = FRAMEWORKS.coaching;
    const prompt = assemblePrompt(framework);
    await gemini.connect(prompt, [], 'en-US');
    log('gemini connected');

    // Audio playback + mic capture
    player = new AudioPlayer();
    player.init();
    mic = new MicCapture((buf) => gemini.sendAudio(arrayBufToBase64(buf)));
    await mic.start();
    log('mic active');

    // Trigger the opening greeting after a small delay so the WS is fully ready.
    setTimeout(() => {
      gemini?.sendText('[CMD:start]');
      log('-> [CMD:start]');
    }, 300);
  } catch (err) {
    log(`activate failed: ${err.message}`);
    deactivate();
  }
}

function deactivate() {
  if (!active) return;
  active = false;
  document.body.classList.remove('session-active');
  mic?.stop(); mic = null;
  player?.stop(); player = null;
  gemini?.close(); gemini = null;
  log('session deactivated');
}

document.getElementById('orb-trigger').addEventListener('click', activate);
document.getElementById('end-session').addEventListener('click', deactivate);

log('preview ready');
