# Degen Club :: Monkeys Funhouse

Pump.fun trading bot. Tracks tracked-wallet activity via PumpPortal websocket, scores it against configurable gates, paper-trades or live-executes through Pump's bonding curve. Cyberpunk-themed dashboard, SQLite for state, latency-aware paper sim, friction audit, runtime-tunable limits.

---

## Quickstart

```bash
git clone https://github.com/CosmoNebula/degen-club.git
cd degen-club
npm install
cp .env.example .env
# edit .env — see Environment below
npm start
```

Open http://localhost:4200 and you're in.

The bot starts in **paper mode** by default. It begins ingesting Pump trades immediately. After a few minutes you'll see mints/trades/wallets accumulating in the topbar. Strategies fire on qualifying signals (paper trades book to SQLite). Toggle live mode via the dashboard once you've validated locally.

---

## Environment

`.env` (never commit — see `.gitignore`):

```
HELIUS_API_KEY=<your helius key>     # required for trade execution + post-migration data
DEGEN_PRIVATE_KEY=<base58 key>       # required ONLY for live mode
BOT_PUBKEY=<your wallet pubkey>      # optional safety pin
PORT=4200                            # optional, default 4200
MODE=paper                           # paper | live (default paper)
PUBLIC_RPC_URL=                      # optional override for read-only RPC
```

**Helius credit conservation:** the bot routes balance reads to `api.mainnet-beta.solana.com` (free public RPC) and only hits Helius for trade tx submission, post-migration holder snapshots, and the cashback flag check. Pre-migration holder data comes from the PumpPortal trade tape (free).

---

## Architecture

```
PumpPortal WS (free)              Public Solana RPC (free)
        │                                  │
        ▼                                  ▼
  ingestion/processor.js  ───►  trades/mints/wallet_holdings tables
        │
        ├──► scoring/  (flags, traders, KOL detection, holders, runner-score, post-exit)
        ├──► trading/king-tracker.js  (per-king-wallet bag tracking)
        └──► trading/strategies.js  (smart_trade / cluster / runner_score / volume_surge dispatch)
                  │
                  ▼
            trading/paper.js  ──► (paper mode)  applyBuyFriction → tier engine → applySellFriction
                  │
                  └──► trading/executor.js  ──► (live mode)  pumpportal-client → on-chain tx
                              │
                              └──► safety.js (halts, daily loss cap, stale-quote failsafe)
```

**Data:** all in `data/degen.db` (SQLite WAL mode, 1h-quiet trade pruning, vacuum on demand). Schema in `src/db/schema.sql`. The bot creates the DB on first run.

**Logs:** `logs/server-YYYY-MM-DD.log`, daily rotation.

---

## Strategies

All three live in `src/config.js` under `strategies.*`. Toggle on/off and tune from the dashboard's Positions panel.

### `quickFlip15` — Q · Quick Flip +20%
Broad-net high-volume scalp. Fires on any tracked-wallet smart_trade where the signaling wallet is a KOL OR a BOT-under-70mc. Hard MC ceiling at 100 SOL. Sells 100% at +20%, peak-floor armed at 10/20/30%, −10% SL. Backtested 80%+ WR over 100+ trades on the gate spec.

### `kingFollow` — K · King Follow
Solo-follows a whitelisted "king" wallet (default: `57stAMFv…`). 0.5 SOL nominal entry (4× QF), MC ceiling 150, +15% TP, −12% SL, 1-min hard time stop. **Smart exit:** when the king dumps ≥50% of their bag SOL-wise, force-closes the position regardless of price (`KING_DUMPED` exit reason).

Whitelist is editable in `src/config.js → strategies.kingFollow.kingWallets`.

### `trackedWalletFollow`
4-tier ladder strategy with breakeven SL after T1 hit, post-T1 trailing stop, peak-floor protection, fast-fail / fakepump / flat-exit / stagnant-exit logic. Off by default; enable from dashboard if you want a wider net than Quick Flip.

