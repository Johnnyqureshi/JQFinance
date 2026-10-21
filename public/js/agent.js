// ── JQFinance Voice Agent Widget ────────────────────────────────────────────
(function () {
  'use strict';

  // ── Screen Context Reader ──────────────────────────────────────────────────
  // Reads the live app state and DOM to give the AI full awareness of the screen
  function getScreenContext() {
    const appState = window.state || {};
    const ctx = {
      platform:     'VixionBot',
      timestamp:    new Date().toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }),
      marketStatus: document.getElementById('mktText')?.textContent?.trim() || 'Unknown',
      currentPage:  appState.page || 'home',
      user:         appState.currentUser?.username ? `Logged in as ${appState.currentUser.username}` : 'Guest',
      watchlist:    appState.watchlist?.length ? appState.watchlist.join(', ') : 'Empty',
    };

    // ── Stock analysis context ─────────────────────────────────────────────
    if (appState.symbol) {
      const snap  = appState.snap  || {};
      const fmp   = appState.stockData?.fmp || {};
      const val   = appState.stockData?.val || {};
      const price = snap.price;
      const prev  = snap.previousClose;
      const chg   = price != null && prev != null ? price - prev : null;
      const chgPct= chg != null && prev ? (chg / prev) * 100 : null;

      ctx.stockAnalysis = {
        symbol:      appState.symbol,
        name:        snap.name || appState.symbol,
        price:       price != null ? `$${price.toFixed(2)}` : 'N/A',
        change:      chg != null ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%)` : 'N/A',
        trend:       chg != null ? (chg >= 0 ? 'UP' : 'DOWN') : 'N/A',
        dayHigh:     snap.dayHigh   != null ? `$${snap.dayHigh.toFixed(2)}`  : 'N/A',
        dayLow:      snap.dayLow    != null ? `$${snap.dayLow.toFixed(2)}`   : 'N/A',
        open:        snap.open      != null ? `$${snap.open.toFixed(2)}`     : 'N/A',
        volume:      _fv(snap.volume),
        avgVolume:   _fv(snap.avgVolume),
        pe:          val.pe  != null ? val.pe.toFixed(2)                                            : 'N/A',
        eps:         val.eps != null ? `${val.eps >= 0 ? '$' : '-$'}${Math.abs(val.eps).toFixed(2)}` : 'N/A',
        week52High:  snap.yearHigh != null ? `$${snap.yearHigh.toFixed(2)}` : 'N/A',
        week52Low:   snap.yearLow  != null ? `$${snap.yearLow.toFixed(2)}`  : 'N/A',
        marketCap:   snap.marketCap ? _fv(snap.marketCap) : 'N/A',
      };

      // Read RSI gauge
      const rsiNum = document.getElementById('rsiNum');
      const rsiZone = document.querySelector('.rsi-zone');
      if (rsiNum?.textContent && rsiNum.textContent !== '--') {
        ctx.stockAnalysis.rsi = `${rsiNum.textContent.trim()} — ${rsiZone?.textContent?.trim() || 'N/A'}`;
      }

      // Read trading signal (verdict)
      const verdictEl = document.querySelector('.verdict');
      const confEl    = document.querySelector('.verdict-conf');
      if (verdictEl?.textContent && verdictEl.textContent !== '--') {
        ctx.stockAnalysis.tradingSignal = verdictEl.textContent.trim();
        if (confEl?.textContent) ctx.stockAnalysis.signalConfidence = confEl.textContent.trim();
      }

      // Read direction indicator
      const dirLabel = document.querySelector('.dir-label');
      if (dirLabel?.textContent && dirLabel.textContent !== '--') {
        ctx.stockAnalysis.directionBias = dirLabel.textContent.trim();
      }

      // Read volume reading
      const volReading = document.querySelector('.vol-reading');
      if (volReading?.textContent) ctx.stockAnalysis.volumeReading = volReading.textContent.trim();

      // Read support / resistance levels
      const srRows = document.querySelectorAll('.sr-row');
      const levels = [];
      srRows.forEach(row => {
        const type  = row.querySelector('.sr-type')?.textContent?.trim();
        const price = row.querySelector('.sr-price')?.textContent?.trim();
        if (type && price) levels.push(`${type}: ${price}`);
      });
      if (levels.length) ctx.stockAnalysis.supportResistanceLevels = levels.join(' | ');

      // Read JQF score / analyst verdict
      const scoreBadge   = document.querySelector('.score-badge');
      const scoreVerdict = document.querySelector('.score-verdict');
      if (scoreBadge?.textContent && scoreBadge.textContent !== '--') {
        ctx.stockAnalysis.jqfScore = scoreBadge.textContent.trim();
        ctx.stockAnalysis.jqfVerdict = scoreVerdict?.textContent?.trim() || '';
      }

      // Read analyst ratings from FMP data
      const r = fmp?.ratings || {};
      if (r.total > 0) {
        const buy  = (r.strongBuy || 0) + (r.buy || 0);
        const sell = (r.sell || 0) + (r.strongSell || 0);
        ctx.stockAnalysis.analystRatings = {
          total: r.total,
          buy, hold: r.hold || 0, sell,
          consensus: buy > sell && buy > (r.hold || 0) ? 'BUY' : sell > buy ? 'SELL' : 'HOLD',
        };
      }

      // Read price target
      const pt = fmp?.priceTarget;
      if (pt?.targetMedian) {
        const upside = price ? ((pt.targetMedian - price) / price * 100).toFixed(1) : null;
        ctx.stockAnalysis.priceTarget = {
          median: `$${pt.targetMedian.toFixed(2)}`,
          high:   pt.targetHigh ? `$${pt.targetHigh.toFixed(2)}` : 'N/A',
          low:    pt.targetLow  ? `$${pt.targetLow.toFixed(2)}`  : 'N/A',
          upside: upside ? `${upside}%` : 'N/A',
        };
      }

      // Intraday Realtime Trader console
      const rtVerdict = document.getElementById('rtVerdict');
      const rtConf    = document.getElementById('rtConf');
      const rtVwap    = document.getElementById('rtVwap');
      const rtRsi     = document.getElementById('rtRsi');
      const rtBias    = document.getElementById('rtBias');
      if (rtVerdict?.textContent && rtVerdict.textContent !== '--') {
        ctx.stockAnalysis.intradayTrader = {
          verdict:    rtVerdict.textContent.trim(),
          confidence: rtConf?.textContent?.trim()  || 'N/A',
          vwap:       rtVwap?.textContent?.trim()  || 'N/A',
          rsi5min:    rtRsi?.textContent?.trim()   || 'N/A',
          bias:       rtBias?.textContent?.trim()  || 'N/A',
        };
      }
    }

    // ── Markets page context ───────────────────────────────────────────────
    if (appState.page === 'markets') {
      const gainers = [], losers = [];
      document.querySelectorAll('#gainersTable .mrow').forEach(row => {
        const s = row.querySelector('.mrow-sym')?.textContent?.trim();
        const c = row.querySelector('.mrow-chg')?.textContent?.trim();
        if (s) gainers.push(`${s} ${c || ''}`);
      });
      document.querySelectorAll('#losersTable .mrow').forEach(row => {
        const s = row.querySelector('.mrow-sym')?.textContent?.trim();
        const c = row.querySelector('.mrow-chg')?.textContent?.trim();
        if (s) losers.push(`${s} ${c || ''}`);
      });
      ctx.markets = { topGainers: gainers.slice(0,6).join(', '), topLosers: losers.slice(0,6).join(', ') };
    }

    // ── Watchlist page context ─────────────────────────────────────────────
    if (appState.page === 'watchlist' && appState.watchlist?.length) {
      ctx.watchlistDetail = appState.watchlist.join(', ');
    }

    // ── Scanner page context ───────────────────────────────────────────────
    if (appState.page === 'scanner') {
      const rows = [];
      document.querySelectorAll('.sc-tr').forEach(row => {
        const sym = row.querySelector('.sc-td-sym')?.textContent?.trim();
        const sig = row.querySelector('.sc-signal-badge')?.textContent?.trim();
        if (sym && rows.length < 10) rows.push(`${sym}: ${sig || 'N/A'}`);
      });
      if (rows.length) ctx.scannerTopResults = rows.join(' | ');
    }

    return JSON.stringify(ctx, null, 2);
  }

  function _fv(v) {
    if (!v) return 'N/A';
    if (v >= 1e12) return (v / 1e12).toFixed(2) + 'T';
    if (v >= 1e9)  return (v / 1e9).toFixed(1)  + 'B';
    if (v >= 1e6)  return (v / 1e6).toFixed(1)  + 'M';
    if (v >= 1e3)  return (v / 1e3).toFixed(0)  + 'K';
    return String(v);
  }

  // ── Widget State ───────────────────────────────────────────────────────────
  let agentOpen    = false;
  let voiceActive  = false;
  let conversation = null;   // ElevenLabs SDK instance
  let isThinking   = false;
  let history      = [];     // [{role, content}] for AIML context
  const MAX_HIST   = 10;

  // ── Widget HTML ────────────────────────────────────────────────────────────
  const WIDGET_HTML = `
<div id="jqfAgent" class="jqf-agent" role="complementary" aria-label="VixionBot AI Agent">

  <!-- Bubble toggle -->
  <button class="jqf-bubble" id="jqfBubble" aria-label="Open JQF AI Agent" aria-expanded="false">
    <div class="jqf-bubble-ring"></div>
    <svg class="jqf-bubble-icon-open" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
    <svg class="jqf-bubble-icon-close" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="display:none">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
    <div class="jqf-bubble-badge" id="jqfBadge" style="display:none">!</div>
  </button>

  <!-- Chat panel -->
  <div class="jqf-panel" id="jqfPanel" aria-hidden="true">

    <!-- Header -->
    <div class="jqf-panel-head">
      <div class="jqf-head-left">
        <div class="jqf-head-avatar">
          <svg width="20" height="20" viewBox="0 0 32 32" fill="none">
            <path d="M3 22L9 14L15 18L21 7L29 12" stroke="#1dd6a3" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="29" cy="12" r="2.5" fill="#1dd6a3"/>
          </svg>
        </div>
        <div>
          <div class="jqf-head-name">QF Agent</div>
          <div class="jqf-head-status" id="jqfStatus">
            <span class="jqf-status-dot" id="jqfStatusDot"></span>
            <span id="jqfStatusText">Ready</span>
          </div>
        </div>
      </div>
      <div class="jqf-head-actions">
        <button class="jqf-head-btn" id="jqfContextBtn" title="Share screen context with AI">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
        </button>
        <button class="jqf-head-btn" id="jqfMicBtn" title="Start voice conversation">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
        </button>
        <button class="jqf-head-btn" id="jqfClearBtn" title="Clear chat">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button>
        <button class="jqf-head-btn jqf-head-close" id="jqfCloseBtn" title="Close" aria-label="Close">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>

    <!-- Messages area -->
    <div class="jqf-messages" id="jqfMessages" role="log" aria-live="polite">
      <div class="jqf-msg jqf-msg-ai" id="jqfWelcomeMsg">
        <div class="jqf-msg-bubble">
          Hi! I'm your <strong>VixionBot AI assistant</strong>. I can read your live charts, RSI, support &amp; resistance levels, analyst ratings, and trading signals in real time.<br><br>
          Ask me anything about a stock on screen, or try: <em>"Analyze what I'm looking at"</em> or <em>"Is this a good entry?"</em>
        </div>
        <div class="jqf-msg-time">Just now</div>
      </div>
    </div>

    <!-- Voice active panel -->
    <div class="jqf-voice-panel" id="jqfVoicePanel" style="display:none">
      <div class="jqf-voice-orb" id="jqfVoiceOrb">
        <div class="jqf-voice-ring jqf-voice-ring-1"></div>
        <div class="jqf-voice-ring jqf-voice-ring-2"></div>
        <div class="jqf-voice-ring jqf-voice-ring-3"></div>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      </div>
      <p class="jqf-voice-hint" id="jqfVoiceHint">Listening… speak now</p>
      <button class="jqf-voice-end" id="jqfVoiceEndBtn">End Voice Session</button>
    </div>

    <!-- Text input -->
    <div class="jqf-input-row" id="jqfInputRow">
      <input class="jqf-input" id="jqfInput" type="text"
        placeholder="Ask about any stock on screen…" autocomplete="off" maxlength="500"/>
      <button class="jqf-send-btn" id="jqfSendBtn" aria-label="Send">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/>
          <polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
      </button>
    </div>

    <div class="jqf-panel-foot">
      Powered by <a href="https://elevenlabs.io" target="_blank" rel="noopener noreferrer">ElevenLabs</a>
      &amp; <a href="https://aimlapi.com" target="_blank" rel="noopener noreferrer">AIML API</a>
    </div>

  </div>
</div>`;

  // ── Build Widget ───────────────────────────────────────────────────────────
  function buildWidget() {
    const wrap = document.createElement('div');
    wrap.innerHTML = WIDGET_HTML.trim();
    const el = wrap.firstElementChild;
    el.style.display = 'none';
    document.body.appendChild(el);
  }

  // ── Visibility API (called from app.js after login/logout) ─────────────────
  function showWidget() {
    const el = document.getElementById('jqfAgent');
    if (el) el.style.display = 'flex';
  }
  function hideWidget() {
    const el = document.getElementById('jqfAgent');
    if (el) { el.style.display = 'none'; closeAgent(); }
  }
  window.jqfAgent = { show: showWidget, hide: hideWidget };

  // ── Message Management ─────────────────────────────────────────────────────
  function addMessage(text, role) {
    const body = document.getElementById('jqfMessages');
    if (!body) return;

    const now = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const div = document.createElement('div');
    div.className = `jqf-msg jqf-msg-${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'jqf-msg-bubble';

    if (role === 'ai') {
      bubble.innerHTML = _parseMarkdown(text);
    } else {
      bubble.textContent = text;
    }

    const time = document.createElement('div');
    time.className = 'jqf-msg-time';
    time.textContent = now;

    div.appendChild(bubble);
    div.appendChild(time);
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;

    if (!agentOpen) {
      const badge = document.getElementById('jqfBadge');
      if (badge) badge.style.display = 'flex';
    }
  }

  function showThinking() {
    if (isThinking) return;
    isThinking = true;
    const body = document.getElementById('jqfMessages');
    if (!body) return;
    const div = document.createElement('div');
    div.className = 'jqf-msg jqf-msg-ai jqf-msg-thinking';
    div.id = 'jqfThinking';
    div.innerHTML = `<div class="jqf-msg-bubble jqf-thinking-bubble">
      <span class="jqf-dot"></span><span class="jqf-dot"></span><span class="jqf-dot"></span>
    </div>`;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
  }

  function hideThinking() {
    isThinking = false;
    const el = document.getElementById('jqfThinking');
    if (el) el.remove();
  }

  function setStatus(text, type = 'idle') {
    const dot  = document.getElementById('jqfStatusDot');
    const span = document.getElementById('jqfStatusText');
    if (span) span.textContent = text;
    if (dot)  dot.className = `jqf-status-dot jqf-status-${type}`;
  }

  // Minimal markdown parser (bold, italic, line breaks, code)
  function _parseMarkdown(text) {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');
  }

  // ── Text Chat via AIML API ─────────────────────────────────────────────────
  async function sendTextMessage(text) {
    text = text.trim();
    if (!text || isThinking) return;

    // Guard: require login (session may have expired)
    if (!window.state?.currentUser) {
      addMessage('⚠️ Please sign in to use the AI assistant.', 'ai');
      return;
    }

    const input = document.getElementById('jqfInput');
    if (input) { input.value = ''; input.disabled = true; }

    addMessage(text, 'user');
    history.push({ role: 'user', content: text });
    if (history.length > MAX_HIST) history.splice(0, history.length - MAX_HIST);

    showThinking();
    setStatus('Thinking…', 'active');

    try {
      const ctx  = getScreenContext();
      const body = JSON.stringify({ message: text, context: ctx, history });
      const r    = await fetch('/api/agent/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      hideThinking();

      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        const msg = err.error || `Server error (${r.status}). Check your AIML_API_KEY.`;
        addMessage(`⚠️ ${msg}`, 'ai');
        setStatus('Error', 'error');
      } else {
        const data  = await r.json();
        const reply = data.reply || 'Sorry, I couldn\'t generate a response.';
        addMessage(reply, 'ai');
        history.push({ role: 'assistant', content: reply });
        if (history.length > MAX_HIST) history.splice(0, history.length - MAX_HIST);
        setStatus('Ready', 'idle');
      }
    } catch (e) {
      hideThinking();
      addMessage('⚠️ Network error. Please check your connection.', 'ai');
      setStatus('Error', 'error');
    } finally {
      if (input) input.disabled = false;
      input?.focus();
    }
  }

  // ── Voice Chat via ElevenLabs ──────────────────────────────────────────────
  async function startVoice() {
    if (voiceActive) return;

    // Guard: require login
    if (!window.state?.currentUser) {
      addMessage('⚠️ Please sign in to use the voice assistant.', 'ai');
      return;
    }

    setStatus('Connecting voice…', 'active');
    const micBtn = document.getElementById('jqfMicBtn');
    if (micBtn) micBtn.disabled = true;

    try {
      // Get signed URL from server
      const r = await fetch('/api/elevenlabs/signed-url');
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        addMessage(`⚠️ Voice unavailable: ${err.error || 'Configure ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID in your secrets.'}`, 'ai');
        setStatus('Voice offline', 'error');
        if (micBtn) micBtn.disabled = false;
        return;
      }
      const { signedUrl } = await r.json();

      // Load SDK
      const sdk = await loadElevenLabsSDK();
      if (!sdk?.Conversation) {
        addMessage('⚠️ ElevenLabs SDK failed to load. Please refresh and try again.', 'ai');
        setStatus('Error', 'error');
        if (micBtn) micBtn.disabled = false;
        return;
      }

      conversation = await sdk.Conversation.startSession({
        signedUrl,
        clientTools: {
          get_screen_context: async () => {
            return getScreenContext();
          },
        },
        onConnect: () => {
          voiceActive = true;
          showVoicePanel(true);
          setStatus('Voice active', 'voice');
          addMessage('🎤 Voice session started. You can speak now — I can see your current screen!', 'ai');
          if (micBtn) {
            micBtn.disabled = false;
            micBtn.title = 'End voice session';
            micBtn.classList.add('jqf-mic-active');
          }
        },
        onDisconnect: () => {
          conversation = null;
          voiceActive  = false;
          showVoicePanel(false);
          setStatus('Ready', 'idle');
          addMessage('Voice session ended.', 'ai');
          if (micBtn) {
            micBtn.disabled = false;
            micBtn.title = 'Start voice conversation';
            micBtn.classList.remove('jqf-mic-active');
          }
        },
        onMessage: ({ message, source }) => {
          if (message && source) addMessage(message, source === 'ai' ? 'ai' : 'user');
        },
        onError: (msg) => {
          addMessage(`⚠️ Voice error: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, 'ai');
          setStatus('Error', 'error');
        },
        onStatusChange: ({ status }) => {
          if (status === 'connected')    setStatus('Voice active', 'voice');
          if (status === 'disconnected') setStatus('Ready', 'idle');
        },
        onModeChange: ({ mode }) => {
          const hint = document.getElementById('jqfVoiceHint');
          const orb  = document.getElementById('jqfVoiceOrb');
          if (mode?.mode === 'speaking') {
            if (hint) hint.textContent = 'Agent speaking…';
            if (orb)  orb.classList.add('jqf-orb-speaking');
          } else {
            if (hint) hint.textContent = 'Listening… speak now';
            if (orb)  orb.classList.remove('jqf-orb-speaking');
          }
        },
      });
    } catch (e) {
      addMessage('⚠️ Could not start voice session. Make sure your browser allows microphone access.', 'ai');
      setStatus('Error', 'error');
      if (micBtn) micBtn.disabled = false;
    }
  }

  async function stopVoice() {
    if (conversation) {
      try { await conversation.endSession(); } catch {}
      conversation = null;
    }
    voiceActive = false;
    showVoicePanel(false);
    setStatus('Ready', 'idle');
  }

  function showVoicePanel(show) {
    const vp  = document.getElementById('jqfVoicePanel');
    const ir  = document.getElementById('jqfInputRow');
    if (vp) vp.style.display = show ? 'flex' : 'none';
    if (ir) ir.style.display = show ? 'none' : 'flex';
  }

  // Load @11labs/client SDK from CDN
  function loadElevenLabsSDK() {
    return new Promise((resolve) => {
      if (window.ElevenLabs?.Conversation) { resolve(window.ElevenLabs); return; }
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/@11labs/client@latest/dist/index.umd.js';
      s.onload = () => {
        const sdk = window.ElevenLabs || window.ElevenLabsClient;
        resolve(sdk || null);
      };
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  }

  // ── Widget Open/Close ──────────────────────────────────────────────────────
  function openAgent() {
    agentOpen = true;
    const panel  = document.getElementById('jqfPanel');
    const bubble = document.getElementById('jqfBubble');
    const badge  = document.getElementById('jqfBadge');
    const iconO  = bubble?.querySelector('.jqf-bubble-icon-open');
    const iconC  = bubble?.querySelector('.jqf-bubble-icon-close');
    if (panel)  { panel.style.display = 'flex'; setTimeout(() => panel.classList.add('jqf-panel-open'), 10); }
    if (iconO)  iconO.style.display = 'none';
    if (iconC)  iconC.style.display = '';
    if (badge)  badge.style.display = 'none';
    if (bubble) bubble.setAttribute('aria-expanded', 'true');
    if (panel)  panel.setAttribute('aria-hidden', 'false');
    setTimeout(() => document.getElementById('jqfInput')?.focus(), 350);
  }

  function closeAgent() {
    agentOpen = false;
    const panel  = document.getElementById('jqfPanel');
    const bubble = document.getElementById('jqfBubble');
    const iconO  = bubble?.querySelector('.jqf-bubble-icon-open');
    const iconC  = bubble?.querySelector('.jqf-bubble-icon-close');
    if (panel) {
      panel.classList.remove('jqf-panel-open');
      setTimeout(() => { if (!agentOpen) panel.style.display = 'none'; }, 280);
    }
    if (iconO)  iconO.style.display = '';
    if (iconC)  iconC.style.display = 'none';
    if (bubble) bubble.setAttribute('aria-expanded', 'false');
    if (panel)  panel.setAttribute('aria-hidden', 'true');
  }

  // ── Event Bindings ─────────────────────────────────────────────────────────
  function bindEvents() {
    // Bubble toggle
    document.getElementById('jqfBubble')?.addEventListener('click', () => {
      agentOpen ? closeAgent() : openAgent();
    });

    // Close button
    document.getElementById('jqfCloseBtn')?.addEventListener('click', closeAgent);

    // Send button
    document.getElementById('jqfSendBtn')?.addEventListener('click', () => {
      const v = document.getElementById('jqfInput')?.value;
      if (v?.trim()) sendTextMessage(v);
    });

    // Enter key
    document.getElementById('jqfInput')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const v = document.getElementById('jqfInput')?.value;
        if (v?.trim()) sendTextMessage(v);
      }
    });

    // Mic button — toggle voice
    document.getElementById('jqfMicBtn')?.addEventListener('click', () => {
      if (voiceActive) stopVoice(); else startVoice();
    });

    // Screen context button — share context as message
    document.getElementById('jqfContextBtn')?.addEventListener('click', () => {
      const ctx = JSON.parse(getScreenContext());
      const page = ctx.currentPage;
      const sym  = ctx.stockAnalysis?.symbol;
      let summary = `📊 **Current Screen Context**\n`;
      summary += `Page: ${page}  |  Market: ${ctx.marketStatus}\n`;
      if (sym) {
        const s = ctx.stockAnalysis;
        summary += `Stock: **${sym}** (${s.name})  |  ${s.price}  ${s.change}\n`;
        if (s.rsi)          summary += `RSI: ${s.rsi}\n`;
        if (s.tradingSignal) summary += `Signal: ${s.tradingSignal} (${s.signalConfidence || ''})\n`;
        if (s.supportResistanceLevels) summary += `S&R: ${s.supportResistanceLevels}\n`;
        if (s.intradayTrader) summary += `Intraday: ${s.intradayTrader.verdict} | VWAP ${s.intradayTrader.vwap} | RSI(5) ${s.intradayTrader.rsi5min}\n`;
      }
      if (ctx.markets) {
        summary += `Gainers: ${ctx.markets.topGainers}\nLosers: ${ctx.markets.topLosers}`;
      }
      addMessage(summary, 'ai');
    });

    // Clear button
    document.getElementById('jqfClearBtn')?.addEventListener('click', () => {
      const body = document.getElementById('jqfMessages');
      if (body) body.innerHTML = '';
      history = [];
      addMessage('Chat cleared. I\'m ready to help — what would you like to know?', 'ai');
    });

    // End voice session
    document.getElementById('jqfVoiceEndBtn')?.addEventListener('click', stopVoice);
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    buildWidget();
    bindEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
