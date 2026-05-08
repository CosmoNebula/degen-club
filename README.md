# Degen Club :: Monkeys Funhouse 🐒

An **autonomous ML-driven** Solana pump.fun paper-trading bot. The system collects forward-only data, trains its own probability models, and runs an agent that creates, deploys, monitors, and retires its own trading strategies based on what it has learned.

No human-coded strategies. The agent decides everything: entry conditions, sizing, stop-losses, take-profit ladders, exit logic. The only hard line: it cannot flip live trading on — that's a human-only switch.

```
[ Helius WS / on-chain decoder ] ──► mints + trades
                  │
                  ▼
[ Snapshot sweeper @ 60s/300s/900s/3600s ] ──► ml_mint_snapshots
                  │
                  ▼
[ Label resolver (after 6h) ] ──► migrated, peaked_30/100/300, peak_pct_max,
                  │                time_to_peak_sec, will_die_fast labels
                  ▼
[ Hourly retrain ] ──► 7 sklearn models → Python FastAPI inference
                  │
                  ▼
[ Continuous scoring sweep @ 60s ] ──► ml_predictions on the most-active mints
                  │
                  ▼
[ Autonomous Agent (Claude-powered reasoning) ]
   ├── introspects readiness → proposes its own strategies
   ├── executor evaluates recipes → fires paper trades
   ├── 6h batch post-mortems → pattern recognition → strategy iteration
   ├── hourly mint-metadata intel (heuristic + Claude on borderlines)
   ├── daily report card + calibration deep-review
   └── all reasoning logged to ml_agent_log
```

Cyberpunk-themed dashboards at:
- `http://localhost:4200/` — live trading view, paper PnL, strategy state
- `http://localhost:4200/ml` — ML lab: data quality, drift, calibration, agent's thoughts feed

---

## Architecture

### Data pipeline
- **Ingestion** — PumpPortal websocket for new-mint events; Helius webhooks for tracked-wallet trades; on-chain Pump.fun program log decoder for trade firehose (PumpPortal trade feed went paid 2026-05-01).
- **Snapshots** — Every active mint gets feature snapshots captured at 60s, 300s, 900s, and 3600s of age. Forward-only (no retroactive feature extraction → no survivor bias).
- **Labels** — After a 6-hour resolution window, each snapshot gets labeled with what actually happened (migrated, peaked +30/100/300%, peak %, time-to-peak, died-fast).
- **Friction model** — Realistic exit costs computed live from network state: bonding-curve slippage, sandwich risk, priority-fee p99 scoped to the Pump.fun program.

### ML system
Seven targets trained simultaneously, mode-aware:

| Target | Type | What it predicts |
|---|---|---|
| `migrated` | classification | Will this mint graduate to Raydium/PumpSwap |
| `peaked_30` | classification | Will it peak +30% post-snapshot |
| `peaked_100` | classification | Will it peak +100% |
| `peaked_300` | classification | Will it peak +300% |
| `will_die_fast` | classification | Will it peak <+15% within 30 min and go quiet |
| `peak_pct_max` | regression (log1p) | Max % gain post-snapshot |
| `time_to_peak_sec` | regression (log1p) | Seconds from snapshot to peak |

- **HistGradientBoosting** (sklearn) — handles NaN natively, no libomp dependency
- **Calibrated probabilities** via isotonic CalibratedClassifierCV
- **Time-based train/val split** (80/20, no shuffle) — prevents look-ahead bias
- **Hourly retrain cron** — bails early if <100 new labeled rows
- **Drift detection** — compares each retrain to the previous, alerts on AUC/R² regressions

### Inference bridge
- Node ↔ Python via FastAPI on `localhost:5050`
- All 7 models served from one process via `/predict-all` (multi-target round-trip)
- Watchdog auto-restarts `serve.py` if unhealthy >2 min
- Every prediction logged to `ml_predictions` for the audit trail and calibration backtest

### Autonomous agent
Powered by the Claude CLI as a subprocess (subscription auth via OAuth, not API key). Built from these modules:

