/* USERS admin page (Johnny 2026-10-17): owner-only. Johnny's login gets
 * this extra page to track registered users — emails, subscription
 * state, referral standing, connected bots and account sizes — and to
 * run the platform: suspend/reactivate accounts, set subscription
 * states, and set per-account fee discounts. Every mutation is a POST
 * to the same owner-gated API and lands in the audit log rendered at
 * the bottom of the page.
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

  async function api(url, body) {
    const init = { credentials: 'include', signal: AbortSignal.timeout(45000) };
    if (body !== undefined) {
      init.method = 'POST';
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const response = await fetch(url, init);
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
          <p>Every registered account: subscription state, referral standing, and each connected bot's account size — plus your admin controls. Sizes are the last values the bot service captured, never a live broker pull. Every change below is written to the audit log.</p>
        </div>
        <button class="usr-refresh" id="usrRefresh" type="button">Refresh</button>
      </header>
      <div class="usr-notice" id="usrNotice" role="status" aria-live="polite"></div>
      <div class="usr-totals" id="usrTotals"></div>
      <div class="usr-table-wrap"><table class="usr-table" id="usrTable">
        <thead><tr>
          <th>Email</th><th>Joined</th><th>Verified</th><th>Subscription</th>
          <th>Referrals</th><th>Bot</th><th>Open</th><th>Account size</th><th>Admin</th>
        </tr></thead>
        <tbody id="usrRows"><tr><td colspan="9" class="usr-empty">Loading…</td></tr></tbody>
      </table></div>
      <section class="usr-audit" id="usrAuditWrap" aria-labelledby="usrAuditTitle">
        <h2 id="usrAuditTitle">Recent admin actions</h2>
        <div id="usrAudit"><p class="usr-dim">No admin actions yet.</p></div>
      </section>
    </section>`;
    page.appendChild(root);
    $('usrRefresh').addEventListener('click', refresh);
    $('usrRows').addEventListener('click', onRowAction);
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

  function controlsHtml(user) {
    // The owner's own row renders NO controls: the API refuses any
    // mutation targeting him, and the UI does not pretend otherwise.
    if (user.isOwnerRow) return '<span class="usr-dim">Owner</span>';
    const id = Number(user.id);
    const subStates = ['Free', 'Founding', 'Active', 'Exempt'];
    const options = subStates.map(s =>
      `<option value="${s.toLowerCase()}"${user.subscription === s ? ' selected' : ''}>${s}</option>`).join('');
    const discountValue = user.adminDiscountPct == null ? '' : String(user.adminDiscountPct);
    const clearBtn = user.adminDiscountPct == null
      ? '' : `<button type="button" class="usr-btn" data-action="discount-clear" data-user="${id}">Clear</button>`;
    return `<div class="usr-controls">
      <button type="button" class="usr-btn${user.suspended ? '' : ' usr-btn-danger'}"
        data-action="suspension" data-user="${id}" data-suspended="${user.suspended ? '0' : '1'}">${user.suspended ? 'Reactivate' : 'Suspend'}</button>
      <span class="usr-ctl-group">
        <select class="usr-select" data-sub-select="${id}" aria-label="Subscription state">${options}</select>
        <button type="button" class="usr-btn" data-action="subscription" data-user="${id}">Set</button>
      </span>
      <span class="usr-ctl-group">
        <input class="usr-input" type="number" min="0" max="100" step="1" placeholder="Fee % off"
          value="${esc(discountValue)}" data-discount-input="${id}" aria-label="Admin fee discount percent">
        <button type="button" class="usr-btn" data-action="discount" data-user="${id}">Set fee</button>${clearBtn}
      </span>
      <small>Effective discount: ${Number(user.effectiveDiscountPct || 0)}% off</small>
    </div>`;
  }

  function rowHtml(user) {
    const bot = user.bot;
    let botCell = '—';
    if (bot) {
      botCell = `${esc(bot.mode === 'LIVE' ? 'Live' : 'Paper')} · ${bot.enabled ? 'On' : 'Paused'}`;
      if (bot.adminHold) botCell += '<small>Held by admin</small>';
    }
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
    const suspendedTag = user.suspended ? ' <span class="usr-chip usr-chip-suspended">Suspended</span>' : '';
    return `<tr>
      <td class="usr-email">${esc(user.email || user.username || '')}${suspendedTag}</td>
      <td>${esc(fmtDate(user.joinedAt))}</td>
      <td>${user.emailVerified ? 'Yes' : '<span class="usr-dim">No</span>'}</td>
      <td>${subChip(user.subscription)}</td>
      <td>${refCell}</td>
      <td>${botCell}</td>
      <td>${openCell}</td>
      <td class="usr-size">${sizeCell}</td>
      <td class="usr-admin-cell">${controlsHtml(user)}</td>
    </tr>`;
  }

  function renderAudit(audit) {
    const el = $('usrAudit');
    if (!el) return;
    if (!audit || !audit.length) {
      el.innerHTML = '<p class="usr-dim">No admin actions yet.</p>';
      return;
    }
    el.innerHTML = `<ul class="usr-audit-list">${audit.map(row => {
      const when = fmtDateTime(row.at) || esc(row.at || '');
      const target = esc(row.targetEmail || `user ${row.targetUserId}`);
      const change = row.action === 'subscription' || row.action === 'discount'
        ? `: ${esc(row.oldValue || '—')} → ${esc(row.newValue || '—')}` : '';
      const verb = row.action === 'suspend' ? 'Suspended'
        : row.action === 'reactivate' ? 'Reactivated'
          : row.action === 'subscription' ? 'Subscription changed'
            : row.action === 'discount' ? 'Fee discount changed' : esc(row.action);
      return `<li><span class="usr-audit-when">${esc(when)}</span> ${verb} <strong>${target}</strong>${change}</li>`;
    }).join('')}</ul>`;
  }

  async function onRowAction(event) {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const userId = button.getAttribute('data-user');
    const action = button.getAttribute('data-action');
    const row = button.closest('tr');
    try {
      button.disabled = true;
      notice('Working…');
      if (action === 'suspension') {
        await api(`/api/admin/users/${userId}/suspension`, { suspended: button.getAttribute('data-suspended') === '1' });
      } else if (action === 'subscription') {
        const select = row ? row.querySelector(`select[data-sub-select="${userId}"]`) : null;
        if (!select) throw new Error('Subscription selector missing.');
        await api(`/api/admin/users/${userId}/subscription`, { state: select.value });
      } else if (action === 'discount') {
        const input = row ? row.querySelector(`input[data-discount-input="${userId}"]`) : null;
        const raw = input ? input.value.trim() : '';
        if (raw === '') throw new Error('Enter a fee discount percentage first (0–100).');
        await api(`/api/admin/users/${userId}/discount`, { pct: Number(raw) });
      } else if (action === 'discount-clear') {
        await api(`/api/admin/users/${userId}/discount`, { pct: null });
      } else {
        return;
      }
      notice('Done.');
      await refresh();
    } catch (error) {
      notice(error.message || 'Admin action failed.', true);
    } finally {
      button.disabled = false;
    }
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
          : '<tr><td colspan="9" class="usr-empty">No registered users yet.</td></tr>';
      }
      renderAudit(data.audit || []);
      notice('');
    } catch (error) {
      notice(error.message || 'Could not load users.', true);
    }
  }

  async function open() { shell(); mounted = true; await refresh(); }
  function pause() { mounted = false; }
  window.usersPage = { open, pause };
})();
