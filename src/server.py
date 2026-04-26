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
HOME_HTML    = _ROOT / "preview" / "index.html"  # / serves the one-page concierge experience now

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# ── Founding Members env (loaded but optional — billing inert until all set) ─
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
RESEND_FROM = os.getenv("RESEND_FROM", "Ojaq <hello@ojaq.ai>")
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "")
STRIPE_PRICE_STARTER = os.getenv("STRIPE_PRICE_STARTER", "")
STRIPE_PRICE_RITUAL = os.getenv("STRIPE_PRICE_RITUAL", "")
STRIPE_PRICE_EVERGREEN = os.getenv("STRIPE_PRICE_EVERGREEN", "")
APP_URL = os.getenv("APP_URL", "http://localhost:8000")
COOKIE_DOMAIN = os.getenv("COOKIE_DOMAIN", "")  # ".ojaq.ai" in prod, empty for dev

_BILLING_CONFIGURED = bool(
    RESEND_API_KEY and STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET
    and STRIPE_PRICE_STARTER and STRIPE_PRICE_RITUAL and STRIPE_PRICE_EVERGREEN
)
logger_init = logging.getLogger("ojaq-proxy.boot")
logger_init.info(f"founding-members billing configured: {_BILLING_CONFIGURED}")

app = FastAPI(title="ojaq-proxy")


@app.get("/")
async def home_page():
    """Serves the concierge-led one-page experience (formerly /preview).
    Same file is also reachable at /preview/ via the static mount, so
    bookmarks/links to /preview/ keep working during the transition."""
    return FileResponse(HOME_HTML, media_type="text/html")


@app.get("/landing-old")
async def legacy_landing():
    """Keeps the original marketing landing reachable for reference /
    rollback. Not linked from anywhere in the new flow."""
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

# Founding Members storage subdirs — wallet (per-email JSON) + auth (sessions, magic tokens)
WALLET_DIR = _DATA_DIR / "wallet"
AUTH_DIR = _DATA_DIR / "auth"
WALLET_DIR.mkdir(parents=True, exist_ok=True)
AUTH_DIR.mkdir(parents=True, exist_ok=True)

# Founding Members auth — magic link, sessions, /me, logout
from auth import router as auth_router, init_auth
init_auth(auth_dir=AUTH_DIR, app_url=APP_URL, cookie_domain=COOKIE_DOMAIN)
app.include_router(auth_router)

# Founding Members wallet — credit balance + per-session deduct
from wallet import router as wallet_router, init_wallet
init_wallet(wallet_dir=WALLET_DIR)
app.include_router(wallet_router)

# Hume Expression Measurement proxy — keeps the API key server-side
# and bridges browser PCM → Hume prosody → Plutchik label → browser.
from emotion_proxy import router as emotion_router  # noqa: E402
app.include_router(emotion_router)

# Founding Members billing — Stripe checkout + webhook → wallet credits
from billing import router as billing_router, init_billing
init_billing(
    stripe_secret_key=STRIPE_SECRET_KEY,
    webhook_secret=STRIPE_WEBHOOK_SECRET,
    price_starter=STRIPE_PRICE_STARTER,
    price_ritual=STRIPE_PRICE_RITUAL,
    price_evergreen=STRIPE_PRICE_EVERGREEN,
    app_url=APP_URL,
)
app.include_router(billing_router)


# ── Rate limiting (in-memory only, never persisted) ──────────────────────
_rate_map = {}  # ip -> [timestamp, ...]
_RATE_LIMIT = 3
_RATE_WINDOW = 86400  # 24 hours
_RATE_DISABLED = os.getenv("RATE_LIMIT_DISABLED", "").lower() in ("1", "true", "yes")


def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_rate(ip: str) -> bool:
    if _RATE_DISABLED:
        return True
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


@app.get("/session/status")
async def session_status(request: Request):
    if _RATE_DISABLED:
        return {"sessions_remaining": 99, "reset_at": None}
    ip = _get_client_ip(request)
    now = datetime.datetime.utcnow().timestamp()
    cutoff = now - _RATE_WINDOW
    timestamps = [t for t in _rate_map.get(ip, []) if t > cutoff]
    remaining = max(0, _RATE_LIMIT - len(timestamps))
    # Reset time = earliest timestamp + 24h
    reset_at = None
    if timestamps and remaining == 0:
        reset_at = datetime.datetime.utcfromtimestamp(
            min(timestamps) + _RATE_WINDOW
        ).isoformat()
    return {"sessions_remaining": remaining, "reset_at": reset_at}


