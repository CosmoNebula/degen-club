# Degen Club :: Monkeys Funhouse

Pump.fun trading bot focused on hunting **migrators and big runners** instead of sniping new launches. Built around one strategy — `migratorHunter` — that copies wallets with proven history of catching mints that graduate to Raydium / PumpSwap.

PumpPortal websocket for trade ingestion · Helius for cashback flag detection · Dexscreener for post-migration price feeds · SQLite (WAL) for state · cyberpunk-themed dashboard at `localhost:4200`.

---

## Why one strategy

A 63-trade postmortem of the previous multi-strategy setup showed:

- The sniper-style `preKing` strategy was responsible for ~75% of trades and ~all of the loss (-33.8 SOL on 4,339 entries, 19.8% WR).
- Mid-curve entries on coins that *eventually migrated* were +2.5 SOL net at 36% WR.
- 100% of -30% SL hits later recovered (avg 2.55x from exit price) — the SL was just too tight, not picking bad coins.
- Wallets with the strongest migrator-finding skill were tagged `BUNDLE` / `BOT` / `SCALPER` by the existing categorizer — the global "no-bundle" filter was cutting off exactly the signal we wanted.

So: kill the snipers, copy the bundles/bots that catch migrators, give the trade room to breathe.

---

## migratorHunter strategy

**Trigger:** an in-memory sliding-window tracker watches every buy. When ≥3 distinct wallets with `migrator_score ≥ 0.55` and `≥5 pre-migration buys` buy the same mint inside 5 minutes, the strategy fires.

**Mint shape gates:**
- Age 120s – 7200s (filter freshest chop only — wider SL handles the 0-2m bucket)
- Mcap 30 – 250 SOL (mid-curve)
- Unique buyers ≥ 150 (diverse activity)

**Sizing:** score-weighted entry from 0.05 SOL → 0.30 SOL as the avg hunter score climbs from 0.55 → 0.85.

