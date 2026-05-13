import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { seedKnownAddressesTable } from '../data/known-addresses.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db;

export function db() {
  if (!_db) init();
  return _db;
}

export function init() {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  _db = new Database(config.dbPath, { timeout: 30000 }); // 30s busy_timeout — workers contend on writes
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('wal_autocheckpoint = 1000'); // keep WAL bounded
  _db.pragma('mmap_size = 268435456');     // 256MB mmap for large reads
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  _db.exec(schema);
  runMigrations(_db);
  return _db;
}

function ensureCol(d, table, name, def) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(name)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}

function runMigrations(d) {
  // Strategy lineage (added 2026-05-09)
  ensureCol(d, 'ml_agent_strategies', 'parent_strategy_id', `TEXT`);
  ensureCol(d, 'ml_agent_strategies', 'generation', `INTEGER DEFAULT 1`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_strategies_parent ON ml_agent_strategies(parent_strategy_id)`);

  // Post-migration tracking via DexScreener (PumpSwap data went paid 2026-05)
  ensureCol(d, 'mints', 'amm_pool_address', `TEXT`);
  ensureCol(d, 'mints', 'amm_dex', `TEXT`);
  ensureCol(d, 'mints', 'amm_liquidity_usd', `REAL DEFAULT 0`);
  ensureCol(d, 'mints', 'amm_volume_h1_usd', `REAL DEFAULT 0`);
  ensureCol(d, 'mints', 'amm_volume_h24_usd', `REAL DEFAULT 0`);
  ensureCol(d, 'mints', 'amm_buys_h24', `INTEGER DEFAULT 0`);
  ensureCol(d, 'mints', 'amm_sells_h24', `INTEGER DEFAULT 0`);
  ensureCol(d, 'mints', 'amm_price_change_h1', `REAL DEFAULT 0`);
  ensureCol(d, 'mints', 'amm_price_change_h24', `REAL DEFAULT 0`);
  ensureCol(d, 'mints', 'last_amm_refresh_at', `INTEGER`);

  ensureCol(d, 'wallets', 'category', `TEXT DEFAULT 'NOT_SURE'`);
  ensureCol(d, 'wallets', 'bot_flags', `TEXT DEFAULT '[]'`);
  ensureCol(d, 'wallets', 'copy_friendly', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'trades_per_position', `REAL DEFAULT 0`);
  ensureCol(d, 'wallets', 'realized_pnl_30d', `REAL DEFAULT 0`);
  ensureCol(d, 'wallets', 'trade_count_30d', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'closed_30d', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'win_count_30d', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'win_rate_30d', `REAL DEFAULT 0`);
  // Rolling 7-day stats (Tier B #1, added 2026-05-11). Computed alongside
  // the 30d versions by recomputeWallet() in traders.js. Used as a
  // hot-streak overlay on the leaderboard scoring — a wallet that hit
  // 5 winners this week shouldn't be drowned in their 30d average.
  ensureCol(d, 'wallets', 'realized_pnl_7d', `REAL DEFAULT 0`);
  ensureCol(d, 'wallets', 'closed_7d', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'win_count_7d', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'win_rate_7d', `REAL DEFAULT 0`);
  ensureCol(d, 'wallets', 'graduated_touched', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'sell_100pct_count', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'sell_100pct_ratio', `REAL DEFAULT 0`);
  ensureCol(d, 'wallets', 'bundle_cluster_id', `TEXT`);
  ensureCol(d, 'wallets', 'first_block_count', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'first_block_ratio', `REAL DEFAULT 0`);
  ensureCol(d, 'wallets', 'manually_tracked', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'is_kol', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'kol_since', `INTEGER`);
  ensureCol(d, 'wallets', 'auto_blocked', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'auto_boost_mult', `REAL DEFAULT 1.0`);
  ensureCol(d, 'wallets', 'follow_trades', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'follow_wr', `REAL DEFAULT 0`);
  ensureCol(d, 'wallets', 'follow_net_sol', `REAL DEFAULT 0`);

  // Migrator-hunter stats: per-wallet behavior on mints that graduated to Raydium.
  // entry_pct = entry mcap / peak mcap (lower = bought earlier on the curve).
  // realized_sol = sum of sells - buys across migrated mints (proxy for actual exit quality).
  ensureCol(d, 'wallets', 'migrator_buys', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'migrator_pre_mig_buys', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'migrator_avg_entry_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'wallets', 'migrator_realized_sol', `REAL DEFAULT 0`);
  ensureCol(d, 'wallets', 'migrator_score', `REAL DEFAULT 0`);
  ensureCol(d, 'wallets', 'migrator_stats_updated_at', `INTEGER`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_wallets_migrator_score ON wallets(migrator_score DESC) WHERE migrator_score > 0`);

  // Section D / 2026-05-13: dropped_count tracks consecutive leaderboard
  // recomputes a wallet was OFF the top-50. Reset to 0 when it re-enters.
  // After AUTO_UNTRACK_DROPS (=3 at 30-min cadence = 1.5h), tracked=0.
  // Prevents single bad hour from kicking out a long-standing high-quality
  // wallet, while still pruning trackers that have genuinely gone cold.
  ensureCol(d, 'wallets', 'dropped_count', `INTEGER DEFAULT 0`);

  // Section D1 / 2026-05-13: per-entry tracker attribution. JSON array of
  // tracker wallets that bought this mint in the 60s window before our entry
  // fired. Used by tracker-concentration to compute rolling per-wallet credit
  // and mute over-represented wallets.
  ensureCol(d, 'paper_positions', 'tracker_wallets_json', `TEXT`);

  // Wallet rings: groups of wallets that buy the same mints together.
  // Detected by mint co-occurrence; aggregate W/L pulled from paper_positions.
  ensureCol(d, 'wallets', 'ring_id', `TEXT`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_wallets_ring ON wallets(ring_id) WHERE ring_id IS NOT NULL`);
  d.exec(`CREATE TABLE IF NOT EXISTS wallet_rings (
    id TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    shared_mint_count INTEGER NOT NULL,
    detected_at INTEGER NOT NULL,
    updated_at INTEGER,
    paper_wins INTEGER DEFAULT 0,
    paper_losses INTEGER DEFAULT 0,
    paper_net_sol REAL DEFAULT 0,
    distinct_mints_bought INTEGER DEFAULT 0,
    label TEXT,
    notes TEXT
  )`);

  d.exec(`CREATE TABLE IF NOT EXISTS paper_wallet (
    id INTEGER PRIMARY KEY,
    starting_balance_sol REAL NOT NULL DEFAULT 1.0,
    started_at INTEGER NOT NULL,
    reset_count INTEGER DEFAULT 0,
    peak_total_value REAL DEFAULT 0,
    peak_at INTEGER
  )`);
  const exists = d.prepare('SELECT id FROM paper_wallet WHERE id = 1').get();
  if (!exists) {
    d.prepare('INSERT INTO paper_wallet (id, starting_balance_sol, started_at) VALUES (1, 1.0, ?)').run(Date.now());
  }

  ensureCol(d, 'trades', 'is_first_block', `INTEGER DEFAULT 0`);
  ensureCol(d, 'trades', 'buyer_rank', `INTEGER`);

  ensureCol(d, 'wallet_holdings', 'is_first_block', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallet_holdings', 'buyer_rank', `INTEGER`);

  ensureCol(d, 'mints', 'migrated_to', `TEXT`);
  ensureCol(d, 'mints', 'bundle_buyer_count', `INTEGER DEFAULT 0`);
  ensureCol(d, 'mints', 'bonding_curve_key', `TEXT`);
  ensureCol(d, 'mints', 'cashback_enabled', `INTEGER`);
  ensureCol(d, 'mints', 'cashback_checked_at', `INTEGER`);
  ensureCol(d, 'mints', 'runner_score', `INTEGER`);
  ensureCol(d, 'mints', 'runner_breakdown', `TEXT`);
  ensureCol(d, 'mints', 'runner_scored_at', `INTEGER`);
  ensureCol(d, 'mints', 'runner_fired', `INTEGER DEFAULT 0`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_mints_runner_score ON mints(runner_score DESC) WHERE runner_score IS NOT NULL`);

  ensureCol(d, 'paper_positions', 'strategy', `TEXT`);
  ensureCol(d, 'paper_positions', 'entry_mcap_sol', `REAL DEFAULT 0`);
  ensureCol(d, 'paper_positions', 'exit_mcap_sol', `REAL`);
  ensureCol(d, 'paper_positions', 'unrealized_pnl_sol', `REAL DEFAULT 0`);
  ensureCol(d, 'paper_positions', 'unrealized_pnl_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'paper_positions', 'highest_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'paper_positions', 'updated_at', `INTEGER`);
  ensureCol(d, 'paper_positions', 'entry_score', `REAL DEFAULT 1.0`);
  ensureCol(d, 'paper_positions', 'is_moonbag', `INTEGER DEFAULT 0`);
  ensureCol(d, 'paper_positions', 'moonbag_started_at', `INTEGER`);
  ensureCol(d, 'paper_positions', 'migration_price', `REAL`);
  ensureCol(d, 'paper_positions', 'migration_mcap_sol', `REAL`);
  ensureCol(d, 'paper_positions', 'moonbag_peak_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'paper_positions', 'pool_address', `TEXT`);
  ensureCol(d, 'paper_positions', 'post_exit_peak_price', `REAL`);
  ensureCol(d, 'paper_positions', 'post_exit_peak_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'paper_positions', 'post_exit_recheck_at', `INTEGER`);
  ensureCol(d, 'paper_positions', 'post_exit_outcome', `TEXT`);
  ensureCol(d, 'paper_positions', 'position_mode', `TEXT DEFAULT 'paper'`);
  ensureCol(d, 'paper_positions', 'pending_fill', `INTEGER DEFAULT 0`);
  ensureCol(d, 'paper_positions', 'sell_events', `TEXT DEFAULT '[]'`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_positions_moonbag ON paper_positions(is_moonbag, status)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_positions_outcome ON paper_positions(post_exit_outcome)`);

  d.exec(`CREATE TABLE IF NOT EXISTS strategy_state (
    name TEXT PRIMARY KEY,
    label TEXT,
    description TEXT,
    enabled INTEGER DEFAULT 0,
    entry_sol REAL,
    tp_pct REAL,
    sl_pct REAL,
    max_hold_min INTEGER,
    positions_opened INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    total_pnl_sol REAL DEFAULT 0,
    updated_at INTEGER
  )`);

  ensureCol(d, 'creators', 'last_active_at', `INTEGER`);
  ensureCol(d, 'creators', 'abandoned_count', `INTEGER DEFAULT 0`);
  ensureCol(d, 'creators', 'avg_cycle_time_seconds', `REAL DEFAULT 0`);
  ensureCol(d, 'creators', 'avg_launch_lifetime_seconds', `REAL DEFAULT 0`);
  ensureCol(d, 'creators', 'days_active', `REAL DEFAULT 0`);
  ensureCol(d, 'creators', 'bundle_overlap_count', `INTEGER DEFAULT 0`);
  ensureCol(d, 'creators', 'category', `TEXT DEFAULT 'NEW'`);
  ensureCol(d, 'creators', 'dev_flags', `TEXT DEFAULT '[]'`);

  d.exec(`DROP INDEX IF EXISTS idx_trades_firstblock`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_wallets_pnl_30d ON wallets(realized_pnl_30d DESC)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_wallets_category ON wallets(category)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_wallets_bundle ON wallets(bundle_cluster_id)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_creators_category ON creators(category)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_creators_score ON creators(reputation_score DESC)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_positions_strategy ON paper_positions(strategy)`);

  d.exec(`CREATE TABLE IF NOT EXISTS gate_rejections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint_address TEXT NOT NULL UNIQUE,
    first_rejected_at INTEGER NOT NULL,
    last_rejected_at INTEGER NOT NULL,
    reject_count INTEGER DEFAULT 1,
    reason TEXT NOT NULL,
    reason_detail TEXT,
    signal_type TEXT,
    mcap_at_reject REAL,
    price_at_reject REAL
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_rejections_first ON gate_rejections(first_rejected_at DESC)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_rejections_reason ON gate_rejections(reason)`);

  ensureCol(d, 'strategy_state', 'tp_trail_arm_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'fast_fail_sec', `INTEGER DEFAULT 60`);
  ensureCol(d, 'strategy_state', 'fast_fail_min_peak_pct', `REAL DEFAULT 0.05`);
  ensureCol(d, 'strategy_state', 'fast_fail_sl_pct', `REAL DEFAULT -0.10`);
  ensureCol(d, 'strategy_state', 'breakeven_arm_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'breakeven_floor_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'flat_exit_min', `INTEGER DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'flat_exit_max_peak_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'flat_exit_band_pct', `REAL DEFAULT 0.10`);
  ensureCol(d, 'strategy_state', 'cashback_trigger_boost', `REAL DEFAULT 1.0`);
  ensureCol(d, 'strategy_state', 'fakepump_sec', `INTEGER DEFAULT 120`);
  ensureCol(d, 'strategy_state', 'fakepump_min_peak_pct', `REAL DEFAULT 0.15`);
  ensureCol(d, 'strategy_state', 'fakepump_sl_pct', `REAL DEFAULT -0.15`);
  ensureCol(d, 'strategy_state', 'stagnant_exit_min', `INTEGER DEFAULT 3`);
  ensureCol(d, 'strategy_state', 'stagnant_loss_pct', `REAL DEFAULT -0.10`);
  ensureCol(d, 'strategy_state', 'trail_stop_pct', `REAL DEFAULT 0.20`);
  ensureCol(d, 'strategy_state', 'tp_trail_pct', `REAL DEFAULT 0`);

  ensureCol(d, 'strategy_state', 'tier1_trigger_pct', `REAL DEFAULT 0.5`);
  ensureCol(d, 'strategy_state', 'tier1_sell_pct', `REAL DEFAULT 0.5`);
  ensureCol(d, 'strategy_state', 'tier2_trigger_pct', `REAL DEFAULT 1.0`);
  ensureCol(d, 'strategy_state', 'tier2_sell_pct', `REAL DEFAULT 0.3`);
  ensureCol(d, 'strategy_state', 'tier3_trigger_pct', `REAL DEFAULT 2.0`);
  ensureCol(d, 'strategy_state', 'tier3_sell_pct', `REAL DEFAULT 0.2`);
  ensureCol(d, 'strategy_state', 'tier3_trail_pct', `REAL DEFAULT 0.2`);
  ensureCol(d, 'strategy_state', 'breakeven_after_tier1', `INTEGER DEFAULT 1`);
  ensureCol(d, 'strategy_state', 'peak_floor_arm_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'peak_floor_exit_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'peak_floor_arm2_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'peak_floor_exit2_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'peak_floor_arm3_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'peak_floor_exit3_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'dead_bag_age_min', `INTEGER DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'dead_bag_max_peak_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'dead_bag_loss_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'fade_exit_peak_min', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'fade_exit_peak_max', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'fade_exit_loss_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'mid_fade_peak_min', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'mid_fade_peak_max', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'mid_fade_loss_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'lazy_exit_age_min', `INTEGER DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'lazy_exit_max_peak_pct', `REAL DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'lazy_exit_band_pct', `REAL DEFAULT 0`);

  ensureCol(d, 'paper_positions', 'tokens_remaining', `REAL DEFAULT 0`);
  ensureCol(d, 'paper_positions', 'sol_realized_so_far', `REAL DEFAULT 0`);
  ensureCol(d, 'paper_positions', 'tiers_hit', `TEXT DEFAULT '[]'`);
  ensureCol(d, 'paper_positions', 'breakeven_armed', `INTEGER DEFAULT 0`);

  // DCA scale-in (added 2026-05-11) — per-position tracking of how many
  // dollar-cost-average buys have fired on this position. Each DCA averages
  // down entry_price and adds to entry_sol/token_amount/tokens_remaining.
  // dca_count is checked against strategy_state.dca_max_dca to enforce caps.
  ensureCol(d, 'paper_positions', 'dca_count', `INTEGER DEFAULT 0`);
  ensureCol(d, 'paper_positions', 'dca_total_sol_added', `REAL DEFAULT 0`);

  // Data-quality flag for closed positions whose exit was recorded against
  // a junk price tick. Set by the one-time backfill (see below) and used by
  // the agent to discount unreliable historical PnL.
  // Possible values: NULL (clean) | 'junk_exit_tick'
  ensureCol(d, 'paper_positions', 'data_quality_flag', `TEXT`);

  // One-time backfill: pre-2026-05-11 we accepted exit prices below
  // pump.fun's bonding-curve floor of ~2.8e-8 SOL/token, recording fake
  // ~-99% losses on positions that actually exited fine (or the mint
  // never crashed at all). Flag those rows so the agent's per-strategy
  // lift analysis can exclude them. We don't rewrite realized_pnl —
  // that's irreversible — but the flag prevents the bad data from
  // distorting future decisions.
  try {
    const flagged = d.prepare(`
      UPDATE paper_positions SET data_quality_flag = 'junk_exit_tick'
      WHERE status = 'closed'
        AND data_quality_flag IS NULL
        AND exit_mcap_sol IS NOT NULL
        AND exit_mcap_sol > 0
        AND exit_mcap_sol < entry_mcap_sol * 0.05
        AND entry_mcap_sol >= 10
        AND mint_address IN (
          SELECT mint_address FROM mints WHERE migrated = 0 AND rugged = 0
        )
    `).run();
    if (flagged.changes > 0) {
      console.log(`[backfill] flagged ${flagged.changes} closed positions as junk_exit_tick (exit_mcap << entry_mcap on non-migrated, non-rugged mint)`);
    }
  } catch (err) {
    console.error('[backfill] junk_exit_tick flag failed:', err.message);
  }
  // Per-strategy DCA controls. dca_enabled=0 by default (opt-in) so existing
  // strategies don't get DCA'd unless the agent (or a manual override)
  // turns it on. The agent's strategy recipe schema includes a dca section
  // — see agent-llm.js. Defaults reflect "modest dip-buy" semantics: -25%
  // drawdown trigger, 50% size add, 60s-to-30min window, max 1 DCA.
  ensureCol(d, 'strategy_state', 'dca_enabled', `INTEGER DEFAULT 0`);
  ensureCol(d, 'strategy_state', 'dca_trigger_pct', `REAL DEFAULT -0.25`);
  ensureCol(d, 'strategy_state', 'dca_size_pct', `REAL DEFAULT 0.5`);
  ensureCol(d, 'strategy_state', 'dca_min_age_sec', `INTEGER DEFAULT 60`);
  ensureCol(d, 'strategy_state', 'dca_max_age_min', `INTEGER DEFAULT 30`);
  ensureCol(d, 'strategy_state', 'dca_max_dca', `INTEGER DEFAULT 1`);

  d.exec(`UPDATE paper_positions SET tokens_remaining = token_amount WHERE tokens_remaining IS NULL OR tokens_remaining = 0`);
  // Removed: hardcoded-whitelist DELETE that wiped any strategy not in a stale list.
  // It nuked migratorHunter/kingFollow/preKing/quickFlip15 every time init() ran
  // (e.g. when the monitor worker thread opens its own DB connection). Stale rows
  // from removed strategies are harmless — they just sit unused. Remove explicitly
  // via SQL if needed.

  // Cold archive manifest. Tracks which day-batches of trades have been
  // exported to Parquet + uploaded to MEGA. The prune cycle MUST verify a
  // day is in this manifest before deleting trades for that day — otherwise
  // we'd lose the raw data forever (which is what happened to 2.4M trades
  // on 2026-05-09 before this archive system existed).
  d.exec(`CREATE TABLE IF NOT EXISTS archive_manifest (
    date_key TEXT PRIMARY KEY,
    rows INTEGER NOT NULL,
    size_bytes INTEGER,
    min_ts INTEGER,
    max_ts INTEGER,
    parquet_path TEXT,
    mega_path TEXT,
    archived_at INTEGER NOT NULL,
    pruned_at INTEGER
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_archive_pruned ON archive_manifest(pruned_at)`);

  // Top-50 dynamic trader leaderboard. Replaces the old `tracked = 1` threshold
  // gate — wallets compete for 50 fixed slots, recomputed hourly. Top 10 = KOL,
  // 11-25 = HIGH, 26-50 = TRACKED. Helius webhooks subscribe only to the top 50,
  // cutting our credit usage and concentrating signal on the best wallets.
  d.exec(`CREATE TABLE IF NOT EXISTS wallet_leaderboard (
    address TEXT PRIMARY KEY,
    rank INTEGER NOT NULL,
    tier TEXT NOT NULL,
    score REAL NOT NULL,
    realized_pnl_30d REAL DEFAULT 0,
    win_rate_30d REAL DEFAULT 0,
    closed_30d INTEGER DEFAULT 0,
    migrator_pre_mig_buys INTEGER DEFAULT 0,
    avg_multiple_30d REAL DEFAULT 0,
    early_entry_rate REAL DEFAULT 0,
    rug_rate_30d REAL DEFAULT 0,
    sniper_ratio REAL DEFAULT 0,
    avg_hold_seconds INTEGER DEFAULT 0,
    components_json TEXT,
    label TEXT,
    computed_at INTEGER NOT NULL
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_leaderboard_rank ON wallet_leaderboard(rank ASC)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_leaderboard_tier ON wallet_leaderboard(tier)`);

  // Base table for ML training snapshots. Historically this table was created
  // implicitly via ensureCol's ALTER TABLE chain — which silently no-ops on a
  // missing table (PRAGMA table_info returns empty, then ALTER TABLE errors
  // get caught by SQLite's "table doesn't exist" path on some platforms but
  // succeeds on others). Adding an explicit CREATE here so fresh installs
  // get a usable table; ensureCol calls below remain idempotent on existing
  // DBs. Composite PK matches the (mint, age) bucket structure — one row per
  // mint per snapshot-age (60/300/900/3600s pre-mig).
  d.exec(`CREATE TABLE IF NOT EXISTS ml_mint_snapshots (
    mint_address TEXT NOT NULL,
    snapshot_age_sec INTEGER NOT NULL,
    snapshot_ts INTEGER NOT NULL,
    labels_resolved_at INTEGER,
    PRIMARY KEY (mint_address, snapshot_age_sec)
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_ml_unresolved ON ml_mint_snapshots(labels_resolved_at) WHERE labels_resolved_at IS NULL`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_ml_snapshot_ts ON ml_mint_snapshots(snapshot_ts DESC)`);

  // ML features for top-buyer presence (added with leaderboard system).
  // Models will pick these up on the next retrain cycle.
  ensureCol(d, 'ml_mint_snapshots', 'top10_buyers', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'top50_buyers', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'weighted_buyer_quality', `REAL`);

  // Trade-size distribution features (Tier 1 #1). Captures the SHAPE of
  // buy/sell flow that sol_inflow + buy_count alone can't see. Distinguishes
  // bot-spam (many tiny uniform trades) from whale-pumps (few huge trades)
  // from organic retail (wide distribution). Each stat is REAL or NULL.
  // NULL on empty (no buys/sells in window) — model handles NaN natively.
  ensureCol(d, 'ml_mint_snapshots', 'avg_buy_sol', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'median_buy_sol', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'p90_buy_sol', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'max_buy_sol', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'std_buy_sol', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'avg_sell_sol', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'median_sell_sol', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'p90_sell_sol', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'max_sell_sol', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'std_sell_sol', `REAL`);

  // Whale concentration features (Tier 1 #2). Captures HOW CONCENTRATED the
  // buy/sell flow is into a few wallets. Top-N share + Herfindahl index for
  // each side. Distinguishes whale-pumped mints (top1_buyer=0.6+) from
  // organic flow (top1_buyer<0.1), and rug-style single-wallet dumps
  // (top1_seller=0.7+) from distributed exits.
  // All values 0-1 fractions, NULL when no trades on that side.
  ensureCol(d, 'ml_mint_snapshots', 'top1_buyer_sol_pct', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'top3_buyer_sol_pct', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'top5_buyer_sol_pct', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'buyer_hhi', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'top1_seller_sol_pct', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'top3_seller_sol_pct', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'top5_seller_sol_pct', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'seller_hhi', `REAL`);

  // Sniper / first-block / buyer-rank aggregates (Tier 1 #3). The trades
  // table tags each buy with is_sniper, is_first_block, and buyer_rank but
  // none of that rolled up into snapshots — model couldn't directly see
  // "this mint's first 10 buyers were all sniper bots." Now it can.
  // avg_buyer_rank uses each wallet's MIN rank (their actual entry position),
  // not raw average over trades — repeat buys would otherwise pull the
  // average toward early ranks artificially.
  ensureCol(d, 'ml_mint_snapshots', 'sniper_buyer_count', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'pct_sniper_buys', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'first_block_buyer_count', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'pct_first_block_buys', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'avg_buyer_rank', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'median_buyer_rank', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'pct_buyers_in_first_10', `REAL`);

  // Time-to-first-tracked-buyer + accumulation velocity (Tier 1 #4). The
  // existing tracked_buyers / kol_buyers counts say IF smart money engaged
  // but not HOW FAST. Same signal at second-5 vs second-90 are very different
  // (info-edge sniper vs late discovery). seconds_to_N_unique_buyers measure
  // organic accumulation speed independent of who the buyers are.
  // All values are seconds-from-mint-creation, NULL when the threshold isn't met.
  ensureCol(d, 'ml_mint_snapshots', 'tracked_first_seen_sec', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'kol_first_seen_sec', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'seconds_to_5_unique_buyers', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'seconds_to_10_unique_buyers', `REAL`);

  // Additional pre-migration ML targets (added 2026-05-10) — fill gaps in
  // the 7-model lineup:
  //   rug_within_5min:        will price drop ≥70% within 5 min after snapshot?
  //                           Tighter horizon than will_die_fast (30 min).
  //                           Defends against flash-rug entries.
  //   migrates_within_15min:  will mint graduate to AMM within 15 min?
  //                           Time-bounded version of migrated (which is "ever").
  //                           Drives sizing on imminent migrations.
  //   drawdown_from_peak_pct: typical drop from peak (0-0.99). Calibrates
  //                           trailing stops dynamically — some mints have one
  //                           decisive peak, others chop.
  ensureCol(d, 'ml_mint_snapshots', 'rug_within_5min', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'migrates_within_15min', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'drawdown_from_peak_pct', `REAL`);

  // Additional pre-migration ML targets (added 2026-05-11):
  //   hits_2x_within_1h:     binary — did price hit ≥2x snapshot price within
  //                          60 min of snapshot? Catches medium runners that
  //                          never migrate but still go 2-5x. peaked_100 is
  //                          "ever" — this is the time-bounded version.
  //   time_to_peak_5x_sec:   regression — seconds from "mint first crossed
  //                          +50% from snapshot" to "mint hit its peak". NULL
  //                          if mint never hit +50%. Drives WHEN to tighten
  //                          trailing stops on running positions (the existing
  //                          time_to_peak_sec is from snapshot, not from a
  //                          milestone — different semantics).
  ensureCol(d, 'ml_mint_snapshots', 'hits_2x_within_1h', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'time_to_peak_5x_sec', `REAL`);

  // Tier 2 #1 — Price reversal count. Beyond raw volatility, count how many
  // times the price flipped direction in the snapshot window. Choppy mints
  // (8 reversals in 60s = trader chop) have a different outcome distribution
  // from trending mints (1-2 reversals = clean climb or fall). Volatility
  // alone can't tell these apart.
  // n_reversals_in_window: integer count of direction flips
  // longest_up_run_pct:    largest single up-move sequence (in pct of entry)
  // longest_down_run_pct:  largest single down-move sequence
  ensureCol(d, 'ml_mint_snapshots', 'n_reversals_in_window', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'longest_up_run_pct', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'longest_down_run_pct', `REAL`);

  // Tier 2 #2 — Max 30-sec burst stats. Slide a 30-second window across the
  // trade stream and capture the most intense moment seen so far. Same total
  // buy_count/sol_inflow can look very different if it was a single 30s rip
  // vs. a steady 10-minute trickle — these features expose that shape.
  // max_30s_buy_sol: peak SOL inflow within any 30s window
  // max_30s_buy_count: peak buy count within any 30s window
  // max_30s_buy_sell_ratio: highest buy/sell skew seen in any 30s window
  //   (capped at 99 like the rolling buy_sell_ratio; NULL if no buys at all)
  ensureCol(d, 'ml_mint_snapshots', 'max_30s_buy_sol', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'max_30s_buy_count', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'max_30s_buy_sell_ratio', `REAL`);

  // Tier 2 #3 — Creator post-launch activity. Two features from the trades
  // table (cheap, derived from firehose) + two features from Helius Parse
  // History API (catches off-firehose sidewallet shenanigans).
  // creator_buys_post_launch:  count of buys of THIS mint by the creator's
  //                            main wallet — direct dev-support signal
  // creator_sells_post_launch: count of sells of THIS mint by creator —
  //                            dev-rug-from-main-wallet signal
  // creator_sol_to_sidewallets: SOL the creator transferred to fresh wallets
  //                            in the launch window (sourced from parse API)
  // creator_sidewallet_buyer_count: how many of those fresh wallets then
  //                            bought THIS mint — the smoking gun for
  //                            sidewallet-bait launches
  // The parse-API features may be NULL on snapshots where the async
  // creator-activity fetch hadn't landed yet — the label resolver backfills
  // them on the next pass.
  ensureCol(d, 'ml_mint_snapshots', 'creator_buys_post_launch', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'creator_sells_post_launch', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'creator_sol_to_sidewallets', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'creator_sidewallet_buyer_count', `INTEGER`);

  // Tier 3 features — pump.fun-specific dynamics (added 2026-05-11).
  // All compute-only from local trades/mints tables; zero Helius credit cost.
  //
  // Volume momentum (#1): pump dynamics are acceleration, not level. Split the
  // snapshot window into halves, compare inflow rates. Same total volume looks
  // very different if it was 60/40 second-half (accelerating) vs 40/60 (fading).
  ensureCol(d, 'ml_mint_snapshots', 'inflow_accel_pct', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'buy_count_accel_pct', `REAL`);
  // KOL cluster timing (#2): std of timestamps when top-10 leaderboard wallets
  // bought, in seconds. Synchronized buys (low std) = coordinated pump signal.
  // Spread buys (high std) = organic interest. NULL if <3 top-10 buyers.
  ensureCol(d, 'ml_mint_snapshots', 'top10_buy_timing_std_sec', `REAL`);
  // Withdrawal cluster (#5): mirror of the existing burst30s buy stats, but on
  // SELLS, with unique-seller count as the key discriminator. High unique-
  // seller count in a 30s window = coordinated dump (rug-bait); high sell
  // count from few wallets = single whale exit. The former is rug signal.
  ensureCol(d, 'ml_mint_snapshots', 'max_30s_sell_sol', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'max_30s_sell_count', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'max_30s_unique_sellers', `INTEGER`);
  // Creator heat-map (#7): how many OTHER mints did this creator launch in
  // the hour before this one? Mass-launch creators (3+ siblings in 1h) split
  // their dev attention and rarely push any single mint to migration.
  ensureCol(d, 'ml_mint_snapshots', 'creator_recent_launch_siblings', `INTEGER`);

  // Tier 4 features — activate the dead data (added 2026-05-11).
  // ALL compute-only from local SQLite (or free Telegram Bot API). $0 cost.
  //
  // trend_signal_match (#1): 1 if mint's symbol appears in trend_signals in
  // last 4h (Reddit ticker extractions + CoinGecko/DexScreener/GeckoTerminal
  // trending APIs). 0 otherwise. NULL if no symbol on mint.
  ensureCol(d, 'ml_mint_snapshots', 'trend_signal_match', `INTEGER`);
  // narrative_match_count (#2): count of distinct news_items keywords in last
  // 4h that match tokens in this mint's name/symbol. e.g., AI news active +
  // mint name "AIBot" → match_count >= 1. Drives "narrative-aligned mint" gates.
  ensureCol(d, 'ml_mint_snapshots', 'narrative_match_count', `INTEGER`);
  // Real-time pressure (#4): buy/sell skew over the LAST 60 trades for this
  // mint. Lag-eliminator vs our 60s snapshot aggregations — last 60 trades
  // might span 5s on a hot mint vs 5min on a slow one, but it's "what just
  // happened" regardless. pressure_60_buy_pct = buys/60, pressure_60_net =
  // (buys - sells) / 60 (signed: positive = buy pressure, negative = sell).
  ensureCol(d, 'ml_mint_snapshots', 'pressure_60_buy_pct', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'pressure_60_net', `REAL`);
  // Telegram member count (#5). Populated by telegram-watcher worker via
  // free Telegram Bot API. NULL if no TG URL, fetch failed, or private chat.
  ensureCol(d, 'ml_mint_snapshots', 'telegram_member_count', `INTEGER`);

  // Tier 5 features — deeper signal extraction from existing data (added 2026-05-11).
  // All compute-only, $0 cost.
  //
  // d/dt HHI (#3): change in buyer/seller concentration since the previous
  // (younger) snapshot of the same mint. Wallets EXITING fast = HHI dropping
  // fast. Wallets accumulating = HHI rising. Direction-of-flow signal that
  // the level alone misses. NULL on the first (60s) snapshot — no predecessor.
  ensureCol(d, 'ml_mint_snapshots', 'buyer_hhi_delta', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'seller_hhi_delta', `REAL`);
  // Sniper slot distinction (#4): split the existing is_sniper / is_first_block
  // flags into two distinct cohorts. Slot-1 buyers (is_first_block=1) are
  // pure bots — they're in the same transaction as the mint creation, only
  // possible via on-chain scripts. Slot-2-5 (is_sniper=1 AND is_first_block=0)
  // are human-fast buyers — manual or webhook-driven entries with reaction
  // times of 1-5 slots. Different cohort outcomes per pump.fun analysts.
  ensureCol(d, 'ml_mint_snapshots', 'bot_sniper_buyer_count', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'fast_human_sniper_count', `INTEGER`);
  // Revenge launch detector (#5): seconds since the creator's most recent
  // prior mint went quiet (its last_trade_at). Tight values (< ~5min) =
  // revenge launch — creator immediately relaunched after a failed mint.
  // Trench wisdom: these hit harder than cold-start launches.
  ensureCol(d, 'ml_mint_snapshots', 'seconds_since_prev_creator_death', `REAL`);

  // Long-horizon "hold-to-maturity" labels (added 2026-05-12). The pre-mig
  // labels above all resolve within 1h — peaked_30, hits_2x_within_1h,
  // rug_within_5min, etc. answer "did this pump fast?". These new targets
  // answer "is this worth holding?": 1h/4h/24h hold returns, liveness flags,
  // bounded-horizon multiples, and bounded-horizon max-drawdown. Models trained
  // on these let the agent propose buy-and-hold strategies, not just flips.
  // Resolved later than other labels — the 24h-bound ones need 25h of trade
  // history. The label resolver returns NULL until the window is ready, and
  // the stale-backfill pass fills them in as snapshots age past each horizon.
  ensureCol(d, 'ml_mint_snapshots', 'alive_at_1h', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'alive_at_4h', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'alive_at_24h', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'hits_5x_within_24h', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'hits_10x_within_24h', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'hold_1h_pct', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'hold_4h_pct', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'hold_24h_pct', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'peak_pct_within_24h', `REAL`);
  ensureCol(d, 'ml_mint_snapshots', 'max_drawdown_within_24h_pct', `REAL`);

  // Phase C sentiment features (added 2026-05-13). Each snapshot reads from
  // mint_sentiment for the current 4h window and stores the bull/bear/shill
  // counts + total mentions + avg confidence. NULL when no mentions exist
  // (model handles NaN natively as a split signal — "no social attention"
  // is itself information).
  ensureCol(d, 'ml_mint_snapshots', 'sentiment_bull_4h', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'sentiment_bear_4h', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'sentiment_shill_4h', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'sentiment_total_4h', `INTEGER`);
  ensureCol(d, 'ml_mint_snapshots', 'sentiment_avg_confidence', `REAL`);

  // Per-mint Telegram cache so the snapshot sweeper doesn't re-fetch on
  // every snapshot age. Worker fetches once per mint with a long TTL; the
  // snapshot just reads the cached value.
  d.exec(`CREATE TABLE IF NOT EXISTS telegram_members (
    mint_address TEXT PRIMARY KEY,
    telegram_url TEXT,
    chat_id TEXT,
    member_count INTEGER,
    fetched_at INTEGER NOT NULL,
    fetch_status TEXT,
    error_message TEXT
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_tg_fetched ON telegram_members(fetched_at DESC)`);

  // Per-mint cache of the creator's parsed Helius history at launch time.
  // Pre-aggregated stats — raw_summary kept for debugging. TTL handled at
  // read time (skip cache > 60 min stale).
  d.exec(`CREATE TABLE IF NOT EXISTS creator_activity_cache (
    mint_address TEXT PRIMARY KEY,
    creator_wallet TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    sol_to_sidewallets REAL,
    sidewallet_buyer_count INTEGER,
    fetch_status TEXT,
    raw_summary TEXT
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_creator_activity_creator ON creator_activity_cache(creator_wallet)`);

  // Known non-human addresses — DEX programs, CEX hot wallets, aggregators,
  // bridges, etc. Used to filter sidewallet candidates so we don't flag
  // protocol infrastructure as suspicious dev sidewallets. Seeded from
  // src/data/known-addresses.js on startup; runtime-added rows (source != 'seed')
  // are preserved across re-seeds.
  d.exec(`CREATE TABLE IF NOT EXISTS known_addresses (
    address TEXT PRIMARY KEY,
    name TEXT,
    category TEXT,
    confidence TEXT,
    source TEXT,
    added_at INTEGER DEFAULT (strftime('%s','now') * 1000)
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_known_addresses_category ON known_addresses(category)`);
  // Seed the curated list — re-runs on every init, idempotent. Runtime-added
  // rows (source != 'seed') are left untouched.
  try { seedKnownAddressesTable(d); }
  catch (err) { console.error('[db] known-addresses seed failed:', err.message); }

  // ml_model_history — one row per (target, retrain) capturing validation
  // metrics so we can detect regressions across retrains. Lightweight A/B:
  // we don't run two models in parallel, but we can spot "AUC dropped from
  // 0.82 → 0.71 on this retrain" and decide whether to revert by hand.
  // Populated by retrain_all.py after each successful target train.
  d.exec(`CREATE TABLE IF NOT EXISTS ml_model_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,            -- 'binary' | 'regression'
    trained_at INTEGER NOT NULL,
    n_train INTEGER,
    n_val INTEGER,
    n_pos INTEGER,                 -- positives in train (binary only)
    -- Binary metrics (NULL for regression)
    auc_pr REAL,
    auc_roc REAL,
    brier REAL,
    lift REAL,
    baseline_rate REAL,
    -- Regression metrics (NULL for binary)
    mae REAL,
    median_ae REAL,
    r2 REAL,
    log_transform INTEGER DEFAULT 0,
    -- Misc
    model_path TEXT,
    feature_importances_json TEXT,
    notes TEXT
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_model_history_target ON ml_model_history(target, trained_at DESC)`);

  // webhook_dead_letter — Helius enhanced webhook events that failed to parse.
  // Previously errors were just console.error'd and the event vanished. Now
  // we capture the raw payload + error so we can diagnose schema drift,
  // unexpected event types, or our own bugs. Retention: 7 days (auto-pruned
  // in intelligence-condensate.js).
  d.exec(`CREATE TABLE IF NOT EXISTS webhook_dead_letter (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    event_signature TEXT,
    error_message TEXT,
    raw_event_json TEXT
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_dl_received ON webhook_dead_letter(received_at DESC)`);

  // whale_watch — 10-minute enrollment window for big-initial-buy mints.
  // src/scoring/whale-spawn.js fires a 'whale_spawn' trigger on the first
  // significant dip from peak after the launch sniper phase settles. Was
  // referenced in code (processor.js:153 INSERT, whale-spawn.js prepared
  // statements) but never defined — INSERTs were being swallowed by a too-
  // broad catch, so the whole feature was silently no-op. Define it here.
  d.exec(`CREATE TABLE IF NOT EXISTS whale_watch (
    mint_address TEXT PRIMARY KEY,
    initial_buy_sol REAL NOT NULL,
    seed_price REAL,
    peak_price REAL,
    peak_at INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    fired INTEGER DEFAULT 0,
    fired_at INTEGER
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_whale_watch_active ON whale_watch(expires_at) WHERE fired = 0`);

  // ml_predictions — every model inference logged for audit + calibration.
  // Previously created implicitly via INSERT; centralized here so the table
  // exists even on fresh init before any prediction has fired. Prune cutoff
  // is timestamp-based, so index that column.
  d.exec(`CREATE TABLE IF NOT EXISTS ml_predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    mint_address TEXT NOT NULL,
    prob REAL,
    target TEXT NOT NULL,
    source TEXT,
    cache_hit INTEGER DEFAULT 0,
    features_json TEXT,
    latency_ms INTEGER,
    model_loaded INTEGER DEFAULT 0,
    error TEXT
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_ml_predictions_ts ON ml_predictions(timestamp DESC)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_ml_predictions_mint ON ml_predictions(mint_address, target, timestamp DESC)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_ml_predictions_target ON ml_predictions(target, timestamp DESC)`);

  // friction_log — every paper/live trade's friction breakdown for the dynamic
  // friction model (Phase 1D). Previously created implicitly; centralized so
  // dashboard endpoints can query it before the first trade fires.
  d.exec(`CREATE TABLE IF NOT EXISTS friction_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    position_id INTEGER,
    mint_address TEXT,
    strategy TEXT,
    side TEXT NOT NULL,
    trade_size_sol REAL,
    total_slippage_pct REAL,
    curve_slip_pct REAL,
    vol_drift_pct REAL,
    sandwich_pct REAL,
    priority_fee_sol REAL,
    latency_ms INTEGER,
    v_sol_in_curve REAL,
    was_dynamic INTEGER DEFAULT 0
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_friction_log_ts ON friction_log(timestamp DESC)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_friction_log_strategy_t ON friction_log(strategy, timestamp DESC) WHERE strategy IS NOT NULL`);

  // live_conditions — RPC latency + priority fee + slot time + network status
  // snapshots. Was created lazily inside live-conditions.js at first probe,
  // which meant the prune cycle (which queries this table) could run before
  // the table existed if the live-conditions worker hadn't initialized yet.
  // Move CREATE here so it's guaranteed before anything reads.
  d.exec(`CREATE TABLE IF NOT EXISTS live_conditions (
    timestamp INTEGER PRIMARY KEY,
    rpc_helius_p50 REAL, rpc_helius_p90 REAL, rpc_helius_p99 REAL,
    rpc_public_p50 REAL, rpc_public_p90 REAL, rpc_public_p99 REAL,
    priority_fee_p50 INTEGER, priority_fee_p90 INTEGER, priority_fee_p99 INTEGER,
    slot_time_mean REAL, slot_time_max REAL,
    network_status TEXT,
    rpc_gatekeeper_p50 REAL, rpc_gatekeeper_p90 REAL, rpc_gatekeeper_p99 REAL
  )`);
  // Gatekeeper cols may be missing on DBs older than 2026-05-10 — ensure them.
  ensureCol(d, 'live_conditions', 'rpc_gatekeeper_p50', `REAL`);
  ensureCol(d, 'live_conditions', 'rpc_gatekeeper_p90', `REAL`);
  ensureCol(d, 'live_conditions', 'rpc_gatekeeper_p99', `REAL`);

  d.exec(`CREATE TABLE IF NOT EXISTS volume_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint_address TEXT NOT NULL,
    fired_at INTEGER NOT NULL,
    velocity_ratio REAL,
    current_buys_per_min REAL,
    baseline_buys_per_min REAL,
    unique_buyers INTEGER,
    sol_inflow REAL,
    price_change_pct REAL,
    score REAL,
    has_tracked_overlap INTEGER DEFAULT 0,
    suggested_entry_sol REAL,
    details TEXT
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_volume_signals_mint ON volume_signals(mint_address)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_volume_signals_fired ON volume_signals(fired_at DESC)`);
}
