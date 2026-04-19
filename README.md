# Binance Futures Pump Fingerprint Bot

This project scans watched Binance USDⓈ-M Futures pairs, studies pumped or dumped setups from a configurable recent-day window, saves strategy fingerprints, compares them against current multi-timeframe conditions, and sends Telegram alerts for LONG and SHORT dry-run trades.

## What it does

- Reads watched pairs from `pair.js` and `storage/pairs.json`
- Lets you add and remove pairs using Telegram commands
- Scans every minute
- Reads all requested timeframes: `1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w`
- Learns from pumped and dumped tokens in the last kept N days
- Stores learned strategies in `storage/strategies/*.json`
- Automatically deletes saved strategies older than the configured retention window
- Scores current LONG and SHORT candidates
- Sends Telegram alerts and score-rise replies
- Tracks dry-run PNL, TP, and SL

## Install

```bash
npm install
```

## Environment

Create `.env` from `.env.example`.

## Run

```bash
npm start
```

## Main Telegram commands

- `/pairs`
- `/addpair BTCUSDT`
- `/removepair BTCUSDT`
- `/scan`
- `/dryrun`
- `/pnl`
- `/signals`
- `/closed`
- `/cleartradehistory`
- `/strategies`
- `/strategylist`
- `/strategy BTCUSDT`
- `/recentstrategyday 3`
- `/clearstrategy BTCUSDT`
- `/clearallstrategy`
- `/help`

## Notes

- This is dry-run only.
- It uses Binance USDⓈ-M Futures public endpoints.
- Your pasted `BINANCE_API_URL=https://api.binance.com/api/v3` is the spot base URL. For this project, use `https://fapi.binance.com`.