@app.post("/session/start")
async def session_start(request: Request):
    # Authed users with credits/evergreen bypass the IP rate limit.
    # Authed users with NO credits → 402 paywall.
    # Unauthed users fall through to the existing IP rate limit (free tier).
    from auth import get_current_user_optional
    from wallet import get_summary

    email = get_current_user_optional(request)
    if email:
        summary = get_summary(email)
        if not (summary.get("evergreenActive") or (summary.get("credits") or 0) > 0):
            return JSONResponse(
                {"error": "no_credits", "paywall": True},
                status_code=402,
            )
        # Authed-with-credits → skip IP rate limit
    else:
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
        "email": email or None,  # null for unauthed sessions; useful for analytics
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


FEEDBACK_FILE = _DATA_DIR / "feedback.jsonl"


@app.post("/feedback")
async def submit_feedback(request: Request):
    body = await request.json()
    text = (body.get("text") or "")[:500].strip()
    if not text:
        return {"ok": False}
    entry = {
        "feedback": text,
        "duration_s": body.get("duration_s", 0),
        "framework": body.get("framework", ""),
        "timestamp": datetime.datetime.utcnow().isoformat(),
    }
    with open(FEEDBACK_FILE, "a") as f:
        f.write(json.dumps(entry) + "\n")
    logger.info(f"FEEDBACK: {text[:80]}")
    return {"ok": True}


@app.post("/session/action")
async def session_action(request: Request):
    body = await request.json()
    entry = {
        "event": "post_session_action",
        "session_id": body.get("session_id", ""),
        "action": body.get("action", ""),
        "timestamp": datetime.datetime.utcnow().isoformat(),
    }
    with open(SESSIONS_LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")
    return {"ok": True}


ANALYZE_PROMPT = """\
You are a presence reader. Given a conversation turn, report the \
user's emotional state.

User said: "{user_text}"
Coach said: "{model_text}"

Return ONLY a JSON object:
- energy (0-100): how alive they sound, not how loud
- confidence (0-100): real ground, not performance
- resistance (0-100): where they're guarding or avoiding
- engagement (0-100): how present they are in what they're saying
- congruence (0-100): does the way they say it match what they say
- sentiment (-1.0 to 1.0): emotional temperature
- signal (string): one sentence. What is actually happening \
beneath the words. Not a summary. Not analysis. A specific, \
human observation.

Rules for the signal:
- Write it to the user in second person ("you"), never third \
person ("the user" or "they").
- Observe HOW they are, not WHAT they said. Test: a good signal \
would land equally well for someone who didn't hear the conversation.
- Write it in the user's speaking language. If they spoke Turkish, \
signal in Turkish. If English, English.
- One sentence. No analytical hedging ("indicating", "suggesting", \
"underlying").
- Like whispering to a friend about what you just noticed -- \
specific, grounded, human.

Signal examples:
- Good: "You named the goal but went flat when you said it."
- Good: "Something opened up halfway through."
- Good: "There was a pause before you said it."
- Good (Turkish): "Icinde bir sey direniyor ama henuz adlandirmadin."
- Bad: "The user is expressing positive emotions." (clinical, third person)
- Bad: "You seem engaged with the topic." (generic, says nothing)
- Bad: "You mentioned your sister and opened up." (describes content)

JSON only, no markdown, no explanation."""

_ANALYZE_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3-flash-preview",
]
_REST_BASE = "https://generativelanguage.googleapis.com/v1beta/models/"

_http = httpx.AsyncClient(timeout=10)


@app.post("/analyze")
async def analyze_presence(request: Request):
    body = await request.json()
    user_text = body.get("user", "")
    model_text = body.get("model", "")
    if not user_text:
        return JSONResponse({"error": "no user text"}, 400)

    prompt = ANALYZE_PROMPT.format(user_text=user_text, model_text=model_text)
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2},
    }

    # Try each model in the fallback chain
    last_error = None
    for model in _ANALYZE_MODELS:
        try:
            resp = await _http.post(
                f"{_REST_BASE}{model}:generateContent?key={GEMINI_API_KEY}",
                json=payload,
            )
            if resp.status_code == 503:
                logger.warning(f"Analyze: {model} returned 503, trying next")
                continue
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
            last_error = e
            logger.warning(f"Analyze: {model} failed: {e}")
            continue

    logger.error(f"Presence analysis failed on all models: {last_error}")
    return JSONResponse({"error": "all models unavailable"}, 503)


