# Founding Members — manual setup

External-account configuration required for the Founding Members
billing layer. Code-side changes ship in branch `feat/founding-members`;
this doc covers what to wire up by hand in Stripe / Resend / Railway.

Order matters — webhook secret depends on a created webhook endpoint;
Price IDs depend on created Products. Follow top-to-bottom.

---

## 1. Resend (transactional email — magic links)

**Free tier** is sufficient for early Founding Members traffic
(3,000/month, 100/day).

1. Sign up at https://resend.com.
2. **Verify the `ojaq.ai` domain.** Add the DNS records Resend
   provides (TXT for SPF, CNAME for DKIM, optionally TXT for DMARC).
   Domain verification typically completes in minutes once DNS propagates.
3. **Create an API key**: dashboard → API Keys → Create.
   Scope: "Sending access" → ojaq.ai.
4. **Save the key** for Railway env (next section).

Sender configuration:
- **From** address: `Ojaq <hello@ojaq.ai>` (or any verified-domain mailbox)
- Set via `RESEND_FROM` env. The default in code is
  `Ojaq <hello@ojaq.ai>` — change if you want a different mailbox.

Without `RESEND_API_KEY` the magic link is logged to stdout instead
of emailed (useful for local dev).

---

## 2. Stripe Products + Prices

**Use Test Mode first.** Switch to Live Mode only when you're ready
for real charges.

For each of the three packages, create a Product with a one-time
(non-recurring) Price:

| Product name | Price | Description | Billing |
|---|---|---|---|
| **Starter** | **$29 USD** | 10 sessions | One-time |
| **Ritual** | **$79 USD** | 30 sessions | One-time |
| **Evergreen** | **$199 USD / year** | Unlimited sessions for 365 days | One-time |

Steps in dashboard:
1. Stripe Dashboard → Products → **Add product**
2. Name + description per the table above
3. **Pricing → One-time** (NOT recurring). Confirm "Recurring" is
   un-toggled.
4. Save → copy the **Price ID** (starts with `price_…`)
5. Repeat for the other two.

> **Why one-time for Evergreen?** The codebase activates 365 days of
> unlimited use upon `checkout.session.completed`. There's no
> auto-renewal — user buys again at expiry. If you want recurring
> renewal later, swap to `mode="subscription"` in `src/billing.py`
> and add an `invoice.paid` handler. Out of scope for v1.

**Test card for Test Mode**: `4242 4242 4242 4242`, any future
expiry, any CVC, any ZIP.

---

## 3. Stripe Webhook

The webhook secret is needed for signature validation in
`src/billing.py`.

1. Stripe Dashboard → Developers → Webhooks → **Add endpoint**
2. **Endpoint URL**:
   - Production: `https://www.ojaq.ai/stripe/webhook`
   - Local dev: use `stripe listen --forward-to localhost:8000/stripe/webhook`
     (see "Local dev" below)
3. **Events to subscribe to**:
   - `checkout.session.completed` (required)
   - `invoice.paid` (only if/when you switch evergreen to subscription)
4. Save → copy the **Signing secret** (starts with `whsec_…`)

---

## 4. Railway environment variables

Add these to the `ojaq-proxy` service env (Project → Service → Variables):

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | from Resend §1 |
| `RESEND_FROM` | `Ojaq <hello@ojaq.ai>` (or your verified mailbox) |
| `STRIPE_SECRET_KEY` | `sk_test_…` (Test Mode) or `sk_live_…` (Live) |
| `STRIPE_WEBHOOK_SECRET` | from Webhook §3 |
| `STRIPE_PRICE_STARTER` | `price_…` for Starter |
| `STRIPE_PRICE_RITUAL` | `price_…` for Ritual |
| `STRIPE_PRICE_EVERGREEN` | `price_…` for Evergreen |
| `APP_URL` | `https://www.ojaq.ai` (no trailing slash) |
| `COOKIE_DOMAIN` | `.ojaq.ai` (leading dot — covers any subdomain) |

After setting, redeploy. The boot log will show:
```
founding-members billing configured: True
billing initialized: configured=True test_mode=True
```
(`test_mode=True` if `STRIPE_SECRET_KEY` starts with `sk_test_`,
`False` for live.)

