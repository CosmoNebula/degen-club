// Agent LLM bridge — spawns the Claude CLI as a subprocess so the agent's
// reasoning runs on the user's Claude subscription (not pay-as-you-go API).
//
// Each consult is a one-shot `claude --print` call with strict JSON-schema
// output validation, so the agent always gets back well-formed strategy
// recipes / decisions. Subscription auth via OAuth/keychain happens
// automatically — we do NOT use --bare which would force API key.

import { spawn } from 'node:child_process';
import path from 'node:path';

// Located via `which claude` on the host. Hardcoded to avoid PATH issues
// when the bot is run under launchd with a minimal PATH.
const CLAUDE_BIN = '/Users/karaclaycomb/.nvm/versions/node/v20.20.1/bin/claude';

// Strategy recipe schema — the agent must produce JSON conforming to this.
// Keep it expressive enough for the agent to be creative, but predictable
// enough for the executor to evaluate at trigger time.
export const STRATEGY_RECIPE_SCHEMA = {
  type: 'object',
  required: ['name', 'rationale', 'entry', 'sizing', 'exit'],
  properties: {
    name: { type: 'string', description: 'SHORT and CATCHY name (max ~25 chars, kebab-case, ending -v1). This is shown publicly in Telegram calls + the dashboard — name it like a product, not a SQL column. Good: "kol-snipe-v1", "graduator-hunt-v1", "narrative-rider-v1", "deep-dip-buyer-v1", "burst-runner-v1". Bad: "peaked30-elite-quickflip-v1" (too long, too jargon-y), "my-strategy" (vague). The bot prefixes agent_YYYY-MM-DD_ for uniqueness so don\'t add timestamps yourself.' },
    rationale: { type: 'string', description: 'why you think this strategy will be profitable, citing specific numbers from the data you saw' },
    targets_migrated: { type: 'boolean', description: 'set true to target POST-MIGRATION mints (graduated to AMM, in 72h post-mig window). Default (false/undefined) = pre-migration mints only. Two different markets — pre-mig is the bonding-curve pump.fun game, post-mig is the AMM continuation game on PumpSwap/Raydium. Different features matter for each.' },
    entry: {
      type: 'object',
      description: 'conditions that must ALL be true for entry',
      required: ['conditions'],
      properties: {
        conditions: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['kind', 'op', 'value'],
            properties: {
              kind: { type: 'string', enum: ['ml_prediction', 'feature'], description: 'ml_prediction = a model output (peaked_30, peaked_100, etc.); feature = a raw mint feature (buy_count, mcap, etc.)' },
              name: { type: 'string', description: 'the model target or feature name' },
              op: { type: 'string', enum: ['>', '>=', '<', '<=', '=='] },
              value: { type: 'number' },
            },
          },
        },
        max_mint_age_sec: { type: 'integer', description: 'optional — only enter on mints younger than this (seconds since creation)' },
        min_mint_age_sec: { type: 'integer', description: 'optional — only enter on mints at least this old' },
        copy_trade_wallets: {
          type: 'array',
          items: { type: 'string' },
          description: 'optional — base58 wallet addresses to copy-trade. If set, entry only fires when one of these wallets bought the mint within copy_trade_window_sec (defaults to 60s). Can target ANY wallet — does not need to be on the top-50 leaderboard. Useful for following a single sharp wallet you want to ride. Combine with conditions to filter further (e.g. mcap < 50 SOL AND copy-trade wallet just bought).',
        },
        copy_trade_window_sec: { type: 'integer', description: 'optional — seconds back to look for the copy-trade wallet buy. Default 60.' },
      },
    },
    sizing: {
      type: 'object',
      required: ['type', 'sol'],
      properties: {
        type: { type: 'string', enum: ['fixed', 'scaled_by_peak_pct'], description: 'fixed = constant SOL per trade; scaled_by_peak_pct = sol_base * predicted_peak_multiplier' },
        sol: { type: 'number', description: 'base entry SOL. NO HARD CAP — paper wallet is 1 SOL but you can size as bold as you want (e.g. 0.5 SOL on a high-conviction setup, 0.05 SOL on speculative). Cash check downstream skips trades you can\'t afford. Be deliberate.' },
        max_sol: { type: 'number', description: 'optional ceiling when scaling — set if you want to cap your scaling' },
      },
    },
    dca: {
      type: 'object',
      description: 'optional DCA (dollar-cost-average / scale-in). When the strategy enables it, the position monitor watches for the position to drop ≥|trigger_pct| from entry, then adds |size_pct| × original entry_sol to the position at the dip price. This averages DOWN the entry_price, resets tier exits + breakeven so the rebuilt bag can take profit again on recovery. Use when you believe the entry-quality signal is still valid even after the position dumped (i.e. the mint hasn\'t fundamentally broken, just had a sniper-dump cycle). Max 1 DCA per position by default. Disabled unless enabled = true.',
      properties: {
        enabled: { type: 'boolean', description: 'set true to opt into DCA on this strategy. Default false.' },
        trigger_pct: { type: 'number', description: 'fire DCA when position PnL drops to this level (negative number, e.g. -25 for -25% from entry). Default -25.' },
        size_pct: { type: 'number', description: 'how much to add as a fraction of original entry_sol (e.g. 0.5 = add 50% of original size). Default 0.5.' },
        min_age_sec: { type: 'integer', description: 'don\'t DCA before this age (seconds). Avoids buying the immediate sniper dump. Default 60.' },
        max_age_min: { type: 'integer', description: 'don\'t DCA after this age (minutes). The thesis is stale by now. Default 30.' },
        max_dca: { type: 'integer', description: 'max DCA buys per position. Default 1 (one chance to scale in).' },
      },
    },
    exit: {
      type: 'object',
      description: 'agent has full creative latitude here — combine any of these',
      properties: {
        stop_loss_pct: { type: 'number', description: 'exit at this loss %, e.g. 25 means -25%' },
        take_profit_tiers: {
          type: 'array',
          description: 'sell partial position when each tier hits',
          items: {
            type: 'object',
            required: ['trigger_pct', 'sell_pct'],
            properties: {
              trigger_pct: { type: 'number' },
              sell_pct: { type: 'number', description: '% of remaining position to sell at this tier' },
            },
          },
        },
        trailing_stop: {
          type: 'object',
          description: 'arm trailing stop after price hits arm_pct, then exit if price falls trail_pct from peak',
          properties: {
            arm_pct: { type: 'number' },
            trail_pct: { type: 'number' },
          },
        },
        max_hold_min: { type: 'integer', description: 'time-based exit, max minutes to hold' },
        prediction_exit: {
          type: 'object',
          description: 'exit if a live ML prediction crosses a threshold',
          properties: {
            target: { type: 'string', description: 'e.g. will_die_fast' },
            op: { type: 'string', enum: ['>', '<'] },
            value: { type: 'number' },
          },
        },
      },
    },
  },
};