# ── Room presence — observes the conversation flow during Concierge ──
# Concierge is a character; THIS is the meta-intelligence that watches
# the whole exchange and decides whether to route to a module. Lives
# alongside the spoken conversation, never participates — it just
# watches and acts. Same async-per-turn cadence as /analyze.
ROOM_OBSERVE_PROMPT = """\
You are the room observer in Ojaq. Watch the conversation between
the user and Ojaq, classify whether a navigation event has happened.

EVENTS

  ROUTE — only valid when current framework is "concierge". The
  user has agreed to enter a specific module and the module is
  identifiable from context. Modules: coaching, selfDiscovery,
  friend, meditation, voice, together.

  END — the conversation is closing. In a module, closing is
  mutual: if Ojaq is still asking the next question or working
  the material with the user, the user is in session, regardless
  of what they said.

  WAIT — anything else.

The user's words trigger these events. Ojaq's words can confirm
or reject (asking the next question rejects a close), but never
alone trigger an action.

Confidence reflects clarity of the signal. Module-end requires
≥ 0.7; concierge actions ≥ 0.4. Below the floor: return wait.

OUTPUT — strict JSON, no markdown:
  {{"action": "wait"}}
  {{"action": "route", "module_id": "<id>", "confidence": 0.0..1.0}}
  {{"action": "end", "confidence": 0.0..1.0}}

Current framework: {current_framework}

Conversation:
{history}
"""


@app.post("/room/observe")
async def room_observe(request: Request):
    body = await request.json()
    history = body.get("history", [])  # [{"role": "user"|"ojaq", "text": "..."}]
    current_framework = (body.get("current_framework") or "concierge").strip()
    if not isinstance(history, list) or not history:
        return JSONResponse({"action": "wait"})

    # Speaker label depends on whose voice we're watching. Same observer,
    # both contexts — concierge entry routing AND module session wrap-up.
    other_role = "Concierge" if current_framework == "concierge" else "Ojaq"
    rendered = "\n".join(
        f"{('User' if t.get('role') == 'user' else other_role)}: {t.get('text','').strip()}"
        for t in history if t.get("text")
    )
    prompt = ROOM_OBSERVE_PROMPT.format(
        history=rendered,
        current_framework=current_framework,
    )
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        # temperature 0 — same dialog ALWAYS produces same decision.
        # 0.1 had observable variance: identical "Concierge said going,
        # user said yes" inputs returned wait on one call, route on the
        # next. Routing is a classification, not a generation — the
        # exploration noise costs us turn-level latency in the user's
        # perception (one wait = one extra round of "hadi geçelim").
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
    }

    last_error = None
    for model in _ANALYZE_MODELS:
        try:
            resp = await _http.post(
                f"{_REST_BASE}{model}:generateContent?key={GEMINI_API_KEY}",
                json=payload,
            )
            if resp.status_code == 503:
                continue
            data = resp.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.endswith("```"):
                text = text[:-3]
            decision = json.loads(text.strip())
            # Defensive gates — confidence floors differ by context.
            # Concierge → route is cheap (the user explicitly came here
            # to be routed). Module → end is expensive (false positive
            # pulls the user out of a working session). Hence the
            # higher bar in modules.
            action = decision.get("action")
            if action == "route":
                conf = float(decision.get("confidence", 0))
                mid = decision.get("module_id", "")
                # Routes only valid in concierge
                if current_framework != "concierge":
                    return JSONResponse({"action": "wait"})
                if conf < 0.4 or mid not in {
                    "coaching", "selfDiscovery", "friend",
                    "meditation", "voice", "together",
                }:
                    return JSONResponse({"action": "wait"})
            elif action == "end":
                conf = float(decision.get("confidence", 0))
                # Higher floor in modules — pulling out mid-conversation
                # on a false positive is the bigger cost.
                floor = 0.7 if current_framework != "concierge" else 0.4
                if conf < floor:
                    return JSONResponse({"action": "wait"})
            return JSONResponse(decision)
        except Exception as e:
            last_error = e
            continue

    logger.warning(f"/room/observe failed on all models: {last_error}")
    return JSONResponse({"action": "wait"})


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


@app.get("/playground/manifest.json")
async def playground_manifest():
    """Serve PWA manifest with the correct MIME type (application/manifest+json)."""
    return FileResponse(
        PLAYGROUND / "manifest.json",
        media_type="application/manifest+json",
    )


app.mount("/playground", StaticFiles(directory=PLAYGROUND, html=True), name="playground")

# Single-page preview prototype — landing + playground in one DOM context.
# Production routes (/ and /playground/) untouched; /preview is a sandbox.
PREVIEW = _ROOT / "preview"
if PREVIEW.is_dir():
    app.mount("/preview", StaticFiles(directory=PREVIEW, html=True), name="preview")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host=HOST, port=PORT, reload=True)
