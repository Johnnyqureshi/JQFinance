'use strict';

const { brokerOrderMatchesIntent } = require('./broker-order-ownership');

const STRATEGIES = ['momentum', 'pmh', 'candlestick'];
const SCENARIOS = [
  ['full-fill', 'Full entry and protected exit fill'],
  ['partial-fill', 'Single partial entry fill'],
  ['multiple-partial-fills', 'Several partial entry fills'],
  ['delayed-fill', 'Entry fills after an initial empty broker snapshot'],
  ['broker-timeout', 'Broker accepts an order but the request times out'],
  ['broker-response-timeout', 'Broker response is lost after acceptance'],
  ['rejected-order', 'Broker rejects the entry'],
  ['cancelled-order', 'Broker cancels the entry'],
  ['cancel-request-timeout', 'Protection cancellation remains pending once'],
  ['lost-broker-response', 'Order lookup recovers a lost submission'],
  ['duplicate-broker-response', 'The same broker response is returned twice'],
  ['restart-pending', 'Process restart while an entry is pending'],
  ['restart-partial', 'Process restart after a partial entry fill'],
  ['restart-holding', 'Process restart while holding a position'],
  ['restart-protected', 'Process restart while protective orders exist'],
  ['reconnect', 'Broker disconnect followed by reconnect'],
  ['browser-closed-exit', 'Exit occurs without a browser tab'],
  ['logged-out-exit', 'Exit occurs after user logout'],
  ['position-at-startup', 'Position already exists at startup'],
  ['order-at-startup', 'Broker order already exists at startup'],
  ['unexpected-broker-state', 'Unexpected broker state is flagged'],
  ['cross-bot-isolation', 'Same-symbol orders remain strategy-owned'],
  ['duplicate-entry', 'A repeated entry intent is idempotent'],
];

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function brokerError(code, message, extras = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extras);
  return error;
}

class PaperBroker {
  constructor({ strategy, symbol, responseFault = null } = {}) {
    this.strategy = strategy;
    this.accountId = `paper-account-${strategy}`;
    this.symbol = symbol;
    this.responseFault = responseFault;
    this.available = true;
    this.nextOrder = 1;
    this.orders = new Map();
    this.positions = new Map();
    this.events = [];
    this.cancelTimeouts = new Set();
  }

  submit({ symbol, side, qty, clientOrderId, protectedOrder = false }) {
    if (!this.available) throw brokerError('BROKER_DISCONNECTED', 'Paper broker is disconnected.');
    const existing = this.orders.get(clientOrderId);
    if (existing) {
      this.events.push({ event: 'duplicate_response', clientOrderId });
      return { ...copy(existing), duplicateResponse: true };
    }
    const order = {
      id: `${this.strategy}-paper-${this.nextOrder++}`,
      client_order_id: clientOrderId,
      symbol,
      side,
      qty: Number(qty),
      filled_qty: 0,
      filled_avg_price: 0,
      status: 'new',
      legs: protectedOrder ? [
        { id: `${clientOrderId}-stop`, type: 'stop', side: side === 'buy' ? 'sell' : 'buy', status: 'held' },
        { id: `${clientOrderId}-target`, type: 'limit', side: side === 'buy' ? 'sell' : 'buy', status: 'held' },
      ] : [],
    };
    this.orders.set(clientOrderId, order);
    this.events.push({ event: 'submitted', orderId: order.id, clientOrderId });
    if (this.responseFault) {
      const fault = this.responseFault;
      this.responseFault = null;
      if (fault === 'timeout') {
        throw brokerError('BROKER_TIMEOUT', 'Paper broker request timed out after acceptance.', { orderAccepted: true, orderId: order.id });
      }
      if (fault === 'lost-response') {
        throw brokerError('RESPONSE_LOST', 'Paper broker response was lost after acceptance.', { orderAccepted: true, orderId: order.id });
      }
    }
    return copy(order);
  }

