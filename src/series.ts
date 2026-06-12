// Shared time-series model + pure helpers for the planetary indicators layer.
// Everything here is network-free and unit-tested offline.

export interface SeriesPoint {
  t: string; // ISO date or YYYY-MM
  v: number | null;
}

export interface Series {
  label: string;
  unit: string;
  points: SeriesPoint[];
}

/**
 * Fractional year for an ISO date/month/year string ("2024-03-15" → ~2024.2).
 * Bare years land mid-year and bare months mid-month, so annual/monthly series sit at the
 * center of the period they summarize.
 */
export function yearFraction(t: string): number {
  const year = Number(t.slice(0, 4));
  if (t.length < 7) return year + 0.5;
  const month = Number(t.slice(5, 7));
  const day = t.length >= 10 ? Number(t.slice(8, 10)) : 15;
  return year + (month - 1) / 12 + (day - 1) / 365;
}

export interface Trend {
  perYear: number;
  perDecade: number;
  n: number;
}

/**
 * Ordinary least-squares slope over (yearFraction, v), ignoring null gaps.
 * Returns null when fewer than 3 valid points (a "trend" of 2 points is noise).
 */
export function linearTrend(points: SeriesPoint[]): Trend | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of points) {
    if (p.v === null || !Number.isFinite(p.v)) continue;
    xs.push(yearFraction(p.t));
    ys.push(p.v);
  }
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  if (den === 0) return null;
  const perYear = num / den;
  return { perYear: round(perYear, 6), perDecade: round(perYear * 10, 4), n };
}

/**
 * Downsample to at most `maxN` points by uniform striding, always keeping the first and
 * last point so the visible range is honest.
 */
export function decimate(points: SeriesPoint[], maxN = 400): SeriesPoint[] {
  if (points.length <= maxN || maxN < 3) return points.slice(0, Math.max(0, maxN));
  const stride = Math.ceil(points.length / (maxN - 1));
  const out: SeriesPoint[] = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]!);
  const last = points[points.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export interface SeriesSummary {
  n: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  latest: SeriesPoint | null;
}

/** Min/max/mean over non-null values + the latest non-null point. */
export function summarize(points: SeriesPoint[]): SeriesSummary {
  let min: number | null = null;
  let max: number | null = null;
  let sum = 0;
  let n = 0;
  let latest: SeriesPoint | null = null;
  for (const p of points) {
    if (p.v === null || !Number.isFinite(p.v)) continue;
    if (min === null || p.v < min) min = p.v;
    if (max === null || p.v > max) max = p.v;
    sum += p.v;
    n++;
    latest = p;
  }
  return { n, min, max, mean: n > 0 ? round(sum / n, 4) : null, latest };
}

/** Collapse daily points into monthly means keyed YYYY-MM (months with no data dropped). */
export function monthlyMean(points: SeriesPoint[]): SeriesPoint[] {
  return groupMean(points, (t) => t.slice(0, 7));
}

/** Collapse daily/monthly points into calendar-year means keyed YYYY. */
export function annualMean(points: SeriesPoint[]): SeriesPoint[] {
  return groupMean(points, (t) => t.slice(0, 4));
}

function groupMean(points: SeriesPoint[], keyOf: (t: string) => string): SeriesPoint[] {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const p of points) {
    if (p.v === null || !Number.isFinite(p.v)) continue;
    const k = keyOf(p.t);
    const cur = sums.get(k) ?? { sum: 0, n: 0 };
    cur.sum += p.v;
    cur.n++;
    sums.set(k, cur);
  }
  return [...sums.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([t, { sum, n }]) => ({ t, v: round(sum / n, 4) }));
}

export function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
