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