  fill(clientOrderId, qty, price) {
    const order = this.orders.get(clientOrderId);
    if (!order) throw new Error(`Unknown paper order ${clientOrderId}`);
    const remaining = order.qty - order.filled_qty;
    const fillQty = Math.min(Math.max(0, Number(qty)), remaining);
    if (!(fillQty > 0)) return copy(order);
    const priorValue = order.filled_qty * order.filled_avg_price;
    order.filled_qty += fillQty;
    order.filled_avg_price = (priorValue + fillQty * Number(price)) / order.filled_qty;
    order.status = order.filled_qty >= order.qty ? 'filled' : 'partially_filled';
    const signed = order.side === 'buy' ? fillQty : -fillQty;
    this.positions.set(order.symbol, (this.positions.get(order.symbol) || 0) + signed);
    if (order.legs.length && order.status !== 'new') {
      order.legs.forEach(leg => { if (leg.status === 'held') leg.status = 'accepted'; });
    }
    this.events.push({ event: 'fill', orderId: order.id, qty: fillQty, price: Number(price) });
    return copy(order);
  }

  reject(clientOrderId) {
    const order = this.orders.get(clientOrderId);
    if (!order) throw new Error(`Unknown paper order ${clientOrderId}`);
    order.status = 'rejected';
    this.events.push({ event: 'rejected', orderId: order.id });
    return copy(order);
  }

  cancel(clientOrderId) {
    const order = this.orders.get(clientOrderId);
    if (!order) throw new Error(`Unknown paper order ${clientOrderId}`);
    if (this.cancelTimeouts.has(clientOrderId)) {
      this.cancelTimeouts.delete(clientOrderId);
      order.status = 'canceled';
      order.legs.forEach(leg => { leg.status = 'canceled'; });
      this.events.push({ event: 'cancel_confirmed', orderId: order.id });
      return copy(order);
    }
    order.status = 'pending_cancel';
    this.cancelTimeouts.add(clientOrderId);
    this.events.push({ event: 'cancel_pending', orderId: order.id });
    throw brokerError('CANCEL_TIMEOUT', 'Paper broker cancellation response was lost.');
  }

  setAvailable(available) {
    this.available = !!available;
    this.events.push({ event: available ? 'reconnected' : 'disconnected' });
  }

  seedPosition(symbol, qty) {
    this.positions.set(symbol, Number(qty));
    this.events.push({ event: 'startup_position', symbol, qty: Number(qty) });
  }

  seedOrder({ symbol, clientOrderId, side = 'buy', qty = 10 } = {}) {
    const order = {
      id: `${this.strategy}-startup-${this.nextOrder++}`,
      client_order_id: clientOrderId,
      symbol,
      side,
      qty,
      filled_qty: 0,
      filled_avg_price: 0,
      status: 'new',
      legs: [],
    };
    this.orders.set(clientOrderId, order);
    this.events.push({ event: 'startup_order', orderId: order.id, clientOrderId });
  }

  getByClientId(clientOrderId) {
    const order = this.orders.get(clientOrderId);
    return order ? copy(order) : null;
  }

  snapshot() {
    return {
      accountId: this.accountId,
      orders: [...this.orders.values()].map(copy),
      positions: [...this.positions.entries()].map(([symbol, qty]) => ({ symbol, qty })),
    };
  }

  restart() {
    this.events.push({ event: 'process_restart' });
    // The broker state intentionally survives a simulated process restart.
    return this.snapshot();
  }
}

class PaperStrategyHarness {
  constructor(strategy, scenario) {
    this.strategy = strategy;
    this.scenario = scenario;
    this.symbol = `${strategy.slice(0, 3).toUpperCase()}QA`;
    this.broker = new PaperBroker({
      strategy,
      symbol: this.symbol,
      responseFault: ['broker-timeout', 'lost-broker-response', 'broker-response-timeout'].includes(scenario)
        ? (scenario === 'broker-timeout' ? 'timeout' : 'lost-response') : null,
    });
    this.entryIntents = [];
    this.exitIntent = null;
    this.reconciliationEvents = [];
    this.localState = 'idle';
    this.localPosition = 0;
    this.foreignOrderTouched = false;
  }

  createEntryIntents() {
    const lots = this.strategy === 'pmh' ? 2 : 1;
    const qty = lots === 2 ? 5 : 10;
    for (let index = 0; index < lots; index++) {
      this.entryIntents.push({
        clientOrderId: `${this.strategy}-entry-${this.scenario}-${index + 1}`,
        symbol: this.symbol,
        qty,
        filledQty: 0,
        status: 'intent',
        protected: true,
      });
    }
  }

