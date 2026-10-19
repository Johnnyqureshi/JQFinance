/* Unlock Agentic Trading (Johnny 2026-10-16): ONE flat subscription —
 * $49.99/mo, everything included, early-signup reward locked while you
 * stay subscribed. No tiers. First 14 days free, then $49.99/mo
 * (Johnny 2026-10-18; extended 2026-10-19 — actually 10 business days).
 *
 * The popup shows once per browser session on the first authenticated
 * dashboard load, and only while the server says the account has neither
 * subscribed, joined the founding list, nor dismissed it (dismissal is a
 * server-side per-account flag, not a cookie). A permanent entry point
 * (nav pill, dashboard banner, Kiaan page strip) stays visible after
 * dismissal; for subscribers it reads "Agentic Trading: Active".
 *
 * Checkout is Stripe Checkout (cards + Apple Pay + Google Pay) when the
 * server has a Stripe key; until then the CTA records a founding signup
 * and the popup shows the founding-list confirmation. PayPal is a
 * separate phase-2 integration and is intentionally absent here.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let state = null;
  let sessionShownFor = null;

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error((data && data.error) || `Request failed (${response.status})`);
    return data;
  }

  function entryButtons() {
    return [$('subscriptionNavBtn'), $('subscriptionBannerBtn'), $('subscriptionKiaanBtn')].filter(Boolean);
  }

  function renderEntryPoints() {
    const label = state ? state.entryLabel : 'Unlock Agentic Trading';
    for (const btn of entryButtons()) {
      btn.textContent = label;
      btn.classList.toggle('is-active', !!state && state.status !== 'none');
    }
    const bannerCopy = $('subscriptionBannerCopy');
    if (bannerCopy && state) {
      bannerCopy.textContent = state.status === 'active' && state.exempt
        ? 'Agentic Trading is active on your account — subscription fees are waived for this account.'
        : state.status === 'active'
          ? 'Agentic Trading is active on your account at the locked early-signup price.'
          : state.status === 'founding'
          ? "You're on the founding list — billing opens the moment payments go live."
          : 'The agentic bot on your own broker account, live journal and signals, paper mode included.';
    }
  }

  function showModal(mode) {
    const overlay = $('subscriptionOverlay');
    if (!overlay) return;
    const confirm = $('subscriptionConfirm');
    const cta = $('subscriptionCta');
    const note = $('subscriptionCheckoutNote');
    const later = $('subscriptionLater');
    const done = $('subscriptionDone');
    if (confirm) confirm.classList.remove('show');
    if (cta) { cta.disabled = false; cta.textContent = 'Unlock Now'; }
    if (later) later.style.display = '';
    if (done) done.style.display = 'none';
    if (state && state.status === 'active') {
      if (confirm) {
        confirm.textContent = state.exempt
          ? 'Agentic Trading is active on your account — subscription fees are waived for this account.'
          : 'Agentic Trading is active on your account — $49.99/mo at your locked early-signup price.';
        confirm.classList.add('show');
      }
      if (cta) cta.style.display = 'none';
      if (later) later.style.display = 'none';
      if (done) done.style.display = '';
      if (note) note.textContent = '';
    } else if (state && state.status === 'founding') {
      if (confirm) {
        confirm.textContent = "You're on the founding list — billing opens the moment payments go live";
        confirm.classList.add('show');
      }
      if (cta) cta.style.display = 'none';
      if (later) later.style.display = 'none';
      if (done) done.style.display = '';
      if (note) note.textContent = '';
    } else {
      if (cta) cta.style.display = '';
      if (note) {
        note.textContent = mode === 'stripe'
          ? 'First 14 days free, then $49.99/mo. Secure checkout by Stripe — credit/debit cards, Apple Pay and Google Pay accepted.'
          : 'Billing is not live yet: Unlock Now joins the founding list at the locked $49.99/mo early-signup price — no charge today, and your first 14 days are free when billing opens.';
      }
    }
    overlay.classList.add('open');
  }

  function hideModal() {
    $('subscriptionOverlay')?.classList.remove('open');
  }

  // Trial promo popup (Johnny 2026-10-18): audience and dismissal are
  // server-side state (state.showTrialPopup); this layer only renders.
  // Guard: the two modals never stack — if the unlock popup is open
  // (or opens first), the trial popup stays down.
  function showTrialModal() {
    const overlay = $('trialOverlay');
    if (!overlay) return;
    if ($('subscriptionOverlay')?.classList.contains('open')) return;
    const err = $('trialError');
    if (err) err.textContent = '';
    const cta = $('trialCta');
    if (cta) { cta.disabled = false; cta.textContent = 'Start my free trial'; }
    overlay.classList.add('open');
  }

  function hideTrialModal() {
    $('trialOverlay')?.classList.remove('open');
  }

  async function dismissTrial() {
    hideTrialModal();
    try { state = await api('/api/subscription/trial-dismiss', { method: 'POST', body: '{}' }); } catch (_) {}
    renderEntryPoints();
  }

  async function refresh() {
    try {
      state = await api('/api/subscription/status');
    } catch (_) {
      state = null; // logged out / unavailable: entry points keep default label
    }
    renderEntryPoints();
    return state;
  }

  // Called by app.js showApp() on every login / authenticated load, and
  // once on DOMContentLoaded below for already-authenticated sessions.
  async function onAuthenticated(user) {
    const uid = user && user.id != null ? String(user.id) : 'me';
    await refresh();
    let returning = false;
    try { returning = new URLSearchParams(window.location.search).has('subscription'); } catch (_) {}
    handleReturnParams();
    if (state && state.shouldShowPopup) {
      // The unlock popup wins: when it is due, the trial promo never
      // stacks on top of it.
      let shown = null;
      try { shown = sessionStorage.getItem('qf-sub-popup-session'); } catch (_) {}
      if (shown === uid || sessionShownFor === uid) return; // first load of the session only
      sessionShownFor = uid;
      try { sessionStorage.setItem('qf-sub-popup-session', uid); } catch (_) {}
      showModal(state.checkoutMode);
      return;
    }
    // Trial promo: dashboard load, free accounts only (server-gated),
    // skipped on a checkout-return load so it never crowds the result.
    if (!returning && state && state.showTrialPopup) showTrialModal();
  }

  function handleReturnParams() {
    let params;
    try { params = new URLSearchParams(window.location.search); } catch (_) { return; }
    const flag = params.get('subscription');
    if (!flag) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('subscription');
      window.history.replaceState({}, '', url.toString());
    } catch (_) {}
    if (flag === 'active') {
      refresh().then(() => showModal(state && state.checkoutMode));
    } else if (flag === 'cancelled' || flag === 'unconfirmed') {
      const host = $('page-home');
      if (host && !$('subscriptionNotice')) {
        const div = document.createElement('div');
        div.id = 'subscriptionNotice';
        div.className = 'sub-notice';
        div.textContent = flag === 'cancelled'
          ? 'Checkout was cancelled — your account was not charged and nothing changed.'
          : 'Checkout could not be confirmed — your account was not marked subscribed. If you were charged, contact support before trying again.';
        host.prepend(div);
      }
    }
  }

  async function dismiss() {
    hideModal();
    try { state = await api('/api/subscription/dismiss', { method: 'POST', body: '{}' }); } catch (_) {}
    renderEntryPoints();
  }

  // One checkout flow for both CTAs: the unlock popup's "Unlock Now"
  // and the trial popup's "Start my free trial" (fromTrial) post to the
  // same endpoint — the session it creates carries the trial.
  async function unlock(fromTrial = false) {
    const cta = $(fromTrial ? 'trialCta' : 'subscriptionCta');
    const err = $(fromTrial ? 'trialError' : 'subscriptionError');
    if (err) err.textContent = '';
    if (cta) { cta.disabled = true; cta.textContent = 'Working…'; }
    try {
      const result = await api('/api/subscription/checkout', { method: 'POST', body: '{}' });
      if (result.mode === 'stripe' && result.url) {
        window.location.href = result.url;
        return;
      }
      // Founding-list mode: no charge, signup recorded server-side.
      state = result;
      renderEntryPoints();
      if (fromTrial) {
        // Hand off to the unlock modal, which renders the resulting
        // state (founding confirmation / active) with state fresh.
        hideTrialModal();
        showModal(state && state.checkoutMode);
        return;
      }
      const confirm = $('subscriptionConfirm');
      if (confirm) {
        confirm.textContent = result.confirmation
          || "You're on the founding list — billing opens the moment payments go live";
        confirm.classList.add('show');
      }
      if (cta) cta.style.display = 'none';
      const later = $('subscriptionLater');
      if (later) later.style.display = 'none';
      const done = $('subscriptionDone');
      if (done) done.style.display = '';
      const note = $('subscriptionCheckoutNote');
      if (note) note.textContent = '';
    } catch (e) {
      if (err) err.textContent = e.message || 'Something went wrong. Your account was not charged.';
      if (cta) { cta.disabled = false; cta.textContent = fromTrial ? 'Start my free trial' : 'Unlock Now'; }
    }
  }

  function openFromEntry() {
    if (!state) { refresh().then(() => showModal(state && state.checkoutMode)); return; }
    showModal(state.checkoutMode);
  }

  function onLogout() {
    state = null;
    sessionShownFor = null;
    hideModal();
    hideTrialModal();
    renderEntryPoints();
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('subscriptionCta')?.addEventListener('click', () => unlock(false));
    $('subscriptionLater')?.addEventListener('click', dismiss);
    $('subscriptionClose')?.addEventListener('click', dismiss);
    $('subscriptionDone')?.addEventListener('click', hideModal);
    $('subscriptionOverlay')?.addEventListener('click', e => {
      if (e.target === $('subscriptionOverlay')) dismiss();
    });
    $('trialCta')?.addEventListener('click', () => unlock(true));
    $('trialLater')?.addEventListener('click', dismissTrial);
    $('trialClose')?.addEventListener('click', dismissTrial);
    $('trialOverlay')?.addEventListener('click', e => {
      if (e.target === $('trialOverlay')) dismissTrial();
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if ($('subscriptionOverlay')?.classList.contains('open')) dismiss();
      else if ($('trialOverlay')?.classList.contains('open')) dismissTrial();
    });
    for (const btn of entryButtons()) btn.addEventListener('click', openFromEntry);
    // Already-authenticated page load (session cookie): app.js showApp
    // also calls onAuthenticated; the session guard dedupes the popup.
    refresh().then(() => { if (state) onAuthenticated({ id: sessionShownFor || undefined }); });
  });

  window.subscriptionPopup = {
    open: openFromEntry, refresh, onAuthenticated, onLogout, showModal, hideModal,
    showTrialModal, hideTrialModal, dismissTrial,
  };
})();
