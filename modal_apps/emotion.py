"""
Ojaq Emotion Classifier — Modal WebSocket service
═════════════════════════════════════════════════

Realtime speech emotion recognition for the Ojaq orb. Receives a stream
of 16kHz int16 PCM chunks from the browser, returns Plutchik 8-class
emotion + continuous arousal/valence/dominance every ~500ms.

DEPLOYMENT
----------
    cd ojaq-proxy
    modal deploy modal_apps/emotion.py

After deploy Modal prints a public WS URL, e.g.:
    https://<username>--ojaq-emotion-emotion-classifier-web.modal.run/ws

Wire that URL into playground/emotion.js (next commit). The browser
connects directly — no server proxy — same pattern as Sortformer.

MODEL
-----
audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim
  — fine-tuned on MSP-Podcast (10k+ hours, ~1000 speakers)
  — outputs continuous [arousal, dominance, valence] each ~0..1
  — 300MB, ~150-250ms inference on A10G for 1s audio

PROTOCOL
--------
Browser → Server (binary frames):
    Raw 16kHz mono int16 PCM. Any chunk size; server buffers a 1.0s
    window and slides 0.5s for inference.

Server → Browser (JSON frames):
    {
      "emotion": "joy" | "trust" | "fear" | "surprise" | "sadness"
                | "disgust" | "anger" | "anticipation" | "neutral",
      "intensity": 0.0..1.0,
      "arousal":   0.0..1.0,
      "valence":   0.0..1.0,
      "dominance": 0.0..1.0,
      "ts": float (server clock, seconds since epoch)
    }

PLUTCHIK MAPPING
----------------
Plutchik's 8 primaries don't have direct counterparts in standard SER
output (which is continuous arousal/valence/dominance). We use a
heuristic placement on the AVD plane that follows Plutchik's wheel
geometry. Tunable in `avd_to_plutchik()` — these thresholds are an
educated start, not gospel; tune from real session traces.
"""

import time
import modal
import numpy as np


# ── Image: torch + transformers + audio utils ─────────────────────────
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch==2.1.0",
        "torchaudio==2.1.0",
        "transformers==4.40.0",
        "fastapi==0.115.0",
        "numpy==1.26.4",
    )
)

app = modal.App("ojaq-emotion", image=image)

MODEL_NAME = "audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim"
SAMPLE_RATE = 16000
WINDOW_SAMPLES = SAMPLE_RATE        # 1.0s analysis window
HOP_SAMPLES    = SAMPLE_RATE // 2   # slide 0.5s = 2 predictions/sec


# ── Plutchik mapping ──────────────────────────────────────────────────
# Each of arousal/valence/dominance arrives in [0, 1] (audeering's
# regression head). Centered offsets (>< 0.5) place the sample on the
# Plutchik wheel by quadrant + dominance modifier.
def avd_to_plutchik(arousal: float, valence: float, dominance: float):
    a, v, d = arousal, valence, dominance
    da = a - 0.5
    dv = v - 0.5
    dd = d - 0.5

    # Distance from neutral on the AV plane → intensity (capped at 1.0)
    intensity = float(min(1.0, ((da * da) + (dv * dv)) ** 0.5 * 1.6))

    if intensity < 0.15:
        return "neutral", intensity

    # High arousal + high valence quadrant → joy / anticipation
    if da > 0.12 and dv > 0.12:
        return ("anticipation", intensity) if dd > 0.10 else ("joy", intensity)

    # Low arousal + high valence → trust (calm positive)
    if da < -0.05 and dv > 0.12:
        return "trust", intensity

    # High arousal + low valence → anger / fear (split by dominance)
    if da > 0.12 and dv < -0.10:
        return ("anger", intensity) if dd > 0.05 else ("fear", intensity)

    # Very high arousal near-neutral valence → surprise
    if da > 0.30 and abs(dv) < 0.12:
        return "surprise", intensity

    # Low arousal + low valence → sadness
    if da < -0.05 and dv < -0.12:
        return "sadness", intensity

    # Mid-low arousal + low valence + high dominance → disgust
    if abs(da) < 0.20 and dv < -0.10 and dd > 0.10:
        return "disgust", intensity

    # Fallback: nearest cardinal quadrant
    if dv >= 0:
        return ("joy" if da >= 0 else "trust"), intensity
    return ("anger" if da >= 0 else "sadness"), intensity