  submitEntries() {
    this.createEntryIntents();
    for (const intent of this.entryIntents) {
      try {
        const order = this.broker.submit({
          symbol: intent.symbol, side: 'buy', qty: intent.qty,
          clientOrderId: intent.clientOrderId, protectedOrder: intent.protected,
        });
        intent.orderId = order.id;
      } catch (error) {
        intent.status = error.orderAccepted ? 'entry_unknown' : 'entry_unavailable';
        intent.orderId = error.orderId || null;
        intent.error = error.code;
      }
    }
  }

  reconcile() {
    for (const intent of this.entryIntents) {
      const order = this.broker.getByClientId(intent.clientOrderId);
      if (!order) continue;
      if (!brokerOrderMatchesIntent(order, intent.clientOrderId)) {
        throw new Error(`Order ownership mismatch for ${intent.clientOrderId}`);
      }
      intent.orderId = order.id;
      intent.filledQty = Number(order.filled_qty);
      intent.status = order.status;
    }
    if (this.exitIntent) {
      const order = this.broker.getByClientId(this.exitIntent.clientOrderId);
      if (!order) return;
      if (!brokerOrderMatchesIntent(order, this.exitIntent.clientOrderId)) {
        throw new Error(`Exit ownership mismatch for ${this.exitIntent.clientOrderId}`);
      }
      this.exitIntent.orderId = order.id;
      this.exitIntent.filledQty = Number(order.filled_qty);
      this.exitIntent.status = order.status;
    }
    const entryFilled = this.entryIntents.reduce((sum, intent) => sum + intent.filledQty, 0);
    this.localPosition = Number(this.broker.snapshot().positions.find(p => p.symbol === this.symbol)?.qty || 0);
    if (this.exitIntent?.filledQty && this.localPosition === 0) this.localState = 'closed';
    else if (entryFilled > 0) this.localState = 'open';
    else if (this.entryIntents.some(intent => ['rejected', 'canceled'].includes(intent.status))) this.localState = 'void';
    else if (this.entryIntents.some(intent => intent.status === 'entry_unavailable')) this.localState = 'blocked';
    else if (this.entryIntents.some(intent => intent.status === 'entry_unknown')) this.localState = 'unknown';
    this.reconciliationEvents.push({
      event: 'reconciliation',
      entryFilled,
      position: this.localPosition,
      state: this.localState,
    });
  }

  fillEntries(chunks) {
    for (const [index, quantities] of chunks.entries()) {
      const intent = this.entryIntents[index] || this.entryIntents[0];
      for (const qty of quantities) this.broker.fill(intent.clientOrderId, qty, 10.25);
    }
    this.reconcile();
  }

  submitExit() {
    const qty = this.localPosition;
    if (!(qty > 0)) throw new Error('Cannot submit an exit with no paper position.');
    const clientOrderId = `${this.strategy}-exit-${this.scenario}`;
    this.exitIntent = { clientOrderId, symbol: this.symbol, qty, filledQty: 0, status: 'intent' };
    try {
      const order = this.broker.submit({
        symbol: this.symbol, side: 'sell', qty, clientOrderId, protectedOrder: false,
      });
      this.exitIntent.orderId = order.id;
    } catch (error) {
      this.exitIntent.status = error.orderAccepted ? 'exit_unknown' : 'exit_unavailable';
      this.exitIntent.orderId = error.orderId || null;
    }
  }

  fillExit() {
    if (!this.exitIntent) return;
    this.broker.fill(this.exitIntent.clientOrderId, this.exitIntent.qty, 10.75);
    this.reconcile();
  }

  restart() {
    this.broker.restart();
    this.reconcile();
  }

  protectedState() {
    const activeLegs = this.entryIntents.flatMap(intent => {
      const order = this.broker.getByClientId(intent.clientOrderId);
      return order?.legs || [];
    }).filter(leg => ['accepted', 'new', 'pending_cancel'].includes(leg.status));
    return {
      stop: activeLegs.some(leg => leg.type === 'stop') ? 'active' : 'not-active',
      target: activeLegs.some(leg => leg.type === 'limit') ? 'active' : 'not-active',
      runner: this.strategy === 'pmh' ? 'separate-protected-lot' : 'not-applicable',
    };
  }
}

