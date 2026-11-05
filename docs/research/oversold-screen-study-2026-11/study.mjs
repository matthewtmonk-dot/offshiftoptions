// SURVIVOR-ONLY EXPLORATORY walk-forward study, frozen protocol V1.0.
// Usage: node fetch.mjs   (throttled Yahoo download into ./cache; run first)
//        node study.mjs   (analysis; writes results.md + results.json)
// Nothing here is tuned; all thresholds are the pre-registered ones.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CACHE = path.join(DIR, 'cache');
const TODAY = '2026-11-05'; // bars dated >= this are dropped (last Yahoo bar is a live/incomplete session)
const N_BOOT = 5000;
const ALPHA = 0.0125; // Bonferroni: 0.05 / 4 guards, one-sided
const DEV_END = '2022-12-31';

// ---------- indicator helpers (all causal: value at i uses data through i only) ----------
function sma(a, n) { const o = new Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
function rsiWilder(c, n = 14) {
  const o = new Array(c.length).fill(NaN); if (c.length <= n) return o;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n; o[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1]; g = (g * (n - 1) + (d > 0 ? d : 0)) / n; l = (l * (n - 1) + (d < 0 ? -d : 0)) / n;
    o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return o;
}
function atrWilder(h, l, c, n = 14) {
  const o = new Array(c.length).fill(NaN); if (c.length <= n) return o;
  const tr = (i) => Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  let a = 0; for (let i = 1; i <= n; i++) a += tr(i); a /= n; o[n] = a;
  for (let i = n + 1; i < c.length; i++) { a = (a * (n - 1) + tr(i)) / n; o[i] = a; }
  return o;
}
function bollPctB(c, n = 20) {
  const o = new Array(c.length).fill(NaN);
  for (let i = n - 1; i < c.length; i++) {
    let m = 0; for (let k = i - n + 1; k <= i; k++) m += c[k]; m /= n;
    let v = 0; for (let k = i - n + 1; k <= i; k++) v += (c[k] - m) ** 2; const sd = Math.sqrt(v / n); // population std
    const up = m + 2 * sd, lo = m - 2 * sd; o[i] = up === lo ? NaN : (100 * (c[i] - lo)) / (up - lo);
  }
  return o;
}
function realizedVol(c, n = 20) { // stdev of daily log returns over last n returns
  const o = new Array(c.length).fill(NaN);
  for (let i = n; i < c.length; i++) {
    let m = 0; const r = []; for (let k = i - n + 1; k <= i; k++) { r.push(Math.log(c[k] / c[k - 1])); }
    m = r.reduce((x, y) => x + y, 0) / n; o[i] = Math.sqrt(r.reduce((x, y) => x + (y - m) ** 2, 0) / (n - 1));
  }
  return o;
}
const dayMs = 86400000;
function mondayOf(dateStr) { const d = new Date(dateStr + 'T00:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; return new Date(d.getTime() - dow * dayMs).toISOString().slice(0, 10); }
function dayDiff(a, b) { return (new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / dayMs; }
function median(a) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function quantile(a, q) { const s = [...a].sort((x, y) => x - y); const p = (s.length - 1) * q; const lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); }
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------- load + per-ticker processing ----------
const syms = fs.readFileSync(path.join(DIR, 'universe.txt'), 'utf8').split(/\s+/).filter(Boolean);
const fetchFailed = [], loaded = [], suspicious = [];
const recs = []; // one record per eligible (stock, Friday) with a complete outcome window
let splitCount = 0;

for (const sym of syms) {
  const f = path.join(CACHE, sym + '.json');
  if (!fs.existsSync(f)) { fetchFailed.push([sym, 'not cached']); continue; }
  let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { fetchFailed.push([sym, 'bad json']); continue; }
  const r = j?.chart?.result?.[0];
  if (!r || !r.timestamp) { fetchFailed.push([sym, j?.error ? 'error ' + j.error : 'no data']); continue; }
  const off = r.meta.gmtoffset ?? 0, q = r.indicators.quote[0];
  const D = [], O = [], H = [], L = [], C = [], V = [];
  for (let k = 0; k < r.timestamp.length; k++) {
    const d = new Date((r.timestamp[k] + off) * 1000).toISOString().slice(0, 10);
    if (d >= TODAY) continue;
    const o = q.open[k], h = q.high[k], l = q.low[k], c = q.close[k], v = q.volume[k];
    if (![o, h, l, c].every((x) => x != null && x > 0) || v == null) continue;
    if (D.length && D[D.length - 1] === d) continue;
    D.push(d); O.push(o); H.push(h); L.push(l); C.push(c); V.push(v);
  }
  if (D.length < 300) { fetchFailed.push([sym, 'too short ' + D.length]); continue; }
  loaded.push(sym);
  // split factors: factor[i] = product of split ratios with split date > D[i]  (as-traded = adjusted * factor)
  const splits = Object.values(r.events?.splits ?? {}).map((s) => ({ date: new Date((s.date + off) * 1000).toISOString().slice(0, 10), ratio: s.numerator / s.denominator })).sort((a, b) => a.date.localeCompare(b.date));
  splitCount += splits.length;
  const fac = new Array(D.length).fill(1);
  for (const s of splits) for (let i = 0; i < D.length && D[i] < s.date; i++) fac[i] *= s.ratio;
  // data sanity: big close-to-close jumps remaining after split adjustment
  for (let i = 1; i < D.length; i++) { const x = C[i] / C[i - 1]; if (x < 0.5 || x > 2) suspicious.push(`${sym} ${D[i]} ${x.toFixed(2)}`); }

  const atp = C.map((c, i) => c * fac[i]);                       // as-traded close
  const dvol = C.map((c, i) => c * fac[i] * (V[i] / fac[i]));    // as-traded dollar volume = adj price*adj vol (factors cancel)
  const rsi = rsiWilder(C), pb = bollPctB(C), atr = atrWilder(H, L, C), s200 = sma(C, 200), rv = realizedVol(C);
  const dvAvg20 = sma(dvol, 20), vAvg20 = sma(V, 20);

  // last session of each calendar week
  const weekLast = new Map();
  for (let i = 0; i < D.length; i++) weekLast.set(mondayOf(D[i]), i);
  for (const [wk, i] of weekLast) {
    if (i < 252) continue; // >=252 completed sessions of history (also needed for G3's preceding-252 window)
    const e = i + 1; if (e + 9 >= D.length) continue; // need entry + 10-session window complete
    if (dayDiff(D[i], D[e]) > 6) continue; // entry must be the next session (not a long data gap)
    // universe filters at Friday close
    if (!(atp[i] >= 10 && atp[i] <= 50)) continue;
    if (!(dvAvg20[i] >= 20e6)) continue;
    if ([rsi[i], pb[i], atr[i], s200[i], s200[i - 20], rv[i]].some((x) => !Number.isFinite(x))) continue;
    const entry = O[e]; let minLow = Infinity; for (let k = e; k <= e + 9; k++) minLow = Math.min(minLow, L[k]);
    const mae = minLow / entry - 1;
    const signal = rsi[i] <= 40 && pb[i] <= 33;
    // guards (split-adjusted prices)
    const g1 = C[i] - C[i - 5] < -3 * atr[i];
    const g2 = C[i] < s200[i] && s200[i] < s200[i - 20];
    let low252 = Infinity; for (let k = i - 252; k <= i - 1; k++) low252 = Math.min(low252, L[k]);
    const g3 = C[i] <= 1.05 * low252;
    let g4 = false;
    for (let k = i - 9; k <= i; k++) {
      if (Number.isFinite(atr[k - 1]) && O[k] < C[k - 1] - 2 * atr[k - 1] && vAvg20[k - 1] > 0 && V[k] > 2 * vAvg20[k - 1]) { g4 = true; break; }
    }
    recs.push({ sym, date: D[i], week: wk, year: +D[i].slice(0, 4), signal, g: [g1, g2, g3, g4], tail: mae <= -0.10, mae, r5: C[e + 4] / entry - 1, r10: C[e + 9] / entry - 1, vol: rv[i], rsi: rsi[i], pb: pb[i] });
  }
}

// ---------- summaries ----------
const period = (r) => (r.date <= DEV_END ? 'dev' : 'val');
const distinct = (arr) => new Set(arr.map((r) => r.sym)).size;
const rate = (arr) => (arr.length ? arr.filter((r) => r.tail).length / arr.length : NaN);
const pct = (x, d = 1) => (Number.isFinite(x) ? (100 * x).toFixed(d) + '%' : 'n/a');
const pp = (x, d = 1) => (Number.isFinite(x) ? (100 * x).toFixed(d) + ' pp' : 'n/a');
const base = recs.filter((r) => r.signal);
const GN = ['G1 rapid decline', 'G2 falling trend', 'G3 52-week low', 'G4 gap-down'];

// weekly aggregates for block bootstrap
function weekAgg(arr, extra) { // returns Map week -> {n,t,...}
  const m = new Map();
  for (const r of arr) { const w = m.get(r.week) ?? { n: 0, t: 0 }; w.n++; if (r.tail) w.t++; if (extra) extra(w, r); m.set(r.week, w); }
  return m;
}
function bootstrap(weeks, stat, seed) { // weeks: array of week keys; stat(sampleWeeks)->number ; returns array of N_BOOT stats
  const rnd = mulberry32(seed), out = [];
  for (let b = 0; b < N_BOOT; b++) { const s = new Array(weeks.length); for (let k = 0; k < weeks.length; k++) s[k] = weeks[Math.floor(rnd() * weeks.length)]; out.push(stat(s)); }
  return out;
}

const out = []; // markdown lines
const P = (s = '') => out.push(s);
const J = { };

P('# Oversold-screen guard study (SURVIVOR-ONLY EXPLORATORY) - results');
P();
P('Protocol V1.0 frozen before data inspection. **Survivor-only exploratory**: the universe contains only currently listed tickers. No parameter was tuned. Generated by `study.mjs`.');
P();
P('## 1. Data');
P(`- Universe file: universe.txt (${syms.length} symbols; no ticker universe with >=250 common stocks exists as a static list in the repo - the scanner universe is a DB-cached OCC optionable list - so a hand-built ~500-symbol list of liquid US/ADR names was used; includes a few ADRs/foreign filers, see caveats. 36 of the 523 symbols returned HTTP 404 (delisted/renamed tickers: itself evidence of how survivor-limited any such list is) and 19 more had no/too little data).`);
P(`- Tickers loaded and used: **${loaded.length}**; fetch/processing failures: **${fetchFailed.length}**${fetchFailed.length ? ' (' + fetchFailed.map((x) => x[0] + ':' + x[1]).join(', ') + ')' : ''}.`);
P(`- Split events found/applied: ${splitCount}. Residual |close-to-close| jumps >2x or <0.5x after split adjustment (possible unadjusted spin-offs/data errors): ${suspicious.length}${suspicious.length ? ' e.g. ' + suspicious.slice(0, 15).join('; ') : ''}.`);
P(`- Eligible stock-Friday observations with complete 10-session outcome window (price $10-50, 20d avg $ volume >= $20M, >=252 sessions): **${recs.length}** (baseline oversold signals: **${base.length}**).`);
P(`- Last bar dated ${TODAY} dropped (incomplete session). Development = signals through ${DEV_END}; validation = 2023-01-01 on (last usable signal is ~3 weeks before the data end because a full 10-session window is required).`);
P();

// ---- signals per year, p0 vs controls
const years = [...new Set(recs.map((r) => r.year))].sort();
P('## 2. Baseline screen vs controls (primary outcome: intraday low >= 10% below entry open within 10 sessions incl. entry day)');
P();
P('Control definitions: **Ctrl-all** = every eligible stock-Friday (includes the signals); **Ctrl-non-signal** = eligible, not oversold-flagged; **Ctrl-volmatched** = non-signal eligible whose 20-session realized vol is within the baseline-signal IQR (computed within the same period/year row, i.e. matched on the same slice).');
P();
P('| Slice | Baseline n | stocks | p0 | Ctrl-all n | p_ctrl(all) | Ctrl-nonsig n | p_ctrl(nonsig) | Ctrl-volmatched n | p_ctrl(volmatched) | med ret10 base | med ret10 ctrl-all |');
P('|---|---|---|---|---|---|---|---|---|---|---|---|');
function sliceRow(label, f) {
  const all = recs.filter(f), b = all.filter((r) => r.signal), ns = all.filter((r) => !r.signal);
  let vm = [];
  if (b.length >= 4) { const q1 = quantile(b.map((r) => r.vol), 0.25), q3 = quantile(b.map((r) => r.vol), 0.75); vm = ns.filter((r) => r.vol >= q1 && r.vol <= q3); }
  P(`| ${label} | ${b.length} | ${distinct(b)} | ${pct(rate(b))} | ${all.length} | ${pct(rate(all))} | ${ns.length} | ${pct(rate(ns))} | ${vm.length} | ${pct(rate(vm))} | ${pct(median(b.map((r) => r.r10)))} | ${pct(median(all.map((r) => r.r10)))} |`);
  return { label, b: b.length, p0: rate(b), pall: rate(all), pns: rate(ns), pvm: rate(vm) };
}
J.slices = [];
J.slices.push(sliceRow('ALL', () => true));
J.slices.push(sliceRow('DEV (<=2022)', (r) => period(r) === 'dev'));
J.slices.push(sliceRow('VAL (2023+)', (r) => period(r) === 'val'));
for (const y of years) J.slices.push(sliceRow(String(y) + (y >= 2023 ? ' (val)' : ' (dev)'), (r) => r.year === y));
P();

// baseline vs control bootstrap
P('### Does the oversold screen itself have a higher tail rate than the control? (week-block bootstrap, 5000 resamples)');
P();
P('| Period | Comparison | difference (pp) | 95% block-bootstrap CI | one-sided p (baseline <= control) |');
P('|---|---|---|---|---|');
for (const [label, f] of [['ALL', () => true], ['DEV', (r) => period(r) === 'dev'], ['VAL', (r) => period(r) === 'val']]) {
  const all = recs.filter(f);
  const bw = weekAgg(all.filter((r) => r.signal)), aw = weekAgg(all), nw = weekAgg(all.filter((r) => !r.signal));
  const weeks = [...aw.keys()];
  const cmp = (cw, name, seed) => {
    const stat = (ws) => { let bn = 0, bt = 0, cn = 0, ct = 0; for (const w of ws) { const b = bw.get(w), c = cw.get(w); if (b) { bn += b.n; bt += b.t; } if (c) { cn += c.n; ct += c.t; } } return bn && cn ? bt / bn - ct / cn : NaN; };
    const obs = stat(weeks), bs = bootstrap(weeks, stat, seed).filter(Number.isFinite).sort((a, b) => a - b);
    const p = bs.filter((x) => x <= 0).length / bs.length;
    P(`| ${label} | baseline vs ${name} | ${(100 * obs).toFixed(2)} | [${(100 * bs[Math.floor(0.025 * bs.length)]).toFixed(2)}, ${(100 * bs[Math.floor(0.975 * bs.length)]).toFixed(2)}] | ${p.toFixed(4)} |`);
    return { label, name, diff: obs, p };
  };
  (J.b2c ??= []).push(cmp(aw, 'Ctrl-all', 11), cmp(nw, 'Ctrl-non-signal', 12));
}
P();
P('Forward return and adverse-excursion detail (baseline vs Ctrl-all):');
P();
P('| Slice | group | n | mean ret5 | median ret5 | mean ret10 | median ret10 | median MAE10 |');
P('|---|---|---|---|---|---|---|---|');
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
for (const [label, f] of [['DEV', (r) => period(r) === 'dev'], ['VAL', (r) => period(r) === 'val']]) {
  for (const [gn, gf] of [['baseline', (r) => r.signal], ['ctrl-all', () => true]]) {
    const a = recs.filter((r) => f(r) && gf(r));
    P(`| ${label} | ${gn} | ${a.length} | ${pct(mean(a.map((r) => r.r5)), 2)} | ${pct(median(a.map((r) => r.r5)), 2)} | ${pct(mean(a.map((r) => r.r10)), 2)} | ${pct(median(a.map((r) => r.r10)), 2)} | ${pct(median(a.map((r) => r.mae)), 2)} |`);
  }
}
P();
// de-clustering sensitivity: keep a stock's signal only if the same stock had no signal the previous week
{
  const byWeekSym = new Set(base.map((r) => r.sym + '|' + r.week));
  const firstOnly = base.filter((r) => { const pw = new Date(new Date(r.week + 'T00:00:00Z').getTime() - 7 * dayMs).toISOString().slice(0, 10); return !byWeekSym.has(r.sym + '|' + pw); });
  P(`Overlap sensitivity (baseline signals whose stock was NOT also a signal the previous week, i.e. first of each run): n=${firstOnly.length}, p0=${pct(rate(firstOnly))} (all periods); dev ${pct(rate(firstOnly.filter((r) => period(r) === 'dev')))} / val ${pct(rate(firstOnly.filter((r) => period(r) === 'val')))}. Repeat signals (consecutive weeks) share 5 of 10 window sessions.`);
  J.firstOnly = { n: firstOnly.length, p0: rate(firstOnly) };
}
P();

// ---- guards
function guardAnalysis(per) {
  const b = base.filter((r) => period(r) === per);
  const res = [];
  for (let gi = 0; gi < 4; gi++) {
    const fl = b.filter((r) => r.g[gi]), rt = b.filter((r) => !r.g[gi]);
    const p0 = rate(b), pg = rate(rt), pf = rate(fl);
    const abs = p0 - pg, rel = abs / p0, retention = rt.length / b.length;
    const medBase = median(b.map((r) => r.r10)), medRet = median(rt.map((r) => r.r10));
    // week-block bootstrap of (p0 - pg) over weeks that contain >=1 baseline signal
    const bw = new Map();
    for (const r of b) { const w = bw.get(r.week) ?? { n: 0, t: 0, rn: 0, rt: 0 }; w.n++; if (r.tail) w.t++; if (!r.g[gi]) { w.rn++; if (r.tail) w.rt++; } bw.set(r.week, w); }
    const weeks = [...bw.keys()];
    const stat = (ws) => { let n = 0, t = 0, rn = 0, rtt = 0; for (const w of ws) { const x = bw.get(w); n += x.n; t += x.t; rn += x.rn; rtt += x.rt; } return rn && n ? t / n - rtt / rn : NaN; };
    const bs = bootstrap(weeks, stat, 100 + gi).filter(Number.isFinite).sort((a, c) => a - c);
    const pval = bs.filter((x) => x <= 0).length / bs.length;
    const ci = [bs[Math.floor(0.025 * bs.length)], bs[Math.floor(0.975 * bs.length)]];
    // per-year consistency
    const yrs = [];
    for (const y of [...new Set(b.map((r) => r.year))].sort()) {
      const by = b.filter((r) => r.year === y), fy = by.filter((r) => r.g[gi]), ry = by.filter((r) => !r.g[gi]);
      const a = rate(by) - rate(ry), rl = a / rate(by);
      yrs.push({ y, n: by.length, flagged: fy.length, p0: rate(by), pg: rate(ry), pf: rate(fy), abs: a, rel: rl, supports: fy.length >= 20 && a >= 0.02 && rl >= 0.2 });
    }
    const yearsSupporting = yrs.filter((y) => y.supports).length;
    // decision (validation only is binding)
    const enough = fl.length >= 100 && distinct(fl) >= 40;
    const medOK = medRet - medBase >= -0.005;
    const cautionCrit = { abs2pp: abs >= 0.02, rel20: rel >= 0.2, retention60: retention >= 0.6, sig: pval < ALPHA, twoYears: yearsSupporting >= 2, medianOK: medOK };
    const cautionPass = Object.values(cautionCrit).every(Boolean);
    const rejectNumeric = abs >= 0.04 && rel >= 0.4 && retention >= 0.75 && pf >= 2 * pg;
    let decision;
    if (!enough) decision = 'INCONCLUSIVE'; else if (cautionPass) decision = 'CAUTION'; else decision = 'DROP';
    res.push({ guard: GN[gi], per, nBase: b.length, flagged: fl.length, flaggedStocks: distinct(fl), retention, p0, pg, pf, abs, rel, ratio: pf / pg, medBase, medRet, pval, ci, yrs, yearsSupporting, cautionCrit, cautionPass, rejectNumeric, enough, decision });
  }
  return res;
}
for (const per of ['val', 'dev']) {
  const R = guardAnalysis(per); J['guards_' + per] = R;
  P(`## ${per === 'val' ? '3. Guards - VALIDATION period (binding for decisions)' : '4. Guards - DEVELOPMENT period (context only, not used for decisions)'}`);
  P();
  P(`Baseline signals in period: ${R[0].nBase}, p0 = ${pct(R[0].p0)}.`);
  P();
  P('| Guard | flagged n | flagged stocks | retention | p0 | pg (retained) | flagged tail rate | flagged/retained | abs reduction | rel reduction | median ret10 baseline | median ret10 retained | boot 95% CI of (p0-pg) | one-sided p | yrs supporting |');
  P('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const g of R) P(`| ${g.guard} | ${g.flagged} | ${g.flaggedStocks} | ${pct(g.retention)} | ${pct(g.p0)} | ${pct(g.pg)} | ${pct(g.pf)} | ${g.ratio.toFixed(2)}x | ${pp(g.abs)} | ${pct(g.rel, 0)} | ${pct(g.medBase, 2)} | ${pct(g.medRet, 2)} | [${(100 * g.ci[0]).toFixed(2)}, ${(100 * g.ci[1]).toFixed(2)}] pp | ${g.pval.toFixed(4)} | ${g.yearsSupporting} |`);
  P();
  P('Per-year consistency (year "supports" if flagged n >= 20, abs reduction >= 2 pp and relative >= 20%):');
  P();
  P('| Guard | Year | baseline n | flagged n | p0 | pg | flagged rate | abs red. | rel red. | supports |');
  P('|---|---|---|---|---|---|---|---|---|---|');
  for (const g of R) for (const y of g.yrs) P(`| ${g.guard} | ${y.y} | ${y.n} | ${y.flagged} | ${pct(y.p0)} | ${pct(y.pg)} | ${pct(y.pf)} | ${pp(y.abs)} | ${pct(y.rel, 0)} | ${y.supports ? 'yes' : 'no'} |`);
  P();
  if (per === 'val') {
    P('### Mechanical decisions (validation)');
    P();
    P('| Guard | min sample (>=100 flagged, >=40 stocks) | abs>=2pp | rel>=20% | retention>=60% | p<0.0125 | >=2 val years | median ret10 not >0.5pp worse | REJECT numerics met (informational) | DECISION |');
    P('|---|---|---|---|---|---|---|---|---|---|');
    for (const g of R) {
      const c = g.cautionCrit, yn = (x) => (x ? 'yes' : 'no');
      P(`| ${g.guard} | ${yn(g.enough)} (${g.flagged}/${g.flaggedStocks}) | ${yn(c.abs2pp)} | ${yn(c.rel20)} | ${yn(c.retention60)} | ${yn(c.sig)} | ${yn(c.twoYears)} | ${yn(c.medianOK)} | ${yn(g.rejectNumeric)} | **${g.decision}** |`);
    }
    P();
    P('REJECT is never issued (survivor-only rule); if CAUTION passes and the REJECT numerics are also met, the result is still capped at CAUTION.');
    P();
  }
}

P('## 5. Biggest caveats');
P(`1. **Survivorship**: only currently listed tickers. Stocks that fell and were delisted/bankrupt are absent, so tail rates after oversold signals are understated, and guards aimed at falling-knife situations (G1-G3 especially) are *systematically disadvantaged* in measurement - the very stocks most likely to be flagged and to crash further are partly missing. Absolute rates and guard value are biased in an unknown direction; this cannot be fixed with this data.`);
P('2. **Universe is hand-built**, not the scanner universe (not available offline); selection of "names I remember" is itself a form of hindsight (tickers that are well-known today). Includes some ADRs/foreign filers; ETF/leveraged/preferred products deliberately excluded.');
P('3. **Overlapping windows / serial dependence**: a stock oversold for several consecutive Fridays contributes overlapping 10-session windows (5 shared sessions). Week-block bootstrap handles cross-sectional (same-week) dependence but NOT same-stock dependence across adjacent weeks, so p-values are somewhat optimistic. A first-of-run sensitivity for p0 is given above.');
P('4. **Regime clustering**: tail events cluster in market-wide selloffs (Mar 2020, 2022, Apr 2025). With few independent episodes, year-level "consistency" is weak evidence. 2026 validation year is partial.');
P('5. **Yahoo quirks**: OHLC are split-adjusted but not dividend-adjusted (small bias in indicators for high yielders, ignored); split reconstruction depends on Yahoo split events being complete and correct (unadjusted spin-offs, mergers, ticker reuse or reverse-split errors can create bogus price levels - see residual jump list in section 1); volume revisions are possible; intraday lows can include bad ticks. As-traded price band uses the reconstructed price.');
P('6. **Period asymmetry**: bars start Nov 2016 and 252 sessions of history are required, so the effective development period is ~Nov 2017-2022 (~5 years, including the 2020 crash and 2022 bear market) and validation is ~3.8 years of mostly rising market.');
P('7. **Entry realism**: entry at Monday open assumes a fill at the open price; weekend gaps are part of the outcome; the primary outcome uses intraday lows (not closes). No transaction costs, no options pricing - this is a stock-price tail study only, not an options P&L study.');
P('8. **Multiple comparisons / one-sided test**: p-value tests only p0 - pg > 0 (not >= 2pp). Four guards Bonferroni-adjusted to 1.25%.');
P('9. **Interpretive choices where the protocol was silent** (see final report): per-year support rule; MIN 20 flagged obs per year; %B/RSI computed from series start (Wilder seeding); day-1 = entry day for 5/10-session horizons; weeks defined Monday-Sunday; window completeness required.');

fs.writeFileSync(path.join(DIR, 'results.md'), out.join('\n') + '\n');
fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify({ loaded: loaded.length, failed: fetchFailed, nRecs: recs.length, nBase: base.length, J }, null, 1));
console.log(out.join('\n'));
