"""Magic-link auth + 30-day session cookies.

Storage:
  /data/auth/tokens.json    — magic-link tokens (single-use, 1h expiry)
  /data/auth/sessions.json  — session cookies (30d expiry)

Both are JSON maps: token -> { email, created, expires }. Read-modify-write
is atomic via tmp+rename on POSIX. Expired entries are purged on read.
"""
import datetime
import json
import logging
import re
import secrets
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel

from email_service import send_magic_link

logger = logging.getLogger("ojaq-proxy.auth")

# ── Constants ────────────────────────────────────────────────────────────────
COOKIE_NAME = "ojaq_session"
SESSION_TTL_SECONDS = 30 * 24 * 3600        # 30 days
MAGIC_TOKEN_TTL_SECONDS = 3600              # 1 hour
MAGIC_RATE_LIMIT = 5                        # max magic-link requests per IP per window
MAGIC_RATE_WINDOW = 3600                    # 1 hour

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# ── Module state (set by init_auth from server.py) ───────────────────────────
_AUTH_DIR: Optional[Path] = None
_APP_URL: str = ""
_COOKIE_DOMAIN: str = ""

# ── Magic-link rate limit (in-memory, per IP) ────────────────────────────────
_magic_rate_map: dict[str, list[float]] = {}


# ── Time helpers ─────────────────────────────────────────────────────────────
def _now_iso() -> str:
    return datetime.datetime.utcnow().isoformat()


def _expires_iso(seconds: int) -> str:
    return (datetime.datetime.utcnow() + datetime.timedelta(seconds=seconds)).isoformat()


def _is_expired(iso_ts: str) -> bool:
    try:
        return datetime.datetime.fromisoformat(iso_ts) < datetime.datetime.utcnow()
    except Exception:
        return True


# ── JSON file helpers (atomic write via tmp+rename) ──────────────────────────
def _read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.exception("failed to read %s; treating as empty", path)
        return {}


def _atomic_write_json(path: Path, data: dict):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(path)  # atomic on POSIX


def _tokens_file() -> Path:
    return _AUTH_DIR / "tokens.json"


def _sessions_file() -> Path:
    return _AUTH_DIR / "sessions.json"


def _purge_expired(path: Path) -> dict:
    """Read JSON map, drop expired entries, write back if anything was removed."""
    data = _read_json(path)
    cleaned = {k: v for k, v in data.items() if not _is_expired(v.get("expires", ""))}
    if len(cleaned) != len(data):
        _atomic_write_json(path, cleaned)
    return cleaned


# ── Rate-limit helpers ───────────────────────────────────────────────────────
def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_magic_rate(ip: str) -> bool:
    now = datetime.datetime.utcnow().timestamp()
    cutoff = now - MAGIC_RATE_WINDOW
    timestamps = [t for t in _magic_rate_map.get(ip, []) if t > cutoff]
    _magic_rate_map[ip] = timestamps
    return len(timestamps) < MAGIC_RATE_LIMIT


def _record_magic_rate(ip: str):
    _magic_rate_map.setdefault(ip, []).append(datetime.datetime.utcnow().timestamp())


# ── Cookie helpers ───────────────────────────────────────────────────────────
def _set_session_cookie(response: Response, token: str):
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=bool(_COOKIE_DOMAIN),       # secure in prod (cookie domain set), not in local dev
        samesite="lax",
        domain=_COOKIE_DOMAIN or None,
        path="/",
    )


def _clear_session_cookie(response: Response):
    response.delete_cookie(
        key=COOKIE_NAME,
        domain=_COOKIE_DOMAIN or None,
        path="/",
    )


# ── Public auth helper for other routes (wallet, billing) ────────────────────
def get_current_user_optional(request: Request) -> Optional[str]:
    """Return the email tied to a valid session cookie, or None.

    Used as a soft auth check — does NOT raise. Routes that REQUIRE auth
    should check the return value and respond with 401 themselves.
    """
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    sessions = _read_json(_sessions_file())
    entry = sessions.get(token)
    if not entry or _is_expired(entry.get("expires", "")):
        return None
    return (entry.get("email") or "").lower()


# ── Routes ───────────────────────────────────────────────────────────────────
router = APIRouter()


class MagicLinkRequest(BaseModel):
    email: str


@router.post("/auth/magic-link")
async def magic_link(req: MagicLinkRequest, request: Request):
    email = (req.email or "").strip().lower()
    if not EMAIL_RE.match(email):
        return JSONResponse({"error": "invalid_email"}, 400)

    ip = _client_ip(request)
    if not _check_magic_rate(ip):
        return JSONResponse({"error": "rate_limit"}, 429)
    _record_magic_rate(ip)

    token = secrets.token_urlsafe(32)
    tokens = _purge_expired(_tokens_file())
    tokens[token] = {
        "email": email,
        "created": _now_iso(),
        "expires": _expires_iso(MAGIC_TOKEN_TTL_SECONDS),
    }
    _atomic_write_json(_tokens_file(), tokens)

    verify_url = f"{_APP_URL}/auth/verify?token={token}"
    sent = send_magic_link(email, verify_url)
    return {"ok": True, "message": "sent" if sent else "logged"}


@router.get("/auth/verify")
async def verify(token: str):
    tokens = _purge_expired(_tokens_file())
    entry = tokens.pop(token, None)  # single-use: remove on consume
    if not entry:
        return JSONResponse({"error": "invalid_or_expired_token"}, 400)
    _atomic_write_json(_tokens_file(), tokens)

    # Issue a fresh session cookie
    session_token = secrets.token_urlsafe(32)
    sessions = _purge_expired(_sessions_file())
    sessions[session_token] = {
        "email": entry["email"],
        "created": _now_iso(),
        "expires": _expires_iso(SESSION_TTL_SECONDS),
    }
    _atomic_write_json(_sessions_file(), sessions)

    redirect = RedirectResponse(url="/playground/?welcome=1", status_code=302)
    _set_session_cookie(redirect, session_token)
    return redirect


@router.get("/me")
async def me(request: Request):
    email = get_current_user_optional(request)
    if not email:
        return JSONResponse({"error": "unauthorized"}, 401)
    # Lazy import — wallet module imports auth, so a top-level import here would loop.
    try:
        from wallet import get_summary
        summary = get_summary(email)
    except Exception:
        logger.exception("wallet summary failed for %s", email)
        summary = {"credits": 0, "plan": None, "evergreenActive": False}
    return {"email": email, **summary}


@router.post("/auth/logout")
async def logout(request: Request):
    response = JSONResponse({"ok": True})
    token = request.cookies.get(COOKIE_NAME)
    if token:
        sessions = _read_json(_sessions_file())
        if token in sessions:
            del sessions[token]
            _atomic_write_json(_sessions_file(), sessions)
    _clear_session_cookie(response)
    return response


# ── Init (called from server.py at module load) ──────────────────────────────
def init_auth(*, auth_dir: Path, app_url: str, cookie_domain: str):
    global _AUTH_DIR, _APP_URL, _COOKIE_DOMAIN
    _AUTH_DIR = auth_dir
    _APP_URL = app_url.rstrip("/")
    _COOKIE_DOMAIN = cookie_domain
    logger.info(
        "auth initialized: app_url=%s cookie_domain=%s tokens=%s sessions=%s",
        _APP_URL, _COOKIE_DOMAIN or "(unset)",
        _tokens_file(), _sessions_file(),
    )