If `_BILLING_CONFIGURED` reports False, the routes still mount but
return 503 `billing_not_configured` — server stays up for non-billing
flows.

---

## 5. Local dev — testing the full flow

```bash
# In one terminal: run the server
cd ojaq-proxy
python src/server.py

# In another: install Stripe CLI and forward webhooks to localhost
# https://stripe.com/docs/stripe-cli
stripe login
stripe listen --forward-to localhost:8000/stripe/webhook
# This prints a webhook signing secret — copy it to your local .env
# as STRIPE_WEBHOOK_SECRET (different from the production one).

# In your local .env file, set:
RESEND_API_KEY=re_test_…              # optional — magic link logged to stdout if unset
STRIPE_SECRET_KEY=sk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…         # from `stripe listen` output
STRIPE_PRICE_STARTER=price_…          # use Test Mode prices
STRIPE_PRICE_RITUAL=price_…
STRIPE_PRICE_EVERGREEN=price_…
APP_URL=http://localhost:8000
COOKIE_DOMAIN=                        # leave empty for local dev
```

Then in your browser:
1. Open `http://localhost:8000/playground/`
2. Click "Sign in" chip → enter `you@ojaq.ai`
3. Magic link is logged to server stdout (`MAGIC_LINK (not emailed): http://localhost:8000/auth/verify?token=…`).
   Open that URL → cookie set → redirected to playground.
4. Chip now shows your email + `0` credits.
5. Click Start → pre-flight catches "no credits" → paywall opens.
6. Click "Starter" → redirects to Stripe Checkout (test mode).
7. Pay with `4242 4242 4242 4242` → Stripe redirects back.
8. The `stripe listen` terminal shows the webhook firing.
9. Server log shows `webhook: +10 credits (starter) for you@ojaq.ai`.
10. Chip updates to `you@ojaq.ai · 10` after the page reload.

---

## 6. Switching to live mode

Once tested in test mode:
1. Stripe Dashboard → toggle to **Live Mode**.
2. Repeat §2 (create the same three Products + Prices in Live).
3. Repeat §3 (create a Live webhook endpoint pointing at
   `https://www.ojaq.ai/stripe/webhook`).
4. Update Railway env: replace all `sk_test_…` / `whsec_…test…` /
   test-mode `price_…` IDs with their Live counterparts.
5. Redeploy. Verify boot log shows `test_mode=False`.

---

## 7. Operational notes

- **Wallet storage**: `/data/wallet/<safe-email>.json` per user, on
  Railway Volume. To inspect a user's balance:
  `railway ssh --service ojaq-proxy "cat /data/wallet/gokhan_at_ojaq_dot_ai.json"`
  (`MSYS_NO_PATHCONV=1` on Git Bash if path conversion bites you).
- **Sessions storage**: `/data/auth/sessions.json` (single file, all
  active cookie tokens). Tokens persist across container restarts.
- **Magic-link rate limit**: 5/hr per IP, in-memory (resets on
  container restart). Fine for early traffic; revisit if needed.
- **Webhook idempotency**: dedupes by `stripe_session.id`. Replays
  return `{ok:true, duplicate:true}`. No double-credit risk.
- **Refunds**: not handled in v1. If you refund manually in Stripe,
  edit the user's wallet JSON file directly to deduct the credits.
  A `wallet.refund_session()` helper is a good follow-up if refunds
  become routine.

---

## 8. Quick env-wiring sanity check

After setting Railway env, hit `https://www.ojaq.ai/me` in a logged-out
browser — should return `401 {"error":"unauthorized"}`. That confirms
the auth router is mounted and reachable.

Then sign in via the playground UI; `/me` now returns
`{email, credits, plan, evergreenActive}`. That confirms the cookie
flow + wallet read.

Click a paywall package → if Stripe Checkout opens, the secret key +
price IDs are correct. If you see 503 `billing_not_configured`, one
of the env vars is unset.

After a test-mode purchase, verify the wallet file appears under
`/data/wallet/`. If it doesn't, the webhook secret mismatch is the
likely culprit — check `stripe listen` output / Stripe webhook log
for delivery errors.
