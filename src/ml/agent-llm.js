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

Return your strategy proposal as JSON conforming to the provided schema. Be decisive — this is one strategy, propose it.`;

const RETIRE_SYSTEM_PROMPT = `You are evaluating one of your own active trading strategies. Decide whether to keep it running, modify it, or retire it.

Look at the data: how many trades fired, win rate, realized PnL, recent performance vs initial expectations. Be honest with yourself.

Return JSON: { "decision": "keep" | "retire", "reason": "...", "modifications": null | {...recipe-modifications...} }`;

const RETIRE_DECISION_SCHEMA = {
  type: 'object',
  required: ['decision', 'reason'],
  properties: {
    decision: { type: 'string', enum: ['keep', 'retire'] },
    reason: { type: 'string' },
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
