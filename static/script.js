async function runORB() {
    const symbol = document.getElementById('symbol').value;
    const profit = document.getElementById('profit').value;
    const resultDiv = document.getElementById('result');
    
    resultDiv.innerHTML = 'Processing...';
    resultDiv.className = 'result';
    
    try {
        const response = await fetch('/run_orb', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                symbol: symbol,
                take_profit: parseFloat(profit)
            })
        });
        
        const data = await response.json();
        
        let statusClass = '';
        let output = '';
        
        switch(data.status) {
            case 'TRADE_PLACED':
                statusClass = 'success';
                output = `<strong>Trade Placed!</strong><br>
                    Direction: ${data.direction}<br>
                    Symbol: ${data.symbol}<br>
                    Entry: $${data.entry_price.toFixed(2)}<br>
                    Take Profit: $${data.take_profit.toFixed(2)}<br>
                    ORB Range: $${data.orb_low.toFixed(2)} - $${data.orb_high.toFixed(2)}`;
                break;
            case 'NO_BREAKOUT':
                statusClass = 'info';
                output = `<strong>No Breakout</strong><br>${data.message}`;
                if (data.current_price) {
                    output += `<br>Current: $${data.current_price.toFixed(2)}<br>
                        ORB Range: $${data.orb_low.toFixed(2)} - $${data.orb_high.toFixed(2)}`;
                }
                break;
            case 'WAIT':
                statusClass = 'warning';
                output = `<strong>Waiting</strong><br>${data.message}`;
                break;
            default:
                statusClass = 'error';
                output = `<strong>Error</strong><br>${data.message}`;
        }
        
        resultDiv.className = 'result ' + statusClass;
        resultDiv.innerHTML = output;
        
    } catch (error) {
        resultDiv.className = 'result error';
        resultDiv.innerHTML = '<strong>Error</strong><br>Failed to connect to server.';
    }
}

function toggleTheme() {
    document.body.classList.toggle('light-mode');
    localStorage.setItem('theme', document.body.classList.contains('light-mode') ? 'light' : 'dark');
}

document.addEventListener('DOMContentLoaded', function() {
    if (localStorage.getItem('theme') === 'light') {
        document.body.classList.add('light-mode');
    }
});