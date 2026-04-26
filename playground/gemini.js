// ── Gemini Live WebSocket ────────────────────────────────────────────────

const GEMINI_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';
const MODEL = 'models/gemini-3.1-flash-live-preview';
const SAMPLE_RATE = 24000;
const MIME = `audio/pcm;rate=${SAMPLE_RATE}`;

export { SAMPLE_RATE };

export class GeminiConnection {
  constructor() {
    this.ws = null;
    this.resumeHandle = null;
    this.onAudio = null;            // (base64) => void
    this.onText = null;             // (textChunk) => void
    this.onTurnComplete = null;     // () => void
    this.onInterrupted = null;
    this.onInputTranscript = null;  // (text) => void
    this.onOutputTranscript = null; // (text) => void
    this.onToolCall = null;         // (name, args, id) => void
    this.onClose = null;
    this.onGoAway = null;
  }

  async connect(systemPrompt, tools = [], language = 'en-US') {
    const resp = await fetch('/token');
    if (!resp.ok) throw new Error(`/token ${resp.status}`);
    const { token } = await resp.json();

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${GEMINI_WS}?key=${token}`);
      this.ws.binaryType = 'arraybuffer';
      let resolved = false;
      // Hard timeout — if neither onopen nor onmessage delivers
      // setupComplete within 10s, surface as an error instead of
      // hanging the activate() flow indefinitely.
      const timeout = setTimeout(() => {
        if (!resolved) reject(new Error('gemini setup timeout (10s)'));
      }, 10_000);

      this.ws.onopen = () => {
        const setup = {
          model: MODEL,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { languageCode: language },
          },
          systemInstruction: { parts: [{ text: systemPrompt }] },
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          realtimeInputConfig: {},
          contextWindowCompression: {
            triggerTokens: 100000,
            slidingWindow: { targetTokens: 4000 },
          },
          sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
        };
        if (tools.length) setup.tools = tools;
        this.ws.send(JSON.stringify({ setup }));
      };

      this.ws.onmessage = (e) => {
        const raw = (e.data instanceof ArrayBuffer)
          ? new TextDecoder().decode(e.data) : e.data;
        if (!raw) return;
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.setupComplete != null) {
          resolved = true;
          clearTimeout(timeout);
          resolve();
          return;
        }
        if (msg.goAway) { this.onGoAway?.(msg.goAway.timeLeft); return; }
        if (msg.sessionResumptionUpdate?.newHandle) {
          this.resumeHandle = msg.sessionResumptionUpdate.newHandle;
          return;
        }

        // Tool calls (presence)
        if (msg.toolCall) {
          for (const call of (msg.toolCall.functionCalls || [])) {
            this.onToolCall?.(call.name, call.args, call.id);
          }
          return;
        }

        if (msg.toolCallCancellation) return;

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

      this.ws.onclose = (e) => {
        // Pre-setupComplete close is an error path — reject so the
        // activate() catch fires instead of leaving the promise dangling.
        // After resolve, this is just the normal session-end signal.
        if (!resolved) {
          clearTimeout(timeout);
          reject(new Error(`ws closed before setup (code=${e.code} reason=${e.reason || 'none'})`));
          return;
        }
        this.onClose?.(e.code, e.reason);
      };
      this.ws.onerror = () => {
        if (!resolved) {
          clearTimeout(timeout);
          reject(new Error('ws error before setup'));
        }
      };
    });
  }

  respondToTool(name, id) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      toolResponse: {
        functionResponses: [{ name, id, response: { status: 'ok' } }]
      }
    }));
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
    if (this.ws) {
      // Unbind onclose FIRST — prevents the delayed close event from firing
      // the consumer's onClose callback after a new session has started and
      // set running=true, which would erroneously trigger stop() on the new session.
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }
}