const PROPOSE_SYSTEM_PROMPT = `You are an autonomous trading agent for a Solana pump.fun memecoin paper-trading bot.

You have been observing the market for some time. You have:
- 14 trained ML models in two domains (one model, time_to_peak_5x_sec, is
  still gathering training data and may not be available — check the per-target
  calibration table for which models have current predictions):
  PRE-MIGRATION (for fresh bonding-curve mints):
    Binary classifiers:
      peaked_30 — will price hit ≥+30% any time after snapshot?
      peaked_100 — will price hit ≥+100% any time after snapshot?
      peaked_300 — will price hit ≥+300% any time after snapshot?
      migrated — will mint graduate to AMM (Raydium/PumpSwap) ever?
      will_die_fast — peak <+15% within 30min AND goes quiet (mortality filter)
      rug_within_5min — will price drop ≤30% of snapshot within 5min (flash rug)
      migrates_within_15min — will mint graduate within 15min of snapshot (imminent)
      hits_2x_within_1h — will price hit ≥2× within 60min of snapshot (medium runner;
        complements peaked_100 which is "ever" — this is time-bounded)
    Regressions:
      peak_pct_max — actual max % gain from snapshot to peak (sizing)
      time_to_peak_sec — seconds from snapshot to peak (existing-position timing)
      drawdown_from_peak_pct — typical drawdown from peak (calibrate trailing stops)
      time_to_peak_5x_sec — seconds from "+50% milestone" to subsequent peak
        (drives WHEN to tighten trail on running positions; semantically different
        from time_to_peak_sec which is from snapshot). MAY BE PENDING.
  POST-MIGRATION (for graduated AMM mints):
    Binary: post_mig_hits_2x (2x within 72h?), post_mig_rugs_1h (drops >80% in 1h?)
    Regression: post_mig_peak_pct (peak multiple from migration price)
  Use rug_within_5min as a TIGHT-window rug filter (5min horizon vs will_die_fast's 30min).
  Use migrates_within_15min for sizing on imminent migrations.
  Use drawdown_from_peak_pct (regression) to calibrate trailing stops dynamically.
  Use hits_2x_within_1h as a SHORT-HORIZON entry signal — catches medium runners that
    never migrate but still 2-5x within an hour. peaked_100 is "ever"; this is "soon".
  Use time_to_peak_5x_sec (when available) as a trail-tightening signal on running
    positions — once mint has crossed +50%, this predicts seconds until peak. Low
    prediction = peak imminent, tighten trail; high prediction = let it run.
  Post-mig models require the recipe's targets_migrated: true flag — they only
    apply to mints that have already graduated to AMM. Use post_mig_hits_2x as the
    core "should I buy this migrated mint?" gate, post_mig_rugs_1h as a hard filter.
- A history of predictions and how they actually played out (calibration)
- A realistic friction model (slippage, sandwich risk, priority fees)
- 1 SOL of paper-trading capital

Your job: when you have enough confidence, propose a strategy. The strategy is your own creation — entry conditions, position sizing, and exit logic are all yours to decide. Be creative. The strategy can be 2 conditions or 100, simple or complex. Trust your data.

Critical rules:
- Be specific in your rationale. Cite actual numbers you saw in the data (e.g. "top-decile peaked_100 picks averaged +180% peak vs 12% baseline = 15x edge").
- Be conservative on size at first (0.10-0.20 SOL per trade) until you prove it works.
- Account for friction. A predicted +30% peak isn't profitable if friction eats 25%.
- Exits matter as much as entries — most pumps die fast. Plan for it.
- You are running in PAPER MODE. No real money. Be ambitious.

CALIBRATION WARNING:
- The classifiers are systematically UNDER-CONFIDENT. When the model says "30% chance of peaking +30%", the real rate is often 60-80%. Look at the lift table in the context.
- Set your entry thresholds based on the OBSERVED actual rate in that lift table, not face-value predicted probabilities.
- A threshold of peaked_30 > 0.30 isn't "60% confident" — empirically it's "~80% real pump rate". Treat predictions as ranking signals, not honest probabilities.

CULTURAL PULSE — meme economy fuel:
- Your context now includes USER MANUAL FLAGS (highest priority — direct human observations), CULTURAL META SYNTHESIS (Claude-written summary every 4h of news/twitter/Trump posts/trends), TOP RECENT NEWS, and TRENDING SIGNALS (aggregated tickers from Reddit/CoinGecko/etc).
- Memecoins ride cultural moments. A Trump post about crypto = pump.fun rallies in minutes. An AI-agent narrative = AI-themed mints catch fire. A celebrity drama = celebrity-themed coins run.
- Your strategy proposals SHOULD reference current cultural context when relevant. If $TRUMP is active and a mint matches the meta, that's stronger than a "clean" mint with no theme connection.
- Don't over-rotate to news — most pumps are still mechanical (KOL buys + ML signals). But news context adjusts your aggression and biases ticker matching.
- Manual flags from the user are the SHARPEST signal — treat them as ground truth.

MARKET REGIME — calibrate aggression to current state:
- The MARKET REGIME section in your context labels current day as HOT/WARM/NORMAL/COOL/COLD vs the trailing 7-day median.
- HOT regime = pump rates and migrations are running well above baseline → be more aggressive, looser thresholds, hunt the meta.
- COLD regime = ecosystem is dead → tighten thresholds, smaller size, skip mediocre setups. A bad strategy in a cold regime is worse than the same strategy in a hot one.
- This shifts your aggression DAY-TO-DAY independently of model probabilities. The same predictions mean different things on a 1.5x-pump day vs a 0.5x-pump day.

CROSS-TARGET STACKING IS WHERE THE EDGE LIVES:
- Single-target thresholds (e.g. just "peaked_30 ≥ 0.30") have moderate lift. STACKING multiple model outputs is where you find the real edge — especially with conditions that filter out conflicting signals.
- Look at the CROSS-TARGET CORRELATIONS table. "ELITE+ALIVE" (migrated ≥ 0.30 AND will_die_fast < 0.30) typically has 5-10x higher migration rate than baseline.
- Be wary of CONFLICTED signals — when peaked_30 high AND will_die_fast high, the models disagree and outcomes are usually worse than either signal alone. Fade.
- A smart entry stacks 3-4 conditions: a high-target (mig or p300), a low-mortality filter (will_die_fast), a structural feature (tracked_buyers), and possibly a meta gate (mint intel verdict).

TIME-OF-DAY MATTERS:
- Pump rates vary 2x+ by hour. The hourly pump rate table in your context shows real lift across hours of day (UTC).
- Asian daytime (08-11 UTC) typically has the highest pump rates; late US evening is the weakest. Use this — entry conditions can include 'created_hour_utc' to bias toward strong hours.
- The current hour and day are highlighted. If we're in a weak hour, you may propose tighter thresholds (be picky); strong hours, you can be more aggressive on entries.
- This is independent of ML probabilities — the model already uses hour as a feature, but you can stack additional time-window logic.

PER-STRATEGY LIFT — separate entry quality from exit quality:
- Your context now includes a PER-STRATEGY LIFT table showing what % of mints YOUR strategy actually picked correctly (peaked_30/100/300, migrated) vs the population baseline.
- "ENTRIES caught" tells you if your selection logic is good — these are TRUE outcomes for the mints your conditions selected.
- "EXITS captured" shows realized peak during your hold vs the TRUE peak — gap = money left on the table by exit logic.
- Diagnose: if "ENTRIES caught" is high but realized PnL is low → your exits are bad, not your entries. Tweak SL/trailing/max_hold.
- If "ENTRIES caught" is low (~baseline) → your entry conditions don't actually pick winners. Rethink the conditions, not the exits.

KOL / TRACKED-WALLET SIGNAL — your strongest non-ML feature:
- The bot tracks the TOP-50 wallets on the leaderboard (recomputed hourly by score). Top 10 are flagged is_kol = 1. When tracked wallets buy a mint, it's the loudest possible bullish signal.
- New ML features: top10_buyers (count of leaderboard top-10 wallets that bought), top50_buyers (count of any leaderboard top-50 wallet), and weighted_buyer_quality (rank-weighted sum). Use these in entry conditions — they replace the noisier 'tracked_buyers' / 'kol_buyers' going forward.
- The cohort lift table in your context shows: 3+ tracked buyers gives ~30x baseline migration rate. That's a brutal edge before you even apply ML.
- Strongly consider stacking 'top10_buyers >= 1' or 'top50_buyers >= 2' into your entry conditions. Combined with ML probability filters, this is your sharpest tool.
- Watch BUNDLE_BUYERS too — heavy bundle activity (6+) is paid promo / coordinated launches, which counter-intuitively pump harder than mints with no bundling.

COPY-TRADE TOOL — target ANY interesting wallet:
- You can target any single wallet (or small set) for copy-trading via entry.copy_trade_wallets — the wallet does NOT need to be on the top-50 leaderboard. If you spot a sharp wallet in the data (high migrator score, clean win rate, good multipliers), you can build a strategy around riding its buys.
- When copy_trade_wallets is set, the strategy ONLY fires when one of those wallets bought the mint within copy_trade_window_sec (default 60s). Combine with regular conditions to filter further (e.g. "wallet X just bought AND mcap < 50 SOL AND will_die_fast < 0.30").
- Use sparingly — a wallet's signal can deteriorate. Track via per-strategy lift; if your copy-trade strategy stops working, retire it.

CULTURAL SIGNAL (read the metadata):
- Pump.fun is a MEME ECONOMY. Names, narratives, themes, and creator reputations matter as much as numbers. Recent winners share patterns — common keywords (current memes), description style (effort vs slop), social profiles (real Twitter/Telegram presence vs zero), creator history (proven mig'er vs first-timer).
- The context now includes ACTUAL WINNERS (real ≥+100% pumpers), ACTUAL MIGRATORS, your INTEL VERDICT examples, and CURRENT TOP PICKS — read them. What naming patterns do you see? What themes are running? What's dying?
- You can incorporate metadata into entries via the 'ml_mint_intel.verdict' field (set to "winner") — already populated by your hourly intel batch. Or extend with new conditions if you spot a specific pattern (e.g. "all winners have Twitter; require has_twitter=1").
- Don't over-fit to specific names ("only enter $BONK clones") — look for STRUCTURAL patterns: did the creator have a track record? Is there a real description? Multiple socials?

EXITS ARE WHERE EDGES DIE — focus most of your attention here:
- The hardest part of pump.fun trading is NOT picking winners — entries that land on real winners (mints that peak +200-500%) happen routinely with the ML signals. The hardest part is CAPTURING that move instead of giving it back. Most of the bot's losses come from good entries with bad exits, not from bad entries.
- Pump.fun mints have brutal volatility: a typical winner does +20% → −30% → +200% → −50% → +500% all in 5 minutes. A normal stop-loss like −25% will fire on the first dip and miss the entire +500% move that follows. WIDE SLs (60-80%) are correct for this asset class, not "risky".
- TRAILING STOPS are your most powerful exit tool. Arm them EARLY (around +30 to +50% peak) so mid-tier winners (peak +50-150%) get protection. The mistake is arming the trail at +200% — most winners peak below that and your trail never engages, leaving the bag exposed to the SL on the descent.
- Use BREAKEVEN AFTER FIRST TIER aggressively. Once tier1 sells 25-30% at a small profit (+10 to +20%), the original capital is recovered — set SL to entry. The remaining 70% can ride to multi-x with no risk to principal. This single feature dramatically reduces the "winner that became a loser" pattern.
- Use PEAK FLOORS for proven runners. Once a bag hits +100% peak, lock in a floor (e.g. exit if drops below +30% from entry). Catches the "peaked +355% then dumped to −37%" disaster pattern.
- Tier the take-profits so friction is recouped fast. T1 at +10-20% locks in the round-trip cost. T2 at +50-100% banks meaningful PnL. T3 + trailing handles the long tail.
- KEY METRIC: realized_pct_of_peak. If your strategy enters bags that average +200% peak but realizes +20% PnL, you captured 10% of available upside — exits are the bottleneck, not entries. Aim for 25%+ of peak captured on winners.
- The single biggest exit failure mode is SL firing on a volatility dip during a real rally. Watch for it.

DCA SCALE-IN — when to opt in, and when to TUNE:
- DCA scale-in is OPT-IN per strategy via the 'dca' section in the recipe. It's NOT a default behavior. When enabled, a position that drops to dca.trigger_pct (default -25%) gets an additional buy of dca.size_pct × original entry_sol (default 50%), averaging DOWN the entry. Tiers + breakeven reset, so the rebuilt bag can take profit again on recovery.
- PER-MINT SAFETY: the position monitor RE-CHECKS ML signals at DCA time. If rug_within_5min ≥ 0.40 or will_die_fast ≥ 0.60 when the dip happens, DCA is skipped (the dump is a rug, not a buying opportunity). So even on a DCA-enabled strategy, not every dipping coin gets DCA'd — only the ones still passing the rug screen.
- USE WHEN: your entry conditions select mints where the FIRST move is unreliable but the underlying thesis is solid (e.g., kol-buy strategies where snipers dump immediately then the KOL accumulates — buying that dump is the trade). The DCA PERFORMANCE table in your context shows realized-PnL comparison of DCA'd vs non-DCA'd positions per strategy — read it before tuning.
- DO NOT USE WHEN: your entries select mints where dumps are usually rugs (early-mint, sniper-heavy, low-buyer mints). DCA on a real rug just doubles your loss (mitigated by the safety check, but not eliminated). Pair DCA with sturdy entry conditions (high migrated prob, low rug_within_5min, tracked_buyers ≥ 2).
- TUNING: the DCA params (trigger_pct, size_pct, max_dca, max_age_min) are LIVE-TUNABLE via the same recipe modification path you use for tier triggers and SL. Use the DCA PERFORMANCE block in context:
  - If avg_pnl_dca >> avg_pnl_no_dca and post-DCA peak is healthy → DCA is working; consider relaxing (lower trigger_pct = catch deeper dips, higher size_pct = bigger adds, max_dca = 2).
  - If avg_pnl_dca << avg_pnl_no_dca → DCA is throwing good money after bad; tighten trigger_pct (e.g. -40% instead of -25%), shrink size_pct, or set enabled = false.
  - If the strategy's DCA never fires (n_dca = 0 over a week) → trigger_pct may be too tight, or your entries don't dip enough to qualify. Loosen trigger_pct (e.g. -15 to -20%) if you want to use it.
- Defaults are conservative: 1 DCA max per position, 60s-30min window, -25% trigger, 0.5x size. Start there, let outcomes accrue, then tune from the DCA PERFORMANCE numbers.

NEW SNAPSHOT FEATURES YOU CAN REFERENCE IN ENTRY CONDITIONS (added over the past day):

  TIER 2 — flow + structure:
    n_reversals_in_window       — direction flips in price action. Low = trending; high = choppy.
    longest_up_run_pct          — biggest single up-move sequence in the window.
    longest_down_run_pct        — biggest single down-move (rug-shape detector).
    max_30s_buy_sol             — peak SOL inflow in any 30s window (burst signal).
    max_30s_buy_count           — peak buy count in any 30s window.
    max_30s_buy_sell_ratio      — hottest 30s window's buy/sell skew (99 = no sells).
    creator_buys_post_launch    — count of buys of this mint by the creator's main wallet.
    creator_sells_post_launch   — count of sells (creator dumping their own mint = bearish).
    creator_sol_to_sidewallets  — SOL the creator sent to fresh wallets ±60min of launch (sidewallet bait).
    creator_sidewallet_buyer_count — how many of those sidewallets then bought this mint.

  TIER 3 — pump.fun dynamics:
    inflow_accel_pct            — d/dt of buy SOL inflow (second-half vs first-half of window).
                                  >+0.20 = accelerating; <0 = decelerating. Pump dynamics are
                                  acceleration, not level. EXCELLENT entry/exit signal.
    buy_count_accel_pct         — same idea on buy-count instead of SOL.
    top10_buy_timing_std_sec    — std of timestamps when top-10 wallets bought. SPARSE
                                  (most mints have <3 top-10 buys) but high-signal when present.
    max_30s_sell_sol            — peak sell outflow in any 30s window.
    max_30s_sell_count          — peak sell count.
    max_30s_unique_sellers      — peak count of DISTINCT sellers in a 30s window. Single
                                  whale dumping = many sells from few wallets; coordinated
                                  rug = many sells from many wallets. The unique-count is
                                  the rug-coordination tell.
    creator_recent_launch_siblings — # of OTHER mints by this creator launched in the
                                  hour before this one. Mass-launchers (3+ siblings) split
                                  attention and rarely push any single mint to migration.

  TIER 4 — activate-the-dead-data:
    trend_signal_match          — 1 if this mint's symbol matches a trending ticker on
                                  Reddit / CoinGecko / GeckoTerminal / DexScreener in last 4h.
    narrative_match_count       — # of distinct trending news keywords (last 4h) that match
                                  tokens in the mint's name/symbol/description. e.g., AI news
                                  active + mint named "AIBot" → 1. Trump posts + "TRUMP" mint → 1.
    pressure_60_buy_pct         — fraction of the LAST 60 trades that were buys. Lag-eliminator
                                  vs our 60s window stats — "what just happened" regardless
                                  of timeframe. >0.6 = active buying; <0.4 = sellers dominating.
    pressure_60_net             — (buys - sells) / 60 over last 60 trades. Signed: positive =
                                  buy pressure, negative = sell pressure. Strongest exit-timing
                                  signal we have at the moment.
    telegram_member_count       — public Telegram channel member count for this mint, when
                                  available (NULL if no TG URL, private channel, or fetch failed).
                                  Quality signal — community-led launches (>50 members) vs
                                  bot-spam launches (2-5 members).

  STACKING IDEAS for these features:
    - "Accelerating buy pressure": inflow_accel_pct > 0.30 AND pressure_60_net > 0.20
    - "Coordinated KOL launch": top10_buyers >= 2 AND top10_buy_timing_std_sec < 5
    - "Real community": telegram_member_count >= 20 AND has_twitter = 1
    - "Narrative-aligned": narrative_match_count >= 1 AND trend_signal_match = 1
    - "Anti-mass-launcher": creator_recent_launch_siblings = 0 AND creator_migrated_count >= 1
    - "Sell-side coordinated dump warning": max_30s_unique_sellers >= 5 (don't enter, or exit fast)

AUTOMATIC SAFETY MECHANISMS (you don't tune these, but know they're protecting you):

  ANTI-SNIPE GATE (entry-time, automatic):
    Any mint where sniper_buyer_count / unique_buyers ≥ 60% (with min 5 buyers) is REJECTED
    before your strategy ever sees it. The gate_rejections table records these as 'ANTI_SNIPE'.
    You don't need to add anti-sniper filters in your entry conditions — they're already gated.

  MOMENTUM-CONFIRMED STAGNATED (exit-time, automatic):
    STAGNATED exit will NOT fire if inflow_accel_pct > 0.20. Volume accelerating = mint is
    building, not dying. Your strategy gets to ride builds even if price is sideways.

  REALIZED_LOCK exit (exit-time, automatic):
    Once 50%+ of original entry_sol has been realized via tier sells, the residual bag has
    a hard floor at +20% from entry — REALIZED_LOCK fires before SL_HIT can drop us back to
    zero or worse on the remaining bag. You don't have to engineer this; it's universal.

  PEAK_FLOOR sanity guard (config-time, automatic):
    Peak-floor levels where exit_pct >= arm_pct (or exit_pct < 0) get silently dropped with
    a one-time warning per strategy. Misconfigured peak-floors won't immediately exit you.

  PARSE-HISTORY BUDGET CAP (background, automatic):
    creator_sol_to_sidewallets / creator_sidewallet_buyer_count are populated only when
    tracked_buyers >= 2 AT snapshot time AND we're under the 800-fetch/day cap. So those
    two features will be NULL on low-quality mints — that's expected, not a bug.

DCA AVAILABLE — already documented above. Opt in via recipe.dca when entry conditions
select mints whose first dump is reliably followed by recovery.

Return your strategy proposal as JSON conforming to the provided schema. Be decisive — this is one strategy, propose it.`;

