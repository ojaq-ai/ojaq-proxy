// ── Emotion: streaming speech-emotion-recognition WebSocket client ──────
// Connects to the same-origin /emotion-ws endpoint, which proxies to
// Hume's Expression Measurement (prosody) API on the server side. The
// Hume API key never reaches the browser — see src/emotion_proxy.py.
//
// Input:  raw 16kHz int16 PCM chunks (ArrayBuffer). Server buffers a
//         3s window before each Hume call.
// Output: JSON {emotion, intensity, raw_emotion, raw_score} — only
//         delivered when intensity >= 0.30 (server-side gate so the
//         orb doesn't flicker on weak reads).
//         emotion is one of: joy | trust | fear | surprise | sadness
//         | disgust | anger | anticipation | neutral.

const ENDPOINT = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/emotion-ws`;

export class EmotionConnection {
  constructor() {
    this._ws = null;
    this._state = 'idle'; // idle | connecting | open | closed
    this.onOpen = null;     // () => void
    this.onEmotion = null;  // ({emotion, intensity, raw_emotion, raw_score}) => void
    this.onSummary = null;  // ({n_reads, top, confidence_index, dominant} | {empty:true}) => void
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
        if (!data || typeof data !== 'object') return;
        if (data.summary) {
          this.onSummary?.(data.summary);
        } else if (data.emotion) {
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

  /** Ask the proxy for an aggregated summary of all reads since the
   *  last reset/summary call. Reply arrives via onSummary. The Voice
   *  character uses this on each turn-complete to inject a structured
   *  prosody report into Gemini's next turn. */
  requestSummary() {
    if (this._state !== 'open' || !this._ws) return false;
    try { this._ws.send(JSON.stringify({ cmd: 'summary' })); return true; }
    catch (err) { this.onError?.(err); return false; }
  }

  /** Discard the per-connection prediction buffer without asking for
   *  a summary. Useful at session start. */
  resetReads() {
    if (this._state !== 'open' || !this._ws) return false;
    try { this._ws.send(JSON.stringify({ cmd: 'reset' })); return true; }
    catch { return false; }
  }

  close() {
    if (!this._ws) return;
    try { this._ws.close(); } catch {}
    this._ws = null;
    this._state = 'closed';
  }
}
