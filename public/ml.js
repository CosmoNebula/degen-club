// ML Lab — pulls from /api/ml/quality and renders the full picture.

const REFRESH_MS = 30000;

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function fmtN(n) {
  if (n == null || isNaN(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'K';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}
function fmtPct(p) { return p == null || isNaN(p) ? '—' : (p * 100).toFixed(2) + '%'; }
function fmtRate(p) { return p == null || isNaN(p) ? '—' : (p * 100).toFixed(1) + '%'; }
function fmtNum(n, decimals = 2) {
  if (n == null || isNaN(n)) return '—';
  if (Math.abs(n) >= 1e10) return n.toExponential(2);
  if (Math.abs(n) < 0.001 && n !== 0) return n.toExponential(2);
  return Number(n).toFixed(decimals);
}
function fmtTs(ts) { return ts ? new Date(ts).toLocaleTimeString() : '—'; }

function renderBars(containerId, values, axisId, axisLabels) {
  const c = document.getElementById(containerId);
  if (!c) return;
  const max = Math.max(1, ...values);
  c.innerHTML = values.map((v) => {
    const h = v > 0 ? Math.max(2, (v / max) * 100) : 0;
    return `<div class="bar ${v === 0 ? 'empty' : ''}" style="height:${h}%" title="${v}"></div>`;
  }).join('');
  if (axisId) {
    const ax = document.getElementById(axisId);
    if (ax && axisLabels) ax.innerHTML = axisLabels.map(l => `<span>${l}</span>`).join('');
  }
}

function renderAlerts(alerts) {
  const list = document.getElementById('ml-alerts-list');
  document.getElementById('ml-alerts-count').textContent = alerts.length;
  if (!alerts.length) {
    list.innerHTML = '<div class="ml-alert ml-alert-info">✅ No alerts — system humming</div>';
    return;
  }
  list.innerHTML = alerts.map(a => {
    const cls = a.sev === 'high' ? 'ml-alert-high' : a.sev === 'med' ? 'ml-alert-med' : 'ml-alert-low';
    const icon = a.sev === 'high' ? '🚨' : a.sev === 'med' ? '⚠️' : 'ℹ️';
    return `<div class="ml-alert ${cls}">${icon} ${a.msg}</div>`;
  }).join('');
}

function renderFeatures(features) {
  const tbody = document.getElementById('ml-feature-tbody');
  if (!features || features.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">no features yet</td></tr>';
    return;
  }
  tbody.innerHTML = features.map(f => {
    const healthCls = `ml-health-${f.health}`;
    return `<tr>
      <td><code>${f.name}</code></td>
      <td><span class="ml-health-pill ${healthCls}">${f.health.toUpperCase()}</span></td>
      <td>${f.null_pct.toFixed(1)}%</td>
      <td>${fmtN(f.unique_count)}</td>
      <td>${fmtNum(f.mean)}</td>
      <td>${fmtNum(f.min)}</td>
      <td>${fmtNum(f.max)}</td>
    </tr>`;
  }).join('');
}

function renderRecentSnaps(snaps) {
  const t = document.getElementById('ml-recent-snaps');
  if (!snaps?.length) { t.innerHTML = '<tr><td>no snapshots yet</td></tr>'; return; }
  t.innerHTML = `<thead><tr><th>mint</th><th>age</th><th>buyers</th><th>mcap</th><th>at</th></tr></thead><tbody>` +
    snaps.map(s => `<tr>
      <td class="mint">${s.mint_address.slice(0, 8)}…</td>
      <td>${s.snapshot_age_sec}s</td>
      <td>${s.unique_buyers || 0}</td>
      <td>${fmtNum(s.last_mcap_sol, 1)}◎</td>
      <td>${fmtTs(s.snapshot_ts)}</td>
    </tr>`).join('') + '</tbody>';
}

function renderRecentRes(res) {
  const t = document.getElementById('ml-recent-res');
  if (!res?.length) { t.innerHTML = '<tr><td>no resolutions yet — labels resolve after 6h</td></tr>'; return; }
  t.innerHTML = `<thead><tr><th>mint</th><th>age</th><th>mig</th><th>+30%</th><th>+100%</th><th>peak%</th></tr></thead><tbody>` +
    res.map(r => `<tr>
      <td class="mint">${r.mint_address.slice(0, 8)}…</td>
      <td>${r.snapshot_age_sec}s</td>
      <td class="${r.migrated ? 'label-pos' : 'label-neg'}">${r.migrated ? '✓' : '·'}</td>
      <td class="${r.peaked_30 ? 'label-pos' : 'label-neg'}">${r.peaked_30 ? '✓' : '·'}</td>
      <td class="${r.peaked_100 ? 'label-pos' : 'label-neg'}">${r.peaked_100 ? '✓' : '·'}</td>
      <td>${(r.peak_pct_max * 100).toFixed(0)}%</td>
    </tr>`).join('') + '</tbody>';
}

async function refresh() {
  try {
    const d = await fetchJson('/api/ml/quality');
    document.getElementById('ml-asof').textContent = new Date(d.asOf).toLocaleString();

    // Section 1: Overall Health
    const grade = document.getElementById('ml-grade');
    grade.setAttribute('data-grade', d.grade);
    document.getElementById('ml-grade-val').textContent = d.grade;
    document.getElementById('ml-total').textContent = fmtN(d.snapshots.total);
    document.getElementById('ml-collection-days').textContent = `${d.snapshots.collection_days.toFixed(2)} days`;
    document.getElementById('ml-resolved').innerHTML = `${fmtN(d.snapshots.resolved)} <span style="color:#888;font-size:14px">/ ${fmtN(d.snapshots.unresolved)}</span>`;
    const resPct = d.snapshots.total > 0 ? (d.snapshots.resolved / d.snapshots.total * 100).toFixed(1) : '0';
    document.getElementById('ml-resolved-pct').textContent = `${resPct}% labeled`;
    document.getElementById('ml-rate-now').textContent = fmtN(d.snapshots.rate_per_hr_now);
    document.getElementById('ml-rate-avg').textContent = `avg ${fmtN(d.snapshots.rate_per_hr_avg)}/hr`;
    document.getElementById('ml-lag').textContent = d.resolution.avg_lag_hr ? d.resolution.avg_lag_hr.toFixed(1) : '—';

    // Alerts
    renderAlerts(d.alerts);

    // Section 2: Volume
    renderBars('ml-hourly-chart', d.snapshots.hourly_volume, 'ml-hourly-axis', ['24h ago', '12h', '6h', 'now']);
    renderBars('ml-daily-chart', d.snapshots.daily_volume, 'ml-daily-axis', ['7d', '5d', '3d', 'today']);
    document.getElementById('ml-b-60').textContent = fmtN(d.snapshots.by_age['60']);
    document.getElementById('ml-b-300').textContent = fmtN(d.snapshots.by_age['300']);
    document.getElementById('ml-b-900').textContent = fmtN(d.snapshots.by_age['900']);
    document.getElementById('ml-b-3600').textContent = fmtN(d.snapshots.by_age['3600']);

    // Section 3: Resolution
    document.getElementById('ml-res-count').textContent = fmtN(d.resolution.resolved_count);
    document.getElementById('ml-res-lag').textContent = d.resolution.avg_lag_hr ? d.resolution.avg_lag_hr.toFixed(2) : '—';
    document.getElementById('ml-res-overdue').textContent = fmtN(d.resolution.overdue_count);
    document.getElementById('ml-res-lasthr').textContent = fmtN(d.resolution.resolutions_last_hour);

    // Section 4: Class balance
    const migBars = (d.labels.mig_rate_by_day || []).map(x => x ? x.rate * 1000 : 0);
    renderBars('ml-mig-chart', migBars, 'ml-mig-axis', ['7d', '5d', '3d', 'today']);
    document.getElementById('ml-mig-cv').textContent = d.labels.cv_mig_rate != null
      ? `coefficient of variation: ${(d.labels.cv_mig_rate * 100).toFixed(0)}% (lower = stabler)`
      : 'CV: not enough data';
    document.getElementById('ml-mig-overall').textContent = fmtRate(d.labels.mig_rate_overall);
    document.getElementById('ml-p30').textContent = fmtRate(d.labels.peaked_30_rate);
    document.getElementById('ml-p100').textContent = fmtRate(d.labels.peaked_100_rate);
    document.getElementById('ml-p500').textContent = fmtRate(d.labels.peaked_500_rate);
    document.getElementById('ml-peak-avg').textContent = d.labels.peak_pct_max_median != null
      ? (d.labels.peak_pct_max_median * 100).toFixed(1) + '%' : '—';
    document.getElementById('ml-peak-max').textContent = d.labels.peak_pct_max_p95 != null
      ? (d.labels.peak_pct_max_p95 * 100).toFixed(1) + '%' : '—';

    // Section 5: Features
    renderFeatures(d.features);

    // Section 6: Coverage
    document.getElementById('ml-cov-mints').textContent = fmtN(d.coverage.unique_mints);
    document.getElementById('ml-cov-creators').textContent = fmtN(d.coverage.unique_creators);
    const ib = d.coverage.initial_buy_distribution || {};
    document.getElementById('ml-ib-1').textContent = fmtN(ib.b1);
    document.getElementById('ml-ib-2').textContent = fmtN(ib.b2);
    document.getElementById('ml-ib-3').textContent = fmtN(ib.b3);
    document.getElementById('ml-ib-4').textContent = fmtN(ib.b4);
    document.getElementById('ml-ib-5').textContent = fmtN(ib.b5);
    renderBars('ml-tod-chart', d.coverage.time_of_day_distribution, 'ml-tod-axis', ['00', '06', '12', '18', '23']);
    renderBars('ml-dow-chart', d.coverage.day_of_week_distribution, 'ml-dow-axis', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

    // Section 7: Live activity
    renderRecentSnaps(d.recent.recent_snapshots);
    renderRecentRes(d.recent.recent_resolutions);

    // Section 6.x: extras — fetched separately
    refreshCalibration();
    refreshBridge();
    refreshModelHealth();
    refreshLiftProfile();
    refreshAgent();
    refreshNews();
    refreshTopPicks();
    refreshRetrainStatus();

  } catch (err) {
    console.error('[ml-lab] refresh failed:', err);
  }
}

let _calibTarget = 'peaked_30';

async function refreshCalibration() {
  try {
    const r = await fetchJson('/api/ml/calibration?target=' + encodeURIComponent(_calibTarget));
    document.getElementById('ml-calib-n').textContent = fmtN(r.n_total);
    document.getElementById('ml-calib-target').textContent = r.target || '—';
    document.getElementById('ml-calib-brier').textContent = r.brier_score != null ? r.brier_score.toFixed(4) : '—';
    document.getElementById('ml-calib-ce').textContent = r.calibration_error != null ? (r.calibration_error * 100).toFixed(2) + '%' : '—';

    // Render SVG: predicted vs actual rate, with diagonal reference
    const wrap = document.getElementById('ml-calib-svg-wrap');
    const W = wrap.clientWidth || 600;
    const H = 240;
    const PAD = 32;
    const inner = (size) => size - 2 * PAD;
    let svg = `<svg width="${W}" height="${H}" style="display:block">`;
    // Diagonal (perfect calibration)
    svg += `<line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${PAD}" stroke="rgba(255,255,255,0.15)" stroke-dasharray="4 4"/>`;
    // Axes
    svg += `<line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="rgba(255,255,255,0.2)"/>`;
    svg += `<line x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}" stroke="rgba(255,255,255,0.2)"/>`;
    // Axis labels
    svg += `<text x="${W/2}" y="${H - 6}" fill="rgba(255,255,255,0.6)" font-size="10" text-anchor="middle">Predicted probability</text>`;
    svg += `<text x="12" y="${H/2}" fill="rgba(255,255,255,0.6)" font-size="10" text-anchor="middle" transform="rotate(-90, 12, ${H/2})">Actual rate</text>`;
    // Grid markers (0%, 50%, 100%)
    for (const t of [0, 0.5, 1.0]) {
      const x = PAD + t * inner(W);
      const y = H - PAD - t * inner(H);
      svg += `<text x="${x}" y="${H - PAD + 12}" fill="rgba(255,255,255,0.4)" font-size="9" text-anchor="middle">${(t*100).toFixed(0)}%</text>`;
      svg += `<text x="${PAD - 4}" y="${y + 3}" fill="rgba(255,255,255,0.4)" font-size="9" text-anchor="end">${(t*100).toFixed(0)}%</text>`;
    }
    // Plot points — circle size proportional to bucket count
    const buckets = (r.buckets || []).filter(b => b.n > 0 && b.predicted_avg != null);
    const maxN = Math.max(1, ...buckets.map(b => b.n));
    for (const b of buckets) {
      const px = PAD + b.predicted_avg * inner(W);
      const py = H - PAD - b.actual_rate * inner(H);
      const size = 4 + (b.n / maxN) * 12;
      svg += `<circle cx="${px}" cy="${py}" r="${size}" fill="#b985ff" stroke="#5e3da8" opacity="0.85"><title>predicted ${(b.predicted_avg*100).toFixed(1)}% · actual ${(b.actual_rate*100).toFixed(1)}% · n=${b.n}</title></circle>`;
    }
    // Connect with line
    if (buckets.length > 1) {
      const pts = buckets.map(b => `${PAD + b.predicted_avg * inner(W)},${H - PAD - b.actual_rate * inner(H)}`).join(' ');
      svg += `<polyline points="${pts}" fill="none" stroke="#b985ff" stroke-width="1.5" opacity="0.5"/>`;
    }
    svg += `</svg>`;
    wrap.innerHTML = svg;
  } catch {}
}

async function refreshRetrainStatus() {
  try {
    const r = await fetch('/api/ml/last-train');
    if (r.ok) {
      const j = await r.json();
      if (j.trained_at_ms) {
        const ago = (Date.now() - j.trained_at_ms) / 60000;
        document.getElementById('ml-last-train').textContent = ago < 60 ? `${ago.toFixed(0)}m ago` : `${(ago/60).toFixed(1)}h ago`;
        document.getElementById('ml-last-train-rows').textContent = `${fmtN(j.n_rows)} rows`;
      }
    }
  } catch {}
}

function probCell(prob, opts = {}) {
  if (prob == null) return '<td>—</td>';
  const pct = (prob * 100).toFixed(1);
  const inverse = !!opts.inverse;          // for will_die_fast: red high, green low
  let color;
  if (inverse) {
    color = prob >= 0.7 ? 'var(--red)' : prob >= 0.5 ? 'var(--yellow)' : 'var(--green)';
  } else {
    color = prob >= 0.20 ? 'var(--green)' : prob >= 0.10 ? 'var(--yellow)' : prob >= 0.05 ? 'var(--cyan)' : 'var(--text-dim)';
  }
  return `<td><span style="color:${color};font-weight:700">${pct}%</span></td>`;
}

async function refreshTopPicks() {
  try {
    const sortEl = document.getElementById('ml-picks-sort');
    const sortBy = sortEl ? sortEl.value : 'peaked_30';
    const r = await fetchJson('/api/ml/top-picks?sortBy=' + encodeURIComponent(sortBy));
    const tbody = document.getElementById('ml-picks-tbody');
    if (!r.picks || !r.picks.length) {
      tbody.innerHTML = '<tr><td colspan="11" class="empty">no scored mints yet — sweeper warming up</td></tr>';
      return;
    }
    tbody.innerHTML = r.picks.map((p, i) => {
      const pr = p.predictions || {};
      return `<tr>
        <td>#${i + 1}</td>
        <td class="mint">${p.mint_address.slice(0, 10)}…</td>
        <td>${p.symbol || '?'}</td>
        ${probCell(pr.peaked_30)}
        ${probCell(pr.peaked_100)}
        ${probCell(pr.peaked_300)}
        ${probCell(pr.migrated)}
        ${probCell(pr.will_die_fast, { inverse: true })}
        <td>${p.mcap ? p.mcap.toFixed(1) + '◎' : '—'}</td>
        <td>${p.buyers || 0}</td>
        <td>${fmtTs(p.scored_at)}</td>
      </tr>`;
    }).join('');
  } catch {}
}

// Re-sort picks when dropdown changes
document.addEventListener('DOMContentLoaded', () => {
  const sortEl = document.getElementById('ml-picks-sort');
  if (sortEl) sortEl.addEventListener('change', refreshTopPicks);
});

async function refreshBridge() {
  try {
    const r = await fetchJson('/api/ml/predictions');
    const stats = r.stats || {};
    const svc = stats.service || {};
    const card = document.getElementById('ml-svc');
    const val = document.getElementById('ml-svc-val');
    let grade = 'RED', label = 'OFFLINE';
    if (svc.serviceReachable && svc.modelLoaded) { grade = 'GREEN'; label = 'READY'; }
    else if (svc.serviceReachable) { grade = 'YELLOW'; label = 'NO MODEL'; }
    card.setAttribute('data-grade', grade);
    val.textContent = label;
    document.getElementById('ml-svc-model').textContent = svc.modelLoaded ? '✅ yes' : '❌ no';
    const lh = stats.last_hour || {};
    document.getElementById('ml-pred-total').textContent = fmtN(lh.total);
    document.getElementById('ml-pred-errors').textContent = `${fmtN(lh.errors)} errors`;
    document.getElementById('ml-pred-hitrate').textContent = fmtRate(lh.hit_rate || 0);
    document.getElementById('ml-pred-cachesize').textContent = `cache: ${svc.cacheSize || 0} mints`;
    document.getElementById('ml-pred-lat').textContent = lh.avg_latency_ms ? `${Math.round(lh.avg_latency_ms)}ms` : '—';
    document.getElementById('ml-pred-avgprob').textContent = lh.avg_prob ? fmtPct(lh.avg_prob) : '—';

    // Each prediction's `prob` field is meaningful in different units depending
    // on the target. Format accordingly so a regression output (seconds, peak %)
    // doesn't render as a nonsensical 17000% probability.
    const REGRESSION = { peak_pct_max: true, time_to_peak_sec: true };
    function fmtPredValue(target, v) {
      if (v == null) return '—';
      if (target === 'peak_pct_max') {
        // stored as fraction (0.30 = 30%). Cap display at 1000% — anything bigger is noise.
        const pct = Math.min(1000, v * 100);
        return pct.toFixed(0) + '%';
      }
      if (target === 'time_to_peak_sec') {
        if (v < 60) return Math.round(v) + 's';
        if (v < 3600) return (v / 60).toFixed(1) + 'm';
        return (v / 3600).toFixed(1) + 'h';
      }
      // Classification: probability 0-1
      return (v * 100).toFixed(2) + '%';
    }

    const t = document.getElementById('ml-pred-recent');
    if (!r.recent || !r.recent.length) {
      t.innerHTML = '<tr><td>no predictions yet — model not loaded or no calls made</td></tr>';
    } else {
      t.innerHTML = `<thead><tr><th>at</th><th>mint</th><th>target</th><th>value</th><th>src</th><th>cache</th><th>lat</th></tr></thead><tbody>` +
        r.recent.slice(0, 15).map(p => `<tr>
          <td>${fmtTs(p.timestamp)}</td>
          <td class="mint">${p.mint_address.slice(0, 8)}…</td>
          <td style="color:${REGRESSION[p.target] ? '#b985ff' : 'var(--cyan)'}">${p.target || '—'}</td>
          <td>${fmtPredValue(p.target, p.prob)}</td>
          <td>${p.source || '?'}</td>
          <td>${p.cache_hit ? '✓' : '·'}</td>
          <td>${p.latency_ms || 0}ms</td>
        </tr>`).join('') + '</tbody>';
    }
  } catch {}
}

refresh();
setInterval(refresh, REFRESH_MS);

// Click on alerts count → scroll to alerts section
document.getElementById('ml-alerts-count')?.addEventListener('click', () => {
  document.getElementById('ml-alerts-section').scrollIntoView({ behavior: 'smooth' });
});

// Manual retrain button
const RETRAIN_TARGETS = ['peaked_30','peaked_100','peaked_300','migrated','will_die_fast','peak_pct_max','time_to_peak_sec'];

let _retrainPollTimer = null;

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60).toString().padStart(2, '0') + 's';
}

function renderRetrainProgress(p) {
  const wrap = document.getElementById('ml-retrain-progress');
  const stage = document.getElementById('ml-retrain-progress-stage');
  const elapsed = document.getElementById('ml-retrain-progress-elapsed');
  const fill = document.getElementById('ml-retrain-progress-fill');
  const pills = document.getElementById('ml-retrain-progress-targets');
  if (!wrap) return;

  // Hide if idle and never ran (or already finished a while ago)
  if (!p || p.stage === 'idle') { wrap.style.display = 'none'; return; }
  // Auto-hide 8s after a successful run
  if (!p.running && (p.stage === 'done' || p.stage === 'skipped' || p.stage === 'failed')) {
    if (p.finishedAt && (Date.now() - p.finishedAt > 8000)) {
      wrap.style.display = 'none';
      return;
    }
  }
  wrap.style.display = 'block';

  // Pills
  let pillsHtml = '<span class="ml-retrain-target-pill ' + (p.stage === 'extract' ? 'active' : (p.completedTargets?.length > 0 || p.stage !== 'extract' ? 'done' : '')) + '">extract</span>';
  for (const t of RETRAIN_TARGETS) {
    const isDone = p.completedTargets?.includes(t);
    const isActive = p.currentTarget === t;
    const cls = isActive ? 'active' : (isDone ? 'done' : '');
    pillsHtml += `<span class="ml-retrain-target-pill ${cls}">${t}</span>`;
  }
  pillsHtml += '<span class="ml-retrain-target-pill ' + (p.stage === 'reload' ? 'active' : (p.stage === 'done' ? 'done' : '')) + '">reload</span>';
  if (pills) pills.innerHTML = pillsHtml;

  // Stage label
  let stageLabel = p.stage;
  if (p.stage === 'extract') stageLabel = '📊 extracting features';
  else if (p.stage === 'train' && p.currentTarget) stageLabel = `🧠 training ${p.currentTarget}`;
  else if (p.stage === 'reload') stageLabel = '♻️ reloading models';
  else if (p.stage === 'done') stageLabel = '✅ complete' + (p.durationSec ? ` (${p.durationSec}s)` : '');
  else if (p.stage === 'skipped') stageLabel = '⏭️ skipped — not enough new data';
  else if (p.stage === 'failed') stageLabel = `❌ failed (exit ${p.exitCode})`;
  if (stage) stage.textContent = stageLabel;

  // Elapsed
  if (elapsed) {
    if (p.running && p.startedAt) elapsed.textContent = fmtElapsed(Date.now() - p.startedAt);
    else if (p.durationSec) elapsed.textContent = p.durationSec + 's';
    else elapsed.textContent = '';
  }

  // Progress fill — fraction of stages complete
  // 1 (extract) + 7 (targets) + 1 (reload) = 9 stages
  let frac = 0;
  if (p.stage === 'extract') frac = 0.05;
  else if (p.stage === 'train') {
    const completed = p.completedTargets?.length || 0;
    frac = (1 + completed + 0.5) / 9;
  }
  else if (p.stage === 'reload') frac = (1 + RETRAIN_TARGETS.length + 0.5) / 9;
  else if (p.stage === 'done') frac = 1.0;
  else if (p.stage === 'skipped' || p.stage === 'failed') frac = 1.0;
  if (fill) fill.style.width = (frac * 100).toFixed(1) + '%';
}

async function pollRetrainStatus() {
  try {
    const r = await fetch('/api/ml/retrain-status');
    const p = await r.json();
    renderRetrainProgress(p);
    // Stop polling once it's done AND auto-hide window has passed
    if (!p.running && p.finishedAt && (Date.now() - p.finishedAt > 9000)) {
      if (_retrainPollTimer) { clearInterval(_retrainPollTimer); _retrainPollTimer = null; }
    }
  } catch (e) { /* swallow — keep polling */ }
}

function startRetrainPolling() {
  if (_retrainPollTimer) return;
  pollRetrainStatus();
  _retrainPollTimer = setInterval(pollRetrainStatus, 1000);
}

async function refreshLiftProfile() {
  try {
    const r = await fetchJson('/api/ml/lift-profile');
    const TARGETS = ['peaked_30', 'peaked_100', 'peaked_300', 'migrated', 'will_die_fast'];
    const headline = document.getElementById('ml-lift-headline');
    const tables = document.getElementById('ml-lift-tables');
    if (!r || !TARGETS.some(t => (r[t]?.n || 0) > 0)) {
      headline.textContent = 'no lift data yet — predictions need to age past the 6h label window';
      tables.innerHTML = '';
      return;
    }
    // Headline: per-target top-30% lift summary
    const summary = TARGETS.filter(t => r[t]?.n > 0).map(t => {
      const d = r[t];
      const lift = d.top30_lift != null ? d.top30_lift.toFixed(1) + 'x' : '?';
      const rate = d.top30_rate != null ? (d.top30_rate * 100).toFixed(0) + '%' : '?';
      const base = d.baseline != null ? (d.baseline * 100).toFixed(1) + '%' : '?';
      return `<span style="color:var(--cyan);">${t}</span>: top-30% picks pump <strong>${rate}</strong> vs baseline <strong>${base}</strong> = <strong style="color:#00ff88">${lift} lift</strong> (n=${d.top30_n})`;
    }).join(' &nbsp;·&nbsp; ');
    headline.innerHTML = summary;

    // Per-target decile tables (compact side-by-side)
    tables.innerHTML = `<div class="ml-volume-grid">` + TARGETS.filter(t => r[t]?.n > 0).map(t => {
      const d = r[t];
      const rows = d.deciles.filter(b => b.n > 0).map(b => {
        const liftClr = b.lift != null && b.lift >= 3 ? '#00ff88' : (b.lift >= 1.5 ? '#ffd166' : '#888');
        const gap = b.predicted != null && b.actual != null ? b.actual - b.predicted : null;
        const gapStr = gap != null ? `${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(0)}pts` : '';
        const gapClr = gap != null && Math.abs(gap) > 0.1 ? '#b985ff' : '#666';
        return `<tr>
          <td style="color:#888">${(b.low*100).toFixed(0)}-${(b.high*100).toFixed(0)}%</td>
          <td>${b.n}</td>
          <td>${b.predicted != null ? (b.predicted * 100).toFixed(0) + '%' : '—'}</td>
          <td>${b.actual != null ? (b.actual * 100).toFixed(0) + '%' : '—'}</td>
          <td style="color:${gapClr}">${gapStr}</td>
          <td style="color:${liftClr}; font-weight: 700;">${b.lift != null ? b.lift.toFixed(1) + 'x' : '—'}</td>
        </tr>`;
      }).join('');
      return `<div class="ml-bucket-card">
        <h3>${t} <span style="color:#666;font-size:10px;">n=${d.n}</span></h3>
        <table class="ml-feature-table">
          <thead><tr><th>bucket</th><th>n</th><th>predicted</th><th>actual</th><th>gap</th><th>lift</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="empty">no data</td></tr>'}</tbody>
        </table>
      </div>`;
    }).join('') + `</div>`;
  } catch (e) { /* swallow */ }
}

async function refreshNews() {
  try {
    const [synth, news, flagsRes] = await Promise.all([
      fetchJson('/api/news/synthesis').catch(() => ({})),
      fetchJson('/api/news/recent').catch(() => ({ items: [] })),
      fetchJson('/api/flags').catch(() => ({ flags: [] })),
    ]);
    const synthEl = document.getElementById('ml-news-synthesis');
    const synthAgeEl = document.getElementById('ml-news-synthesis-age');
    if (synth?.summary) {
      synthEl.textContent = synth.summary;
      const ageHr = synth.ts ? ((Date.now() - synth.ts) / 3600000).toFixed(1) : '?';
      synthAgeEl.textContent = `${ageHr}h ago`;
    } else {
      synthEl.textContent = 'no synthesis yet — agent will run first one ~8min after boot';
    }

    const flags = (flagsRes?.flags || []).filter(f => f.active);
    const flagsEl = document.getElementById('ml-flags-list');
    if (flags.length === 0) {
      flagsEl.textContent = 'no active flags — drop one above to override what the agent sees';
    } else {
      flagsEl.innerHTML = flags.map(f => `
        <div style="display:flex; align-items:center; gap:8px; padding:4px 0; border-bottom:1px dashed rgba(255,255,255,0.05); font-size:11px;">
          <span style="color:#b985ff; flex:1;">🚩 ${f.flag}</span>
          ${f.note ? `<span style="color:#888;">${f.note}</span>` : ''}
          <button data-id="${f.id}" class="flag-deactivate" style="background:transparent; color:#ff3860; border:1px solid #ff3860; padding:2px 8px; cursor:pointer; font-size:10px;">×</button>
        </div>`).join('');
      // Wire deactivate buttons
      flagsEl.querySelectorAll('.flag-deactivate').forEach(btn => {
        btn.onclick = async () => {
          await fetch(`/api/flags/${btn.dataset.id}/deactivate`, { method: 'POST' });
          refreshNews();
        };
      });
    }

    const items = news?.items || [];
    const newsEl = document.getElementById('ml-news-list');
    if (items.length === 0) {
      newsEl.textContent = 'no news yet — feeds poll every 30min, first ingestion in ~1min after boot';
    } else {
      newsEl.innerHTML = items.slice(0, 30).map(n => {
        const ageMin = Math.round((Date.now() - n.ts) / 60000);
        const ageStr = ageMin < 60 ? `${ageMin}m` : `${(ageMin / 60).toFixed(1)}h`;
        return `<div style="padding:4px 0; border-bottom:1px dashed rgba(255,255,255,0.05);">
          <span style="color:#888;">[${n.source}]</span>
          <a href="${n.url}" target="_blank" style="color:var(--cyan); text-decoration:none;">${n.title?.slice(0, 130) || '(no title)'}</a>
          <span style="color:#666; font-size:10px;"> · ${ageStr} ago · score=${(n.relevance_score || 0).toFixed(1)}</span>
        </div>`;
      }).join('');
    }
  } catch (e) { /* swallow */ }
}

document.getElementById('ml-flag-submit')?.addEventListener('click', async () => {
  const input = document.getElementById('ml-flag-input');
  const flag = input.value.trim();
  if (!flag) return;
  await fetch('/api/flags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flag, expires_in_hours: 24 }),
  });
  input.value = '';
  refreshNews();
});
document.getElementById('ml-flag-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('ml-flag-submit').click();
});

