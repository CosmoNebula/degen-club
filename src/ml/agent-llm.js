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
    name: { type: 'string', description: 'short name for this strategy (no spaces, lowercase, e.g. kol-momentum-v1)' },
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
- 7 trained ML models predicting outcomes (peaked_30, peaked_100, peaked_300, migrated, will_die_fast, peak_pct_max, time_to_peak_sec)
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
- The bot tracks ~104 wallets with proven migrator-catching history (43 of them flagged as KOLs). When tracked wallets buy a mint, it's the loudest possible bullish signal.
- The cohort lift table in your context shows: 3+ tracked buyers gives ~30x baseline migration rate. That's a brutal edge before you even apply ML.
- Strongly consider stacking 'tracked_buyers >= 2' (or even >= 1) into your entry conditions. Combined with ML probability filters, this is your sharpest tool.
- Watch BUNDLE_BUYERS too — heavy bundle activity (6+) is paid promo / coordinated launches, which counter-intuitively pump harder than mints with no bundling.

CULTURAL SIGNAL (read the metadata):
- Pump.fun is a MEME ECONOMY. Names, narratives, themes, and creator reputations matter as much as numbers. Recent winners share patterns — common keywords (current memes), description style (effort vs slop), social profiles (real Twitter/Telegram presence vs zero), creator history (proven mig'er vs first-timer).
- The context now includes ACTUAL WINNERS (real ≥+100% pumpers), ACTUAL MIGRATORS, your INTEL VERDICT examples, and CURRENT TOP PICKS — read them. What naming patterns do you see? What themes are running? What's dying?
- You can incorporate metadata into entries via the 'ml_mint_intel.verdict' field (set to "winner") — already populated by your hourly intel batch. Or extend with new conditions if you spot a specific pattern (e.g. "all winners have Twitter; require has_twitter=1").
- Don't over-fit to specific names ("only enter $BONK clones") — look for STRUCTURAL patterns: did the creator have a track record? Is there a real description? Multiple socials?

Return your strategy proposal as JSON conforming to the provided schema. Be decisive — this is one strategy, propose it.`;

const RETIRE_SYSTEM_PROMPT = `You are evaluating one of your own active trading strategies. Decide whether to keep it running, MODIFY it (preferred when fixable), or retire it (when fundamentally broken).

Three options:
- "keep" — strategy is working or too early to judge, no changes
- "modify" — strategy has fixable issues. Common fixes: stop_loss_pct too tight (bump 25→40), trailing arm too low, take_profit tiers too aggressive, entry threshold needs raising/lowering. PREFER MODIFY when the issue is parameters not the core thesis.
- "retire" — the entry thesis itself is broken. Use this only when re-tuning parameters wouldn't help (e.g., the model's signal is contaminated, the recipe selects fundamentally bad mints).

Look at the data: trade count, win rate, realized PnL, exit reason breakdown, per-strategy lift table. Be honest.

When choosing "modify", list specific field_path changes:
  field_path examples: "exit.stop_loss_pct", "exit.take_profit_tiers[0].trigger_pct",
                        "exit.trailing_stop.trail_pct", "sizing.sol", "exit.max_hold_min",
                        "entry.conditions[0].value", "entry.max_mint_age_sec"
Each modification has a reason. Don't change everything at once — tweak 1-3 params with clear hypothesis.

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
