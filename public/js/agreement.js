/* Automated Trading Agreement gate — client (Johnny 2026-10-19).
 *
 * Renders the mandatory consent modal on the K1 Agentic page. The
 * terms shown here are fetched from GET /api/agreement/state, whose
 * payload is built from the server's canonical module
 * (lib/agreement.js) — the same text an acceptance row stores, so
 * what the user reads is exactly what gets recorded. Consent itself
 * is recorded ONLY by the server (POST /api/agreement/accept); this
 * file never treats a checkbox as proof, and the enable transition
 * stays refused server-side until the row exists.
 *
 * Triggers:
 *  - K1 page load: shown when the server state says required
 *    (entitled to activate, no current-version acceptance). Never
 *    stacked on top of the subscription/trial popups.
 *  - Immediately when an enable attempt answers agreement_required:
 *    window.agreementGate.requireFor(retry) re-runs the caller's
 *    action after a successful acceptance.
 * Cancel / Escape / backdrop click close the modal and record
 * nothing; trading is not activated.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

  let state = null;
  let statePromise = null;
  let pendingAction = null;
  let accepting = false;

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error((data && data.error) || `Request failed (${response.status})`);
      error.status = response.status;
      error.payload = data;
      throw error;
    }
    return data;
  }

  function loadState(force) {
    if (!force && state) return Promise.resolve(state);
    if (!statePromise) {
      statePromise = api('/api/agreement/state')
        .then(data => { state = data; return state; })
        .catch(() => null) // logged out / unavailable: stay silent
        .finally(() => { statePromise = null; });
    }
    return statePromise;
  }

  function overlay() { return $('agreementOverlay'); }
  function isOpen() { return !!overlay()?.classList.contains('open'); }
  function anotherModalOpen() {
    return !!($('subscriptionOverlay')?.classList.contains('open')
      || $('trialOverlay')?.classList.contains('open'));
  }

  function render() {
    if (!state) return;
    $('agreementTitle').textContent = state.title;
    $('agreementVersion').textContent = `Version ${state.version}`;
    $('agreementTerms').innerHTML = (state.sections || [])
      .map(s => `<h3>${esc(s.n)}. ${esc(s.heading)}</h3><p>${esc(s.body)}</p>`)
      .join('');
    $('agreementCheckboxLabel').textContent = state.checkboxLabel;
    $('agreementError').textContent = '';
  }

  function open(onAgreed) {
    if (!state) return;
    pendingAction = typeof onAgreed === 'function' ? onAgreed : null;
    render();
    const box = $('agreementCheckbox');
    box.checked = false;
    $('agreementAgree').disabled = true;
    overlay().classList.add('open');
    box.focus();
  }

  function close() {
    overlay()?.classList.remove('open');
    pendingAction = null;
  }

  async function agree() {
    if (accepting || !$('agreementCheckbox').checked || !state) return;
    accepting = true;
    $('agreementAgree').disabled = true;
    $('agreementError').textContent = '';
    try {
      const data = await api('/api/agreement/accept', {
        method: 'POST',
        body: JSON.stringify({ version: state.version }),
      });
      state = data;
      const action = pendingAction;
      close();
      if (action) await action();
    } catch (error) {
      if (error.status === 409 && error.payload) {
        // The terms changed under us: adopt the current state and
        // ask for a fresh read + consent. Nothing was recorded.
        state = error.payload;
        render();
        $('agreementCheckbox').checked = false;
        $('agreementAgree').disabled = true;
        $('agreementError').textContent = 'The agreement was updated — please review the current terms.';
      } else {
        $('agreementError').textContent = `Acceptance could not be recorded: ${error.message}`;
        $('agreementAgree').disabled = !$('agreementCheckbox').checked;
      }
    } finally {
      accepting = false;
    }
  }

  // K1 page load: entitled non-consenters meet the agreement here.
  async function checkOnLoad() {
    const s = await loadState();
    if (!s || !s.required || isOpen()) return;
    if (anotherModalOpen()) return; // one modal at a time; the enable attempt re-surfaces it
    open(null);
  }

  // Enable attempt refused with agreement_required: show the modal
  // and re-run the caller's action once consent is recorded. If the
  // state already shows consent (recorded elsewhere), just proceed.
  async function requireFor(action) {
    const s = await loadState(true);
    if (s && s.accepted) { if (typeof action === 'function') await action(); return; }
    if (!s) return;
    open(action);
  }

  function wire() {
    if (!$('agreementOverlay')) return;
    $('agreementCheckbox').addEventListener('change', e => {
      $('agreementAgree').disabled = !e.target.checked;
    });
    $('agreementAgree').addEventListener('click', agree);
    $('agreementCancel').addEventListener('click', close);
    overlay().addEventListener('click', e => { if (e.target === overlay()) close(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && isOpen()) close();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.agreementGate = { checkOnLoad, requireFor, refresh: () => loadState(true) };
}());
