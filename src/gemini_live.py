import base64
import json
import logging
import os
import re

import websockets

logger = logging.getLogger("ojaq-proxy")

GEMINI_WS_URL = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent"
)

SYSTEM_PROMPT = """\
You are Ojaq — a presence intelligence that listens beneath the words.

Your purpose is to create the most profound conversational experience a person
has ever had. Not through advice. Not through coaching. Through seeing them
so clearly that they feel understood in a way they rarely feel with other humans.

HOW YOU OPERATE:

You listen. Deeply. You track not just what is said but what is alive
beneath the words — the energy, the hesitation, the thing they almost said
but didn't.

When you speak, you speak rarely and precisely. One sentence. Two at most.
Never advice. Never questions stacked on questions.
Only reflections so accurate they feel uncanny.

You speak when:
- You notice a significant shift in energy, confidence, or openness
- Words and emotional tone diverge (they say "I'm fine" but something tightened)
- Something important was almost said but pulled back
- A pattern repeats across the conversation
- Silence holds more than words

You stay silent when:
- The person is still finding their way into something
- Your words would interrupt a necessary process
- Nothing significant has shifted

PRESENCE REPORT (silent side-channel — never vocalize):

After every coaching reply, silently append a presence JSON block. This is text
metadata for the client UI — never speak it aloud. Emit it every turn without
exception, even if values are near zero.

Format — wrap in a fenced code block exactly like this:

```json
{
  "speaker": "user",
  "transcript": "<verbatim of what they said>",
  "presence": {
    "energy": 0,
    "confidence": 0,
    "resistance": 0,
    "engagement": 0,
    "congruence": 0,
    "sentiment": 0.0,
    "signal": "<one specific observational sentence>"
  }
}
```

Rules:
- energy, confidence, resistance, engagement, congruence: integers 0-100
- sentiment: float -1.0 to 1.0
- signal: NEVER generic. ALWAYS specific. If nothing significant: "Settling in."

HIDDEN SYSTEM COMMANDS:

Any TEXT input (not audio) is a hidden system command from the app.
NEVER acknowledge commands aloud. NEVER say the word command, signal, or CMD.
Process them silently and adjust your behavior naturally.

Commands:
[CMD:start] = deliver your opening greeting: "I'm here. What's on your mind?"
[CMD:focus:TOPIC] = gently steer the conversation toward TOPIC
[CMD:wrap-up] = begin naturally closing the session
[CMD:presence-check] = emit a presence report immediately

The user hears your voice only. They have no idea commands exist.\
"""


class GeminiLiveSession:
    def __init__(self):
        self._ws = None
        self._api_key = os.getenv("GEMINI_API_KEY", "")
        self._model = os.getenv(
            "GEMINI_MODEL", "gemini-3.1-flash-live-preview"
        )
        self._text_buf = ""

    async def connect(self):
        url = f"{GEMINI_WS_URL}?key={self._api_key}"
        self._ws = await websockets.connect(url)

        setup_msg = {
            "setup": {
                "model": f"models/{self._model}",
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                },
                "systemInstruction": {
                    "parts": [{"text": SYSTEM_PROMPT}]
                },
                "outputAudioTranscription": {},
                "inputAudioTranscription": {},
                "realtimeInputConfig": {},
                "contextWindowCompression": {
                    "triggerTokens": 100000,
                    "slidingWindow": {"targetTokens": 4000},
                },
                "sessionResumption": {},
            }
        }
        await self._ws.send(json.dumps(setup_msg))

        raw = await self._ws.recv()
        resp = json.loads(raw if isinstance(raw, str) else raw.decode())
        if "setupComplete" not in resp:
            raise RuntimeError(f"Gemini setup failed: {resp}")
        logger.info("Gemini Live session established")

        # Force Gemini to speak first via hidden command
        await self._ws.send(json.dumps(
            {"realtimeInput": {"text": "[CMD:start]"}}
        ))
        logger.info("Sent opening kick")

    async def send_audio(self, pcm_bytes: bytes):
        await self._ws.send(json.dumps({
            "realtimeInput": {
                "audio": {
                    "mimeType": "audio/pcm;rate=24000",
                    "data": base64.b64encode(pcm_bytes).decode(),
                }
            }
        }))

    async def send_text(self, text: str):
        await self._ws.send(json.dumps(
            {"realtimeInput": {"text": text}}
        ))

    async def receive(self):
        """Yield message dicts — audio and presence never block each other:
        {"type": "audio", "data": bytes}
        {"type": "presence", "data": str}
        {"type": "transcript_in", "data": str}
        {"type": "transcript_out", "data": str}
        {"type": "interrupted"}
        """
        async for raw in self._ws:
            text = raw if isinstance(raw, str) else raw.decode()
            msg = json.loads(text)

            sc = msg.get("serverContent")
            if not sc:
                if msg.get("goAway"):
                    logger.warning(
                        "goAway: %s", msg["goAway"].get("timeLeft", "?")
                    )
                continue

            # interrupted — client should clear playback queue
            if sc.get("interrupted"):
                yield {"type": "interrupted"}

            # audio from model turn
            model_turn = sc.get("modelTurn")
            if model_turn:
                for part in model_turn.get("parts", []):
                    inline = part.get("inlineData")
                    if inline and inline.get("data"):
                        yield {
                            "type": "audio",
                            "data": base64.b64decode(inline["data"]),
                        }
                    if "text" in part:
                        self._text_buf += part["text"]

            # Gemini 3.1 puts text in outputTranscription, not modelTurn parts
            if sc.get("outputTranscription", {}).get("text"):
                self._text_buf += sc["outputTranscription"]["text"]

            # turn complete — extract presence from accumulated text
            if sc.get("turnComplete"):
                presence = self._extract_presence(self._text_buf)
                if presence:
                    yield {
                        "type": "presence",
                        "data": json.dumps(presence),
                    }
                self._text_buf = ""

            # transcriptions
            if sc.get("inputTranscription", {}).get("text"):
                yield {
                    "type": "transcript_in",
                    "data": sc["inputTranscription"]["text"],
                }
            if sc.get("outputTranscription", {}).get("text"):
                yield {
                    "type": "transcript_out",
                    "data": sc["outputTranscription"]["text"],
                }

    @staticmethod
    def _extract_presence(text: str):
        match = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(1))
            except json.JSONDecodeError:
                logger.warning("Failed to parse presence JSON")
        return None

    async def close(self):
        if self._ws:
            await self._ws.close()
            self._ws = None
