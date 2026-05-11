# Degen Club :: Monkeys Funhouse 🐒

An **autonomous, self-evolving ML trading agent** for Solana pump.fun memecoins. The bot collects forward-only training data, retrains 15 probability models as new labels resolve, and runs an LLM-in-the-loop agent that **proposes, deploys, modifies, and retires its own trading strategies** based on what it has learned.

No human-coded strategies. The agent owns the entry filters, sizing, stop-losses, take-profit ladders, trailing stops, DCA, and exit logic. The only hard human switch is flipping paper → live trading.

```
[ Helius WS / PumpPortal / on-chain decoder ] ──► mints + trades
                  │
                  ▼
[ Snapshot sweeper @ 60s/300s/900s/3600s ] ──► ml_mint_snapshots
                  │
                  ▼
[ Label resolver (6h forward window) ] ──► 15 labels per snapshot
                  │
                  ▼
[ Adaptive retrain (hourly backstop + new-labels + drawdown triggers) ]
                  │
                  ▼
[ Python FastAPI inference @ :5050 + on-disk hot-swap models ]
                  │
                  ▼
[ Continuous scoring sweep @ 60s ] ──► ml_predictions
                  │
                  ▼
[ Autonomous Agent (Claude-powered reasoning) ]
   ├── 30-min cycle: orphan-retire, evolutionary-retire, modify, propose
   ├── 3h batch post-mortems (cross-trade pattern recognition)
   ├── 6h exit-reason concentration check (catches systemic failure modes)
   ├── hourly mint-metadata intel (heuristic + Claude on borderline)
   ├── daily report card + calibration honesty audit + intelligence condensate
   ├── noon + midnight market regime check (aggressive/normal/cautious)
   └── all reasoning + decisions logged to ml_agent_log
                  │
                  ▼
[ TG broadcaster (userbot via gramjs MTProto) ]
   └── high-conviction entries posted to Telegram for call-tracker indexing (Phanes-compatible)
```

Dashboards at:
- `http://localhost:4200/` — live trading view, paper PnL, strategy state, network health
- `http://localhost:4200/ml` — ML lab: data quality, drift alerts, calibration, consult budget, agent thoughts feed

---

## Architecture

### Data pipeline
- **Ingestion** — PumpPortal websocket for new-mint events; Helius webhooks for tracked-wallet trades; on-chain Pump.fun program log decoder for the full trade firehose.
- **Snapshots** — Every active mint gets feature snapshots captured at 60s, 300s, 900s, and 3600s of age. Forward-only — no retroactive feature extraction, no survivor bias.
- **Labels** — After a 6-hour resolution window, each snapshot gets labeled with what actually happened. Resolves 15 targets per snapshot.
- **Price defense** — Four writers can touch `mints.last_price_sol` (processor, on-chain WS, dexscreener, migrated-tracker). All four enforce a sub-floor price guard. The on-chain WS short-circuits the moment `curve.complete=true` to avoid pushing stale bond-curve final-state ticks after migration.
- **Friction model** — Realistic exit costs computed live: bonding-curve slippage, sandwich risk, RPC latency p50 (paper fills) and p90 (network-health alerts), priority-fee p99 scoped to the Pump.fun program.

### ML system

15 training targets, mode-aware (pre-migration vs post-migration):

