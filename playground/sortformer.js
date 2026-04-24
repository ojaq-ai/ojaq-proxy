// ── Sortformer: streaming speaker diarization WebSocket client ───────────
// Wraps the Modal-hosted NVIDIA Sortformer 4-speaker endpoint.
// Input:  raw 16kHz int16 PCM chunks (ArrayBuffer), inference triggers
//         once the server-side window exceeds ~2560 bytes.
// Output: JSON array [p0, p1, p2, p3] — per-speaker probabilities.

const ENDPOINT = 'wss://gokhan--sortformer2-1-speaker-diarization-sortformer2-1--6e627c.modal.run/ws';

export class SortformerConnection {
  constructor() {
    this._ws = null;
    this._state = 'idle'; // idle | connecting | open | closed
    this.onOpen = null;              // () => void
    this.onProbs = null;             // (number[]) => void
    this.onClose = null;             // (code, reason) => void
    this.onError = null;             // (err) => void
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
        if (Array.isArray(data)) this.onProbs?.(data);
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
