'use strict';
/* Kiaan Bot page — stage 1 (Johnny 2026-10-08).
   The regime engine is built and unit-tested (lib/kiaan). Broker wiring
   (service, account connect, scheduler) is the next stage, so this page
   is an honest design/status board: no live status is faked, and the
   connect step — when it ships — stays in Johnny's hands like every bot. */
(function () {
  function el(id) { return document.getElementById(id); }

  var CSS = [
    '.kb-wrap{max-width:980px;margin:0 auto;padding:28px 20px 48px;color:var(--text,#e8ecf1)}',
    '.kb-eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;opacity:.65}',
    '.kb-title{font-size:30px;font-weight:800;margin:6px 0 2px}',
    '.kb-sub{opacity:.75;margin:0 0 22px}',
    '.kb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-bottom:22px}',
    '.kb-card{border:1px solid rgba(127,140,160,.25);border-radius:14px;padding:14px 16px;background:rgba(127,140,160,.06)}',
    '.kb-card h4{margin:0 0 6px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;opacity:.7}',
    '.kb-card .kb-big{font-size:17px;font-weight:700}',
    '.kb-card p{margin:6px 0 0;font-size:13px;opacity:.8;line-height:1.45}',
    '.kb-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:8px 0 22px}',
    '.kb-step{border-left:3px solid #1dd6a3;padding:4px 0 4px 12px}',
    '.kb-step b{display:block;margin-bottom:4px}',
    '.kb-step span{font-size:13px;opacity:.8;line-height:1.45;display:block}',
    '.kb-regime{border:1px solid rgba(255,170,60,.35);background:rgba(255,170,60,.07);border-radius:14px;padding:16px 18px;margin-bottom:22px}',
    '.kb-regime h4{margin:0 0 6px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;opacity:.75}',
    '.kb-regime p{margin:0;font-size:14px;line-height:1.55}',
    '.kb-table{width:100%;border-collapse:collapse;font-size:13.5px}',
    '.kb-table td{padding:7px 8px;border-top:1px solid rgba(127,140,160,.18)}',
    '.kb-table td:first-child{opacity:.7;width:42%}',
    '.kb-note{font-size:12.5px;opacity:.6;margin-top:18px;line-height:1.5}',
  ].join('\n');

  function render() {
    var host = el('page-kiaan');
    if (!host || host.dataset.built) return;
    host.dataset.built = '1';
    var style = document.createElement('style');
    style.textContent = CSS;
    host.appendChild(style);
    var wrap = document.createElement('div');
    wrap.className = 'kb-wrap';
    wrap.innerHTML = [
      '<span class="kb-eyebrow">Kiaan Bot · first in the fleet</span>',
      '<h2 class="kb-title">Kiaan Bot</h2>',
      '<p class="kb-sub">Regime first, trades second. This bot reads the whole board before it looks at a single stock — the way the morning briefing does.</p>',

      '<div class="kb-grid">',
      '  <div class="kb-card"><h4>Engine</h4><div class="kb-big">Built &amp; tested</div><p>Regime classifier + entry engine are done and unit-tested.</p></div>',
      '  <div class="kb-card"><h4>Broker</h4><div class="kb-big">Not connected yet</div><p>Service wiring is the next stage. Connecting stays in Johnny&rsquo;s hands, like every bot.</p></div>',
      '  <div class="kb-card"><h4>Mode</h4><div class="kb-big">Paper only</div><p>There is deliberately no live-trading path in this bot.</p></div>',
      '  <div class="kb-card"><h4>Automation</h4><div class="kb-big">Fully automatic</div><p>Once enabled it never waits on a manual approval — and every &ldquo;no trade&rdquo; is journaled with its reason.</p></div>',
      '</div>',

      '<div class="kb-regime"><h4>Today&rsquo;s regime read · Thu Oct 8, 2026</h4>',
      '<p><b>Risk-off tilt.</b> Futures down after Tuesday&rsquo;s record closes, the 10-year at ~5.35% (highest since 2002) and bear-steepening, Brent above $105 on Hormuz attacks, and a hawkish FOMC backdrop. On a day like this the Kiaan Bot takes no fresh longs in regular names — defense or inverse ETFs only, and only on confirmation.</p></div>',

      '<span class="kb-eyebrow">How it thinks</span>',
      '<div class="kb-steps">',
      '  <div class="kb-step"><b>1 · Classify the day</b><span>SPY/QQQ trend, VIX, yields, oil, and the news tape decide risk-on, risk-off, or chop — before any stock is considered.</span></div>',
      '  <div class="kb-step"><b>2 · Trade only what fits</b><span>Risk-on: the strongest relative-strength names breaking out on volume. Risk-off: no fresh longs — inverse ETFs (SQQQ, SPXS, TSDD, SOXS, TECS, LABD) only when they confirm. Chop: stand aside.</span></div>',
      '  <div class="kb-step"><b>3 · Never chase</b><span>A name already up 20%+ on the day is never bought. Entries cap at 2 ATR past the trigger.</span></div>',
      '  <div class="kb-step"><b>4 · Protect the day</b><span>ATR stops, breakeven at 1R, hard halts on daily loss and loss streaks, flat by 15:55 ET. Nothing is held overnight.</span></div>',
      '</div>',

      '<span class="kb-eyebrow">Standing rules</span>',
      '<table class="kb-table">',
      '  <tr><td>Entry window</td><td>09:45 – 15:30 ET, after a 15-minute opening range</td></tr>',
      '  <tr><td>Confirmation</td><td>Structure break or VWAP reclaim + relative strength ≥ 1 pt vs SPY + volume ≥ 1.5× pace</td></tr>',
      '  <tr><td>Position size</td><td>$500 per trade, risk capped at $50 per trade</td></tr>',
      '  <tr><td>Max positions</td><td>3 · max 6 trades/day</td></tr>',
      '  <tr><td>Daily halts</td><td>−2% day or 3 straight losses</td></tr>',
      '  <tr><td>Targets</td><td>50% at 2R, 50% at 3R, stop to breakeven at 1R</td></tr>',
      '</table>',

      '<p class="kb-note">The regime read above is refreshed by the daily market study and lives in the Kiaan Bot playbook. When the broker wiring lands, this page becomes the live dashboard — status, regime, candidates, journal — with the same layout as the rest of the fleet.</p>',
    ].join('\n');
    host.appendChild(wrap);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