async function refreshAgent() {
  try {
    const [summary, logRes] = await Promise.all([
      fetchJson('/api/ml/agent/state'),
      fetchJson('/api/ml/agent/log?n=30'),
    ]);
    const s = summary?.state || {};
    document.getElementById('ml-agent-status').textContent = (s.status || 'unknown').toUpperCase();
    document.getElementById('ml-agent-thought').textContent = s.current_thought || '—';
    const live = summary?.live_strategies || [];
    document.getElementById('ml-agent-live-count').textContent = live.length;
    document.getElementById('ml-agent-live-sub').textContent = live.length === 0
      ? 'agent has not proposed any yet'
      : `${live.reduce((a, x) => a + x.n_open, 0)} open positions across ${live.length} strategies`;
    document.getElementById('ml-agent-consults').textContent = `${s.consults_today || 0} / ${s.consults_max || '?'}`;
    document.getElementById('ml-agent-last-cycle').textContent = s.last_cycle_at
      ? fmtTs(s.last_cycle_at)
      : '—';

    // Readiness checks
    const readiness = s.readiness || {};
    const rGrid = document.getElementById('ml-agent-readiness');
    rGrid.innerHTML = Object.entries(readiness).map(([name, c]) => `
      <div class="ml-stat-card" style="border-color: ${c.passed ? '#00ff88' : '#ff3860'}">
        <div class="ml-stat-label">${name.replace(/_/g, ' ')}</div>
        <div class="ml-stat-val" style="font-size:18px;color:${c.passed ? '#00ff88' : '#ff3860'}">${c.passed ? '✅' : '❌'}</div>
        <div class="ml-stat-sub">${c.detail || ''}</div>
      </div>
    `).join('');

    // Active strategies
    const stratWrap = document.getElementById('ml-agent-strategies');
    if (live.length === 0) {
      stratWrap.innerHTML = '<div class="ml-stat-sub" style="padding: 12px 0;">no strategies yet — agent will create them when ready</div>';
    } else {
      stratWrap.innerHTML = live.map(st => {
        const pnlColor = (st.realized_pnl_sol || 0) >= 0 ? '#00ff88' : '#ff3860';
        const winRate = st.n_trades > 0 ? (100 * st.wins / st.n_trades).toFixed(0) + '%' : '—';
        return `<div class="ml-stat-card" style="margin-bottom:8px;border-color:#b985ff">
          <div style="display:flex; justify-content:space-between; align-items:start; gap:12px;">
            <div style="flex:1; min-width:0;">
              <div class="ml-stat-label" style="font-size:11px;color:#d4a8ff;letter-spacing:1px">${st.id}</div>
              <div style="font-size:14px;font-weight:700;color:#b985ff;margin:4px 0;">${st.name}</div>
              <div class="ml-stat-sub" style="white-space:normal;line-height:1.4;">${st.rationale || ''}</div>
            </div>
            <div style="text-align:right; font-size:11px; min-width:140px;">
              <div>trades: <strong>${st.n_trades}</strong> closed · ${st.n_open} open</div>
              <div>win rate: <strong>${winRate}</strong></div>
              <div>realized: <strong style="color:${pnlColor}">${(st.realized_pnl_sol || 0).toFixed(4)} SOL</strong></div>
              <div>avg trade: ${(st.avg_trade_pct || 0).toFixed(1)}%</div>
            </div>
          </div>
        </div>`;
      }).join('');
    }

    // Retired strategies archive
    try {
      const arch = await fetchJson('/api/ml/agent/archive');
      const archEl = document.getElementById('ml-agent-archive');
      const list = arch?.archived || [];
      if (archEl) {
        if (list.length === 0) {
          archEl.textContent = 'none yet — retired strategies appear here, decluttered from the main dashboard';
        } else {
          archEl.innerHTML = list.map(a => {
            const pnlColor = (a.pnl || 0) >= 0 ? '#00ff88' : '#ff3860';
            const ageDays = a.retired_at ? ((Date.now() - a.retired_at) / 86400000).toFixed(1) + 'd ago' : '?';
            return `<div style="padding:6px 0; border-bottom: 1px dashed rgba(255,255,255,0.06);">
              <div style="color:#888;">🪦 <strong style="color:#b985ff;">${a.id}</strong> · retired ${ageDays}</div>
              <div style="color:#666; font-size:10px; margin: 2px 0;">${a.retired_reason || 'no reason recorded'}</div>
              <div style="font-size:10px;">${a.n_trades} trades · realized <strong style="color:${pnlColor}">${(a.pnl || 0).toFixed(3)} SOL</strong></div>
            </div>`;
          }).join('');
        }
      }
    } catch {}

    // Thoughts feed
    const log = logRes?.entries || [];
    const logWrap = document.getElementById('ml-agent-log');
    if (log.length === 0) {
      logWrap.innerHTML = '<div class="ml-stat-sub" style="padding:12px;">no log entries yet</div>';
    } else {
      const colors = {
        thought: '#888', info: '#05d9e8', propose: '#00ff88',
        retire: '#ffd166', error: '#ff3860', trade: '#b985ff',
      };
      logWrap.innerHTML = '<table class="ml-feed-table" style="width:100%"><tbody>' +
        log.map(e => `<tr>
          <td style="white-space:nowrap; padding-right:12px; color:#666; font-size:10px;">${fmtTs(e.timestamp)}</td>
          <td style="white-space:nowrap; color:${colors[e.level] || '#888'}; padding-right:8px; font-size:10px; text-transform:uppercase;">${e.level || ''}</td>
          <td style="white-space:nowrap; color:#888; padding-right:8px; font-size:10px;">${e.category || ''}</td>
          <td style="font-size:11px; color:#ccc;">${e.message || ''}</td>
        </tr>`).join('') + '</tbody></table>';
    }
  } catch (e) { /* swallow */ }
}

