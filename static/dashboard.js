function toggleTheme() {
    document.body.classList.toggle("light-mode");
    localStorage.setItem("theme", document.body.classList.contains("light-mode") ? "light" : "dark");
}

function loadTheme() {
    if (localStorage.getItem("theme") === "light") {
        document.body.classList.add("light-mode");
    }
}

function togglePositionInput() {
    const sizeType = document.getElementById("position-size-type").value;
    const label = document.getElementById("position-value-label");
    const input = document.getElementById("position-value");
    
    if (sizeType === "fixed") {
        label.innerText = "Shares:";
        input.value = "1";
        input.step = "1";
        input.min = "1";
    } else if (sizeType === "dollars") {
        label.innerText = "Amount ($):";
        input.value = "100";
        input.step = "10";
        input.min = "10";
    } else if (sizeType === "percent") {
        label.innerText = "Percent (%):";
        input.value = "5";
        input.step = "1";
        input.min = "1";
        input.max = "100";
    }
    updateRiskPreview();
}

function updateRiskPreview() {
    const accountEl = document.getElementById("account");
    const preview = document.getElementById("risk-preview");
    
    if (!accountEl || !preview) return;
    
    const selected = accountEl.options[accountEl.selectedIndex];
    const equity = parseFloat(selected.dataset.equity) || 0;
    const buyingPower = parseFloat(selected.dataset.buyingPower) || 0;
    
    const sizeType = document.getElementById("position-size-type").value;
    const sizeValue = parseFloat(document.getElementById("position-value").value) || 0;
    const stopLoss = parseFloat(document.getElementById("stop-loss").value) || 2;
    const maxRisk = parseFloat(document.getElementById("max-risk").value) || 0.02;
    
    const maxRiskDollars = equity * maxRisk;
    
    let positionInfo = "";
    if (sizeType === "fixed") {
        positionInfo = `${sizeValue} shares`;
    } else if (sizeType === "dollars") {
        positionInfo = `$${sizeValue.toFixed(0)} position`;
    } else if (sizeType === "percent") {
        const dollarAmount = buyingPower * (sizeValue / 100);
        positionInfo = `${sizeValue}% = $${dollarAmount.toFixed(0)}`;
    }
    
    preview.innerHTML = `
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span style="color: #666680;">Account Equity</span>
            <span style="color: #00ff80; text-shadow: 0 0 10px rgba(0, 255, 128, 0.5);">$${equity.toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span style="color: #666680;">Max Risk (${(maxRisk * 100).toFixed(0)}%)</span>
            <span style="color: #ff8000; text-shadow: 0 0 10px rgba(255, 128, 0, 0.5);">$${maxRiskDollars.toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span style="color: #666680;">Position Size</span>
            <span style="color: #00ffff;">${positionInfo}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
            <span style="color: #666680;">Stop Loss</span>
            <span style="color: #ff0080; text-shadow: 0 0 10px rgba(255, 0, 128, 0.5);">${stopLoss}%</span>
        </div>
    `;
}

function getPositionSettings() {
    const sizeType = document.getElementById("position-size-type")?.value || "fixed";
    const sizeValue = parseFloat(document.getElementById("position-value")?.value) || 1;
    const stopLoss = parseFloat(document.getElementById("stop-loss")?.value) || 2;
    const maxRisk = parseFloat(document.getElementById("max-risk")?.value) || 0.02;
    const trailingStop = document.getElementById("trailing-stop")?.checked || false;
    
    return {
        size_type: sizeType,
        size_value: sizeValue,
        stop_loss: stopLoss / 100,
        max_risk: maxRisk,
        trailing_sl: trailingStop
    };
}