# ── Modal class — model loaded once per warm container ────────────────
@app.cls(
    gpu="A10G",
    timeout=3600,
    scaledown_window=300,   # keep warm for 5 min after last request
    max_containers=2,
)
class EmotionClassifier:

    @modal.enter()
    def load(self):
        import torch
        import torch.nn as nn
        from transformers import (
            Wav2Vec2Processor,
            Wav2Vec2Model,
            Wav2Vec2PreTrainedModel,
        )

        self.torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"[ojaq-emotion] loading {MODEL_NAME} on {self.device}…")

        # audeering's model uses a custom regression head — replicated from
        # their HuggingFace card. Outputs [arousal, dominance, valence].
        class RegressionHead(nn.Module):
            def __init__(self, config):
                super().__init__()
                self.dense = nn.Linear(config.hidden_size, config.hidden_size)
                self.dropout = nn.Dropout(config.final_dropout)
                self.out_proj = nn.Linear(config.hidden_size, config.num_labels)

            def forward(self, features):
                x = self.dropout(features)
                x = self.dense(x)
                x = torch.tanh(x)
                x = self.dropout(x)
                return self.out_proj(x)

        class EmotionModel(Wav2Vec2PreTrainedModel):
            def __init__(self, config):
                super().__init__(config)
                self.config = config
                self.wav2vec2 = Wav2Vec2Model(config)
                self.classifier = RegressionHead(config)
                self.init_weights()

            def forward(self, input_values):
                outputs = self.wav2vec2(input_values)
                hidden = outputs[0].mean(dim=1)
                return hidden, self.classifier(hidden)

        self.processor = Wav2Vec2Processor.from_pretrained(MODEL_NAME)
        self.model = EmotionModel.from_pretrained(MODEL_NAME).to(self.device).eval()
        print("[ojaq-emotion] model ready.")

    @modal.asgi_app()
    def web(self):
        from fastapi import FastAPI, WebSocket, WebSocketDisconnect

        api = FastAPI(title="ojaq-emotion")

        @api.get("/healthz")
        async def healthz():
            return {"ok": True, "device": self.device, "model": MODEL_NAME}

        @api.websocket("/ws")
        async def ws(websocket: WebSocket):
            await websocket.accept()
            buffer = np.zeros(0, dtype=np.float32)
            torch = self.torch

            try:
                while True:
                    data = await websocket.receive_bytes()
                    if not data:
                        continue
                    chunk = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
                    buffer = np.concatenate([buffer, chunk])

                    # Drain windows until we don't have a full one
                    while len(buffer) >= WINDOW_SAMPLES:
                        window = buffer[:WINDOW_SAMPLES]
                        buffer = buffer[HOP_SAMPLES:]  # slide

                        inputs = self.processor(
                            window,
                            sampling_rate=SAMPLE_RATE,
                            return_tensors="pt",
                        )
                        input_values = inputs.input_values.to(self.device)
                        with torch.no_grad():
                            _, preds = self.model(input_values)
                        # audeering: [arousal, dominance, valence]
                        avd = preds[0].cpu().numpy().tolist()
                        arousal   = max(0.0, min(1.0, float(avd[0])))
                        dominance = max(0.0, min(1.0, float(avd[1])))
                        valence   = max(0.0, min(1.0, float(avd[2])))

                        emotion, intensity = avd_to_plutchik(arousal, valence, dominance)

                        await websocket.send_json({
                            "emotion":   emotion,
                            "intensity": intensity,
                            "arousal":   arousal,
                            "valence":   valence,
                            "dominance": dominance,
                            "ts":        time.time(),
                        })
            except WebSocketDisconnect:
                return
            except Exception as e:
                # Log and close — don't propagate (would 500 the WS)
                print(f"[ojaq-emotion] ws error: {type(e).__name__}: {e}")
                try:
                    await websocket.close(code=1011)
                except Exception:
                    pass

        return api