**Exit ladder** (tuned from postmortem):
- T1 +50% / sell 30% → arm breakeven floor at -20% from entry (don't choke +59% peaks)
- T2 +150% / sell 30%
- T3 +400% / sell 20% / 40% trail
- SL -50% (recovery rate on prior -30% SLs was 100%)
- Peak floor 1: arm at +100% above entry, exit if drops 50% from peak
- Peak floor 2: arm at +300%, 55% trail
- Peak floor 3: arm at +700%, 60% trail
- Stagnant exit: 45min holding -30%+
- Max hold: 240 min
- On migration: convert 75% of bag at migration price, ride the remaining 25% as moonbag (target +500%, trail at +20%, 48h max hold)

Strategy file: `src/strategies/migratorHunter.js`. Helper window-tracker: `src/scoring/migrator-hunter.js`.

---

## Wallet scoring (migrator hunters)

`src/scoring/migrator-stats.js` computes per-wallet stats over migrated mints:

- `migrator_buys` — distinct migrated mints the wallet ever bought
- `migrator_pre_mig_buys` — same, but only buys *before* the mint migrated (the harder skill)
- `migrator_avg_entry_pct` — mean of `(first_buy_mcap / peak_mcap)` across pre-mig buys (lower = bought earlier)
- `migrator_realized_sol` — sum of (sells – buys) across all migrated mints
- `migrator_score` — composite: earliness × sample-weight × realized-norm

**Backfill:** `node bin/migrator-stats.js` runs the full backfill from trade history (~37s on ~50k wallets) and prints the leaderboard.

**Live updates:** when any mint flips `migrated=1`, `processor.onMigrate()` calls `updateMigratorStatsForMint()`, which recomputes scores for every wallet that touched that mint. Scoped to the wallets involved (typically a few hundred), so the update is cheap and stays consistent with the full backfill.

---

## Architecture

### Main thread
- **PumpPortal websocket** ingestion (`src/ingestion/processor.js`)
- Per-trade hot path: trade insert → labelTrade → flag check → trackBuyer → migrator-hunter window check → forward to worker
- HTTP server + dashboard (`src/server/index.js`)
- Strategy auto-loader (`src/strategies/index.js`) — drop-in `*.js` files in `src/strategies/` are auto-registered

### Worker threads (off main event loop)

**Position monitor worker** (`src/trading/position-monitor-worker.js`)
- Owns the 250ms `monitorPositions` sweep — checks open positions, fires tier exits / SL / peak floors
- Handles per-trade `checkMint` requests from main thread via `postMessage`
- Has its own better-sqlite3 connection sharing the WAL file
- Auto-respawns on crash

**Traders worker** (`src/trading/traders-worker.js`)
- Recomputes active wallets every 2 min (skips boot-time full classification)
- Hourly **stale wallet cleanup**: deletes wallets where ALL of:
  - `last_activity_at < now - 24h`
  - `manually_tracked = 0` AND `is_kol = 0` AND `tracked = 0` AND `migrator_score = 0`
- Resurrects automatically: deleted wallets are recreated by `processor.upsertWallet` on next trade

### Maintenance (`src/maintenance.js`)

Runs every 30 min:
- **`pruneTrades`**: drops trades on rugged/quiet mints, old rug flags
- **`pruneAuxData`**:
  - Orphan `wallet_holdings` rows (where wallet was deleted)
  - Stale mints (not migrated, no trade in >24h, no open paper position)
  - `copy_signals` and `volume_signals` older than 6h

**Hard-protected from any cleanup:**
- Migrated mints (forever — scoring depends on them)
- Trades on migrated mints
- Mints with open paper positions
- Wallets that are KOL / tracked / manually_tracked / migrator-scored

---

## Live vs paper

- `MODE=paper` (default): every signal opens a paper position. No live execution.
- `MODE=live`: every signal opens **only** a live position. No paper shadow doubling work.
- Mode flips at startup via the `MODE` env var (or via `setMode()` from the dashboard).

`paperLatencyMs` (`config.paper.latencyMs`, runtime-tunable from `data/runtime-limits.json`) simulates fill latency for paper trades only — purely a realism knob, doesn't touch live execution.

---

## File layout

```
src/
  index.js                      # boot
  config.js                     # all knobs
  db/
    index.js                    # SQLite open + migrations (idempotent)
    schema.sql
  ingestion/
    processor.js                # WS trade ingestion hot path
    metadata.js                 # IPFS metadata fetch
    helius.js                   # cashback flag check
    dexscreener.js              # post-migration price feeds
  scoring/
    traders.js                  # wallet classification + stale cleanup
    migrator-stats.js           # migrator-score backfill + per-mint update
    migrator-hunter.js          # in-memory window tracker for the strategy
    coin-velocity.js            # buyer-window helpers (dormant; preKing legacy)
    bundle.js                   # bundle cluster detection
    devs.js                     # creator classification
    flags.js                    # mint flag rules (BUNDLE, ABANDONED, DEAD)
    holders.js                  # holder diversity gate
    runner-score.js             # peak-mcap predictor
    post-exit.js                # post-exit outcome classification
    volume.js                   # volume surge sweeper (dormant)
    wallet-grader.js            # auto-block / auto-boost grading
  strategies/
    index.js                    # auto-loader
    migratorHunter.js           # the only active strategy
  trading/
    paper.js                    # position open/exit logic
    strategies.js               # signal dispatchers (onSmartTrade, onMigratorHunter, etc)
    position-monitor-worker.js  # worker: 250ms position sweep + per-trade checks
    traders-worker.js           # worker: 2min wallet sweep + hourly stale cleanup
    executor.js                 # live PumpPortal/Photon execution
    wallet.js                   # mode + balance
    sizing.js                   # dynamic position sizing
    backtest.js                 # signal replay engine
  server/
    index.js                    # Express + dashboard JSON API
  maintenance.js                # trade/aux pruning
  price.js                      # SOL/USD feed
bin/
  migrator-stats.js             # full backfill + leaderboard CLI
data/
  degen.db                      # SQLite (WAL mode)
  runtime-limits.json           # runtime-tunable safety limits
public/                         # cyberpunk dashboard (vanilla JS)
logs/
  server-YYYY-MM-DD.log         # daily-rotated app log
  launchd-stdout.log            # launchd-managed
  launchd-stderr.log
```

---

## Operational notes

- **Auto-restart on file change:** the launch agent runs `node --watch --watch-path=src src/index.js`. Save a `src/` file, server reloads in ~1s. Watch picks up file content changes, not `touch`.
- **Manual restart:** if the watch flag itself stops triggering, `launchctl unload && load` from `~/Library/LaunchAgents/com.degen-club.plist`.
- **Big Sur / cloudflared:** binary at `~/bin/cloudflared` pinned to `2023.7.3` (newer builds need macOS 15+). Don't overwrite.
- **Boot storm:** the trade-prune + creator-classification on first boot can briefly spike CPU. Dashboard responds within 30-60s. The expensive trader-recompute moved to a worker so it no longer blocks HTTP.
- **Strategy Builder UI caveat:** saving a strategy through the dashboard's Strategy Builder UI overwrites the source file with a generic template, dropping any custom fields like `trigger`, `minHunters`, `sizing`, etc. that aren't in its form schema. **Edit strategy files directly, not through the UI.**

---

## Quick queries

```sql
-- Current run performance
SELECT exit_reason, COUNT(*) n,
  ROUND(AVG(realized_pnl_pct)*100, 1) avg_pct,
  ROUND(SUM(realized_pnl_sol), 3) net_sol
FROM paper_positions
WHERE entered_at >= (SELECT started_at FROM paper_wallet WHERE id=1)
  AND status = 'closed'
GROUP BY exit_reason ORDER BY n DESC;

-- Top migrator hunters
SELECT substr(address, 1, 8) wallet, ROUND(migrator_score, 3) score,
       migrator_pre_mig_buys n, ROUND(migrator_realized_sol, 2) sol
FROM wallets WHERE migrator_score > 0.6
ORDER BY migrator_score DESC LIMIT 20;

-- Mints we held that migrated
SELECT substr(p.mint_address, 1, 8) mint, p.exit_reason,
  ROUND(p.realized_pnl_pct*100, 1) pnl_pct,
  ROUND(m.peak_market_cap_sol / p.entry_mcap_sol, 1) peak_x
FROM paper_positions p JOIN mints m ON m.mint_address = p.mint_address
WHERE p.strategy = 'migratorHunter' AND m.migrated = 1
ORDER BY p.entered_at DESC;
```

---

## Reset for a fresh test session

```sql
DELETE FROM paper_positions;
DELETE FROM gate_rejections;
UPDATE paper_wallet SET starting_balance_sol = 1.0,
  started_at = CAST(strftime('%s','now')*1000 AS INTEGER),
  peak_total_value = 1.0, peak_at = NULL,
  reset_count = reset_count + 1 WHERE id = 1;
UPDATE strategy_state SET positions_opened = 0, wins = 0, losses = 0, total_pnl_sol = 0;
```

Wallets, mints, trades, scoring, and creator history all preserved.
