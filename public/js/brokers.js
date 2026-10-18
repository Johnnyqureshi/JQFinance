/* Brokers page (Johnny 2026-10-16): the ONE place broker API keys are
 * entered. The Alpaca card re-hosts the Kiaan Bot connect form — same
 * backend endpoints (POST /api/kiaan/connect, POST /api/kiaan/disconnect)
 * and the same encrypted credential store the bot page used. No second
 * credential store exists, and no other broker captures credentials:
 * Interactive Brokers and Tradier are "In development" placeholders only.
 *
 * PAPER / LIVE: the form offers an explicit account-type choice and
 * the server accepts both (live capability shipped 2026-10-17): keys
 * are validated against the endpoint for the chosen account type and
 * stored under that mode — no quiet downgrade, no parallel store.
 * Entering keys only stores them through the existing flow: connecting
 * never arms or enables the bot; it trades only after Resume.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  let mounted = false, busy = false, connected = false;

  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(45000), headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const data = await response.json().catch(() => { throw new Error('Server returned an unreadable response. Refresh to verify the current state.'); });
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    if (!data || typeof data !== 'object') throw new Error('Server response is incomplete.');
    return data;
  }
  function notice(message, error) { const el = $('brkNotice'); if (el) { el.textContent = message || ''; el.classList.toggle('is-error', !!error); } }
  function formError(message) { const el = $('brkError'); if (el) el.textContent = message || ''; }

  function shell() {
    const page = $('page-brokers');
    if (!page || $('brokersRoot')) return;
    const root = document.createElement('div');
    root.innerHTML = `<section class="brk-shell" id="brokersRoot" aria-labelledby="brokersTitle">
      <header class="brk-hero"><div><span class="brk-eyebrow">BROKERS</span><h1 id="brokersTitle">Brokers</h1><p>Connect a brokerage once; K1 Agentic trades only the account you connect; you can disconnect anytime.</p></div></header>
      <div class="brk-notice" id="brkNotice" role="status" aria-live="polite"></div>
      <div class="brk-grid">
        <article class="brk-card" aria-label="Alpaca">
          <div class="brk-card-head"><h2>Alpaca</h2><span class="brk-chip brk-chip-ok">Available now</span></div>
          <p>Free API, paper and live — the broker K1 Agentic runs on today.</p>
          <div class="brk-state"><span>Status</span><strong id="brkAlpacaState">Checking…</strong></div>
          <details class="brk-help">
            <summary>How to connect your API keys</summary>
            <ol>
              <li>Open your Alpaca account at <a href="https://app.alpaca.markets" target="_blank" rel="noopener">app.alpaca.markets</a> (or log in) and pick <b>Paper</b> or <b>Live</b> trading inside Alpaca first.</li>
              <li>In Alpaca, go to <b>API Keys → Generate New Key</b> and copy the Key ID and Secret <b>together</b> — the secret is shown only once, and generating a new pair replaces the old one.</li>
              <li>Back here, choose <b>Paper account</b> or <b>Live account</b> to match where the keys came from, paste both, and tap <b>Connect</b>.</li>
              <li>We verify the keys with Alpaca before saving anything. If they're rejected, the pair doesn't match or the Paper/Live choice is wrong.</li>
              <li>Keys are stored encrypted and never shown again. Connecting doesn't turn trading on — enable the bot on the K1 Agentic page when you're ready, and disconnect anytime from this page.</li>
            </ol>
          </details>
          <form id="brkForm" autocomplete="off">
            <fieldset class="brk-mode">
              <legend>Account type</legend>
              <label class="brk-mode-opt"><input type="radio" name="brkMode" value="paper" checked><span><b>Paper account</b><small>Practice account with fake money — what the bot runs on today.</small></span></label>
              <label class="brk-mode-opt"><input type="radio" name="brkMode" value="live"><span><b>Live account</b><small>Your real-money Alpaca account.</small></span></label>
            </fieldset>
            <p class="brk-live-note" id="brkLiveNote" style="display:none">Live account — real money. These keys are validated against your LIVE Alpaca account and stored as the bot's live account. Connecting only stores your keys: the bot stays paused until you resume it on the K1 Agentic page, and it then trades this account for real.</p>
            <label class="brk-field"><span>API Key ID</span><input id="brkKey" type="text" placeholder="PKXXXXXXXXXXXXXXXXXXXXXXXX" autocomplete="off" spellcheck="false"/></label>
            <label class="brk-field"><span>API Secret Key</span><input id="brkSecret" type="password" placeholder="••••••••••••••••••••••••••••••••••••••••" autocomplete="off"/></label>
            <div class="brk-error" id="brkError" role="alert"></div>
            <div class="brk-actions">
              <button class="brk-button" id="brkConnect" type="submit">Connect</button>
              <button class="brk-button brk-quiet" id="brkDisconnect" type="button" style="display:none">Disconnect</button>
            </div>
          </form>
          <p class="brk-note">Keys are stored encrypted and never shown back. Connecting only stores your keys — it does not turn trading on, and it never switches anything to live trading.</p>
          <p class="brk-note">Get free API keys at <a href="https://app.alpaca.markets" target="_blank" rel="noopener">app.alpaca.markets</a> → API Keys. Coming later: open an Alpaca account right here in the app (Alpaca Broker API) — planned.</p>
        </article>
        <article class="brk-card" aria-label="Interactive Brokers">
          <div class="brk-card-head"><h2>Interactive Brokers</h2><span class="brk-chip">In development</span></div>
          <p>Full API, global markets; coming by subscriber demand.</p>
          <div class="brk-actions"><button class="brk-button brk-quiet" type="button" disabled>In development</button></div>
        </article>
        <article class="brk-card" aria-label="Tradier">
          <div class="brk-card-head"><h2>Tradier</h2><span class="brk-chip">In development</span></div>
          <p>API-first, options-friendly.</p>
          <div class="brk-actions"><button class="brk-button brk-quiet" type="button" disabled>In development</button></div>
        </article>
        <article class="brk-card brk-note-card" aria-label="Robinhood and Fidelity">
          <div class="brk-card-head"><h2>Robinhood &amp; Fidelity</h2></div>
          <p>Robinhood and Fidelity do not offer an official trading API, so no bot can connect to them. If your money is there, you can open an Alpaca account to use this service.</p>
        </article>
      </div>
    </section>`;
    page.appendChild(root);
    $('brkForm').addEventListener('submit', onConnect);
    $('brkDisconnect').addEventListener('click', onDisconnect);
    document.querySelectorAll('input[name="brkMode"]').forEach(radio => {
      radio.addEventListener('change', () => {
        $('brkLiveNote').style.display = radio.value === 'live' && radio.checked ? '' : 'none';
      });
    });
  }

  function renderStatus(status) {
    connected = !!status?.connected;
    const modeLabel = String(status?.mode || 'paper').toLowerCase() === 'live' ? 'Live account' : 'Paper account';
    $('brkAlpacaState').textContent = connected ? `Connected — ${modeLabel}` : 'Not connected';
    $('brkAlpacaState').className = connected ? 'brk-good' : 'brk-bad';
    $('brkDisconnect').style.display = connected ? '' : 'none';
    $('brkConnect').textContent = connected ? 'Update keys' : 'Connect';
  }

  async function refresh() {
    try { renderStatus(await api('/api/kiaan/status')); }
    catch (error) { const el = $('brkAlpacaState'); if (el) el.textContent = `Status unavailable: ${error.message}`; }
  }

  async function onConnect(event) {
    event.preventDefault();
    if (busy) return;
    const mode = document.querySelector('input[name="brkMode"]:checked')?.value || 'paper';
    const key = $('brkKey').value.trim();
    const secret = $('brkSecret').value.trim();
    formError('');
    if (!key || !secret) { formError('Enter both the API Key ID and the API Secret Key.'); return; }
    busy = true; $('brkConnect').disabled = true;
    try {
      await api('/api/kiaan/connect', { method: 'POST', body: JSON.stringify({ key, secret, mode }) });
      $('brkKey').value = ''; $('brkSecret').value = '';
      notice(`Alpaca connected (${mode === 'live' ? 'Live account' : 'Paper account'}). Connecting only stores your keys — trading is unchanged.`);
      await refresh();
    } catch (error) {
      $('brkSecret').value = '';
      formError(error.message);
    } finally { busy = false; $('brkConnect').disabled = false; }
  }

  async function onDisconnect() {
    if (busy || !connected) return;
    busy = true; $('brkDisconnect').disabled = true; formError('');
    try {
      await api('/api/kiaan/disconnect', { method: 'POST', body: '{}' });
      notice('Alpaca disconnected. K1 Agentic no longer has an account to trade.');
      await refresh();
    } catch (error) { formError(error.message); }
    finally { busy = false; $('brkDisconnect').disabled = false; }
  }

  async function open() { shell(); mounted = true; await refresh(); }
  function pause() { mounted = false; }
  window.brokersPage = { open, pause };
}());
