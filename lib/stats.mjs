// Pure math. Browser-safe: no node imports.

// Assumes sorted (ascending) input and 0 <= p <= 1; callers must sort first.
export function quantileSorted(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export function naivePercentiles(durations, ps) {
  if (!durations.length) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  const out = {};
  for (const p of ps) out['p' + Math.round(p * 100)] = quantileSorted(sorted, p);
  return out;
}

// obs: [{t: days, event: 1|0}] (event=1 approved, 0 = right-censored)
export function kmCurve(obs) {
  const sorted = [...obs].sort((a, b) => a.t - b.t);
  const eventTimes = [...new Set(sorted.filter(o => o.event).map(o => o.t))].sort((a, b) => a - b);
  let S = 1;
  const curve = [];
  for (const t of eventTimes) {
    const atRisk = sorted.filter(o => o.t >= t).length;
    const events = sorted.filter(o => o.event && o.t === t).length;
    S *= 1 - events / atRisk;
    curve.push({ t, atRisk, events, S });
  }
  return curve;
}

export function kmSurvivalAt(curve, t) {
  let S = 1;
  for (const pt of curve) {
    if (pt.t <= t) S = pt.S; else break;
  }
  return S;
}

export function kmQuantile(curve, p) {
  const target = 1 - p;
  for (const pt of curve) if (pt.S <= target + 1e-12) return pt.t;
  return null;
}

export function kmConditionalQuantile(curve, elapsed, p) {
  const Se = kmSurvivalAt(curve, elapsed);
  if (Se <= 1e-12) return null;
  const target = Se * (1 - p);
  for (const pt of curve) if (pt.t > elapsed && pt.S <= target + 1e-12) return pt.t;
  return null;
}
