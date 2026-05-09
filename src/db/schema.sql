CREATE TABLE IF NOT EXISTS mints (
  mint_address TEXT PRIMARY KEY,
  creator_wallet TEXT NOT NULL,
  signature TEXT,
  name TEXT,
  symbol TEXT,
  uri TEXT,
  description TEXT,
  image_uri TEXT,
  twitter TEXT,
  telegram TEXT,
  website TEXT,
  metadata_fetched_at INTEGER,
  initial_buy_sol REAL DEFAULT 0,
  v_sol_in_curve REAL DEFAULT 0,
  v_tokens_in_curve REAL DEFAULT 0,
  peak_market_cap_sol REAL DEFAULT 0,
  current_market_cap_sol REAL DEFAULT 0,
  last_price_sol REAL DEFAULT 0,
  pool TEXT DEFAULT 'pump',
  migrated INTEGER DEFAULT 0,
  migrated_at INTEGER,
  migrated_to TEXT,
  rugged INTEGER DEFAULT 0,
  rugged_at INTEGER,
  flags TEXT DEFAULT '[]',
  trade_count INTEGER DEFAULT 0,
  unique_buyer_count INTEGER DEFAULT 0,
  bundle_buyer_count INTEGER DEFAULT 0,
  last_trade_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mints_creator ON mints(creator_wallet);
CREATE INDEX IF NOT EXISTS idx_mints_created ON mints(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mints_status ON mints(migrated, rugged);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT UNIQUE,
  mint_address TEXT NOT NULL,
  wallet TEXT NOT NULL,
  is_buy INTEGER NOT NULL,
  sol_amount REAL NOT NULL,
  token_amount REAL NOT NULL,
  price_sol REAL,
  market_cap_sol REAL,
  seconds_from_creation INTEGER,
  is_sniper INTEGER DEFAULT 0,
  is_first_block INTEGER DEFAULT 0,
  buyer_rank INTEGER,
  wallet_label TEXT,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint_address, timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(wallet, timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_sniper ON trades(mint_address, is_sniper);

CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_activity_at INTEGER,
  total_sol_in REAL DEFAULT 0,
  total_sol_out REAL DEFAULT 0,
  realized_pnl REAL DEFAULT 0,
  unrealized_pnl REAL DEFAULT 0,
  realized_pnl_30d REAL DEFAULT 0,
  trade_count INTEGER DEFAULT 0,
  trade_count_30d INTEGER DEFAULT 0,
  buy_count INTEGER DEFAULT 0,
  sell_count INTEGER DEFAULT 0,
  sniper_count INTEGER DEFAULT 0,
  sniper_ratio REAL DEFAULT 0,
  first_block_count INTEGER DEFAULT 0,
  first_block_ratio REAL DEFAULT 0,
  position_count INTEGER DEFAULT 0,
  closed_position_count INTEGER DEFAULT 0,
  closed_30d INTEGER DEFAULT 0,
  win_count INTEGER DEFAULT 0,
  loss_count INTEGER DEFAULT 0,
  win_count_30d INTEGER DEFAULT 0,
  win_rate REAL DEFAULT 0,
  win_rate_30d REAL DEFAULT 0,
  best_coin_pnl REAL DEFAULT 0,
  worst_coin_pnl REAL DEFAULT 0,
  avg_hold_seconds INTEGER DEFAULT 0,
  trades_per_position REAL DEFAULT 0,
  graduated_touched INTEGER DEFAULT 0,
  sell_100pct_count INTEGER DEFAULT 0,
  sell_100pct_ratio REAL DEFAULT 0,
  bundle_cluster_id TEXT,
  category TEXT DEFAULT 'NOT_SURE',
  bot_flags TEXT DEFAULT '[]',
  copy_friendly INTEGER DEFAULT 0,
  tracked INTEGER DEFAULT 0,
  tracked_since INTEGER,
  manually_tracked INTEGER DEFAULT 0,
  label TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_wallets_tracked ON wallets(tracked);
CREATE INDEX IF NOT EXISTS idx_wallets_activity ON wallets(last_activity_at DESC);

CREATE TABLE IF NOT EXISTS creators (
  wallet TEXT PRIMARY KEY,
  first_launch INTEGER NOT NULL,
  last_launch INTEGER,
  last_active_at INTEGER,
  launch_count INTEGER DEFAULT 0,
  migrated_count INTEGER DEFAULT 0,
  rugged_count INTEGER DEFAULT 0,
  abandoned_count INTEGER DEFAULT 0,
  avg_peak_mcap REAL DEFAULT 0,
  best_peak_mcap REAL DEFAULT 0,
  avg_cycle_time_seconds REAL DEFAULT 0,
  avg_launch_lifetime_seconds REAL DEFAULT 0,
  days_active REAL DEFAULT 0,
  bundle_overlap_count INTEGER DEFAULT 0,
  reputation_score REAL DEFAULT 0,
  category TEXT DEFAULT 'NEW',
  dev_flags TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS wallet_holdings (
  wallet TEXT NOT NULL,
  mint_address TEXT NOT NULL,
  tokens_bought REAL DEFAULT 0,
  tokens_sold REAL DEFAULT 0,
  sol_invested REAL DEFAULT 0,
  sol_realized REAL DEFAULT 0,
  first_buy_at INTEGER,
  last_activity_at INTEGER,
  is_sniper INTEGER DEFAULT 0,
  is_first_block INTEGER DEFAULT 0,
  buyer_rank INTEGER,
  PRIMARY KEY (wallet, mint_address)
);
CREATE INDEX IF NOT EXISTS idx_holdings_mint ON wallet_holdings(mint_address);
CREATE INDEX IF NOT EXISTS idx_holdings_wallet ON wallet_holdings(wallet);

CREATE TABLE IF NOT EXISTS rug_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint_address TEXT NOT NULL,
  flag_type TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_flags_mint ON rug_flags(mint_address);
CREATE INDEX IF NOT EXISTS idx_flags_fired ON rug_flags(fired_at DESC);

CREATE TABLE IF NOT EXISTS bundle_clusters (
  cluster_id TEXT PRIMARY KEY,
  member_count INTEGER NOT NULL,
  mint_count INTEGER NOT NULL,
  total_realized_pnl REAL DEFAULT 0,
  members TEXT,
  detected_at INTEGER NOT NULL,
  last_updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS copy_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint_address TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  wallet_count INTEGER NOT NULL,
  time_span_seconds REAL,
  tracked_wallets TEXT,
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_copy_signals_mint ON copy_signals(mint_address);
CREATE INDEX IF NOT EXISTS idx_copy_signals_fired ON copy_signals(fired_at DESC);

CREATE TABLE IF NOT EXISTS paper_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint_address TEXT NOT NULL,
  strategy TEXT,
  entry_signal TEXT,
  entry_price REAL NOT NULL,
  entry_sol REAL NOT NULL,
  token_amount REAL NOT NULL,
  entry_mcap_sol REAL DEFAULT 0,
  exit_price REAL,
  exit_mcap_sol REAL,
  exit_reason TEXT,
  realized_pnl_sol REAL,
  realized_pnl_pct REAL,
  unrealized_pnl_sol REAL DEFAULT 0,
  unrealized_pnl_pct REAL DEFAULT 0,
  highest_pct REAL DEFAULT 0,
  status TEXT DEFAULT 'open',
  entered_at INTEGER NOT NULL,
  exited_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_positions_status ON paper_positions(status);

CREATE TABLE IF NOT EXISTS strategy_state (
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
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint_address TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  score REAL,
  details TEXT,
  fired_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_mint ON signals(mint_address);
CREATE INDEX IF NOT EXISTS idx_signals_fired ON signals(fired_at DESC);

-- ML Trading Agent — autonomous proposer/evaluator that generates and runs
-- its own trading strategies based on what it has learned. Strategies are
-- JSON recipes the agent invents via Claude consults; executor evaluates
-- them against live mints and fires paper trades. Agent monitors PnL and
-- can self-modify or retire its own strategies.

CREATE TABLE IF NOT EXISTS ml_agent_strategies (
  id TEXT PRIMARY KEY,                 -- e.g. 'agent_2026-05-08_kol-momentum'
  name TEXT NOT NULL,                  -- agent's chosen name for this strategy
  rationale TEXT,                      -- why the agent thinks this works
  recipe_json TEXT NOT NULL,           -- the full strategy spec
  status TEXT DEFAULT 'live',          -- live | paused | retired
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  retired_reason TEXT,
  -- Lineage: which strategy this evolved from (NULL = first generation)
  parent_strategy_id TEXT,
  generation INTEGER DEFAULT 1,        -- 1 = original, 2 = first child, etc.
  -- Lifetime stats
  n_trades INTEGER DEFAULT 0,
  n_wins INTEGER DEFAULT 0,
  n_losses INTEGER DEFAULT 0,
  realized_pnl_sol REAL DEFAULT 0,
  best_trade_pct REAL DEFAULT 0,
  worst_trade_pct REAL DEFAULT 0,
  last_evaluated_at INTEGER,
  FOREIGN KEY (parent_strategy_id) REFERENCES ml_agent_strategies(id)
);
-- idx_strategies_parent created in runMigrations (after column ensured)

-- Modification history per strategy. Every in-place tweak (SL bumped, threshold
-- adjusted, etc.) writes a row here so the agent + dashboard can show an audit
-- trail. Lineage is for "where did this strategy come from"; modifications is
-- for "how has this strategy evolved while running."
CREATE TABLE IF NOT EXISTS ml_agent_strategy_modifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  field_path TEXT NOT NULL,            -- 'exit.stop_loss_pct' or 'sizing.sol' etc.
  old_value TEXT,
  new_value TEXT,
  reason TEXT,                          -- agent's justification
  source TEXT DEFAULT 'agent',         -- 'agent' | 'manual'
  FOREIGN KEY (strategy_id) REFERENCES ml_agent_strategies(id)
);
CREATE INDEX IF NOT EXISTS idx_strat_mods_strategy ON ml_agent_strategy_modifications(strategy_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_agent_strategies_status ON ml_agent_strategies(status);

-- Full reasoning trail. Every introspection cycle, every consult, every
-- proposal/retirement decision lands here so the user can read what the
-- agent was thinking.
CREATE TABLE IF NOT EXISTS ml_agent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  level TEXT,                          -- info | thought | propose | retire | error | trade
  category TEXT,                       -- introspect | consult | execute | monitor
  strategy_id TEXT,                    -- nullable — only set if log is about a specific strategy
  message TEXT,                        -- human-readable summary
  data_json TEXT                       -- structured payload (whatever's relevant)
);
CREATE INDEX IF NOT EXISTS idx_agent_log_ts ON ml_agent_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_agent_log_strategy ON ml_agent_log(strategy_id);

-- Single-row table holding agent's overall state — readiness assessment,
-- last cycle time, why it isn't (or is) ready to act.
CREATE TABLE IF NOT EXISTS ml_agent_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT DEFAULT 'observing',     -- observing | ready | active | error
  readiness_json TEXT,                 -- per-criterion readiness breakdown
  last_cycle_at INTEGER,
  last_consult_at INTEGER,
  consults_today INTEGER DEFAULT 0,
  consult_day_key TEXT,                -- 'YYYY-MM-DD' for daily reset
  current_thought TEXT,                -- short one-liner: what is the agent doing right now
  updated_at INTEGER
);
INSERT OR IGNORE INTO ml_agent_state (id, status, current_thought, updated_at)
VALUES (1, 'observing', 'agent has not started yet', 0);

-- Migration snapshots — captured the moment a mint graduates to AMM.
-- Mirrors ml_mint_snapshots but for post-migration ML. Pre-mig features
-- (proven graduator?) + initial AMM state. Labels resolve after 24-72h:
-- did it 2x post-mig? hit $1M mcap? rug? still alive?
--
-- This is the second ML domain — we already train on pre-migration outcomes
-- (peaked_30/100/300, will_die_fast). Post-migration is a NEW game with its
-- own dynamics, deserves its own models.
-- Migration snapshots — multi-age time series of a mint's day post-migration.
-- Mirrors ml_mint_snapshots's age-based design but for post-migration tracking.
-- Each (mint, age) row captures features AT that age; labels resolve once
-- the 24h horizon has passed and live on the age=0 anchor row.
--
-- Snapshot ages (minutes post-migration):
--   0     = at migration moment (pre-mig features + initial AMM state)
--   30    = first 30 min — early dump or breakout window
--   60    = first hour — establishing trend
--   360   = 6 hours — momentum confirmation
--   720   = 12 hours — sustained interest
--   1440  = 24 hours — final outcome
CREATE TABLE IF NOT EXISTS ml_migration_snapshots (
  mint_address TEXT NOT NULL,
  snapshot_age_min INTEGER NOT NULL,    -- 0, 30, 60, 360, 720, 1440
  migrated_at INTEGER NOT NULL,
  snapshot_ts INTEGER NOT NULL,          -- when this row was captured
  -- === FEATURES AT THIS AGE ===
  -- Common across all ages
  current_mcap_sol REAL,
  current_price_sol REAL,
  liquidity_usd REAL,
  amm_volume_h1_usd REAL,
  amm_volume_h24_usd REAL,
  amm_buys_h24 INTEGER,
  amm_sells_h24 INTEGER,
  amm_price_change_h1 REAL,
  amm_price_change_h24 REAL,
  -- Window-relative: trades in this snapshot's window (since prev snapshot)
  window_buys INTEGER,
  window_sells INTEGER,
  window_unique_buyers INTEGER,
  window_tracked_buyers INTEGER,
  window_kol_buyers INTEGER,
  -- Cumulative since migration
  pct_from_migration REAL,               -- (current - mig_anchor) / mig_anchor
  peak_pct_so_far REAL,                  -- best % seen so far
  -- === AGE=0 SNAPSHOT ONLY: pre-mig features + initial state ===
  pre_mig_age_min REAL,
  pre_mig_peak_mcap_sol REAL,
  pre_mig_unique_buyers INTEGER,
  pre_mig_trade_count INTEGER,
  pre_mig_buy_count INTEGER,
  pre_mig_sell_count INTEGER,
  pre_mig_buy_sell_ratio REAL,
  pre_mig_tracked_buyers INTEGER,
  pre_mig_kol_buyers INTEGER,
  pre_mig_bundle_buyers INTEGER,
  pre_mig_volatility_pct REAL,
  pre_mig_sandwich_risk REAL,
  pre_mig_creator_launches INTEGER,
  pre_mig_creator_migrations INTEGER,
  has_twitter INTEGER,
  has_telegram INTEGER,
  has_website INTEGER,
  name_length INTEGER,
  symbol_length INTEGER,
  migration_hour_utc INTEGER,
  migration_dow INTEGER,
  amm_initial_liquidity_usd REAL,
  amm_dex TEXT,
  amm_pool_address TEXT,
  pre_mig_intel_verdict TEXT,
  -- === LABELS — resolved at 24h+, stored on ALL age rows for easy joins ===
  post_mig_peak_mcap_sol REAL,
  post_mig_peak_pct REAL,
  post_mig_hits_2x INTEGER,
  post_mig_hits_5x INTEGER,
  post_mig_hits_10x INTEGER,
  post_mig_hits_1m_usd INTEGER,
  post_mig_rugs_1h INTEGER,
  post_mig_alive_24h INTEGER,
  post_mig_alive_72h INTEGER,
  post_mig_volume_24h_usd REAL,
  post_mig_max_liquidity_usd REAL,
  labels_resolved_at INTEGER,
  PRIMARY KEY (mint_address, snapshot_age_min)
);
CREATE INDEX IF NOT EXISTS idx_migsnap_migrated ON ml_migration_snapshots(migrated_at DESC);
CREATE INDEX IF NOT EXISTS idx_migsnap_unresolved ON ml_migration_snapshots(labels_resolved_at) WHERE labels_resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_migsnap_age ON ml_migration_snapshots(snapshot_age_min);

-- Anomaly detector. Rolling-window comparisons to baseline. When something
-- unusual happens (mint volume spike, tracked-cohort cluster, dormant creator
-- waking, theme cluster spawning), surface it for the agent's context.
CREATE TABLE IF NOT EXISTS anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,                  -- 'mint_volume_spike' | 'tracked_cohort' | 'dormant_creator' | 'theme_cluster' | 'bundle_reactivation'
  severity TEXT,                        -- 'info' | 'watch' | 'high'
  subject TEXT,                         -- mint/wallet/theme/etc.
  description TEXT,
  data_json TEXT,                       -- full event payload
  expires_at INTEGER                    -- when to drop from "active" view
);
CREATE INDEX IF NOT EXISTS idx_anomalies_ts ON anomalies(ts DESC);
CREATE INDEX IF NOT EXISTS idx_anomalies_active ON anomalies(expires_at, kind);

-- Daily intelligence condensate. Before pruning bulky raw tables (trades,
-- predictions), nightly job rolls up the meaningful aggregates here. This is
-- the agent's long-term memory — what was the state of the world on day X.
CREATE TABLE IF NOT EXISTS daily_intelligence (
  date_key TEXT PRIMARY KEY,           -- YYYY-MM-DD (local)
  ts INTEGER NOT NULL,                  -- when condensate was computed
  mints_created INTEGER,
  mints_migrated INTEGER,
  trades_total INTEGER,
  unique_traders INTEGER,
  -- Outcome rates from labeled snapshots (the population's day)
  pop_peaked_30_rate REAL,
  pop_peaked_100_rate REAL,
  pop_peaked_300_rate REAL,
  pop_migration_rate REAL,
  pop_avg_peak_pct REAL,
  -- Tracked-wallet activity
  tracked_wallet_buys INTEGER,
  kol_buys INTEGER,
  -- Per-strategy daily PnL (JSON map: { strategy_id: pnl_sol })
  per_strategy_pnl_json TEXT,
  -- Top winners that day (JSON array of {mint, name, peak_pct})
  top_winners_json TEXT,
  -- Top tickers/themes from news + reddit aggregated
  top_themes_json TEXT,
  -- Model snapshot — current AUC/Brier per target at end of day
  model_metrics_json TEXT,
  -- Cultural meta if synthesis ran that day
  cultural_summary TEXT,
  -- Trump posts count (high-impact signal)
  trump_post_count INTEGER,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_daily_intel_ts ON daily_intelligence(ts DESC);

-- Shared Claude consult rate limiter. Every subsystem (agent introspection,
-- post-mortem, daily report, calibration review, mint intel) checks this
-- before firing a Claude call. Hard caps per subsystem per day prevent runaway
-- loops or sudden bursts (e.g. 100 closed positions → 100 post-mortems).
CREATE TABLE IF NOT EXISTS ml_agent_rate_limit (
  date_key TEXT NOT NULL,             -- YYYY-MM-DD
  subsystem TEXT NOT NULL,            -- 'agent' | 'post-mortem' | 'daily-report' | 'calib-review' | 'mint-intel'
  count INTEGER DEFAULT 0,
  PRIMARY KEY (date_key, subsystem)
);

-- News + cultural pulse ingestion. Multiple sources (RSS, Reddit, CoinGecko
-- trending, Truth Social, etc.) feed into news_items + trend_signals. The
-- agent reads aggregates from these for its "current cultural moment" view.
CREATE TABLE IF NOT EXISTS news_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,        -- 'rss:CoinDesk' | 'rss:NYT' | 'reddit:r/solana' | etc.
  title TEXT,
  url TEXT UNIQUE,
  summary TEXT,
  ts INTEGER NOT NULL,         -- when published (or fetched)
  relevance_score REAL,
  keywords TEXT                -- JSON array of matched keywords
);
CREATE INDEX IF NOT EXISTS idx_news_ts ON news_items(ts DESC);
CREATE INDEX IF NOT EXISTS idx_news_source ON news_items(source);

-- Trend signals: trending tickers, search keywords, hot mentions
CREATE TABLE IF NOT EXISTS trend_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,        -- 'coingecko-trending' | 'dexscreener-trending' | 'reddit-mentions' | 'lunarcrush' | etc.
  keyword TEXT NOT NULL,       -- ticker, hashtag, or phrase
  score REAL,                  -- source-specific score (rank, mentions, etc.)
  metadata_json TEXT,          -- extra source-specific data
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trend_ts ON trend_signals(ts DESC);
CREATE INDEX IF NOT EXISTS idx_trend_source ON trend_signals(source);

-- Manual user flags — quick "watching today" overrides
CREATE TABLE IF NOT EXISTS manual_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flag TEXT NOT NULL,
  note TEXT,
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  expires_at INTEGER           -- nullable; if set, auto-deactivates
);
CREATE INDEX IF NOT EXISTS idx_flags_active ON manual_flags(active, created_at DESC);

-- Daily/4-hourly synthesis: Claude reads ALL news + trends + flags and writes
-- a "current meta" summary. Agent reads the latest one in its context.
CREATE TABLE IF NOT EXISTS agent_meta_synthesis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  summary TEXT,
  raw_context TEXT,            -- the full input we gave Claude (for audit)
  cost_estimate_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_synthesis_ts ON agent_meta_synthesis(ts DESC);

-- Mint metadata intel — agent's per-mint scam/winner verdicts. Populated by
-- the hourly batch in agent-mint-intel.js. Combined heuristic + Claude review.
CREATE TABLE IF NOT EXISTS ml_mint_intel (
  mint_address TEXT PRIMARY KEY,
  analyzed_at INTEGER NOT NULL,
  source TEXT,                          -- 'heuristic' | 'claude' | 'manual'
  verdict TEXT,                         -- winner | clean | suspicious | ruggy | junk
  confidence REAL,
  signals_json TEXT,                    -- short list of detected patterns
  rationale TEXT
);
CREATE INDEX IF NOT EXISTS idx_mint_intel_analyzed ON ml_mint_intel(analyzed_at DESC);
CREATE INDEX IF NOT EXISTS idx_mint_intel_verdict ON ml_mint_intel(verdict);
