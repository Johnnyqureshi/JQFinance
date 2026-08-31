---
name: Momentum inverse fallback
description: Safety and routing rules for automated Momentum downside exposure
---
# Momentum inverse fallback

Automated Momentum downside exposure is a fallback, not a short strategy. It requires fresh completed-bar downside consensus from both SPY and QQQ and runs only when no ordinary long candidate passes the strategy safety gates. Exposure is opened only by buying an approved inverse ETF with the same protected-entry controls as a long.

**Why:** A single weak benchmark or stale intraday bar can misclassify the market, while selling an unheld asset would violate the platform-wide no-short policy. Safe long opportunities should retain priority because inverse mode was requested specifically as the no-candidate fallback.

**How to apply:** Keep the benchmark decision fail-closed, recheck it immediately before submission, route only through BUY orders, and preserve the normal bracket, capacity, duplicate, daily-loss, and equity-risk controls.