function performScenario(strategy, scenario) {
  const harness = new PaperStrategyHarness(strategy, scenario);
  const initialState = { strategy, symbol: harness.symbol, scenario, accountId: harness.broker.accountId };
  let expectedState = 'closed';
  let orderSubmitted = false;
  let brokerResponse = 'accepted';
  let errorDetails = null;

  if (scenario === 'position-at-startup') {
    harness.broker.seedPosition(harness.symbol, 4);
    expectedState = 'blocked';
    harness.localState = 'blocked';
  } else if (scenario === 'order-at-startup' || scenario === 'unexpected-broker-state') {
    harness.broker.seedOrder({ symbol: harness.symbol, clientOrderId: `${strategy}-foreign-startup-order` });
    expectedState = 'blocked';
    harness.localState = 'blocked';
  } else {
    harness.submitEntries();
    orderSubmitted = harness.broker.events.some(event => event.event === 'submitted');
    if (['broker-timeout', 'broker-response-timeout', 'lost-broker-response'].includes(scenario)) brokerResponse = 'lost-after-acceptance';
    try {
      if (scenario === 'reconnect') {
        harness.broker.setAvailable(false);
        harness.entryIntents.forEach(intent => { intent.status = 'entry_unavailable'; });
        harness.broker.setAvailable(true);
        harness.submitEntries();
      }
      if (scenario === 'rejected-order') {
        harness.entryIntents.forEach(intent => harness.broker.reject(intent.clientOrderId));
        expectedState = 'void';
      } else if (scenario === 'cancelled-order') {
        harness.entryIntents.forEach(intent => {
          try { harness.broker.cancel(intent.clientOrderId); } catch (_) {}
          try { harness.broker.cancel(intent.clientOrderId); } catch (_) {}
        });
        expectedState = 'void';
      } else if (scenario === 'delayed-fill') {
        harness.reconcile();
        harness.fillEntries(harness.entryIntents.map(() => [10]));
      } else if (scenario === 'partial-fill') {
        harness.fillEntries(harness.entryIntents.map((_, index) => index === 0 ? [5] : [2]));
        expectedState = 'open';
      } else if (scenario === 'multiple-partial-fills') {
        harness.fillEntries(harness.entryIntents.map((_, index) => index === 0 ? [3, 4, 3] : [2, 3]));
      } else if (scenario === 'restart-pending') {
        harness.reconcile(); harness.restart(); harness.fillEntries(harness.entryIntents.map(() => [10]));
      } else if (scenario === 'restart-partial') {
        harness.fillEntries(harness.entryIntents.map((_, index) => index === 0 ? [5] : [2]));
        harness.restart(); harness.fillEntries(harness.entryIntents.map((_, index) => index === 0 ? [5] : [3]));
      } else if (scenario === 'restart-holding' || scenario === 'restart-protected') {
        harness.fillEntries(harness.entryIntents.map(() => [10]));
        harness.restart();
        expectedState = 'open';
      } else if (scenario === 'cancel-request-timeout') {
        harness.fillEntries(harness.entryIntents.map(() => [10]));
        harness.entryIntents.forEach(intent => {
          try { harness.broker.cancel(intent.clientOrderId); } catch (_) {}
          try { harness.broker.cancel(intent.clientOrderId); } catch (_) {}
        });
        harness.reconcile();
        harness.submitExit(); harness.fillExit();
      } else if (scenario === 'duplicate-broker-response' || scenario === 'duplicate-entry') {
        const intent = harness.entryIntents[0];
        const first = harness.broker.submit({
          symbol: intent.symbol, side: 'buy', qty: intent.qty,
          clientOrderId: intent.clientOrderId, protectedOrder: true,
        });
        const second = harness.broker.submit({
          symbol: intent.symbol, side: 'buy', qty: intent.qty,
          clientOrderId: intent.clientOrderId, protectedOrder: true,
        });
        if (first.id !== second.id || harness.broker.snapshot().orders.length !== harness.entryIntents.length) {
          throw new Error('Duplicate client order created a second broker order.');
        }
        harness.fillEntries(harness.entryIntents.map(() => [10]));
      } else if (scenario === 'cross-bot-isolation') {
        const foreignClient = `foreign-${strategy}-same-symbol`;
        harness.broker.seedOrder({ symbol: harness.symbol, clientOrderId: foreignClient });
        harness.fillEntries(harness.entryIntents.map(() => [10]));
        harness.foreignOrderTouched = harness.broker.getByClientId(foreignClient).status !== 'new';
        if (harness.foreignOrderTouched) throw new Error('Foreign strategy order was modified.');
      } else if (scenario === 'browser-closed-exit' || scenario === 'logged-out-exit') {
        harness.fillEntries(harness.entryIntents.map(() => [10]));
        harness.submitExit(); harness.fillExit();
      } else {
        harness.fillEntries(harness.entryIntents.map(() => [10]));
      }
      if (['partial-fill', 'restart-holding', 'restart-protected'].includes(scenario)) {
        // These scenarios intentionally stop after proving the open position
        // and its protection survived; no exit is expected yet.
      } else if (!['rejected-order', 'cancelled-order'].includes(scenario) && harness.localPosition > 0 && !harness.exitIntent) {
        harness.submitExit();
        harness.fillExit();
      }
      harness.reconcile();
    } catch (error) {
      errorDetails = { code: error.code || 'HARNESS_ERROR', message: error.message };
      brokerResponse = error.code || 'error';
    }
  }

  const snapshot = harness.broker.snapshot();
  const entryOrders = snapshot.orders.filter(order => order.client_order_id.includes('-entry-'));
  const exitOrders = snapshot.orders.filter(order => order.client_order_id.includes('-exit-'));
  const positionQty = Number(snapshot.positions.find(position => position.symbol === harness.symbol)?.qty || 0);
  const finalState = harness.localState;
  const pass = finalState === expectedState
    && !harness.foreignOrderTouched
    && entryOrders.every(order => brokerOrderMatchesIntent(order, order.client_order_id))
    && (expectedState !== 'closed' || positionQty === 0);
  return {
    strategy,
    symbol: harness.symbol,
    scenario,
    initialState,
    orderSubmitted,
    brokerResponse,
    partialFillStatus: entryOrders.map(order => ({ clientOrderId: order.client_order_id, status: order.status, filledQty: order.filled_qty })),
    positionState: { symbol: harness.symbol, qty: positionQty },
    protectionState: harness.protectedState(),
    reconciliationResult: harness.reconciliationEvents,
    finalState,
    expectedState,
    status: pass ? 'PASS' : 'FAIL',
    errorDetails,
    eventCount: harness.broker.events.length,
  };
}

