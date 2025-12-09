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
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span style="color: #888;">Account Equity:</span>
            <span style="color: #4caf50;">$${equity.toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span style="color: #888;">Max Risk (${(maxRisk * 100).toFixed(0)}%):</span>
            <span style="color: #ff9800;">$${maxRiskDollars.toFixed(2)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span style="color: #888;">Position Size:</span>
            <span>${positionInfo}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
            <span style="color: #888;">Stop Loss:</span>
            <span style="color: #f44336;">${stopLoss}%</span>
        </div>
    `;
}

function getPositionSettings() {
    const sizeType = document.getElementById("position-size-type")?.value || "fixed";
    const sizeValue = parseFloat(document.getElementById("position-value")?.value) || 1;
    const stopLoss = parseFloat(document.getElementById("stop-loss")?.value) || 2;
    const maxRisk = parseFloat(document.getElementById("max-risk")?.value) || 0.02;
    
    return {
        size_type: sizeType,
        size_value: sizeValue,
        stop_loss: stopLoss / 100,
        max_risk: maxRisk
    };
}

async function runORB() {
    const symbol = document.getElementById("symbol").value;
    const profit = document.getElementById("profit").value;
    const accountEl = document.getElementById("account");
    const account_id = accountEl ? accountEl.value : null;
    const resultEl = document.getElementById("result");
    
    const positionSettings = getPositionSettings();
    
    resultEl.innerText = "Running strategy...";
    resultEl.style.color = "#888";
    
    try {
        const res = await fetch("/api/run_strategy", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                strategy: "orb",
                symbol: symbol,
                take_profit: parseFloat(profit),
                account_id: account_id,
                position: positionSettings
            })
        });
        
        const data = await res.json();
        
        if (data.status === "TRADE_PLACED") {
            resultEl.style.color = "#4caf50";
            resultEl.innerText = data.message;
        } else if (data.status === "NO_BREAKOUT") {
            resultEl.style.color = "#ff9800";
            resultEl.innerText = data.message;
        } else if (data.status === "WAIT") {
            resultEl.style.color = "#2196f3";
            resultEl.innerText = data.message;
        } else {
            resultEl.style.color = "#f44336";
            resultEl.innerText = data.message || "An error occurred";
        }
    } catch (e) {
        resultEl.style.color = "#f44336";
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
            "orb_ready": "#4caf50",
            "opening": "#ff9800",
            "pre_market": "#2196f3",
            "closed": "#f44336",
            "error": "#888"
        };
        
        indicator.style.background = colors[data.status] || "#888";
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
                const plColor = pos.unrealized_pl >= 0 ? "#4caf50" : "#f44336";
                const plSign = pos.unrealized_pl >= 0 ? "+" : "";
                html += `
                <div style="background: #2a2a2a; padding: 10px; border-radius: 6px; margin-bottom: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <strong>${pos.symbol}</strong>
                            <span style="color: #888; font-size: 12px; margin-left: 8px;">${pos.qty} shares</span>
                        </div>
                        <span style="color: ${plColor}; font-weight: bold;">${plSign}${pos.unrealized_plpc.toFixed(2)}%</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-top: 6px; font-size: 12px;">
                        <span style="color: #888;">Entry: $${pos.entry_price.toFixed(2)} | Current: $${pos.current_price.toFixed(2)}</span>
                        <span style="color: ${plColor};">${plSign}$${pos.unrealized_pl.toFixed(2)}</span>
                    </div>
                    <button onclick="closePosition('${pos.symbol}', ${accountId})" 
                        style="margin-top: 8px; padding: 6px 12px; font-size: 12px; background: #ff9800; border: none; border-radius: 4px; color: white; cursor: pointer;">
                        Take Profit
                    </button>
                </div>`;
            });
            positionsList.innerHTML = html;
        } else {
            positionsList.innerHTML = '<p style="color: #888; font-size: 13px;">No positions</p>';
        }
    } catch (e) {
        console.error("Positions error:", e);
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