---

## Dashboard

Top bar tiles + four runtime-editable inputs:

- **⚙ Max/Trade ◎** — clamps any single strategy entry (e.g., 0.13)
- **⚙ Max Exposure ◎** — total SOL across all open positions (e.g., 0.40)
- **⚙ Max Entry Slip %** — pre-flight stale-quote abort (e.g., 0.10 = 10%)
- **⚙ Paper Lag ms** — paper-mode latency simulator (0 = instant, 750 = realistic live)

Persisted to `data/runtime-limits.json` so they survive restarts.

Tabs: Mints, Devs, Traders, Positions, System, Coin Lab, Ticker. Coin Lab includes the post-exit analysis ("did we exit too early?").

---

## Safety

- **Halt switch:** click the LIVE/PAPER mode tile to halt all trading. New entries refused, open positions still monitored.
- **Daily loss cap:** `safety.dailyMaxLossSol` in config.
- **Min wallet floor:** won't open a live trade if it would drop wallet below `safety.minWalletSolFloor`.
- **Stale-quote failsafe:** on live buys, before tx submit, the executor reads the latest on-chain price and aborts if the coin has drifted upward more than `safety.maxEntrySlippagePct` since the trigger trade. Logs as `STALE_QUOTE`. Saves you from filling on coins that already ripped past your target.
- **Per-trade size cap & total exposure cap:** see dashboard inputs above.
- **On-chain slippage tolerance:** `photon.slippageBps = 1500` (15%) — the Pump program will reject your tx if the curve has moved more than 15% by the time it lands.

---

## Useful API endpoints

```
GET  /api/stats                      → topbar tiles (live-mode aware)
GET  /api/strategies                 → strategy state
POST /api/strategies/:name/toggle    → on/off
PUT  /api/strategies/:name/settings  → tune entry/sl/tier/etc
GET  /api/limits                     → runtime safety limits
POST /api/limits                     → update limits
GET  /api/exits/analysis             → post-exit outcomes (early/left-money/correct)
GET  /api/friction-audit             → live vs paper-modeled fill comparison (live trades only)
GET  /api/live-sim?latencyMs=750&windowHours=4
                                     → replay paper trades against on-chain tape with simulated lag
POST /api/wallet/sim/reset           → reset paper wallet to fresh starting balance
POST /api/safety/halt                → emergency halt
POST /api/mode                       → switch paper ↔ live (live requires confirm: "LIVE")
```

---

## Going live

1. Fund wallet with at least 0.5 SOL (test small first)
2. Set `DEGEN_PRIVATE_KEY` in `.env`
3. Restart the bot
4. Verify live wallet balance shows on the dashboard topbar
5. Set `Max/Trade ◎` to your starting bet size (recommend 0.13 — friction floor)
6. Set `Max Exposure ◎` low for first session (recommend 0.30 = max 2-3 concurrent)
7. Click **SWITCH → LIVE**, confirm
8. Watch the first 5-10 closed trades closely
9. Run `/api/friction-audit` to compare actual fills vs paper-modeled

If first session goes sideways, click the LIVE tile to halt, audit, tune.

---

## Performance notes from real sessions

- Quick Flip +20% spec (KOL-gated, MC<100): ~83% paper WR over 119 closed trades, ~+12.7% ROI per turn.
- Same-coin pairs of QF + KF show QF wins ~2/3 when coins keep running past +15%; KF wins ~1/3 when it locks the +15% before fade.
- Sub-5s hold times are the norm for QF — these are scalping the post-trigger continuation, not riding multi-minute moves.
- Live-vs-paper friction modeled at 2.5% slippage + 0.0008 SOL priority fee per side. Real friction varies — that's why `/api/friction-audit` exists.

---

## License / use

Personal trading bot. Use at your own risk — it can lose real SOL fast. Backtest, paper, audit, then size up gradually.