| File | Role |
|---|---|
| `src/ml/agent.js` | Main introspection loop — every 30 min, assesses readiness, proposes/retires strategies |
| `src/ml/agent-llm.js` | Claude CLI wrapper with JSON-schema-validated output |
| `src/ml/agent-executor.js` | Evaluates active recipes against live mints, fires paper trades |
| `src/ml/agent-post-mortem.js` | 6-hour batch analyses of closed trades — finds cross-trade patterns |
| `src/ml/agent-daily-report.js` | Daily recap of trading + model + agent activity |
| `src/ml/agent-calibration-review.js` | Daily deep-review of per-decile model honesty |
| `src/ml/agent-mint-intel.js` | Hourly batch — heuristic + Claude classifier for ruggy/winner metadata |
| `src/ml/agent-rate-limit.js` | Hard daily caps prevent runaway Claude usage |
| `src/ml/serve-watchdog.js` | Auto-restarts the Python inference service if it dies |
| `src/ml/drift-monitor.js` | Detects model drift between retrains, surfaces alerts |

**Strategy recipe schema** — what the agent generates:
```json
{
  "name": "kol-momentum-v1",
  "rationale": "Top-decile peaked_100 picks averaged +180% peak vs 12% baseline...",
  "entry": {
    "conditions": [
      { "kind": "ml_prediction", "name": "peaked_100", "op": ">", "value": 0.35 },
      { "kind": "ml_prediction", "name": "will_die_fast", "op": "<", "value": 0.40 },
      { "kind": "feature", "name": "tracked_buyers", "op": ">=", "value": 1 }
    ]
  },
  "sizing": { "type": "fixed", "sol": 0.13 },
  "exit": {
    "stop_loss_pct": 25,
    "take_profit_tiers": [
      { "trigger_pct": 30, "sell_pct": 30 },
      { "trigger_pct": 100, "sell_pct": 50 }
    ],
    "trailing_stop": { "arm_pct": 100, "trail_pct": 30 },
    "max_hold_min": 60
  }
}
```

Recipes get translated to `strategy_state` rows so the existing battle-tested position monitor handles exits — agent doesn't reinvent SL/TP/trailing logic.

### Claude consult rate limits

Hard daily caps prevent runaway loops:

| Subsystem | Daily cap | Burst (per tick) |
|---|---|---|
| Agent (proposals + retirements) | 12 | 3 |
| Post-mortem (6h batches) | 4 | 1 |
| Mint intel (hourly batch) | 24 | 1 |
| Daily report | 1 | 1 |
| Calibration review | 1 | 1 |

Live state visible at `/api/ml/agent/rate-limits`.

---

## Project layout

```
src/
├── index.js              # bot entrypoint — spawns dashboard child process
├── dashboard.js          # dashboard process — Express server
├── config.js             # central config
├── db/                   # SQLite (WAL) + schema
├── ingestion/            # Helius, PumpPortal, on-chain trade decoders
├── trading/              # paper trading, position monitor, friction
├── scoring/              # mint microstructure, wallet grading, KOL/whale detection
├── ml/                   # ML data pipeline, inference bridge, autonomous agent
├── server/               # Express API (used by both dashboards)
├── strategies/           # human-coded strategy registry (currently empty — agent runs the show)
└── runtime-limits.js     # dashboard-edited config plumbing

ml/
├── scripts/
│   ├── extract_from_snapshots.py  # snapshots → training CSV
│   ├── train.py                   # mode-aware classifier/regressor trainer
│   ├── serve.py                   # FastAPI multi-target inference service
│   └── retrain_all.py             # extract → train all targets → reload service
└── requirements.txt

public/                   # cyberpunk-themed dashboards
├── index.html / app.js   # main trading dashboard
└── ml.html / ml.js       # ML Lab — data quality, drift, calibration, agent
```

---

## Run it locally

```bash
# 1. Node side
npm install
cp .env.example .env  # set HELIUS_API_KEY etc.

# 2. Python ML stack
cd ml
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 3. Start Python inference (one-time, watchdog will auto-restart it after)
.venv/bin/python scripts/serve.py &

# 4. Start the bot (loads dashboard as child process)
cd ..
node --watch --watch-path=src src/index.js
```

Dashboards at `http://localhost:4200/` and `http://localhost:4200/ml`.

---

## Status

- ✅ Data pipeline: 80K+ snapshots, 30K+ labeled rows
- ✅ Models: 7 trained, AUC-ROC 0.94+ on classifiers, R² positive on regressions
- ✅ Drift detection: live monitoring with rate-limited alerts
- ✅ Autonomous agent: deployed in observation mode, will propose first strategy when calibration validates
- ⏳ Calibration data: predictions need to age into the 6h label window (~12h after first scoring sweeps)
- ⏳ First agent strategy: will appear when calibration error < 10%

Paper-only. Live trading mode exists but is not currently enabled.

---

🤖 Built collaboratively with [Claude Code](https://claude.com/claude-code).
