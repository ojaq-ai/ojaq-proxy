import asyncio
import json
import logging
import os
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
import httpx

from gemini_live import GeminiLiveSession

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ojaq-proxy")

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

_ROOT = Path(__file__).resolve().parent.parent
TEST_HTML = _ROOT / "test_browser" / "index.html"
LANDING_HTML = _ROOT / "landing" / "index.html"

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

app = FastAPI(title="ojaq-proxy")


@app.get("/")
async def landing_page():
    return FileResponse(LANDING_HTML, media_type="text/html")


@app.get("/terms")
async def terms_page():
    return FileResponse(_ROOT / "landing" / "terms.html", media_type="text/html")


@app.get("/privacy")
async def privacy_page():
    return FileResponse(_ROOT / "landing" / "privacy.html", media_type="text/html")


@app.get("/test")
async def test_page():
    return FileResponse(TEST_HTML, media_type="text/html")


@app.get("/token")
async def get_token():
    """Hand the API key to the browser so it never appears in client source."""
    if not GEMINI_API_KEY:
        return {"error": "GEMINI_API_KEY not set"}, 500
    return {"token": GEMINI_API_KEY}


# ── Persistent data paths ────────────────────────────────────────────────
import datetime
import uuid

# Railway volume at /data if available, otherwise fallback to project root
_DATA_DIR = Path("/data") if Path("/data").is_dir() else _ROOT
SESSIONS_LOG = _DATA_DIR / "sessions.jsonl"
WAITLIST_FILE = _DATA_DIR / "waitlist.jsonl"


# ── Rate limiting (in-memory only, never persisted) ──────────────────────
_rate_map = {}  # ip -> [timestamp, ...]
_RATE_LIMIT = 3
_RATE_WINDOW = 86400  # 24 hours


def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_rate(ip: str) -> bool:
    now = datetime.datetime.utcnow().timestamp()
    cutoff = now - _RATE_WINDOW
    timestamps = [t for t in _rate_map.get(ip, []) if t > cutoff]
    _rate_map[ip] = timestamps
    return len(timestamps) < _RATE_LIMIT


def _record_rate(ip: str):
    _rate_map.setdefault(ip, []).append(
        datetime.datetime.utcnow().timestamp()
    )


async def _cleanup_rate_map():
    while True:
        await asyncio.sleep(3600)
        now = datetime.datetime.utcnow().timestamp()
        cutoff = now - _RATE_WINDOW
        stale = [
            ip for ip, ts in _rate_map.items()
            if all(t <= cutoff for t in ts)
        ]
        for ip in stale:
            del _rate_map[ip]


@app.on_event("startup")
async def _start_cleanup():
    asyncio.create_task(_cleanup_rate_map())


# ── Waitlist ─────────────────────────────────────────────────────────────
def _waitlist_has_email(email: str) -> bool:
    """Check if email already exists in waitlist (case-insensitive)."""
    if not WAITLIST_FILE.exists():
        return False
    lower = email.lower()
    for line in WAITLIST_FILE.read_text().splitlines():
        try:
            entry = json.loads(line)
            if entry.get("email", "").lower() == lower:
                return True
        except json.JSONDecodeError:
            continue
    return False


