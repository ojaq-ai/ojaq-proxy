// ── Audio: mic capture + gapless playback — from test_browser/index.html ─

const SAMPLE_RATE = 24000;

const WORKLET_CODE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Int16Array(1200);
    this._len = 0;
    this._ratio = sampleRate / ${SAMPLE_RATE};
    this._acc = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this._acc++;
      if (this._acc >= this._ratio) {
        this._acc -= this._ratio;
        const s = Math.max(-1, Math.min(1, ch[i]));
        this._buf[this._len++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        if (this._len >= 1200) {
          this.port.postMessage(this._buf.buffer.slice(0, this._len * 2));
          this._len = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

export class MicCapture {
  constructor(onChunk) {
    this.onChunk = onChunk; // (ArrayBuffer) => void
    this._stream = null;
    this._ctx = null;
    this._node = null;
  }

  async start() {
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: { ideal: 48000 }, channelCount: 1, echoCancellation: true },
    });
    this._ctx = new AudioContext({ sampleRate: 48000 });
    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await this._ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = this._ctx.createMediaStreamSource(this._stream);
    this._node = new AudioWorkletNode(this._ctx, 'pcm-capture');
    this._node.port.onmessage = (e) => this.onChunk(e.data);
    src.connect(this._node);
  }

  stop() {
    this._node?.disconnect();
    this._ctx?.close();
    this._stream?.getTracks().forEach(t => t.stop());
    this._node = null; this._ctx = null; this._stream = null;
  }
}

export class AudioPlayer {
  constructor() {
    this._ctx = null;
    this._next = 0;
  }

  init() {
    this._ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (this._ctx.state === 'suspended') this._ctx.resume();
    this._next = 0;
  }

  play(base64) {
    if (!this._ctx) return;
    const buf = b64ToArrayBuf(base64);
    const samples = new Int16Array(buf);
    if (samples.length < 4) return;
    const floats = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) floats[i] = samples[i] / 32768;
    const ab = this._ctx.createBuffer(1, floats.length, SAMPLE_RATE);
    ab.getChannelData(0).set(floats);
    const src = this._ctx.createBufferSource();
    src.buffer = ab;
    src.connect(this._ctx.destination);
    const now = this._ctx.currentTime;
    if (this._next < now) this._next = now;
    src.start(this._next);
    this._next += ab.duration;
  }

  clear() {
    this._ctx?.close();
    this.init();
  }

  stop() {
    this._ctx?.close();
    this._ctx = null;
    this._next = 0;
  }
}

export function arrayBufToBase64(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function b64ToArrayBuf(b64) {
  const bin = atob(b64);
  const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o.buffer;
}
