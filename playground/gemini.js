// ── Gemini Live WebSocket — copied from test_browser/index.html ─────────

const GEMINI_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';
const MODEL = 'models/gemini-3.1-flash-live-preview';
const SAMPLE_RATE = 24000;
const MIME = `audio/pcm;rate=${SAMPLE_RATE}`;

export { SAMPLE_RATE };

export class GeminiConnection {
  constructor() {
    this.ws = null;
    this.resumeHandle = null;
    this.onSetupComplete = null;
    this.onAudio = null;         // (base64) => void
    this.onText = null;          // (textChunk) => void
    this.onTurnComplete = null;  // () => void
    this.onInterrupted = null;
    this.onInputTranscript = null;  // (text) => void
    this.onOutputTranscript = null; // (text) => void
    this.onClose = null;
    this.onGoAway = null;
  }

  async connect(systemPrompt) {
    const resp = await fetch('/token');
    if (!resp.ok) throw new Error(`/token ${resp.status}`);
    const { token } = await resp.json();

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${GEMINI_WS}?key=${token}`);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.ws.send(JSON.stringify({
          setup: {
            model: MODEL,
            generationConfig: { responseModalities: ['AUDIO'] },
            systemInstruction: { parts: [{ text: systemPrompt }] },
            outputAudioTranscription: {},
            inputAudioTranscription: {},
            realtimeInputConfig: {},
            contextWindowCompression: {
              triggerTokens: 100000,
              slidingWindow: { targetTokens: 4000 },
            },
            sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
          }
        }));
      };

      this.ws.onmessage = (e) => {
        const raw = (e.data instanceof ArrayBuffer)
          ? new TextDecoder().decode(e.data) : e.data;
        if (!raw) return;
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.setupComplete != null) { resolve(); return; }
        if (msg.goAway) { this.onGoAway?.(msg.goAway.timeLeft); return; }
        if (msg.sessionResumptionUpdate?.newHandle) {
          this.resumeHandle = msg.sessionResumptionUpdate.newHandle;
          return;
        }

        const sc = msg.serverContent;
        if (!sc) return;

        if (sc.interrupted) this.onInterrupted?.();

        if (sc.modelTurn) {
          for (const part of (sc.modelTurn.parts || [])) {
            if (part.inlineData?.data) this.onAudio?.(part.inlineData.data);
            if (part.text != null) this.onText?.(part.text);
          }
        }

        if (sc.turnComplete) this.onTurnComplete?.();
        if (sc.inputTranscription?.text) this.onInputTranscript?.(sc.inputTranscription.text);
        if (sc.outputTranscription?.text) this.onOutputTranscript?.(sc.outputTranscription.text);
      };

      this.ws.onclose = (e) => { this.onClose?.(e.code, e.reason); };
      this.ws.onerror = () => { reject(new Error('ws error')); };
    });
  }

  sendAudio(base64) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      realtimeInput: { audio: { data: base64, mimeType: MIME } }
    }));
  }

  sendText(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ realtimeInput: { text } }));
  }

  close() {
    if (this.ws) { this.ws.close(); this.ws = null; }
  }
}
