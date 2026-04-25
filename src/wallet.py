"""Per-email credit wallet.

Storage: /data/wallet/<safe-email>.json. One file per user, created on first
credit-add (purchase webhook in billing.py). Atomic write via tmp+rename.
fcntl file lock guards read-modify-write on POSIX; Windows dev falls through
without locking.

Schema:
  {
    "email": "user@example.com",
    "credits": 30,
    "plan": "ritual" | "starter" | "evergreen" | null,
    "evergreenExpiresAt": "<ISO>" | null,
    "history": [
      {"type": "purchase", "package": "ritual", "amount_credits": 30,
       "stripe_session": "cs_…", "ts": "<ISO>"},
      {"type": "session", "ts": "<ISO>"}
    ]
  }

Endpoints:
  GET  /wallet           — auth required, returns balance + last 20 history
  POST /wallet/deduct    — auth required, -1 credit (or no-op if evergreen)
"""
import contextlib
import datetime
import json
import logging
import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from auth import get_current_user_optional

logger = logging.getLogger("ojaq-proxy.wallet")

_WALLET_DIR: Optional[Path] = None
HISTORY_RESPONSE_LIMIT = 20  # how many recent entries returned in /wallet


# ── Filename safety ──────────────────────────────────────────────────────────
_UNSAFE_CHARS = re.compile(r"[^a-z0-9_]")


def _safe_filename(email: str) -> str:
    """user@example.com -> user_at_example_dot_com.json — lowercased, debuggable."""
    s = email.strip().lower()
    s = s.replace("@", "_at_").replace(".", "_dot_").replace("+", "_plus_")
    s = _UNSAFE_CHARS.sub("", s)
    return s + ".json"


def _wallet_path(email: str) -> Path:
    return _WALLET_DIR / _safe_filename(email)


# ── Time helpers ─────────────────────────────────────────────────────────────
def _now_iso() -> str:
    return datetime.datetime.utcnow().isoformat()


def _is_past(iso_ts: Optional[str]) -> bool:
    if not iso_ts:
        return True
    try:
        return datetime.datetime.fromisoformat(iso_ts) < datetime.datetime.utcnow()
    except Exception:
        return True


# ── File lock (POSIX only — graceful no-op on Windows) ───────────────────────
@contextlib.contextmanager
def _file_lock(path: Path):
    try:
        import fcntl
    except ImportError:
        yield
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    f = open(lock_path, "w")
    try:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
        except Exception:
            pass
        f.close()


# ── Read / write ─────────────────────────────────────────────────────────────
def _default_wallet(email: str) -> dict:
    return {
        "email": email,
        "credits": 0,
        "plan": None,
        "evergreenExpiresAt": None,
        "history": [],
    }


def _read_wallet(email: str) -> dict:
    """Return wallet dict (default if file missing or unreadable)."""
    p = _wallet_path(email)
    if not p.exists():
        return _default_wallet(email)
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        logger.exception("failed to read wallet %s; treating as empty", p)
        return _default_wallet(email)


def _atomic_write_wallet(email: str, data: dict):
    p = _wallet_path(email)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(p)


# ── Internal mutators (also used by billing.py in commit 4) ──────────────────
def add_credits(email: str, amount: int, package: str, stripe_session: str = "") -> dict:
    """Increment credits for a one-time purchase (starter/ritual). Returns new wallet."""
    p = _wallet_path(email)
    with _file_lock(p):
        w = _read_wallet(email)
        w["credits"] = int(w.get("credits") or 0) + int(amount)
        w["plan"] = package
        w.setdefault("history", []).append({
            "type": "purchase",
            "package": package,
            "amount_credits": amount,
            "stripe_session": stripe_session,
            "ts": _now_iso(),
        })
        _atomic_write_wallet(email, w)
    return w


def set_evergreen(email: str, expires_at_iso: str, stripe_session: str = "") -> dict:
    """Activate evergreen plan with an expiry. Existing credits remain (no rollover at expiry)."""
    p = _wallet_path(email)
    with _file_lock(p):
        w = _read_wallet(email)
        w["plan"] = "evergreen"
        w["evergreenExpiresAt"] = expires_at_iso
        w.setdefault("history", []).append({
            "type": "purchase",
            "package": "evergreen",
            "expires_at": expires_at_iso,
            "stripe_session": stripe_session,
            "ts": _now_iso(),
        })
        _atomic_write_wallet(email, w)
    return w


def evergreen_active(wallet: dict) -> bool:
    if wallet.get("plan") != "evergreen":
        return False
    return not _is_past(wallet.get("evergreenExpiresAt"))


def get_summary(email: str) -> dict:
    """Snapshot for /me endpoint: credits/plan/evergreenActive, no history."""
    w = _read_wallet(email)
    return {
        "credits": int(w.get("credits") or 0),
        "plan": w.get("plan"),
        "evergreenActive": evergreen_active(w),
    }


# ── Routes ───────────────────────────────────────────────────────────────────
router = APIRouter()


@router.get("/wallet")
async def get_wallet(request: Request):
    email = get_current_user_optional(request)
    if not email:
        return JSONResponse({"error": "unauthorized"}, 401)
    w = _read_wallet(email)
    return {
        "credits": int(w.get("credits") or 0),
        "plan": w.get("plan"),
        "evergreenExpiresAt": w.get("evergreenExpiresAt"),
        "evergreenActive": evergreen_active(w),
        "history": (w.get("history") or [])[-HISTORY_RESPONSE_LIMIT:],
    }


@router.post("/wallet/deduct")
async def deduct(request: Request):
    email = get_current_user_optional(request)
    if not email:
        return JSONResponse({"error": "unauthorized"}, 401)
    p = _wallet_path(email)
    with _file_lock(p):
        w = _read_wallet(email)
        # Evergreen: log session, do NOT decrement
        if evergreen_active(w):
            w.setdefault("history", []).append({"type": "session", "ts": _now_iso()})
            _atomic_write_wallet(email, w)
            return {"ok": True, "credits": int(w.get("credits") or 0),
                    "plan": "evergreen", "evergreenActive": True}
        # Credits path
        credits = int(w.get("credits") or 0)
        if credits <= 0:
            return {"ok": False, "reason": "no_credits"}
        w["credits"] = credits - 1
        w.setdefault("history", []).append({"type": "session", "ts": _now_iso()})
        _atomic_write_wallet(email, w)
    return {"ok": True, "credits": w["credits"], "plan": w.get("plan"),
            "evergreenActive": False}


# ── Init (called from server.py) ─────────────────────────────────────────────
def init_wallet(*, wallet_dir: Path):
    global _WALLET_DIR
    _WALLET_DIR = wallet_dir
    logger.info("wallet initialized: dir=%s", _WALLET_DIR)
