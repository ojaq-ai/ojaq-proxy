"""
Direct Gemini Live WebSocket test -- mirrors the exact setup message
that index.html sends.  Prints every raw message for 10 seconds.

Usage:  python test_direct.py
"""

import asyncio
import json
import os

import websockets
from dotenv import load_dotenv

load_dotenv()

GEMINI_WS = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)
API_KEY = os.getenv("GEMINI_API_KEY", "")
MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025"

SYSTEM_PROMPT = """\
You are a warm, grounded life coach and facilitator. Your job is to help the \
user think clearly about their life plans -- career, relationships, health, \
growth, and the things they care about.

How you coach:
- Ask one focused, open-ended question at a time. Never stack multiple \
questions in one turn.
- Listen closely. Reflect back what you hear before moving on.
- Help the user name the gap between where they are and where they want to \
be, then help them find the smallest next concrete step.
- Challenge gently when you notice vague goals, avoidance, or self-limiting \
stories -- but stay kind.
- Do NOT lecture. Do NOT give long motivational speeches.
- Keep every response short and conversational -- this is a spoken \
conversation, not a written essay.

PRESENCE REPORT (silent side-channel -- do not read aloud):

After you finish speaking your coaching reply, append a machine-readable \
presence insight on the LAST turn describing the user's most recent speech. \
Wrap it strictly in a ```json fenced code block, exactly this schema:

```json
{
  "speaker": "user",
  "transcript": "<verbatim of the user's last turn>",
  "presence": {
    "dominance": 0,
    "arousal": 0,
    "defensiveness": 0,
    "engagement": 0,
    "sentiment": 0.0
  }
}
```

Rules for the presence block:
- Never vocalize the JSON. Speak only the coaching reply; the JSON is text \
metadata for the client UI.
- dominance, arousal, defensiveness, engagement are integers 0-100.
- sentiment is a float from -1.0 (strongly negative) to 1.0 (strongly \
positive).
- Emit the block every single turn, at the very end, even if values are \
near zero.\
"""

# -- exact same setup message as index.html -------------------------------
SETUP_MSG = {
    "setup": {
        "model": MODEL,
        "generationConfig": {
            "responseModalities": ["AUDIO"],
        },
        "systemInstruction": {
            "parts": [{"text": SYSTEM_PROMPT}]
        },
        "realtimeInputConfig": {
            "automaticActivityDetection": {
                "disabled": False,
                "startOfSpeechSensitivity": "START_SENSITIVITY_HIGH",
                "endOfSpeechSensitivity": "END_SENSITIVITY_HIGH",
                "prefixPaddingMs": 200,
                "silenceDurationMs": 500,
            }
        },
        "outputAudioTranscription": {},
    }
}


def truncate(s: str, n: int = 200) -> str:
    return s if len(s) <= n else s[:n] + f"...  ({len(s)} chars total)"


async def main():
    if not API_KEY:
        print("ERROR: set GEMINI_API_KEY in .env")
        return

    url = f"{GEMINI_WS}?key={API_KEY}"
    print(f"connecting to {url[:80]}...")

    async with websockets.connect(url) as ws:
        payload = json.dumps(SETUP_MSG)
        print(f"\n-> SETUP ({len(payload)} chars)")
        print(truncate(payload, 300))
        await ws.send(payload)

        print(f"\nlistening for 10 s ...\n{'-' * 60}")
        i = 0
        try:
            while True:
                raw = await asyncio.wait_for(ws.recv(), timeout=10.0)
                i += 1
                if isinstance(raw, bytes):
                    print(f"[{i}] BINARY  {len(raw)} bytes")
                    print(f"    hex: {raw.hex()}")
                    try:
                        print(f"    utf8: {raw.decode('utf-8')}")
                    except Exception:
                        print(f"    (not valid utf-8)")
                else:
                    # pretty-print JSON, truncate big base64 blobs
                    try:
                        obj = json.loads(raw)
                        compact = json.dumps(obj, indent=2)
                        # mask long base64 data fields for readability
                        import re
                        compact = re.sub(
                            r'"data":\s*"([A-Za-z0-9+/=]{60})[^"]*"',
                            lambda m: f'"data": "{m.group(1)}... <b64 truncated>"',
                            compact,
                        )
                        print(f"[{i}] JSON")
                        print(compact[:600])
                        if len(compact) > 600:
                            print(f"    ... ({len(compact)} chars total)")
                    except json.JSONDecodeError:
                        print(f"[{i}] TEXT  {truncate(raw)}")
                print()

        except asyncio.TimeoutError:
            print(f"{'-' * 60}\ntimeout -- no message for 10 s  (received {i} total)")
        except websockets.exceptions.ConnectionClosed as e:
            print(f"{'-' * 60}\nconnection closed: code={e.code}  reason={e.reason}")

    print("done.")


if __name__ == "__main__":
    asyncio.run(main())
