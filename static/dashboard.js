function toggleTheme() {
    document.body.classList.toggle("light-mode");
    localStorage.setItem("theme", document.body.classList.contains("light-mode") ? "light" : "dark");
}

function loadTheme() {
    if (localStorage.getItem("theme") === "light") {
        document.body.classList.add("light-mode");
    }
}

async function runORB() {
    const symbol = document.getElementById("symbol").value;
    const profit = document.getElementById("profit").value;
    const accountEl = document.getElementById("account");
    const account_id = accountEl ? accountEl.value : null;
    const resultEl = document.getElementById("result");
    
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
                account_id: account_id
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

document.addEventListener("DOMContentLoaded", function() {
    loadTheme();
    startActivityMonitor();
});
