/* USERS admin page (Johnny 2026-10-17): owner-only. Johnny's login gets
 * this extra page to track registered users — emails, subscription
 * state, referral standing, connected bots and account sizes.
 *
 * The nav entry for this page is injected by app.js ONLY for the owner
 * account, and both this page's data API (/api/admin/users) and its
 * /users route are gated server-side (lib/admin-users.js): every other
 * account gets a 404. Nothing rendered here is ever requested by, or
 * sent to, a non-owner client.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  let mounted = false;

  async function api(url) {
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(45000) });
    const data = await response.json().catch(() => { throw new Error('Server returned an unreadable response.'); });
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function fmtDate(value) {
    if (!value) return '—';
    const d = new Date(String(value).includes('T') ? value : String(value).replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return esc(value);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function fmtDateTime(value) {
    if (!value) return null;
    const d = new Date(String(value).includes('T') ? value : String(value).replace(' ', 'T') + 'Z');
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function fmtMoney(value) {
    if (value == null || !Number.isFinite(Number(value))) return null;
    return '$' + Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function shell() {
    const page = $('page-users');
    if (!page || $('usersRoot')) return;
    const root = document.createElement('div');
    root.innerHTML = `<section class="usr-shell" id="usersRoot" aria-labelledby="usersTitle">
      <header class="usr-hero">
        <div>
          <span class="usr-eyebrow">ADMIN · OWNER ONLY</span>
          <h1 id="usersTitle">Users</h1>
          <p>Every registered account: subscription state, referral standing, and each connected bot's account size. Read-only — sizes are the last values the bot service captured, never a live broker pull.</p>
        </div>
        <button class="usr-refresh" id="usrRefresh" type="button">Refresh</button>
      </header>
      <div class="usr-notice" id="usrNotice" role="status" aria-live="polite"></div>
      <div class="usr-totals" id="usrTotals"></div>
      <div class="usr-table-wrap"><table class="usr-table" id="usrTable">
        <thead><tr>
          <th>Email</th><th>Joined</th><th>Verified</th><th>Subscription</th>
          <th>Referrals</th><th>Bot</th><th>Open</th><th>Account size</th>
        </tr></thead>
        <tbody id="usrRows"><tr><td colspan="8" class="usr-empty">Loading…</td></tr></tbody>
      </table></div>
    </section>`;
    page.appendChild(root);
    $('usrRefresh').addEventListener('click', refresh);
  }

  function notice(message, error) {
    const el = $('usrNotice');
    if (el) { el.textContent = message || ''; el.classList.toggle('is-error', !!error); }
  }

  function renderTotals(totals) {
    const el = $('usrTotals');
    if (!el) return;
    const card = (label, value) => `<div class="usr-stat"><span>${esc(label)}</span><strong>${esc(String(value))}</strong></div>`;
    el.innerHTML = card('Registered users', totals.users)
      + card('Founding list', totals.founding)
      + card('Active subscribers', totals.activeSubscribers)
      + card('Bots connected', totals.botsConnected);
  }

  function subChip(label) {
    const cls = label === 'Active' || label === 'Exempt' ? ' usr-chip-ok' : label === 'Founding' ? ' usr-chip-founding' : '';
    return `<span class="usr-chip${cls}">${esc(label)}</span>`;
  }

  function rowHtml(user) {
    const bot = user.bot;
    const botCell = bot
      ? `${esc(bot.mode === 'LIVE' ? 'Live' : 'Paper')} · ${bot.enabled ? 'On' : 'Paused'}`
      : '—';
    const openCell = bot ? String(bot.openPositions) : '—';
    let sizeCell = '—';
    if (bot) {
      const size = fmtMoney(bot.equity);
      if (size) {
        const asOf = fmtDateTime(bot.equityAsOf);
        sizeCell = size + (asOf ? `<small>as of ${esc(asOf)}</small>` : '');
      } else {
        sizeCell = '<span class="usr-dim">Not reported yet</span>';
      }
    }
    const ref = user.referrals || { joined: 0, active: 0, discountPct: 0 };
    const refCell = ref.joined
      ? `${ref.active} active · ${ref.discountPct}% off<small>${ref.joined} joined</small>`
      : '—';
    return `<tr>
      <td class="usr-email">${esc(user.email || user.username || '')}</td>
      <td>${esc(fmtDate(user.joinedAt))}</td>
      <td>${user.emailVerified ? 'Yes' : '<span class="usr-dim">No</span>'}</td>
      <td>${subChip(user.subscription)}</td>
      <td>${refCell}</td>
      <td>${botCell}</td>
      <td>${openCell}</td>
      <td class="usr-size">${sizeCell}</td>
    </tr>`;
  }

  async function refresh() {
    if (!mounted) return;
    notice('Loading…');
    try {
      const data = await api('/api/admin/users');
      renderTotals(data.totals || { users: 0, founding: 0, activeSubscribers: 0, botsConnected: 0 });
      const body = $('usrRows');
      if (body) {
        body.innerHTML = (data.users || []).length
          ? data.users.map(rowHtml).join('')
          : '<tr><td colspan="8" class="usr-empty">No registered users yet.</td></tr>';
      }
      notice('');
    } catch (error) {
      notice(error.message || 'Could not load users.', true);
    }
  }

  async function open() { shell(); mounted = true; await refresh(); }
  function pause() { mounted = false; }
  window.usersPage = { open, pause };
})();
