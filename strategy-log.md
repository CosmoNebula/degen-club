# Strategy Log — Autonomous Iteration

## Guardrails
- Paper only. No live without explicit user approval.
- Freeze + ping user if wallet drops below 5 SOL (50% drawdown).
- Max 1 strategy change per 2 hours.
- Every iteration documented here before deploy.

## V7.4 (2026-05-18 ~03:00 UTC) — Adaptive trail introduced
Recipe: `[[0.10,0.08],[0.25,0.12],[0.80,0.18],[3.00,0.25]]`, SL -35%, max_hold 45.
**Result: -0.47 SOL across 16 closes (12 trail, 4 SL).**
Diagnosis:
- **+10% / 8% bucket is structurally unprofitable.** Fires at peak-8% = ~+2% from entry. Pump.fun friction (7-12%) makes every fire in this bucket a net loss. All 3 sub-+10% trail fires in last batch were -2.1%, -2.8%, -6.0%.
- **SL overshoots by 8-22 points.** Target -35%, actual fills averaged -49%. Volatility + confirmation delay during fast dumps eats the buffer.
- **Backtest mistake**: `/tmp/exit-backtest-v3.py` `sim()` has zero friction model — gross PnL, not net. The +1.4 SOL "winner" was overstated.

## V7.5 (2026-05-18 ~03:40 UTC) — Drop bottom bucket, tighten SL trigger
Hypothesis: skip the friction-loss zone, let actual SL fills land near the original -40% target.
Recipe:
```
adaptive_trail = [
  [0.20, 0.10],   # peak ≥ +20% → retrace 10% (sell at peak-10%, ~+12% from entry on median)
  [0.50, 0.15],   # peak ≥ +50% → retrace 15%
  [1.50, 0.20],   # peak ≥ +150% → retrace 20%
  [5.00, 0.25],   # peak ≥ +500% → retrace 25%
]
SL: -30% (anticipating -42% actual fill)
max_hold: 45 min
```
Expectation: fewer trail fires (only mints peaking ≥+20%), but each fire net positive after friction. SL fills should match the original V7 risk profile.
