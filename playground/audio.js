// ── Audio: mic capture + gapless playback — from test_browser/index.html ─

const SAMPLE_RATE = 24000;

const WORKLET_CODE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const targetRate = opts.targetRate || 24000;
    const bufSize = opts.bufSize || 1200;
    this._buf = new Int16Array(bufSize);
    this._bufSize = bufSize;
    this._len = 0;
    this._ratio = sampleRate / targetRate;
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
        if (this._len >= this._bufSize) {
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
  constructor(onChunk24k, onChunk16k) {
    this.onChunk24k = onChunk24k;         // (ArrayBuffer) => void — 24kHz PCM for Gemini
    this.onChunk16k = onChunk16k || null; // (ArrayBuffer) => void — 16kHz PCM for Sortformer (optional)
    this._stream = null;
    this._ctx = null;
    this._node24 = null;
    this._node16 = null;
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

    this._node24 = new AudioWorkletNode(this._ctx, 'pcm-capture', {
      processorOptions: { targetRate: 24000, bufSize: 1200 },
    });
    this._node24.port.onmessage = (e) => this.onChunk24k(e.data);
    src.connect(this._node24);

    if (this.onChunk16k) {
      this._node16 = new AudioWorkletNode(this._ctx, 'pcm-capture', {
        processorOptions: { targetRate: 16000, bufSize: 1600 },
      });
      this._node16.port.onmessage = (e) => this.onChunk16k(e.data);
      src.connect(this._node16);
    }
  }

  stop() {
    this._node24?.disconnect();
    this._node16?.disconnect();
    this._ctx?.close();
    this._stream?.getTracks().forEach(t => t.stop());
    this._node24 = null; this._node16 = null; this._ctx = null; this._stream = null;
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
