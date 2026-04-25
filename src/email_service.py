"""Thin Resend wrapper. Stateless — reads RESEND_API_KEY / RESEND_FROM at call time."""
import logging
import os

logger = logging.getLogger("ojaq-proxy.email")


def send_magic_link(email: str, verify_url: str) -> bool:
    """Send a magic-link email via Resend. Returns True on success, False otherwise.

    Logs the verify_url at INFO when not actually sent (e.g. RESEND_API_KEY
    missing) so devs can copy-paste the link from server logs during local testing.
    """
    api_key = os.getenv("RESEND_API_KEY", "")
    sender = os.getenv("RESEND_FROM", "Ojaq <hello@ojaq.ai>")
    if not api_key:
        logger.warning("RESEND_API_KEY not set — magic link NOT emailed: %s", verify_url)
        return False
    try:
        import resend  # lazy: package may not be installed yet on dev machines
    except ImportError:
        logger.error("resend package not installed; run: pip install resend")
        return False
    resend.api_key = api_key
    try:
        resend.Emails.send({
            "from": sender,
            "to": email,
            "subject": "Your link to continue with Ojaq",
            "html": (
                "<p>Tap to continue:</p>"
                f'<p><a href="{verify_url}">{verify_url}</a></p>'
                "<p>This link expires in one hour.</p>"
                "<p>If you didn't request this, ignore the message.</p>"
            ),
            "text": (
                f"Tap to continue: {verify_url}\n\n"
                "This link expires in one hour.\n"
                "If you didn't request this, ignore the message."
            ),
        })
        return True
    except Exception as e:
        logger.error("Resend send failed: %s", e)
        return False