async function runORB() {
    const symbol = document.getElementById("symbol").value;
    const profit = document.getElementById("profit").value;
    const accountEl = document.getElementById("account");
    const account_id = accountEl ? accountEl.value : null;
    const resultEl = document.getElementById("result");
    
    const positionSettings = getPositionSettings();
    
    resultEl.style.display = "block";
    resultEl.innerText = "Executing strategy...";
    resultEl.style.color = "#00ffff";
    resultEl.style.borderLeftColor = "#00ffff";
    
    try {
        const res = await fetch("/api/run_strategy", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                strategy: "orb",
                symbol: symbol,
                take_profit: profit === "manual" ? "manual" : parseFloat(profit),
                account_id: account_id,
                position: positionSettings
            })
        });
        
        const data = await res.json();
        
        if (data.status === "TRADE_PLACED") {
            resultEl.style.color = "#00ff80";
            resultEl.style.borderLeftColor = "#00ff80";
            resultEl.style.textShadow = "0 0 10px rgba(0, 255, 128, 0.5)";
            resultEl.innerText = data.message;
        } else if (data.status === "NO_BREAKOUT") {
            resultEl.style.color = "#ff8000";
            resultEl.style.borderLeftColor = "#ff8000";
            resultEl.style.textShadow = "0 0 10px rgba(255, 128, 0, 0.5)";
            resultEl.innerText = data.message;
        } else if (data.status === "WAIT") {
            resultEl.style.color = "#0080ff";
            resultEl.style.borderLeftColor = "#0080ff";
            resultEl.style.textShadow = "0 0 10px rgba(0, 128, 255, 0.5)";
            resultEl.innerText = data.message;
        } else {
            resultEl.style.color = "#ff0080";
            resultEl.style.borderLeftColor = "#ff0080";
            resultEl.style.textShadow = "0 0 10px rgba(255, 0, 128, 0.5)";
            resultEl.innerText = data.message || "An error occurred";
        }
    } catch (e) {
        resultEl.style.color = "#ff0080";
        resultEl.style.borderLeftColor = "#ff0080";
        resultEl.style.textShadow = "0 0 10px rgba(255, 0, 128, 0.5)";
        resultEl.innerText = "Network error. Please try again.";
    }
}

async function fetchMarketStatus() {
    try {
        const res = await fetch("/api/market_status");
        const data = await res.json();
        
        const indicator = document.getElementById("status-indicator");
        const statusText = document.getElementById("status-text");
        const timeEl = document.getElementById("current-time");
        
        if (!indicator || !statusText) return;
        
        const colors = {
            "orb_ready": "#00ff80",
            "opening": "#ff8000",
            "pre_market": "#0080ff",
            "closed": "#ff0080",
            "error": "#666680"
        };
        
        const color = colors[data.status] || "#666680";
        indicator.style.background = color;
        indicator.style.boxShadow = `0 0 10px ${color}, 0 0 20px ${color}`;
        indicator.className = `status-dot ${data.status}`;
        statusText.innerText = data.message;
        if (timeEl && data.current_time) {
            timeEl.innerText = data.current_time;
        }
    } catch (e) {
        console.error("Market status error:", e);
    }
}

async function fetchPositions() {
    const accountEl = document.getElementById("monitor-account");
    const positionsList = document.getElementById("positions-list");
    
    if (!accountEl || !positionsList) return;
    
    const accountId = accountEl.value;
    if (!accountId) return;
    
    try {
        const res = await fetch(`/api/positions?account_id=${accountId}`);
        const data = await res.json();
        
        if (data.positions && data.positions.length > 0) {
            let html = "";
            data.positions.forEach(pos => {
                const isProfit = pos.unrealized_pl >= 0;
                const plColor = isProfit ? "#00ff80" : "#ff0080";
                const plGlow = isProfit ? "0 0 10px rgba(0, 255, 128, 0.5)" : "0 0 10px rgba(255, 0, 128, 0.5)";
                const plSign = isProfit ? "+" : "";
                const borderColor = isProfit ? "rgba(0, 255, 128, 0.3)" : "rgba(255, 0, 128, 0.3)";
                html += `
                <div style="background: rgba(0, 0, 0, 0.4); padding: 15px; border-radius: 8px; margin-bottom: 10px; border: 1px solid ${borderColor}; transition: all 0.3s ease;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <strong style="color: #00ffff; font-family: Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif; letter-spacing: 1px;">${pos.symbol}</strong>
                            <span style="color: #666680; font-size: 12px; margin-left: 10px;">${pos.qty} shares</span>
                        </div>
                        <span style="color: ${plColor}; font-weight: bold; text-shadow: ${plGlow};">${plSign}${pos.unrealized_plpc.toFixed(2)}%</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-top: 10px; font-size: 12px;">
                        <span style="color: #666680;">Entry: <span style="color: #e0e0e0;">$${pos.entry_price.toFixed(2)}</span> | Current: <span style="color: #00ffff;">$${pos.current_price.toFixed(2)}</span></span>
                        <span style="color: ${plColor}; text-shadow: ${plGlow};">${plSign}$${pos.unrealized_pl.toFixed(2)}</span>
                    </div>
                    <button onclick="closePosition('${pos.symbol}', ${accountId})" 
                        style="margin-top: 12px; padding: 8px 16px; font-size: 11px; background: linear-gradient(135deg, rgba(255, 128, 0, 0.2), rgba(255, 0, 128, 0.1)); border: 1px solid #ff8000; border-radius: 4px; color: #ff8000; cursor: pointer; font-family: Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif; letter-spacing: 1px; text-transform: uppercase; transition: all 0.3s ease;">
                        Take Profit
                    </button>
                </div>`;
            });
            positionsList.innerHTML = html;
        } else {
            positionsList.innerHTML = '<p style="color: #666680; font-size: 13px; text-align: center; padding: 20px 0;">No active positions</p>';
        }
    } catch (e) {
        console.error("Positions error:", e);
    }
}

