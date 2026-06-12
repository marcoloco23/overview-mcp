// NOAA ERDDAP griddap client for OISST v2.1 — daily 0.25° global sea-surface temperature
// from 1981-09-01 to ~2 weeks ago. Free, no key. Used for long ocean-temperature series
// (El Niño-grade history) that Open-Meteo's marine archive can't reach.

import { USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";
import { decimate, type SeriesPoint } from "../series.js";

const ERDDAP_BASE = "https://coastwatch.pfeg.noaa.gov/erddap/griddap/ncdcOisst21Agg_LonPM180";

export const OISST_START = "1981-09-01";

interface ErddapTable {
  table: {
    columnNames: string[];
    rows: Array<Array<string | number | null>>;
  };
}

/** Parse an ERDDAP griddap JSON response into series points (time + named variable). */
export function parseErddapSeries(json: unknown, variable: string): SeriesPoint[] {
  const t = (json as ErddapTable)?.table;
  if (!t?.columnNames || !Array.isArray(t.rows)) {
    throw new OverviewError("unexpected ERDDAP response shape");
  }
  const iTime = t.columnNames.indexOf("time");
  const iVar = t.columnNames.indexOf(variable);
  if (iTime < 0 || iVar < 0) {
    throw new OverviewError(`ERDDAP response missing columns (have: ${t.columnNames.join(", ")})`);
  }
  return t.rows.map((r) => {
    const raw = r[iVar];
    const v = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    return { t: String(r[iTime] ?? "").slice(0, 10), v };
  });
}

let cachedLatest: string | null = null;

/** Latest available OISST date (cached per process — the dataset updates daily). */
export async function oisstLatestDate(): Promise<string> {
  if (cachedLatest) return cachedLatest;
  const url = `${ERDDAP_BASE}.json?sst%5B(last)%5D%5B(0.0)%5D%5B(0.125)%5D%5B(0.125)%5D`;
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) {
    throw new OverviewError(`ERDDAP latest-date probe failed (${res.status})`, res.status);
  }
  const pts = parseErddapSeries(await res.json(), "sst");
  const t = pts[0]?.t;
  if (!t) throw new OverviewError("ERDDAP latest-date probe returned no rows");
  cachedLatest = t;
  return t;
}

export interface OisstQuery {
  lat: number;
  lon: number;
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD (clamped to the dataset's latest)
  maxPoints?: number; // default 400 — stride is chosen server-side to stay under this
}

export interface OisstResult {
  points: SeriesPoint[];
  start: string;
  end: string; // after clamping
  strideDays: number;
  gridLat: number;
  gridLon: number;
}

/**
 * Daily SST series at the nearest 0.25° grid cell, strided server-side so at most
 * ~maxPoints values cross the wire. ERDDAP matches `(value)` to the nearest grid index.
 */
export async function oisstSeries(q: OisstQuery): Promise<OisstResult> {
  if (q.lat < -90 || q.lat > 90 || q.lon < -180 || q.lon > 180) {
    throw new OverviewError(`lat/lon out of range: ${q.lat}, ${q.lon}`);
  }
  const latest = await oisstLatestDate();
  const end = q.end > latest ? latest : q.end;
  const start = q.start < OISST_START ? OISST_START : q.start;
  if (start > end) {
    throw new OverviewError(`start ${start} is after the latest available OISST date ${end}`);
  }
  const spanDays = Math.max(
    1,
    Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000),
  );
  const maxPoints = q.maxPoints ?? 400;
  const strideDays = Math.max(1, Math.ceil(spanDays / maxPoints));

  const dim = (v: string | number) => `%5B(${v})%5D`;
  const time = `%5B(${start}T12:00:00Z):${strideDays}:(${end}T12:00:00Z)%5D`;
  const url = `${ERDDAP_BASE}.json?sst${time}${dim("0.0")}${dim(q.lat)}${dim(q.lon)}`;
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OverviewError(`ERDDAP OISST request failed (${res.status})`, res.status, body.slice(0, 300));
  }
  const json = (await res.json()) as ErddapTable;
  const points = decimate(parseErddapSeries(json, "sst"), maxPoints);
  const first = json.table.rows[0];
  const iLat = json.table.columnNames.indexOf("latitude");
  const iLon = json.table.columnNames.indexOf("longitude");
  return {
    points,
    start,
    end,
    strideDays,
    gridLat: Number(first?.[iLat] ?? q.lat),
    gridLon: Number(first?.[iLon] ?? q.lon),
  };
}
