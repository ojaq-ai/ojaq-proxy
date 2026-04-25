// ── Founding Members client ─────────────────────────────────────────────
// Auth (magic link + cookie sessions), account chip, login modal.
// Paywall and credit-deduct-on-start arrive in a follow-up commit.

const log = (msg) => console.log(`[ojaq] [billing] ${msg}`);

let _state = null;     // { email, credits, plan, evergreenActive } | null
let _suppressed = false; // true while a session is running — chip hidden

// ── DOM handles (resolved on init) ──────────────────────────────────────
let $chip, $btn, $label, $menu, $menuEmail, $menuCredits, $signout;
let $modal, $email, $submit, $note, $form, $sent, $sentMsg, $close;
let $paywall, $paywallLoginCta, $paywallLoginLink, $paywallClose, $paywallPkgs;

// ── /me fetch ──────────────────────────────────────────────────────────
async function fetchMe() {
  try {
    const r = await fetch('/me', { credentials: 'same-origin' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    log(`/me failed: ${e.message}`);
    return null;
  }
}

// ── Render the chip from current state ──────────────────────────────────
function renderChip() {
  if (_suppressed) {
    $chip.classList.add('hidden');
    return;
  }
  $chip.classList.remove('hidden');
  if (!_state) {
    $label.textContent = 'Sign in';
    $menu.classList.remove('open');
    return;
  }
  const emailShort = _state.email.length > 22
    ? _state.email.slice(0, 20) + '…'
    : _state.email;
  const creditLabel = _state.evergreenActive
    ? '∞'
    : `${_state.credits ?? 0}`;
  $label.textContent = `${emailShort} · ${creditLabel}`;
  $menuEmail.textContent = _state.email;
  $menuCredits.textContent = _state.evergreenActive
    ? 'Evergreen — unlimited'
    : `${_state.credits ?? 0} session${(_state.credits ?? 0) === 1 ? '' : 's'} left`;
}

// ── Chip click — toggles dropdown when authed, opens login when not ─────
function onChipClick(e) {
  e.stopPropagation();
  if (!_state) {
    showLoginModal();
    return;
  }
  $menu.classList.toggle('open');
}

function onDocumentClick(e) {
  if (!$menu.classList.contains('open')) return;
  if ($chip.contains(e.target)) return;
  $menu.classList.remove('open');
}

// ── Logout ──────────────────────────────────────────────────────────────
async function onSignout(e) {
  e.stopPropagation();
  try {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {}
  _state = null;
  $menu.classList.remove('open');
  renderChip();
  log('signed out');
}

// ── Login modal ────────────────────────────────────────────────────────
export function showLoginModal() {
  $form.style.display = '';
  $sent.style.display = 'none';
  $note.textContent = '';
  $email.value = '';
  $submit.disabled = false;
  $modal.style.display = 'flex';
  setTimeout(() => $email.focus(), 50);
}

export function hideLoginModal() {
  $modal.style.display = 'none';
}

async function onSubmitEmail() {
  const email = ($email.value || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    $note.textContent = 'Enter a valid email.';
    return;
  }
  $submit.disabled = true;
  $note.textContent = '';
  try {
    const r = await fetch('/auth/magic-link', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (r.status === 429) {
      $note.textContent = 'Too many requests. Try again later.';
      $submit.disabled = false;
      return;
    }
    if (!r.ok) {
      $note.textContent = 'Something went wrong. Try again.';
      $submit.disabled = false;
      return;
    }
    // Success — swap to "check your email" state
    $sentMsg.textContent = `Check your inbox at ${email}.`;
    $form.style.display = 'none';
    $sent.style.display = '';
    log(`magic link requested for ${email}`);
  } catch (e) {
    $note.textContent = 'Network error. Try again.';
    $submit.disabled = false;
  }
}

// ── Paywall ────────────────────────────────────────────────────────────
export function showPaywall({ allowLogin = false } = {}) {
  if (!$paywall) return;
  $paywallLoginCta.style.display = allowLogin ? '' : 'none';
  Array.from($paywallPkgs).forEach((b) => { b.disabled = false; });
  $paywall.style.display = 'flex';
}

export function hidePaywall() {
  if (!$paywall) return;
  $paywall.style.display = 'none';
}

async function onPackageClick(packageId) {
  // Unauthed user must sign in before checkout — checkout requires a logged-in email
  if (!_state) {
    hidePaywall();
    showLoginModal();
    return;
  }
  // Disable all package buttons while we await the redirect
  Array.from($paywallPkgs).forEach((b) => { b.disabled = true; });
  try {
    const r = await fetch('/stripe/checkout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      // Pass the current path so Stripe's success/cancel URLs land back
      // on the surface the buyer came from. Server whitelists this
      // (/playground/, /preview/) and falls back to /playground/ otherwise.
      body: JSON.stringify({ package: packageId, return_path: location.pathname }),
    });
    if (!r.ok) {
      log(`/stripe/checkout failed status=${r.status}`);
      Array.from($paywallPkgs).forEach((b) => { b.disabled = false; });
      return;
    }
    const d = await r.json();
    if (d.url) {
      window.location = d.url; // redirect to Stripe Checkout
    } else {
      log(`/stripe/checkout returned no url: ${JSON.stringify(d)}`);
      Array.from($paywallPkgs).forEach((b) => { b.disabled = false; });
    }
  } catch (e) {
    log(`/stripe/checkout error: ${e.message}`);
    Array.from($paywallPkgs).forEach((b) => { b.disabled = false; });
  }
}

// ── Credit deduction (called fire-and-forget after session start) ───────
export async function deductCredit() {
  // Only meaningful if we have a session (cookie). Unauthed users skip the call.
  if (!_state) return;
  try {
    const r = await fetch('/wallet/deduct', { method: 'POST', credentials: 'same-origin' });
    if (r.status === 401) return;
    const d = await r.json();
    if (d.ok) {
      // Optimistic local update so the chip reflects the new balance immediately
      _state.credits = d.credits;
      _state.plan = d.plan ?? _state.plan;
      _state.evergreenActive = !!d.evergreenActive;
      renderChip();
    } else if (d.reason) {
      log(`deduct returned not-ok: ${d.reason}`);
    }
  } catch (e) {
    log(`deduct silent failure: ${e.message}`);
  }
}

// ── Public: hide chip during a live session, restore on stop ────────────
export function setSessionActive(active) {
  _suppressed = !!active;
  renderChip();
}

// ── Public: refresh state from /me (call after a known auth change) ─────
export async function refresh() {
  _state = await fetchMe();
  renderChip();
  return _state;
}

// ── Public: read current state without re-fetching ──────────────────────
export function getState() {
  return _state;
}

// ── Public: init once on page load ──────────────────────────────────────
export async function init() {
  $chip = document.getElementById('account-chip');
  $btn = document.getElementById('account-btn');
  $label = document.getElementById('account-label');
  $menu = document.getElementById('account-menu');
  $menuEmail = document.getElementById('account-menu-email');
  $menuCredits = document.getElementById('account-menu-credits');
  $signout = document.getElementById('account-signout');
  $modal = document.getElementById('login-modal');
  $email = document.getElementById('login-email');
  $submit = document.getElementById('login-submit');
  $note = document.getElementById('login-note');
  $form = document.getElementById('login-form');
  $sent = document.getElementById('login-sent');
  $sentMsg = document.getElementById('login-sent-msg');
  $close = document.getElementById('login-close');
  $paywall = document.getElementById('paywall-modal');
  $paywallLoginCta = document.getElementById('paywall-login-cta');
  $paywallLoginLink = document.getElementById('paywall-login-link');
  $paywallClose = document.getElementById('paywall-close');
  $paywallPkgs = document.querySelectorAll('.paywall-pkg');

  // Wire events
  $btn.addEventListener('click', onChipClick);
  $signout.addEventListener('click', onSignout);
  document.addEventListener('click', onDocumentClick);
  $submit.addEventListener('click', onSubmitEmail);
  $email.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onSubmitEmail(); }
  });
  $close.addEventListener('click', hideLoginModal);
  Array.from($paywallPkgs).forEach((b) => {
    b.addEventListener('click', () => onPackageClick(b.dataset.package));
  });
  $paywallLoginLink.addEventListener('click', () => {
    hidePaywall();
    showLoginModal();
  });
  $paywallClose.addEventListener('click', hidePaywall);

  // Strip ?welcome=1 / ?purchase=success|cancel from URL
  const params = new URLSearchParams(location.search);
  let stripped = false;
  if (params.has('welcome')) { params.delete('welcome'); stripped = true; }
  const purchase = params.get('purchase');
  if (purchase) { params.delete('purchase'); stripped = true; }
  if (stripped) {
    const qs = params.toString();
    history.replaceState(null, '', `${location.pathname}${qs ? '?' + qs : ''}${location.hash}`);
  }

  // Initial state
  await refresh();

  // After Stripe checkout success, the wallet was credited via webhook before
  // the redirect — refresh() above already fetched the new balance.
  if (purchase === 'success') log('purchase completed, chip refreshed');
}