async function runSMABot() {
    const accountEl = document.getElementById("sma-account");
    const qtyEl = document.getElementById("sma-qty");
    const resultEl = document.getElementById("sma-result");
    
    const accountId = accountEl ? accountEl.value : null;
    const qty = qtyEl ? parseInt(qtyEl.value) || 1 : 1;
    
    if (!accountId) {
        resultEl.style.display = "block";
        resultEl.style.color = "#ff0080";
        resultEl.style.borderLeftColor = "#ff0080";
        resultEl.innerText = "Please select an account";
        return;
    }
    
    resultEl.style.display = "block";
    resultEl.style.color = "#ff00ff";
    resultEl.style.borderLeftColor = "#ff00ff";
    resultEl.innerText = "Running SMA Bot on INTC, DAL, T...";
    
    try {
        const res = await fetch("/api/run_sma_bot", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                account_id: accountId,
                qty: qty
            })
        });
        
        const data = await res.json();
        
        if (data.status === "SUCCESS") {
            let resultText = "SMA Bot Results:\n\n";
            const results = data.results || {};
            
            for (const [ticker, info] of Object.entries(results)) {
                const signal = info.signal?.toUpperCase() || "N/A";
                const signalColor = signal === "BUY" ? "↑" : signal === "SELL" ? "↓" : "→";
                const orderStatus = info.order_placed ? "✓ Order placed" : "";
                resultText += `${ticker}: ${signalColor} ${signal} ${orderStatus}\n`;
                if (info.sma_fast && info.sma_slow) {
                    resultText += `  SMA5: ${info.sma_fast.toFixed(2)} | SMA20: ${info.sma_slow.toFixed(2)}\n`;
                }
            }
            
            if (data.orders_placed && data.orders_placed.length > 0) {
                resultText += `\n${data.orders_placed.length} order(s) placed`;
                resultEl.style.color = "#00ff80";
                resultEl.style.borderLeftColor = "#00ff80";
            } else {
                resultEl.style.color = "#ff8000";
                resultEl.style.borderLeftColor = "#ff8000";
                resultText += "\nNo orders placed (signals: hold or insufficient data)";
            }
            
            resultEl.style.whiteSpace = "pre-wrap";
            resultEl.innerText = resultText;
        } else {
            resultEl.style.color = "#ff0080";
            resultEl.style.borderLeftColor = "#ff0080";
            resultEl.innerText = data.message || "Error running SMA bot";
        }
    } catch (e) {
        resultEl.style.color = "#ff0080";
        resultEl.style.borderLeftColor = "#ff0080";
        resultEl.innerText = "Network error. Please try again.";
    }
}

async function closePosition(symbol, accountId) {
    if (!confirm(`Close position for ${symbol}?`)) return;
    
    try {
        const res = await fetch("/api/close_position", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ symbol: symbol, account_id: accountId })
        });
        
        const data = await res.json();
        
        if (data.success) {
            alert(data.message);
            fetchPositions();
        } else {
            alert("Error: " + (data.error || "Failed to close position"));
        }
    } catch (e) {
        alert("Network error");
    }
}

function startActivityMonitor() {
    fetchMarketStatus();
    fetchPositions();
    
    setInterval(fetchMarketStatus, 10000);
    setInterval(fetchPositions, 10000);
    
    const accountEl = document.getElementById("monitor-account");
    if (accountEl) {
        accountEl.addEventListener("change", fetchPositions);
    }
}

function initPositionSettings() {
    updateRiskPreview();
    
    const inputs = ["position-value", "stop-loss"];
    inputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener("input", updateRiskPreview);
        }
    });
    
    const selects = ["position-size-type", "max-risk"];
    selects.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener("change", updateRiskPreview);
        }
    });
}

document.addEventListener("DOMContentLoaded", function() {
    loadTheme();
    startActivityMonitor();
    initPositionSettings();
});
