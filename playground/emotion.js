// ── Emotion: streaming speech-emotion-recognition WebSocket client ──────
// Wraps the Modal-hosted audeering wav2vec2 emotion endpoint.
// Input:  raw 16kHz int16 PCM chunks (ArrayBuffer). Server buffers a 1.0s
//         window and slides 0.5s, so predictions land at ~2/sec.
// Output: JSON {emotion, intensity, arousal, valence, dominance, ts}
//         where emotion is one of: joy | trust | fear | surprise |
//         sadness | disgust | anger | anticipation | neutral.

const ENDPOINT = 'wss://gokhan--ojaq-emotion-emotionclassifier-web.modal.run/ws';

export class EmotionConnection {
  constructor() {
    this._ws = null;
    this._state = 'idle'; // idle | connecting | open | closed
    this.onOpen = null;     // () => void
    this.onEmotion = null;  // ({emotion, intensity, arousal, valence, dominance, ts}) => void
    this.onClose = null;    // (code, reason) => void
    this.onError = null;    // (err) => void
  }

  get state() { return this._state; }
  get isOpen() { return this._state === 'open'; }

  connect() {
    if (this._ws) return;
    this._state = 'connecting';
    try {
      this._ws = new WebSocket(ENDPOINT);
      this._ws.binaryType = 'arraybuffer';
    } catch (err) {
      this._state = 'closed';
      this.onError?.(err);
      return;
    }

    this._ws.onopen = () => {
      this._state = 'open';
      this.onOpen?.();
    };

    this._ws.onmessage = (ev) => {
      try {
        const data = typeof ev.data === 'string' ? JSON.parse(ev.data) : null;
        if (data && typeof data === 'object' && data.emotion) {
          this.onEmotion?.(data);
        }
      } catch (err) {
        this.onError?.(err);
      }
    };

    this._ws.onclose = (ev) => {
      this._state = 'closed';
      this.onClose?.(ev.code, ev.reason);
    };

    this._ws.onerror = (err) => {
      this.onError?.(err);
    };
  }

  sendPcm(buf) {
    if (this._state !== 'open' || !this._ws) return false;
    try {
      this._ws.send(buf);
      return true;
    } catch (err) {
      this.onError?.(err);
      return false;
    }
  }

  close() {
    if (!this._ws) return;
    try { this._ws.close(); } catch {}
    this._ws = null;
    this._state = 'closed';
  }
}
