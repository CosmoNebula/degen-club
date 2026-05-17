# Degen Club :: Monkeys Funhouse 🐒

A Solana Pump.fun trading bot that runs on real-time on-chain data, eight calibrated ML probability models, and a small set of hand-picked trading strategies. Built for paper-first testing with live-execution-grade simulation, designed to flip to live trading without surprises.

```
[ Helius WS · PumpPortal · on-chain decoder ]
                │ mints + trades firehose
                ▼
[ Snapshot sweeper · 9 age windows {15s, 30s, 60s, 2m, 5m, 10m, 15m, 30m, 1h} ]
                │
                ▼
[ ml_mint_snapshots · ~135 features per snapshot ]
                │
                ▼
[ Label resolver · backfills 8 canonical outcomes once trajectory plays out ]
                │
                ▼
[ Hourly retrain · Python sklearn HistGradientBoosting · chunked extract ]
                │
                ▼
[ FastAPI inference @ :5050 · hot-swap models · 2s feature cache ]
                │
                ▼
[ Strategy executor · 4 hand-picked recipes · event-driven + 60s sweep ]
                │
                ▼
[ Paper monitor · 250ms tick · sim'd 500ms fill latency · slippage + sandwich + fees ]
```

---

## The V2 rebuild (May 2026)

The bot was originally designed as an autonomous Claude-driven agent that proposed, modified, and retired its own strategies. Over a few weeks of paper testing the autonomous loop produced 39 generations of overlapping recipes with deteriorating calibration. The May 16/17 rebuild paused the autonomous loop, rebuilt the ML stack on canonical outcome definitions, and replaced the strategy population with 4 hand-picked recipes designed for non-overlap and runner-friendly exits.

### What changed

**ML stack — 32 overlapping labels collapsed into 8 canonical targets.**

The earlier label set had wick-confused rug detection (predicted 30% rug rate, actual 0.7%), overlapping migration definitions, and label name conflicts that broke retraining. The canonical set ties each label to a single authoritative source in the `mints` table:

| Target | Definition | Used for |
|---|---|---|
| `will_rug` | `mint.rugged_at` set within window (85% drop from peak + 10min quiet) | Rug filter on every strategy |
| `will_migrate` | `mint.migrated_at` set within 24h | Pre-migration graduation prediction |
| `hits_2x_within_1h` | Mint reaches +100% within 1 hour | Short-term momentum signal |
| `hits_5x_within_24h` | Mint reaches +400% within 24 hours | Moonshot detection (rare, sparse) |
| `peak_pct_within_24h` | Poisson-regressed expected peak | Size scaling for confidence-weighted entries |
| `local_top_60s` | Price is the local top within next 60s | Exit-timing signal |
| `buy_pressure_continues_60s` | Net-buy ratio sustains in next minute | Entry confirmation |
| `post_mig_hits_2x` | Post-migration 2x within window | AMM-runner detection (post-migration only) |

