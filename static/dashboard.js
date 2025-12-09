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

document.addEventListener("DOMContentLoaded", loadTheme);
