"""Stripe checkout + webhook → wallet credits.

Two routes:
  POST /stripe/checkout {package}  — auth required, returns Stripe Checkout URL
  POST /stripe/webhook             — receives checkout.session.completed, credits wallet

All three packages use one-time payment mode (mode="payment"):
  - starter   ($29)  → +10 session credits
  - ritual    ($79)  → +30 session credits
  - evergreen ($199) → 365 days unlimited (no rollover at expiry)

Stripe Prices in your dashboard should be configured as one-time
(non-recurring) to match. If you later switch evergreen to a recurring
subscription, this module needs mode="subscription" and an additional
handler for invoice.paid renewals.

Idempotency: Stripe retries failed webhook deliveries. We dedupe on
session.id via wallet.has_processed_stripe_session before crediting.
"""
import datetime
import logging
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import wallet
from auth import get_current_user_optional

logger = logging.getLogger("ojaq-proxy.billing")

# ── Module state (set by init_billing from server.py) ────────────────────────
_STRIPE_SECRET_KEY: str = ""
_STRIPE_WEBHOOK_SECRET: str = ""
_PRICE_IDS: dict[str, str] = {}   # package -> Stripe Price ID
_APP_URL: str = ""

# Per-package configuration. Credits for one-time, days for time-bound.
PACKAGES = {
    "starter":   {"credits": 10},
    "ritual":    {"credits": 30},
    "evergreen": {"days": 365},
}


def _stripe_module():
    """Lazy-load stripe so the server can boot before pip install."""
    try:
        import stripe
        return stripe
    except ImportError:
        return None


def _sf(obj, key, default=None):
    """Safe field access for Stripe StripeObject (no .get method) or plain dict.

    Stripe Python SDK v11+ StripeObject does NOT inherit from dict — calling
    .get(key, default) on it raises AttributeError because Python's attribute
    lookup falls through __getattr__ → __getitem__("get") → KeyError.
    Use [] / __getitem__ which is implemented; default on KeyError.
    """
    if obj is None:
        return default
    try:
        v = obj[key]
    except (KeyError, TypeError):
        return default
    return v if v is not None else default


def _is_configured() -> bool:
    """All three checkout-side env vars + at least the relevant price IDs must be set."""
    return bool(_STRIPE_SECRET_KEY and _APP_URL and any(_PRICE_IDS.values()))


# ── Routes ───────────────────────────────────────────────────────────────────
router = APIRouter()


class CheckoutRequest(BaseModel):
    package: str  # "starter" | "ritual" | "evergreen"
    return_path: str | None = None  # surface the buyer came from; whitelist-validated below


# Whitelist of allowed post-checkout return paths. Anything else falls back
# to /playground/ — prevents open-redirect via Stripe success_url.
_ALLOWED_RETURN_PATHS = {"/playground/", "/preview/"}


@router.post("/stripe/checkout")
async def checkout(req: CheckoutRequest, request: Request):
    email = get_current_user_optional(request)
    if not email:
        return JSONResponse({"error": "unauthorized"}, 401)

    package = (req.package or "").strip().lower()
    if package not in PACKAGES:
        return JSONResponse({"error": "invalid_package"}, 400)

    price_id = _PRICE_IDS.get(package, "")
    if not _STRIPE_SECRET_KEY or not price_id:
        return JSONResponse({"error": "billing_not_configured"}, 503)

    stripe = _stripe_module()
    if stripe is None:
        return JSONResponse({"error": "stripe_package_missing"}, 503)

    # Normalize and whitelist the return path so the Stripe success_url
    # always points to a known surface, not an attacker-supplied path.
    rp = (req.return_path or "").strip()
    if not rp.endswith("/"):
        rp += "/"
    if rp not in _ALLOWED_RETURN_PATHS:
        rp = "/playground/"

    stripe.api_key = _STRIPE_SECRET_KEY
    try:
        session = stripe.checkout.Session.create(
            mode="payment",
            line_items=[{"price": price_id, "quantity": 1}],
            success_url=f"{_APP_URL}{rp}?welcome=1&purchase=success",
            cancel_url=f"{_APP_URL}{rp}?purchase=cancel",
            customer_email=email,
            metadata={"email": email, "package": package},
        )
    except Exception as e:
        logger.exception("stripe checkout create failed for %s/%s", email, package)
        return JSONResponse({"error": "stripe_error", "detail": str(e)}, 502)

    return {"url": session.url}