All eight models retrained on a backfilled 1.42M-row snapshot table. `will_rug` calibration is now tight: predicts 3.4%, actual 3.4% (vs the prior model's 30% / 0.7% gap that was killing real entries).

**Strategy system — 4 hand-picked, anti-overlap.**

| Recipe | Niche | Distinguishing gate |
|---|---|---|
| `elite-stack-v2` | Elite-wallet alpha + ML safety net | `wallet_pool: elite_5x >= 1` |
| `pre-mig-conviction-v1` | 4-ML-signal graduation stack | `will_migrate >= 0.08` (high) |
| `ml-momentum-v1` | Pure 2x pumpers that don't graduate | `will_migrate < 0.05` (anti-overlap) |
| `post-mig-runner-v1` | Already-migrated AMM runners | `mint_state: migrated = 1` |

Each strategy lives in its own slice of trigger / time-horizon space, designed so they don't fire on the same coins.

**Two new condition kinds added to the recipe DSL:**

- `wallet_pool` — gate on whether N wallets from a named pool (`elite_5x`, `tracked`, `kol`) have bought this mint within a window. Replaces inlining large wallet lists (the elite pool is ~1,535 wallets — would have made recipes 65 KB each).
- `mint_state` — gate on a column from the `mints` table (`migrated`, `rugged`). Lets the post-migration strategy explicitly require an already-migrated mint without trying to encode that via features.

**Runner-friendly exit philosophy.**

Months of paper testing surfaced a pattern: tight protective exits after the first take-profit tier were causing the bot to bail on coins that went on to 10x. The classic "scared money never wins" problem. Tonight's rebuild encodes a different philosophy:

- **Wide hard stop losses** (-50% to -60%). Pump.fun coins routinely wick 60% in a single tick while still establishing direction. Tight SLs panic-sell coins that go on to run.
- **No breakeven-after-T1.** This was the silent runner-killer. Auto-ratcheting the stop to entry after the first tier sold was kicking the bot out of countless coins that pulled back briefly before exploding.
- **Take initials early but moderately.** T1 sells ~30% at a modest gain (+40%) to lock in profit and de-risk the position math (covers loss down to -17% from peak).
- **Tier sells progressively further out.** T2 at +200%, T3 at +500% — locking chunky profit at meaningful runs without selling the moonbag prematurely.
- **Small manual moonbag** (5%). Once `tokens_remaining / token_amount ≤ moonbag_pct_reserve`, the bot stops evaluating exits entirely. Closed manually from the dashboard. Rug-exception fires through normal SL path if the mint actually goes to zero.
- **DCA modestly on healthy dips.** When a position has peaked at +1%+ and retraced to -30% from entry, add a small reload (0.05 SOL on a 0.18 SOL entry). One DCA per position, max 30 minutes old.

The 5th strategy, `elite-quick-35-v1`, is an A/B test against `elite-stack-v2` — same entry gates, but it sells 100% at +35%. Designed to measure: of elite-wallet picks that reach +35%, how many would have gone much further? The PnL gap between the two over the same coins will quantify the value of holding past T1.

---

## Bugs we fixed (the cascade of May 16/17)

Several issues had been compounding silently. Listed in the order they were discovered tonight, not the order they happened.

### 1. The retrain OOM cascade

The bot OOM-killed itself five separate times in a four-hour window (16:19, 17:06, 18:11, 19:39, 20:21 UTC). Each cycle: bot starts, runs for 30-50 min, peaks at 7.2 GB memory, gets killed by systemd, restarts.

**Root cause:** the ML extract script loaded all ~947k snapshot rows into a single pandas DataFrame, peaked at 7.9 GB just for the extract phase, and `df.to_csv()` doubled that during write. When the snapshot table grew past a threshold, the retrain process started killing the bot.

**Fix:** rewrote `ml/scripts/extract_from_snapshots.py` to stream rows in 50,000-row chunks directly to CSV. Memory now bounded at ~150 MB regardless of total row count. Aggregated summary stats (label rates, age distributions) computed chunk-by-chunk without holding rows in memory.

### 2. The infinite hourly retrain loop

After the OOM fixes the bot started retraining every hour, even when no new labels had landed.

**Root cause:** `retrain_all.py` checked whether each target's model file existed and forced a full retrain on any missing model. `hits_5x_within_24h` consistently failed to train (not enough 24h-old snapshots with positive labels yet), so it was always considered "missing," which always triggered a full retrain.

**Fix:** added a `NEVER_FORCE_TARGETS` set that excludes targets known to be data-sparse from the missing-model check. Those targets train when data is available but don't force a retrain cascade when absent.

### 3. The CPU starvation (load avg 12 on 4 cores)

After the OOM cascade ended and the bot stabilized, load average climbed to 12+. Dashboard requests started timing out (5+ seconds for `/api/health`). Cloudflare tunnel appeared dead from outside because the upstream — the dashboard worker — was starved.

**Root cause:** the strategy executor runs `collectFeatures(mintAddress)` once per strategy per candidate mint per evaluation cycle. With 8 strategies and ~15 candidates per sweep, that's ~120 calls per evaluation. Each call ran a 9-million-row join (`trades` × `wallets` × `wallet_leaderboard`) that took 5–8 seconds at scale. The same data fetched 120 times redundantly per cycle.

**Fix:** added a 2-second TTL cache in `feature-collector.js` on the trades-fetch result, keyed by mint address. Multiple strategies evaluating the same mint within 2s reuse the cached result. Load average dropped from 12.79 to 4.02 within seconds of the deploy.

### 4. The wick-confused rug label

The `rug_within_5min` label fired when a mint's minimum price within 5 minutes fell to 30% or less of the snapshot price. This caught **wicks** (brief downward spikes that recovered), not rugs (permanent capital destruction). The model trained on this label predicted 30% rug rate while actual rug rate was 0.7%, making it useless as a filter — and worse, it was actively blocking entries on coins that went on to run.

**Fix:** introduced `will_rug` as the canonical replacement, keyed off `mint.rugged_at` which is set by the bot's independent rug-detection logic (85% drop from peak + 10min of trading quiet). Backfilled 1.42M historical snapshots with the new label and retrained. Post-retrain calibration: 3.4% predicted, 3.4% actual.

### 5. The silent strategy auto-exits

Recipes specified explicit stop-loss / tier-sell / trailing-stop logic, but the `strategy_state` schema had non-zero column defaults for legacy "auto-exit" modes (`fast_fail_sec=60`, `fakepump_sec=120`, `stagnant_exit_min=3`). The recipe deployer didn't write these fields, so they fell through to the schema defaults — silently activating early-bail logic that contradicted the recipe.

**Fix:** updated the recipe-to-state upsert to write explicit zeros for all auto-exit modes. Recipe is now the sole source of truth for exit logic.

### 6. The global moonbag override

After a position survived to migration the bot would auto-convert it to "moonbag mode" using global config values, overriding the strategy's recipe-defined exits. Strategies designed for specific post-migration behavior were getting their exit logic replaced by generic moonbag rules.

**Fix:** disabled the auto-conversion at migration. Each strategy now owns its moonbag policy via the new `moonbag_pct_reserve` recipe field. When `tokens_remaining / token_amount ≤ reserve`, the bot stops evaluating exits and waits for a manual close.

### 7. The legacy strategy_state ghost rows

The dashboard's `/api/strategies` endpoint read from a separate `strategy_state` table, not from `ml_agent_strategies`. After wiping 39 old strategies from `ml_agent_strategies` and inserting 4 new ones, the dashboard still showed the old 39 because the corresponding rows in `strategy_state` were never deleted (no foreign-key cascade between the two tables).

**Fix:** truncated `strategy_state` and re-registered the 4 V2 strategies via the proper `deployStrategy()` path that writes both tables.

### 8. Cashback detection ($0/day but RPC waste)

Every time a mint hit 5 unique buyers, the bot called the public Solana RPC to check a single byte in the bonding-curve account for a cashback flag. The flag was used downstream as a tier-trigger boost, but no V2 strategy gates on it.

**Fix:** disabled the detection. Saves CPU + log noise + public-RPC rate budget. The downstream boost defaults to 1.0 (no-op) when no flag is present.

### 9. The wallet_leaderboard recompute

A worker thread recomputed a 50-row top-N wallet leaderboard every 15 minutes via a 13-16 second join across ~3,400 wallets. The output fed two snapshot features (`avg_buyer_rank`, `median_buyer_rank`) that were already NULL for 99.96% of wallets.

**Fix:** disabled the worker. Truncated the three leaderboard tables. The new `wallet_5x_score` table (1,535 elite wallets, recomputed every 6 hours) replaces it for the strategy-relevant case. The two affected snapshot features now stay NULL — the trained models handle NULL features natively.

### 10. Paused Claude integrations

Three subsystems consumed the Claude API: the strategy-proposal agent (every 30 min), `mint-intel` (hourly mint classification, ~$5/day), and `market-regime` (twice daily). None of these outputs feed the V2 strategies' entry conditions or the ML training features. Paused all three to eliminate the API spend during the V2 test period. The strategy executor and the reporting subsystems (post-mortem, daily-report, calibration-review) keep running — they don't call Claude.

---

## Simulation realism

Paper trading uses real on-chain prices but applies friction modeled on actual Helius Sender execution:

| Friction | Setting |
|---|---|
| Fill latency | 500ms (configurable, override of measured RPC ping) |
| Max entry slippage before abort | 35% |
| Curve slippage | Computed per fill from AMM pool depth |
| Volatility drift during execution | `vol_drift_pct` |
| Sandwich attack haircut | `sandwich_pct` |
| Priority fees | Deducted from each trade based on network congestion |

A coin that pumps too fast during the 500ms latency window is **rejected** as `STALE_QUOTE_PAPER`, which mirrors the reality that you can't always get in at the price you saw. Realized PnL on every paper trade has slippage + fees baked in.

---

## Layout

```
src/
  ingestion/          — Helius WS, PumpPortal, trade processor
  scoring/            — wallet enrichment workers (5x scorer, bundle, devs)
  ml/                 — model client, feature collector, label resolver,
                        snapshot sweeper, agent executor, retrain orchestrator
  trading/            — paper position monitor, exit logic, strategies
  server/             — dashboard API + WebSocket feed
  db/                 — schema bootstrap + migrations
  dashboard.js        — dashboard worker (own process)
  index.js            — entry point, spawns all workers

ml/
  scripts/            — Python training pipeline (extract, train, retrain_all)
  models/             — trained .pkl + .json metadata (hot-swap)

scripts/              — one-off deploy + tune scripts (history of every
                        strategy change ever shipped, dated)

data/
  degen.db            — SQLite (WAL mode, multi-process safe)
```

---

## Status

Running on a 4-core 8 GB VM, ~400 MB resident at idle, ~1.5 GB peak during retrain. Paper-only currently with a 10 SOL wallet; live execution path is implemented and gated behind a runtime flag (no autonomous flip — explicit human switch). The 4-strategy portfolio has been live since the V2 deploy and is logging entries on elite-wallet triggers.

The autonomous Claude-driven evolution loop is paused but intact. When V2 has accumulated enough resolved-label data to validate or invalidate the hand-picked strategies, it can be re-enabled to evolve from a calibrated baseline rather than a confused one.