| Target | Type | What it predicts |
|---|---|---|
| `peaked_30` | binary | Will it peak +30% post-snapshot |
| `peaked_100` | binary | Will it peak +100% |
| `peaked_300` | binary | Will it peak +300% |
| `migrated` | binary | Will it graduate to Raydium / PumpSwap AMM |
| `migrates_within_15min` | binary | Same but on a 15-min clock |
| `will_die_fast` | binary | Will it peak <+15% within 30 min and go quiet |
| `rug_within_5min` | binary | Sudden price-collapse risk |
| `hits_2x_within_1h` | binary | 2x within an hour |
| `peak_pct_max` | regression (log1p) | Max % gain post-snapshot |
| `time_to_peak_sec` | regression (log1p) | Seconds from snapshot to peak |
| `time_to_peak_5x_sec` | regression | Seconds to 5x specifically |
| `drawdown_from_peak_pct` | regression | How far below peak we are at snapshot time (the agent's main "don't buy bags" signal) |
| `post_mig_hits_2x` | binary | Post-migration 2x prediction |
| `post_mig_peak_pct` | regression | Post-migration max gain |
| `post_mig_rugs_1h` | binary | Post-migration rug risk |

- **HistGradientBoosting** (sklearn) — handles NaN natively, calibrated probabilities via isotonic CalibratedClassifierCV.
- **Time-based train/val split** (80/20, no shuffle) — prevents look-ahead bias.
- **Adaptive retrain** with three triggers:
  - Hourly backstop (always fires)
  - ≥50 new labels AND ≥30 min since last train
  - 24h closed PnL ≤ -2 SOL OR ≤ -15% of starting balance
- **Drift monitor** snapshots metrics on every retrain. Surfaces alerts when AUC-ROC, AUC-PR, or R² regress vs the rolling baseline.
- **Training thread cap** — Python subprocess runs with `OMP_NUM_THREADS=2` + `renice +10` to prevent CPU saturation on the host machine.

### Inference bridge
- Node ↔ Python via FastAPI on `localhost:5050`.
- All 15 models served via `/predict-all` (one HTTP roundtrip per scoring sweep).
- Watchdog auto-restarts `serve.py` if unhealthy.
- Every prediction logged to `ml_predictions` for audit + calibration backtest.

### Autonomous agent

Powered by the Claude CLI as a subprocess (subscription auth via OAuth, not an API key). Built from these modules:

| File | Role |
|---|---|
| `src/ml/agent.js` | Main introspection loop — 30-min cycle: orphan-retire, evolutionary-retire, modify, propose |
| `src/ml/agent-llm.js` | Claude CLI wrapper with JSON-schema-validated output |
| `src/ml/agent-executor.js` | Evaluates active recipes against live mints, fires paper trades |
| `src/ml/agent-post-mortem.js` | 3-hour batch analyses of closed trades — cross-trade pattern recognition |
| `src/ml/agent-daily-report.js` | Daily recap; output feeds back into next day's context |
| `src/ml/agent-calibration-review.js` | Daily per-decile honesty audit of every classification model |
| `src/ml/agent-mint-intel.js` | Hourly batch — heuristic + Claude classifier for ruggy/winner mint metadata |
| `src/ml/agent-concentration-check.js` | 6-hourly — flag exit_reason ≥25% of last 24h trades + Claude diagnosis |
| `src/ml/agent-market-regime.js` | Noon + midnight ET — aggressive/normal/cautious posture for the day |
| `src/ml/agent-rate-limit.js` | Per-subsystem daily caps prevent runaway Claude usage |
| `src/ml/intelligence-condensate.js` | Daily nightly compression — keeps lessons, drops raw trade noise |
| `src/ml/auto-retrain.js` | Adaptive retrain scheduler (Python subprocess orchestration) |
| `src/ml/drift-monitor.js` | Detects model drift between retrains, surfaces alerts to the dashboard |

### Strategy lifecycle

A live strategy goes through this evolutionary loop:

1. **Propose** — Claude generates a JSON recipe (entry conditions, sizing, exit ladder, DCA, trail). Recipes get translated to a `strategy_state` row so the battle-tested position monitor handles exits.
2. **Soak** — first 4 hours, the agent leaves it alone to accumulate data.
3. **Evaluate** — every 2-12 hours (2h for bleeders, 12h for healthy), the agent re-evaluates via Claude. Decision: keep, modify (in-place parameter tweaks), or retire.
4. **Orphan retire** — if a strategy gets 0 entries in 1 hour, its filters were too strict. Auto-retired and its filter stack is reported to the next propose-strategy prompt so Claude knows what didn't work.
5. **Evolutionary retire** — when at strategy cap (8) AND a bleeder exists, the worst-PnL strategy (≥10 closed trades) gets retired to make room for a variant.
6. **Freshness floor** — if live roster drops below 4, the agent proposes new strategies in parallel regardless of bleeders, to maintain diversity.

Strategy recipe schema example:
```json
{
  "name": "elite-alive-runner-v1",
  "rationale": "Bleeding strategy proved peaked_30 is look-ahead biased (drawdown_from_peak ≥0.80 on every loser). Pivot to forward-looking: ELITE+ALIVE stack (migrated≥0.30 AND will_die_fast<0.30) shows 65% mig rate, 69x baseline lift...",
  "entry": {
    "conditions": [
      { "kind": "ml_prediction", "name": "migrated", "op": ">=", "value": 0.30 },
      { "kind": "ml_prediction", "name": "will_die_fast", "op": "<", "value": 0.30 },
      { "kind": "ml_prediction", "name": "drawdown_from_peak_pct", "op": "<", "value": 0.35 },
      { "kind": "feature", "name": "tracked_buyers", "op": ">=", "value": 1 }
    ],
    "max_mint_age_sec": 1800,
    "min_mint_age_sec": 30
  },
  "sizing": { "type": "fixed", "sol": 0.15 },
  "dca": { "enabled": true, "trigger_pct": -30, "size_pct": 0.5, "max_dca": 1 },
  "exit": {
    "stop_loss_pct": 60,
    "take_profit_tiers": [
      { "trigger_pct": 25, "sell_pct": 25 },
      { "trigger_pct": 80, "sell_pct": 35 },
      { "trigger_pct": 200, "sell_pct": 25 }
    ],
    "trailing_stop": { "arm_pct": 40, "trail_pct": 25 },
    "max_hold_min": 30,
    "prediction_exit": { "target": "rug_within_5min", "op": ">", "value": 0.50 }
  }
}
```

### Claude consult rate limits

Hard per-subsystem daily caps. Total ceiling ~101/day, well under typical Claude usage.

| Subsystem | Daily cap |
|---|---|
| Agent (proposals + retirements + modifies) | 55 |
| Post-mortem batches | 8 |
| Mint intel | 24 |
| News synthesis | 6 |
| Concentration check | 4 |
| Market regime | 2 |
| Daily report | 1 |
| Calibration review | 1 |

Live budget visible on the ML dashboard under "Claude Consult Budget" — per-subsystem progress bars + total.

### Telegram broadcaster

High-conviction paper entries are posted to a Telegram group via a **gramjs MTProto userbot** (not the Bot API). Reason: call-tracker bots like Phanes filter `is_bot=true` messages — posting from a real user account is the only way to get indexed. Bot API kept as fallback.

Format includes USD mcap (`$26.1K` style), per-token entry price (DexScreener subscript-zero notation for sub-$0.0001), predicted peak target, signal table (peaked_100/migrated/tracked-buyers), pump.fun link, and the raw CA on its own line for tracker parsers.

---

## Project layout

```
src/
├── index.js              # bot entrypoint — spawns dashboard child process
├── dashboard.js          # dashboard process — Express server
├── config.js             # central config
├── db/                   # SQLite (WAL) + schema
├── ingestion/            # Helius, PumpPortal, on-chain trade decoders, TG broadcaster
├── trading/              # paper trading, position monitor, friction
├── scoring/              # mint microstructure, wallet leaderboard, KOL/whale, network conditions
├── ml/                   # ML pipeline, inference bridge, autonomous agent + learning loops
└── server/               # Express API (used by both dashboards)

ml/
├── scripts/
│   ├── extract_from_snapshots.py        # pre-mig snapshots → training CSV
│   ├── extract_from_migration_snapshots.py  # post-mig snapshots
│   ├── train.py                         # mode-aware classifier/regressor
│   ├── serve.py                         # FastAPI multi-target inference
│   └── retrain_all.py                   # extract → train all 15 targets → reload service
└── requirements.txt

public/                   # cyberpunk-themed dashboards
├── index.html / app.js   # main trading dashboard
└── ml.html / ml.js       # ML Lab — drift, calibration, consult budget, agent

scripts/
└── tg-userbot-auth.mjs   # one-time interactive auth for the TG userbot
```

---

## Run it locally

```bash
# 1. Node side
npm install
cp .env.example .env  # set HELIUS_API_KEY, TELEGRAM_BOT_TOKEN, etc.

# 2. Python ML stack
cd ml
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 3. (Optional) TG userbot auth — for call broadcasting
cd ..
node scripts/tg-userbot-auth.mjs    # one-time: prompts for phone, SMS code, 2FA
# Writes TG_USER_SESSION to .env automatically

# 4. Start the bot (managed by launchd in production)
node src/index.js
```

The Python inference service auto-starts via the watchdog. Dashboards at `http://localhost:4200/` and `http://localhost:4200/ml`.

---

## Status

- ✅ Data pipeline: 380K+ snapshots, 350K+ labeled, ~5K snapshots/hr live ingest
- ✅ Models: 15 trained, will_die_fast AUC 0.99, migrated 0.74, drawdown_from_peak R² 0.74, post_mig_hits_2x 0.78
- ✅ Drift detection: live alerts on degraded models, surfaced on the ML dashboard
- ✅ Autonomous agent: multiple strategies live, self-iterating on bleeders and orphans
- ✅ Six learning loops running daily (post-mortem, daily report, calibration review, mint intel, concentration check, market regime, intelligence condensate)
- ✅ TG broadcaster via userbot, Phanes-compatible
- 🟡 Live trading: code exists, currently paper-only by human switch

---

🤖 Built collaboratively with [Claude Code](https://claude.com/claude-code).
