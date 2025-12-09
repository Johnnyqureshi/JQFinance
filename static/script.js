async function runORB() {
    const symbol = document.getElementById("symbol").value;
    const profit = document.getElementById("profit").value;

    const res = await fetch("/run_orb", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({symbol, take_profit: profit})
    });

    const data = await res.json();
    document.getElementById("result").innerText = JSON.stringify(data, null, 2);
}

function toggleTheme() {
    document.body.classList.toggle("light-mode");
}