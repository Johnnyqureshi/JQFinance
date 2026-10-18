/* Refer & Save (Johnny 2026-10-17): the dashboard card showing the
 * account's personal referral link, how many friends joined, and the
 * current discount — 20% off per subscribed friend, stacking to 60%,
 * live only while each friend stays subscribed. All state comes from
 * the server (/api/referrals/me); the card stays hidden until that
 * loads, so logged-out visitors never see it. Sober site theme, no
 * gradients, no emoji — matches the restyled subscription surfaces.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);

  async function refresh() {
    const card = $('referralCard');
    if (!card) return;
    let data = null;
    try {
      const response = await fetch('/api/referrals/me', { credentials: 'include' });
      if (response.ok) data = await response.json();
    } catch (_) { /* logged out / unavailable: card stays hidden */ }
    if (!data || !data.ok || !data.code) {
      card.style.display = 'none';
      return;
    }
    const link = `${window.location.origin}${data.linkPath}`;
    const input = $('referralLink');
    if (input) input.value = link;
    const discount = $('referralDiscount');
    if (discount) {
      discount.textContent = data.discountPct > 0
        ? `${data.discountPct}% off — first trading week free, then you pay ${data.discountedPriceDisplay}/mo`
        : `First trading week free, then ${data.priceDisplay}/mo — your price drops with each signup`;
    }
    const stats = $('referralStats');
    if (stats) {
      stats.textContent = `${data.joinedCount} joined · ${data.activeCount} subscribed`;
    }
    card.style.display = '';
  }

  function copyLink() {
    const input = $('referralLink');
    const btn = $('referralCopyBtn');
    if (!input || !input.value) return;
    const done = () => {
      if (!btn) return;
      const original = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = original; }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(done).catch(() => {
        input.select();
        try { document.execCommand('copy'); } catch (_) {}
        done();
      });
    } else {
      input.select();
      try { document.execCommand('copy'); } catch (_) {}
      done();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('referralCopyBtn')?.addEventListener('click', copyLink);
    refresh(); // already-authenticated page load (session cookie)
  });

  window.referralsCard = { refresh };
})();
