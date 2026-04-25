"""
Hume Expression Measurement (prosody) proxy.

The browser sends raw 16kHz int16 PCM chunks to /emotion-ws on this
server; we buffer 3-second windows, wrap them in a WAV container,
forward to Hume's streaming WS, take the top emotion from each
prediction, map to Plutchik, and forward back to the browser.

Why proxy on the server: the Hume API key MUST stay server-side.
A direct browser → Hume connection would either expose the key in
client source / network tab, or require Hume to issue short-lived
client tokens (they don't, currently). A WS-to-WS bridge keeps the
key in os.environ, costs ~one extra hop, and lets us swap providers
later without touching the browser.

The client-facing protocol is intentionally identical to the prior
Modal endpoint:
  Browser → Server (binary):  raw 16kHz mono int16 PCM, any chunk size.
  Server → Browser (JSON):    {emotion, intensity, raw_emotion, raw_score}
                              (only sent when intensity >= INTENSITY_GATE).

Plutchik mapping notes — Hume returns 48 fine-grained emotions.
We DON'T sum within Plutchik buckets (the bucket sizes differ, so a
crowded bucket like 'anticipation' wins by counts not by signal).
Instead we pick the SINGLE highest emotion in each prediction and
map THAT one's bucket to Plutchik.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import wave

import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger("ojaq-proxy.emotion")

router = APIRouter()

HUME_WS_URL = "wss://api.hume.ai/v0/stream/models"
SAMPLE_RATE = 16000
WINDOW_SECONDS = 3              # Hume processes ~3s windows well; trade-off
WINDOW_BYTES = SAMPLE_RATE * 2 * WINDOW_SECONDS

# Below this confidence on the top emotion we suppress the message —
# the orb stays at the sentiment baseline rather than flickering on
# weak reads. From the empirical test, 0.30 cleanly separates honest
# emotion signal from "this is calm narrative".
INTENSITY_GATE = 0.30

# Hume's 48 emotion catalog → Plutchik 8. "neutral" reserved for
# weak/unclear reads (Boredom/Tiredness/Confusion). Calmness mapped
# to trust (calm-positive social state).
HUME_TO_PLUTCHIK = {
    # joy
    "Joy": "joy", "Ecstasy": "joy", "Excitement": "joy",
    "Amusement": "joy", "Triumph": "joy", "Pride": "joy",
    "Satisfaction": "joy",
    # trust (calm-positive, relational)
    "Calmness": "trust", "Contentment": "trust", "Love": "trust",
    "Adoration": "trust", "Sympathy": "trust", "Relief": "trust",
    "Romance": "trust",
    # anticipation (engaged forward)
    "Determination": "anticipation", "Interest": "anticipation",
    "Concentration": "anticipation", "Contemplation": "anticipation",
    "Desire": "anticipation", "Craving": "anticipation",
    "Entrancement": "anticipation", "Admiration": "anticipation",
    "Aesthetic Appreciation": "anticipation",
    # surprise
    "Surprise (positive)": "surprise", "Surprise (negative)": "surprise",
    "Realization": "surprise", "Awe": "surprise",
    # sadness
    "Sadness": "sadness", "Disappointment": "sadness", "Pain": "sadness",
    "Empathic Pain": "sadness", "Nostalgia": "sadness", "Guilt": "sadness",
    # disgust
    "Disgust": "disgust", "Contempt": "disgust", "Shame": "disgust",
    "Embarrassment": "disgust", "Awkwardness": "disgust", "Envy": "disgust",
    # fear
    "Fear": "fear", "Anxiety": "fear", "Horror": "fear",
    "Distress": "fear", "Doubt": "fear",
    # anger
    "Anger": "anger",
    # neutral
    "Boredom": "neutral", "Tiredness": "neutral", "Confusion": "neutral",
}


def _pcm_to_wav_bytes(pcm: bytes, sr: int = SAMPLE_RATE) -> bytes:
    """Wrap raw int16 mono PCM into a minimal WAV container so Hume
    accepts it without a separate decode step."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # int16
        w.setframerate(sr)
        w.writeframes(pcm)
    return buf.getvalue()


def _hume_predict_to_plutchik(prediction: dict) -> tuple[str, float, str, float] | None:
    """From a single Hume prediction (one analyzed window), pick the
    fine-grained emotion with the highest score, map to Plutchik, and
    return (plutchik_label, score, raw_name, raw_score). None if no
    emotion data is present."""
    emotions = prediction.get("emotions", [])
    if not emotions:
        return None
    top = max(emotions, key=lambda e: float(e.get("score", 0)))
    raw_name = top.get("name", "")
    raw_score = float(top.get("score", 0))
    plutchik = HUME_TO_PLUTCHIK.get(raw_name, "neutral")
    return plutchik, raw_score, raw_name, raw_score


@router.websocket("/emotion-ws")
async def emotion_ws(websocket: WebSocket):
    await websocket.accept()
    api_key = os.getenv("HUME_API_KEY", "")
    if not api_key:
        logger.warning("HUME_API_KEY not set — closing /emotion-ws")
        await websocket.close(code=1011, reason="emotion service unavailable")
        return

    headers = {"X-Hume-Api-Key": api_key}
    try:
        async with websockets.connect(
            HUME_WS_URL,
            additional_headers=headers,
            max_size=None,
            open_timeout=15,
            ping_interval=20,
        ) as hume:
            buffer = bytearray()

            async def client_to_hume():
                nonlocal buffer
                while True:
                    data = await websocket.receive_bytes()
                    if not data:
                        continue
                    buffer.extend(data)
                    while len(buffer) >= WINDOW_BYTES:
                        chunk = bytes(buffer[:WINDOW_BYTES])
                        del buffer[:WINDOW_BYTES]
                        wav = _pcm_to_wav_bytes(chunk)
                        await hume.send(json.dumps({
                            "models": {"prosody": {}},
                            "data": base64.b64encode(wav).decode(),
                        }))

            async def hume_to_client():
                async for raw_msg in hume:
                    try:
                        msg = json.loads(raw_msg)
                    except Exception:
                        continue
                    prosody = msg.get("prosody", {})
                    for pred in prosody.get("predictions", []) or []:
                        result = _hume_predict_to_plutchik(pred)
                        if not result:
                            continue
                        plutchik, score, raw_name, raw_score = result
                        # Gate weak reads — orb falls back to sentiment baseline
                        if raw_score < INTENSITY_GATE:
                            continue
                        await websocket.send_json({
                            "emotion": plutchik,
                            "intensity": raw_score,
                            "raw_emotion": raw_name,
                            "raw_score": raw_score,
                        })

            tasks = [
                asyncio.create_task(client_to_hume()),
                asyncio.create_task(hume_to_client()),
            ]
            try:
                await asyncio.gather(*tasks)
            finally:
                for t in tasks:
                    t.cancel()
    except WebSocketDisconnect:
        return
    except Exception as e:
        logger.exception("emotion proxy failed: %s", e)
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
