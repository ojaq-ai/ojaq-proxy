"""
Ojaq Emotion2Vec Classifier — Modal WebSocket service (parallel candidate)
══════════════════════════════════════════════════════════════════════════

Empirical-test deployment of `iic/emotion2vec_plus_large` (FunASR), to
compare against the existing audeering wav2vec2 endpoint on Turkish
samples. Same WS protocol as emotion.py so the comparison harness can
talk to both with identical client code.

DEPLOY
------
    cd ojaq-proxy
    modal deploy modal_apps/emotion2vec.py

WHY THIS MODEL
--------------
emotion2vec+ is a 2024 self-supervised speech emotion representation
trained on 262k hours, with multilingual coverage stronger than
audeering's MSP-Podcast (English podcast) baseline. Outputs a 9-class
distribution (happy / sad / angry / fearful / disgusted / surprised
/ neutral / other / unknown), which we surface raw in JSON so the
test script can score it directly. Plutchik mapping deferred until
we know if this model is worth swapping in.

PROTOCOL
--------
Browser → Server (binary frames):
    Raw 16kHz mono int16 PCM. Server buffers a 1.0s window, slides 0.5s.

Server → Browser (JSON frames):
    {
      "emotion":   "happy" | "sad" | "angry" | "fearful" | "disgusted"
                 | "surprised" | "neutral" | "other" | "unknown",
      "intensity": top-class score, 0.0..1.0,
      "scores":    {label: score, ...},  # full 9-class dist
      "ts":        float
    }
"""

import time
import modal


# ── Image: torch + funasr + soundfile + librosa ──────────────────────
def _bake_model():
    """Run at image-build time — download + cache the model so the cold
    start at runtime doesn't pay the 600MB ModelScope hit."""
    from funasr import AutoModel  # noqa: WPS433
    AutoModel(model="iic/emotion2vec_plus_large", disable_update=True)


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libsndfile1", "ffmpeg")
    .pip_install(
        "torch==2.1.0",
        "torchaudio==2.1.0",
        "fastapi==0.115.0",
        "numpy==1.26.4",
        "funasr==1.2.6",
        "modelscope",
        "soundfile",
        "librosa",
    )
    .run_function(_bake_model)
)

app = modal.App("ojaq-emotion2vec", image=image)

SAMPLE_RATE = 16000
WINDOW_SAMPLES = SAMPLE_RATE        # 1.0s analysis window
HOP_SAMPLES    = SAMPLE_RATE // 2   # 0.5s slide


@app.cls(
    gpu="A10G",
    timeout=3600,
    scaledown_window=300,
    max_containers=2,
)
class Emotion2VecClassifier:

    @modal.enter()
    def load(self):
        from funasr import AutoModel
        print("[ojaq-emotion2vec] loading iic/emotion2vec_plus_large…")
        self.model = AutoModel(
            model="iic/emotion2vec_plus_large",
            disable_update=True,
        )
        print("[ojaq-emotion2vec] model ready.")

    @modal.asgi_app()
    def web(self):
        from fastapi import FastAPI, WebSocket, WebSocketDisconnect

        api = FastAPI(title="ojaq-emotion2vec")

        @api.get("/healthz")
        async def healthz():
            return {"ok": True, "model": "iic/emotion2vec_plus_large"}

        @api.websocket("/ws")
        async def ws(websocket: WebSocket):
            import numpy as np
            await websocket.accept()
            buffer = np.zeros(0, dtype=np.float32)

            try:
                while True:
                    data = await websocket.receive_bytes()
                    if not data:
                        continue
                    chunk = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
                    buffer = np.concatenate([buffer, chunk])

                    while len(buffer) >= WINDOW_SAMPLES:
                        window = buffer[:WINDOW_SAMPLES]
                        buffer = buffer[HOP_SAMPLES:]

                        result = self.model.generate(
                            window,
                            output_dir=None,
                            granularity="utterance",
                            extract_embedding=False,
                        )
                        if not result:
                            continue

                        # FunASR returns labels like "angry/生气" — keep
                        # only the English half, lowercased.
                        labels_raw = result[0].get("labels", [])
                        scores_raw = result[0].get("scores", [])
                        if not labels_raw or not scores_raw:
                            continue

                        labels = [
                            (lbl.split("/")[0] if "/" in lbl else lbl).strip().lower()
                            for lbl in labels_raw
                        ]
                        scores = [float(s) for s in scores_raw]
                        scores_dict = dict(zip(labels, scores))

                        top_idx = int(np.argmax(scores))
                        emotion = labels[top_idx]
                        intensity = float(scores[top_idx])

                        await websocket.send_json({
                            "emotion":   emotion,
                            "intensity": intensity,
                            "scores":    scores_dict,
                            "ts":        time.time(),
                        })
            except WebSocketDisconnect:
                return
            except Exception as e:
                print(f"[ojaq-emotion2vec] ws error: {type(e).__name__}: {e}")
                try:
                    await websocket.close(code=1011)
                except Exception:
                    pass

        return api