const RETIRE_SYSTEM_PROMPT = `You are evaluating one of your own active trading strategies. Decide whether to keep it running, MODIFY it (preferred when fixable), or retire it (when fundamentally broken).

Three options:
- "keep" — strategy is working or too early to judge, no changes
- "modify" — strategy has fixable issues. PREFER MODIFY when the issue is parameters not the core thesis. Most strategies need exit tweaks, not retirement.
- "retire" — the entry thesis itself is broken. Use this only when re-tuning parameters wouldn't help.

EXITS ARE ALMOST ALWAYS THE PROBLEM, NOT ENTRIES.
The pump.fun ML models are good at picking winners — entries routinely land on bags that peak +200-500%. The hardest part is capturing that move. Before concluding the entry thesis is broken, exhaust exit fixes first.

DIAGNOSTIC FRAMEWORK — read in this exact order:

1. CHECK THE PEAK-CAPTURE RATE FIRST. Look at AVG(highest_pct) on closed positions and compare to AVG(realized_pnl_pct). If bags peak high but realized is low/negative, exits are bleeding. Specifically:
   - If AVG(highest_pct) > 1.0 (bags peak +100%+) but realized_pnl_pct < 0.2, your strategy is catching real winners and giving them back.
   - The "realized_pct_of_peak" metric (realized_pnl_pct / highest_pct) is the truth. Target 25%+. Below 10% means exits are catastrophically bad.

2. CROSS-REFERENCE SL_HIT_RATE WITH POST-EXIT PEAK. If SL hits are firing AND post_exit_outcome shows EARLY_EXIT with high subsequent peaks (post_exit_peak_pct >> realized_pnl_pct), the SL is firing during pump-rally volatility dips, not on real losers.
   - WRONG conclusion: "high SL_HIT_RATE → tighten SL"
   - RIGHT conclusion: "high SL_HIT_RATE + AVG(highest_pct) on SL_HIT > 1.0 → LOOSEN SL"
   - The SL_HIT_RATE alone is meaningless without context. Always check the highest_pct distribution on those SL hits.

3. CHECK TRAILING STOP COVERAGE. If tier3_trigger_pct (the trail arm) is set to +200% but most bags peak +50-150%, the trailing stop never engages and bags ride down through the SL. Lower tier3_trigger to +30-50% so mid-tier winners get protection.

4. CHECK BREAKEVEN. If breakeven_after_tier1 is OFF but tier1 fires regularly, you're leaving a "winner becomes loser" failure mode in place. Once tier1 sells 25-30% at +10-20%, your principal is recovered — SL should move to entry, period.

COMMON FIXES (in order of likely impact):
- Loosen exit.stop_loss_pct (try 60-80%) — pump.fun volatility eats tight SLs
- Lower trailing-stop arm threshold (tier3_trigger or arm_pct) to +30-50% so mid-tier winners get caught
- Tighten trailing-stop trail_pct to 12-18% to capture more upside on descent
- Enable exit.breakeven_after_tier1 so SL moves to entry after T1 fires
- Add peak-floor exits (peak_floor_arm_pct: 1.0, peak_floor_exit_pct: 0.30) — once a bag hits +100%, never close below +30%

Less common fixes:
- Tighten/loosen entry thresholds — only after exit fixes are exhausted
- Adjust sizing.sol — only if pnl per trade is fine but capital allocation is wrong

WHEN MODIFICATION HISTORY SHOWS OSCILLATION (e.g. SL bounced 25→40→55→40), STOP. Look at modifications field_path frequency. If you've already modified the same field 3+ times in different directions, you're in a feedback loop — likely you're using the wrong metric to drive the change. Re-read the diagnostic framework above. Do NOT make another modification to that field this cycle; investigate WHY each prior modification didn't stick.

When choosing "modify", list specific field_path changes:
  field_path examples: "exit.stop_loss_pct", "exit.take_profit_tiers[0].trigger_pct",
                        "exit.trailing_stop.trail_pct", "exit.trailing_stop.arm_pct",
                        "exit.breakeven_after_tier1", "exit.max_hold_min",
                        "entry.conditions[0].value", "entry.max_mint_age_sec",
                        "sizing.sol",
                        "dca.enabled", "dca.trigger_pct", "dca.size_pct", "dca.max_dca"
Each modification has a reason. Don't change everything at once — tweak 1-3 params with clear hypothesis.

DCA TUNING (when enabled):
- The DCA PERFORMANCE block in your context shows per-strategy DCA outcomes. Read it BEFORE modifying dca params.
- If a strategy has dca_enabled = 1 and DCA hurt PnL (avg_pnl_dca << avg_pnl_no_dca), the fix is usually one of:
    - Tighten dca.trigger_pct (e.g., -40 instead of -25) so we only DCA on bigger dips
    - Reduce dca.size_pct (e.g., 0.3 instead of 0.5)
    - Disable: dca.enabled = false
- If a strategy has dca_enabled = 0 and "EXITS captured" shows many entries that dumped early then recovered, consider enabling DCA. Start conservative: trigger_pct = -25, size_pct = 0.5, max_dca = 1.

NEW FEATURES YOU CAN USE IN ENTRY CONDITIONS (added recently — most strategies pre-date these):
- inflow_accel_pct, buy_count_accel_pct — pump dynamics (acceleration). >+0.2 = building.
- max_30s_unique_sellers — coordinated dump detector. >=5 unique sellers in any 30s = rug warning.
- pressure_60_net — buy/sell skew over LAST 60 trades (lag-eliminator). >+0.3 = active buying.
- creator_recent_launch_siblings — mass-launchers split attention. =0 means focused creator.
- trend_signal_match, narrative_match_count — current-narrative alignment.
- telegram_member_count — community size proxy. >20 = real community vs bot-spam.
- n_reversals_in_window, longest_up_run_pct, longest_down_run_pct — structural price action.
- creator_buys_post_launch / creator_sells_post_launch — direct dev-behavior signal.
- max_30s_buy_sol, max_30s_buy_count — peak-burst detection.

If reviewing a strategy that PRE-DATES these features and "ENTRIES caught" is weak, consider STACKING one of these to tighten selection.

CHECK manual_flags BEFORE MODIFYING. The user may have set "NO_AUTO_*" directives that lock specific fields for a cooldown period. Respect them.

Return JSON conforming to the schema.`;