async function refreshModelHealth() {
  try {
    const r = await fetchJson('/api/ml/model-health');
    const sum = document.getElementById('ml-health-summary');
    const tbl = document.getElementById('ml-health-table').querySelector('tbody');
    if (!r.targets || !r.targets.length) {
      tbl.innerHTML = '<tr><td colspan="6" class="empty">no retrain history yet — first snapshot recorded after next retrain</td></tr>';
      sum.textContent = '—';
      return;
    }
    const dot = (lvl) => lvl === 'red' ? '🔴' : (lvl === 'yellow' ? '🟡' : '🟢');
    sum.innerHTML = `Overall: ${dot(r.overall)} <span style="color:#999">·</span> ${r.freshness.message} <span style="color:#999">·</span> ${r.history_total} snapshots in history`;
    tbl.innerHTML = r.targets.map(t => {
      const c = t.current || {};
      const p = t.previous || {};
      let headline = '—', delta = '—';
      if (t.mode === 'regression') {
        headline = c.r2 != null ? `R² ${c.r2.toFixed(3)}` : '—';
        if (p.r2 != null && c.r2 != null) {
          const d = c.r2 - p.r2;
          delta = `${d >= 0 ? '+' : ''}${d.toFixed(3)}`;
        }
      } else {
        const auc = c.auc_roc != null ? c.auc_roc.toFixed(3) : '—';
        const aucPr = c.auc_pr != null ? c.auc_pr.toFixed(3) : '—';
        headline = `AUC-ROC ${auc} · PR ${aucPr}`;
        if (p.auc_roc != null && c.auc_roc != null) {
          const d = c.auc_roc - p.auc_roc;
          delta = `ROC ${d >= 0 ? '+' : ''}${d.toFixed(3)}`;
        }
      }
      const alertBlurb = t.alerts?.length ? `<div style="font-size:10px; color:${t.level === 'red' ? '#ff3860' : '#ffd166'}; margin-top:2px;">${t.alerts.map(a => a.msg).join(' · ')}</div>` : '';
      return `<tr>
        <td><span style="color:var(--cyan)">${t.target}</span>${alertBlurb}</td>
        <td style="color:${t.mode === 'regression' ? '#b985ff' : 'var(--text-dim)'}">${t.mode}</td>
        <td>${headline}</td>
        <td>${delta}</td>
        <td>${t.n_train ?? '—'}${p && p.n_train != null && c.n_train != null ? ` <span style="color:#666;font-size:10px">(+${(t.n_train - (t.previous_n_train ?? p.n_train ?? t.n_train))})</span>` : ''}</td>
        <td>${dot(t.level)}</td>
      </tr>`;
    }).join('');
  } catch (e) { /* swallow */ }
}

