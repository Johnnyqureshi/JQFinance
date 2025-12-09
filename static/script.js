document.addEventListener('DOMContentLoaded', function() {
    const form = document.getElementById('orbForm');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoading = submitBtn.querySelector('.btn-loading');
    const statusPanel = document.getElementById('statusPanel');
    const statusBadge = document.getElementById('statusBadge');
    const badgeIcon = document.getElementById('badgeIcon');
    const badgeText = document.getElementById('badgeText');
    const statusMessage = document.getElementById('statusMessage');
    const tradeDetails = document.getElementById('tradeDetails');

    const statusConfig = {
        'WAIT': {
            class: 'wait',
            icon: '⏱',
            text: 'Waiting'
        },
        'NO_BREAKOUT': {
            class: 'no-breakout',
            icon: '📊',
            text: 'No Breakout'
        },
        'TRADE_PLACED': {
            class: 'trade-placed',
            icon: '✓',
            text: 'Trade Placed'
        },
        'ERROR': {
            class: 'error',
            icon: '⚠',
            text: 'Error'
        },
        'ORDER_ERROR': {
            class: 'error',
            icon: '⚠',
            text: 'Order Error'
        }
    };

    form.addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const symbol = document.getElementById('symbol').value;
        const takeProfit = parseFloat(document.getElementById('takeProfit').value) / 100;
        
        if (!symbol) {
            showStatus('ERROR', 'Please select a symbol.');
            return;
        }
        
        setLoading(true);
        
        try {
            const response = await fetch('/run_orb', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    symbol: symbol,
                    take_profit: takeProfit
                })
            });
            
            const data = await response.json();
            displayResult(data);
        } catch (error) {
            showStatus('ERROR', 'Failed to connect to server. Please try again.');
        } finally {
            setLoading(false);
        }
    });

    function setLoading(loading) {
        submitBtn.disabled = loading;
        btnText.style.display = loading ? 'none' : 'inline';
        btnLoading.style.display = loading ? 'flex' : 'none';
    }

    function showStatus(status, message) {
        statusPanel.style.display = 'block';
        
        const config = statusConfig[status] || statusConfig['ERROR'];
        
        statusBadge.className = 'status-badge ' + config.class;
        badgeIcon.textContent = config.icon;
        badgeText.textContent = config.text;
        statusMessage.textContent = message;
        tradeDetails.style.display = 'none';
    }

    function displayResult(data) {
        statusPanel.style.display = 'block';
        
        const status = data.status;
        const config = statusConfig[status] || statusConfig['ERROR'];
        
        statusBadge.className = 'status-badge ' + config.class;
        badgeIcon.textContent = config.icon;
        badgeText.textContent = config.text;
        statusMessage.textContent = data.message || '';
        
        if (status === 'TRADE_PLACED') {
            tradeDetails.style.display = 'block';
            document.getElementById('detailSymbol').textContent = data.symbol;
            
            const directionEl = document.getElementById('detailDirection');
            directionEl.textContent = data.direction;
            directionEl.className = 'detail-value ' + data.direction.toLowerCase();
            
            document.getElementById('detailEntry').textContent = '$' + data.entry_price.toFixed(2);
            document.getElementById('detailTP').textContent = '$' + data.take_profit.toFixed(2);
            document.getElementById('detailHigh').textContent = '$' + data.orb_high.toFixed(2);
            document.getElementById('detailLow').textContent = '$' + data.orb_low.toFixed(2);
        } else if (status === 'NO_BREAKOUT' && data.current_price) {
            tradeDetails.style.display = 'block';
            document.getElementById('detailSymbol').textContent = document.getElementById('symbol').value;
            document.getElementById('detailDirection').textContent = '-';
            document.getElementById('detailDirection').className = 'detail-value';
            document.getElementById('detailEntry').textContent = '$' + data.current_price.toFixed(2);
            document.getElementById('detailTP').textContent = '-';
            document.getElementById('detailHigh').textContent = '$' + data.orb_high.toFixed(2);
            document.getElementById('detailLow').textContent = '$' + data.orb_low.toFixed(2);
        } else {
            tradeDetails.style.display = 'none';
        }
        
        statusPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
});