@app.post("/waitlist")
async def waitlist_signup(request: Request):
    body = await request.json()
    email = (body.get("email") or "").strip().lower()
    source = body.get("source", "unknown")

    if not email or "@" not in email:
        return JSONResponse({"error": "Invalid email"}, 400)

    if _waitlist_has_email(email):
        return {"ok": True, "message": "already_registered"}

    entry = {
        "email": email,
        "source": source,
        "timestamp": datetime.datetime.utcnow().isoformat(),
    }
    with open(WAITLIST_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")

    # Also log to stdout so Railway log drain captures it as backup
    logger.info(f"WAITLIST: {email} (source={source})")

    return {"ok": True, "message": "registered"}


@app.get("/waitlist")
async def waitlist_list():
    """Return all waitlist entries collected so far."""
    if not WAITLIST_FILE.exists():
        return {"entries": []}

    entries = []
    for line in WAITLIST_FILE.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
            entries.append({
                "email": entry.get("email", ""),
                "source": entry.get("source", ""),
                "timestamp": entry.get("timestamp", ""),
            })
        except json.JSONDecodeError:
            continue

    return {"entries": entries}


@app.post("/session/start")
async def session_start(request: Request):
    ip = _get_client_ip(request)
    if not _check_rate(ip):
        return JSONResponse(
            {"error": "rate_limited",
             "message": "You've used your previews for today."},
            status_code=429,
        )
    _record_rate(ip)

    body = await request.json()
    entry = {
        "event": "start",
        "session_id": str(uuid.uuid4())[:8],
        "framework": body.get("framework", "unknown"),
        "timestamp": datetime.datetime.utcnow().isoformat(),
    }
    with open(SESSIONS_LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")
    return {"session_id": entry["session_id"]}


@app.post("/session/turn")
async def session_turn(request: Request):
    body = await request.json()
    entry = {
        "event": "turn",
        "session_id": body.get("session_id", ""),
        "presence": body.get("presence"),
        "emotion": body.get("emotion", ""),
        "timestamp": datetime.datetime.utcnow().isoformat(),
    }
    with open(SESSIONS_LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")
    return {"ok": True}


@app.post("/session/end")
async def session_end(request: Request):
    body = await request.json()
    entry = {
        "event": "end",
        "session_id": body.get("session_id", ""),
        "duration_ms": body.get("duration_ms", 0),
        "turns": body.get("turns", 0),
        "framework": body.get("framework", ""),
        "timestamp": datetime.datetime.utcnow().isoformat(),
    }
    with open(SESSIONS_LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")
    return {"ok": True}


ANALYZE_PROMPT = """\
Analyze the emotional presence in this conversation turn.
User said: "{user_text}"
Coach said: "{model_text}"

Return ONLY a JSON object with these fields:
- energy (0-100): how activated/alive the user sounds
- confidence (0-100): how assured
- resistance (0-100): defensiveness or avoidance
- engagement (0-100): how present and involved
- congruence (0-100): alignment between words and tone
- sentiment (-1.0 to 1.0): emotional valence
- signal (string): one specific observational sentence about what is really happening beneath the words. Never generic.

JSON only, no markdown, no explanation."""

GEMINI_REST_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.5-flash:generateContent"
)

_http = httpx.AsyncClient(timeout=10)


@app.post("/analyze")
async def analyze_presence(request: Request):
    body = await request.json()
    user_text = body.get("user", "")
    model_text = body.get("model", "")
    if not user_text:
        return JSONResponse({"error": "no user text"}, 400)

    prompt = ANALYZE_PROMPT.format(user_text=user_text, model_text=model_text)
    try:
        resp = await _http.post(
            f"{GEMINI_REST_URL}?key={GEMINI_API_KEY}",
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.2},
            },
        )
        data = resp.json()
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        # Strip markdown fences if present
        text = text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3]
        presence = json.loads(text.strip())
        return presence
    except Exception as e:
        logger.error(f"Presence analysis failed: {e}")
        return JSONResponse({"error": str(e)}, 500)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    logger.info("RN client connected")

    gemini = GeminiLiveSession()

    try:
        await gemini.connect()

        async def gemini_to_rn():
            """Forward Gemini outputs to React Native client."""
            async for msg in gemini.receive():
                t = msg["type"]
                if t == "audio":
                    await ws.send_bytes(msg["data"])
                elif t == "presence":
                    await ws.send_text(msg["data"])
                elif t == "interrupted":
                    await ws.send_text('{"interrupted":true}')
                elif t in ("transcript_in", "transcript_out"):
                    await ws.send_text(json.dumps(
                        {t: msg["data"]}
                    ))

        async def rn_to_gemini():
            """Forward RN input to Gemini."""
            while True:
                frame = await ws.receive()
                if "bytes" in frame and frame["bytes"]:
                    await gemini.send_audio(frame["bytes"])
                elif "text" in frame and frame["text"]:
                    await gemini.send_text(frame["text"])
                elif frame.get("type") == "websocket.disconnect":
                    break

        tasks = [
            asyncio.create_task(gemini_to_rn()),
            asyncio.create_task(rn_to_gemini()),
        ]

        done, pending = await asyncio.wait(
            tasks, return_when=asyncio.FIRST_COMPLETED
        )
        for t in pending:
            t.cancel()
        for t in done:
            if t.exception():
                logger.error(f"Task error: {t.exception()}")

    except WebSocketDisconnect:
        logger.info("RN client disconnected")
    except Exception as e:
        logger.error(f"Session error: {e}")
    finally:
        await gemini.close()
        try:
            await ws.close()
        except Exception:
            pass
        logger.info("Session ended")


# Static mount for playground (must come after all route definitions)
PLAYGROUND = _ROOT / "playground"
app.mount("/playground", StaticFiles(directory=PLAYGROUND, html=True), name="playground")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host=HOST, port=PORT, reload=True)
