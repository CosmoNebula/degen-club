import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db;

export function db() {
  if (!_db) init();
  return _db;
}

export function init() {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  _db = new Database(config.dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
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
  ensureCol(d, 'wallets', 'category', `TEXT DEFAULT 'NOT_SURE'`);
  ensureCol(d, 'wallets', 'bot_flags', `TEXT DEFAULT '[]'`);
  ensureCol(d, 'wallets', 'copy_friendly', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'trades_per_position', `REAL DEFAULT 0`);
  ensureCol(d, 'wallets', 'realized_pnl_30d', `REAL DEFAULT 0`);
  ensureCol(d, 'wallets', 'trade_count_30d', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'closed_30d', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'win_count_30d', `INTEGER DEFAULT 0`);
  ensureCol(d, 'wallets', 'win_rate_30d', `REAL DEFAULT 0`);
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

  ensureCol(d, 'paper_positions', 'tokens_remaining', `REAL DEFAULT 0`);
  ensureCol(d, 'paper_positions', 'sol_realized_so_far', `REAL DEFAULT 0`);
  ensureCol(d, 'paper_positions', 'tiers_hit', `TEXT DEFAULT '[]'`);
  ensureCol(d, 'paper_positions', 'breakeven_armed', `INTEGER DEFAULT 0`);

  d.exec(`UPDATE paper_positions SET tokens_remaining = token_amount WHERE tokens_remaining IS NULL OR tokens_remaining = 0`);
  // Removed: hardcoded-whitelist DELETE that wiped any strategy not in a stale list.
  // It nuked migratorHunter/kingFollow/preKing/quickFlip15 every time init() ran
  // (e.g. when the monitor worker thread opens its own DB connection). Stale rows
  // from removed strategies are harmless — they just sit unused. Remove explicitly
  // via SQL if needed.

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