document.getElementById('ml-calib-target-select')?.addEventListener('change', (e) => {
  _calibTarget = e.target.value;
  refreshCalibration();
});

document.getElementById('ml-retrain-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('ml-retrain-state');
  btn.textContent = '⏳ running...';
  try {
    const r = await fetch('/api/ml/retrain', { method: 'POST' });
    const j = await r.json();
    if (j.ok) {
      btn.textContent = '🚀 kicked off';
      startRetrainPolling();
      setTimeout(() => btn.textContent = 'click to trigger', 5000);
    }
    else {
      btn.textContent = j.reason || 'failed';
      // Even if "already_running", show the in-progress bar
      if (j.reason === 'already_running') startRetrainPolling();
      setTimeout(() => btn.textContent = 'click to trigger', 4000);
    }
  } catch (e) { btn.textContent = 'error'; setTimeout(() => btn.textContent = 'click to trigger', 3000); }
});

// On page load, check if a retrain is already in progress (from earlier click or cron)
pollRetrainStatus().then(() => {
  // If something is running or recently finished, start polling
  fetch('/api/ml/retrain-status').then(r => r.json()).then(p => {
    if (p && (p.running || (p.finishedAt && Date.now() - p.finishedAt < 9000))) startRetrainPolling();
  }).catch(() => {});
});