@router.post("/stripe/webhook")
async def webhook(request: Request):
    if not _STRIPE_WEBHOOK_SECRET:
        return JSONResponse({"error": "billing_not_configured"}, 503)

    stripe = _stripe_module()
    if stripe is None:
        return JSONResponse({"error": "stripe_package_missing"}, 503)

    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, _STRIPE_WEBHOOK_SECRET)
    except ValueError:
        logger.warning("webhook: invalid payload")
        return JSONResponse({"error": "invalid_payload"}, 400)
    except stripe.error.SignatureVerificationError:
        logger.warning("webhook: signature mismatch")
        return JSONResponse({"error": "invalid_signature"}, 400)
    except Exception as e:
        logger.exception("webhook: construct_event failed")
        return JSONResponse({"error": "construct_failed", "detail": str(e)}, 400)

    event_type = _sf(event, "type", "")
    if event_type != "checkout.session.completed":
        # Acknowledge but ignore other event types (subscription updates, etc.)
        logger.info("webhook ignored event=%s", event_type)
        return {"ok": True, "ignored": event_type}

    session = _sf(_sf(event, "data", {}), "object", {})
    metadata = _sf(session, "metadata", {}) or {}
    email = (
        (_sf(metadata, "email", "") or _sf(session, "customer_email", "") or "")
        .strip().lower()
    )
    package = (_sf(metadata, "package", "") or "").strip().lower()
    stripe_session_id = _sf(session, "id", "") or ""

    if not email or package not in PACKAGES:
        logger.warning("webhook: missing/invalid metadata email=%r package=%r", email, package)
        return JSONResponse({"error": "missing_metadata"}, 400)

    # Idempotency — Stripe retries failed deliveries. Skip if already processed.
    if wallet.has_processed_stripe_session(email, stripe_session_id):
        logger.info("webhook idempotent skip: %s already processed for %s", stripe_session_id, email)
        return {"ok": True, "duplicate": True}

    try:
        if package == "evergreen":
            expires = (datetime.datetime.utcnow()
                       + datetime.timedelta(days=PACKAGES["evergreen"]["days"])).isoformat()
            wallet.set_evergreen(email, expires, stripe_session_id)
            logger.info("webhook: evergreen activated for %s until %s", email, expires)
        else:
            credits = PACKAGES[package]["credits"]
            wallet.add_credits(email, credits, package, stripe_session_id)
            logger.info("webhook: +%d credits (%s) for %s", credits, package, email)
    except Exception:
        logger.exception("webhook: wallet update failed for %s/%s", email, package)
        return JSONResponse({"error": "wallet_update_failed"}, 500)

    return {"ok": True}


# ── Init (called from server.py) ─────────────────────────────────────────────
def init_billing(*, stripe_secret_key: str, webhook_secret: str,
                 price_starter: str, price_ritual: str, price_evergreen: str,
                 app_url: str):
    global _STRIPE_SECRET_KEY, _STRIPE_WEBHOOK_SECRET, _PRICE_IDS, _APP_URL
    _STRIPE_SECRET_KEY = stripe_secret_key
    _STRIPE_WEBHOOK_SECRET = webhook_secret
    _PRICE_IDS = {
        "starter": price_starter,
        "ritual": price_ritual,
        "evergreen": price_evergreen,
    }
    _APP_URL = app_url.rstrip("/")
    logger.info("billing initialized: configured=%s test_mode=%s",
                _is_configured(),
                _STRIPE_SECRET_KEY.startswith("sk_test_") if _STRIPE_SECRET_KEY else "n/a")