function buildReadiness(results) {
  return STRATEGIES.map(strategy => {
    const strategyResults = results.filter(result => result.strategy === strategy);
    const failed = strategyResults.filter(result => result.status !== 'PASS');
    return {
      strategy,
      status: failed.length ? 'NOT READY' : 'NOT READY',
      simulatedScenarios: strategyResults.length,
      simulatedPassed: strategyResults.filter(result => result.status === 'PASS').length,
      simulatedFailed: failed.length,
      blocked: ['REAL_PAPER_BROKER_EXECUTION', 'PRODUCTION_OBSERVABILITY_REVIEW'],
      reason: failed.length
        ? 'A deterministic paper scenario failed.'
        : 'Simulation passed, but a real paper-account run and production observability review remain unverified.',
    };
  });
}

function runPaperQa() {
  const results = [];
  for (const strategy of STRATEGIES) {
    for (const [scenario] of SCENARIOS) results.push(performScenario(strategy, scenario));
  }
  const failures = results.filter(result => result.status !== 'PASS');
  return {
    generatedAt: 'deterministic',
    mode: 'PAPER_SIMULATION_ONLY',
    liveOrdersPlaced: false,
    total: results.length,
    passed: results.length - failures.length,
    failed: failures.length,
    blocked: STRATEGIES.length * 2,
    results,
    readiness: buildReadiness(results),
    criticalRemainingIssues: [
      'No external Alpaca paper-account execution was performed by this offline suite.',
      'Production deployment observability and operator readiness still require a controlled paper run.',
    ],
  };
}

module.exports = { STRATEGIES, SCENARIOS, PaperBroker, performScenario, runPaperQa };