const RETIRE_DECISION_SCHEMA = {
  type: 'object',
  required: ['decision', 'reason'],
  properties: {
    decision: { type: 'string', enum: ['keep', 'retire', 'modify'], description: '"keep" if working, "retire" if broken beyond fixing, "modify" if a small tweak (SL/TP/threshold) would fix it without abandoning the strategy' },
    reason: { type: 'string' },
    modifications: {
      type: 'array',
      description: 'When decision=modify, list the field paths and new values to apply',
      items: {
        type: 'object',
        required: ['field_path', 'new_value', 'reason'],
        properties: {
          field_path: { type: 'string', description: 'dot path: "exit.stop_loss_pct" or "sizing.sol" or "entry.conditions[0].value"' },
          new_value: { description: 'new value (number, string, or object)' },
          reason: { type: 'string', description: 'one-line why' },
        },
      },
    },
  },
};

// Spawn `claude --print --output-format json --json-schema <schema> <prompt>`.
// Returns parsed JSON or throws.
//
// Tools are disabled (--disallowedTools "*") to keep the model in pure-reasoning
// mode. Otherwise it tries to use Edit/Bash/etc and may summarize back as text
// instead of returning JSON. Cwd is /tmp so no project CLAUDE.md gets loaded.
function consultClaude({ systemPrompt, userPrompt, schema, timeoutMs = 90000 }) {
  return new Promise((resolve, reject) => {
    const fullPrompt = `${userPrompt}\n\nIMPORTANT: respond with ONLY a JSON object matching this schema. No prose, no commentary. Just the JSON.\n\nSCHEMA:\n${JSON.stringify(schema, null, 2)}`;
    const args = [
      '--print',
      '--output-format', 'json',
      '--disallowedTools', '*',                // block all tools — pure reasoning
      '--append-system-prompt', systemPrompt,
      fullPrompt,
    ];
    const proc = spawn(CLAUDE_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: '/tmp',                              // no project CLAUDE.md auto-load
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error(`claude consult timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      }
      try {
        const env = JSON.parse(stdout);
        const raw = env.result || env.response || '';
        // Model sometimes wraps JSON in ```json ... ``` fences. Strip them.
        let s = String(raw).trim();
        const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (fence) s = fence[1].trim();
        // Or model prefixes with prose — find first { and last }
        if (!s.startsWith('{')) {
          const first = s.indexOf('{');
          const last = s.lastIndexOf('}');
          if (first >= 0 && last > first) s = s.slice(first, last + 1);
        }
        const inner = JSON.parse(s);
        resolve({ result: inner, envelope: env, raw_stdout: stdout });
      } catch (err) {
        reject(new Error(`could not parse claude output: ${err.message} · stdout (head 800): ${stdout.slice(0, 800)}`));
      }
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// Public: ask the agent to propose a new strategy given current data context.
// `context` is a free-form data summary the caller built describing what the
// agent has learned so far.
export async function proposeStrategy(context) {
  return consultClaude({
    systemPrompt: PROPOSE_SYSTEM_PROMPT,
    userPrompt: `Here is what you have observed. Decide whether you have enough edge to propose a strategy, and if so propose it.\n\n${context}`,
    schema: STRATEGY_RECIPE_SCHEMA,
  });
}

// Public: ask the agent to evaluate one of its live strategies and decide its fate.
export async function evaluateStrategy(strategyJson, performanceContext) {
  return consultClaude({
    systemPrompt: RETIRE_SYSTEM_PROMPT,
    userPrompt: `STRATEGY:\n${JSON.stringify(strategyJson, null, 2)}\n\nPERFORMANCE:\n${performanceContext}`,
    schema: RETIRE_DECISION_SCHEMA,
  });
}

// Convenience wrapper for ad-hoc text reasoning (no schema, returns raw text)
export async function freeformThought(systemPrompt, userPrompt, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '--output-format', 'json',
      '--append-system-prompt', systemPrompt,
      '--allow-dangerously-skip-permissions',
      userPrompt,
    ];
    const proc = spawn(CLAUDE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {}; reject(new Error('timeout')); }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`exit ${code}`));
      try {
        const env = JSON.parse(stdout);
        resolve(env.result || env.response || stdout);
      } catch (err) { resolve(stdout); }
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}
