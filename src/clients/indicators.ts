// Global climate-indicator clients: ENSO (ONI), CO₂ (Mauna Loa), global temperature
// (NASA GISTEMP), and sea ice (NSIDC). All free, no keys — plain text/CSV files parsed
// by pure, exported functions so they're offline-testable.

import { USER_AGENT } from "../config.js";
import { OverviewError } from "../errors.js";
import { round, type SeriesPoint } from "../series.js";

const ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt";
const CO2_MLO_URL = "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.txt";
const GISTEMP_URL = "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv";
const NSIDC_BASE = "https://noaadata.apps.nsidc.org/NOAA/G02135";

async function fetchText(url: string, what: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OverviewError(`${what} request failed (${res.status})`, res.status, body.slice(0, 300));
  }
  return res.text();
}

// ---- ENSO / ONI -------------------------------------------------------------------------

/** One overlapping 3-month season of the Oceanic Niño Index. */
export interface OniRow {
  season: string; // e.g. "DJF"
  year: number;
  total: number; // Niño3.4 SST °C
  anom: number; // anomaly vs the (rolling) 30-yr base — the ONI value
}

/** Parse the CPC ONI fixed-width text table (header: SEAS YR TOTAL ANOM). */
export function parseOni(text: string): OniRow[] {
  const out: OniRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Z]{3})\s+(\d{4})\s+(-?[\d.]+)\s+(-?[\d.]+)$/);
    if (!m) continue;
    out.push({ season: m[1]!, year: Number(m[2]), total: Number(m[3]), anom: Number(m[4]) });
  }
  if (out.length === 0) throw new OverviewError("ONI parse produced no rows — format changed?");
  return out;
}

export type EnsoPhaseName = "El Niño" | "La Niña" | "Neutral";

export interface EnsoPhase {
  phase: EnsoPhaseName;
  latest: OniRow;
  /** Consecutive seasons (incl. latest) at or beyond ±0.5 °C in the latest run's direction. */
  consecutiveSeasons: number;
  /** True when the run meets NOAA's ≥5-consecutive-season event definition. */
  meetsEventDefinition: boolean;
}

/**
 * NOAA definition: an El Niño (La Niña) event needs ≥5 consecutive overlapping seasons with
 * ONI ≥ +0.5 °C (≤ −0.5 °C). The *current phase* reports the latest run even if it hasn't
 * reached 5 seasons yet (flagged via meetsEventDefinition).
 */
export function ensoPhase(rows: OniRow[]): EnsoPhase {
  const latest = rows[rows.length - 1];
  if (!latest) throw new OverviewError("no ONI rows");
  const dir = latest.anom >= 0.5 ? 1 : latest.anom <= -0.5 ? -1 : 0;
  if (dir === 0) {
    return { phase: "Neutral", latest, consecutiveSeasons: 0, meetsEventDefinition: false };
  }
  let run = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const a = rows[i]!.anom;
    if ((dir === 1 && a >= 0.5) || (dir === -1 && a <= -0.5)) run++;
    else break;
  }
  return {
    phase: dir === 1 ? "El Niño" : "La Niña",
    latest,
    consecutiveSeasons: run,
    meetsEventDefinition: run >= 5,
  };
}

/** ONI rows → series points (season centered on its middle month). */
export function oniSeries(rows: OniRow[]): SeriesPoint[] {
  // Season label → middle month (DJF → Jan of the *listed* year, per CPC convention).
  const MID: Record<string, number> = {
    DJF: 1, JFM: 2, FMA: 3, MAM: 4, AMJ: 5, MJJ: 6,
    JJA: 7, JAS: 8, ASO: 9, SON: 10, OND: 11, NDJ: 12,
  };
  return rows
    .filter((r) => MID[r.season] !== undefined)
    .map((r) => ({ t: `${r.year}-${String(MID[r.season]).padStart(2, "0")}`, v: r.anom }));
}

export async function fetchOni(): Promise<OniRow[]> {
  return parseOni(await fetchText(ONI_URL, "NOAA CPC ONI"));
}

// ---- CO₂ (Mauna Loa) --------------------------------------------------------------------

export interface Co2Row {
  year: number;
  month: number;
  average: number; // ppm, monthly mean
  deseasonalized: number; // ppm, seasonal cycle removed
}

/** Parse the NOAA GML monthly mean CO₂ text file (# comments; -9.99 = missing). */
export function parseCo2(text: string): Co2Row[] {
  const out: Co2Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#") || !line.trim()) continue;
    const c = line.trim().split(/\s+/);
    if (c.length < 5) continue;
    const year = Number(c[0]);
    const month = Number(c[1]);
    const average = Number(c[3]);
    const deseasonalized = Number(c[4]);
    if (!Number.isInteger(year) || !Number.isInteger(month)) continue;
    if (average <= 0) continue; // -9.99 = missing
    out.push({ year, month, average, deseasonalized });
  }
  if (out.length === 0) throw new OverviewError("CO₂ parse produced no rows — format changed?");
  return out;
}

export function co2Series(rows: Co2Row[]): SeriesPoint[] {
  return rows.map((r) => ({ t: `${r.year}-${String(r.month).padStart(2, "0")}`, v: r.average }));
}

export async function fetchCo2(): Promise<Co2Row[]> {
  return parseCo2(await fetchText(CO2_MLO_URL, "NOAA GML CO₂"));
}

// ---- Global temperature (NASA GISTEMP v4) -----------------------------------------------

export interface GistempData {
  monthly: SeriesPoint[]; // anomaly °C vs 1951–1980, per month
  annual: SeriesPoint[]; // J-D annual mean anomaly
}

/** Parse the GISTEMP global-means CSV ("***" = not yet available). */
export function parseGistemp(csv: string): GistempData {
  const lines = csv.trim().split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.startsWith("Year,"));
  if (headerIdx < 0) throw new OverviewError("GISTEMP header not found — format changed?");
  const header = lines[headerIdx]!.split(",");
  const jdCol = header.indexOf("J-D");
  const monthly: SeriesPoint[] = [];
  const annual: SeriesPoint[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const c = line.split(",");
    const year = Number(c[0]);
    if (!Number.isInteger(year)) continue;
    for (let m = 1; m <= 12; m++) {
      const v = Number(c[m]);
      if (Number.isFinite(v)) monthly.push({ t: `${year}-${String(m).padStart(2, "0")}`, v });
    }
    if (jdCol > 0) {
      const v = Number(c[jdCol]);
      if (Number.isFinite(v)) annual.push({ t: String(year), v });
    }
  }
  if (monthly.length === 0) throw new OverviewError("GISTEMP parse produced no rows");
  return { monthly, annual };
}

export async function fetchGistemp(): Promise<GistempData> {
  return parseGistemp(await fetchText(GISTEMP_URL, "NASA GISTEMP"));
}

// ---- Sea ice (NSIDC Sea Ice Index v4, G02135) --------------------------------------------

export type Pole = "north" | "south";

/** Parse the NSIDC daily extent CSV (Year, Month, Day, Extent 10^6 km², Missing, Source). */
export function parseSeaIce(csv: string): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d{4}),\s*(\d{2}),\s*(\d{2}),\s*([\d.]+),/);
    if (!m) continue;
    out.push({ t: `${m[1]}-${m[2]}-${m[3]}`, v: Number(m[4]) });
  }
  if (out.length === 0) throw new OverviewError("NSIDC sea-ice parse produced no rows");
  return out;
}

export interface SeaIceClimatologyRow {
  doy: number;
  average: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

/** Parse the NSIDC 1981–2010 climatology CSV (DOY, Average, Std, 10th…90th percentiles). */
export function parseSeaIceClimatology(csv: string): SeaIceClimatologyRow[] {
  const out: SeaIceClimatologyRow[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const c = line.trim().split(/,\s*/);
    if (c.length < 8) continue;
    const doy = Number(c[0]);
    if (!Number.isInteger(doy)) continue;
    out.push({
      doy,
      average: Number(c[1]),
      p10: Number(c[3]),
      p25: Number(c[4]),
      p50: Number(c[5]),
      p75: Number(c[6]),
      p90: Number(c[7]),
    });
  }
  if (out.length === 0) throw new OverviewError("NSIDC climatology parse produced no rows");
  return out;
}

/** Day-of-year (1-based) for a YYYY-MM-DD string, UTC. */
export function dayOfYear(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.round((d.getTime() - start) / 86_400_000);
}

export interface SeaIceStatus {
  pole: Pole;
  latest: SeriesPoint;
  climatology: SeaIceClimatologyRow | null;
  anomalyVsAverage: number | null; // 10^6 km², latest − 1981-2010 average for that DOY
  belowP10: boolean | null;
}

export function seaIceStatus(
  pole: Pole,
  daily: SeriesPoint[],
  clim: SeaIceClimatologyRow[],
): SeaIceStatus {
  const latest = [...daily].reverse().find((p) => p.v !== null);
  if (!latest) throw new OverviewError("no sea-ice observations");
  const doy = dayOfYear(latest.t);
  const c = clim.find((r) => r.doy === doy) ?? null;
  return {
    pole,
    latest,
    climatology: c,
    anomalyVsAverage: c && latest.v !== null ? round(latest.v - c.average, 3) : null,
    belowP10: c && latest.v !== null ? latest.v < c.p10 : null,
  };
}

export async function fetchSeaIce(pole: Pole): Promise<SeriesPoint[]> {
  const url = `${NSIDC_BASE}/${pole}/daily/data/${pole === "north" ? "N" : "S"}_seaice_extent_daily_v4.0.csv`;
  return parseSeaIce(await fetchText(url, "NSIDC sea ice"));
}

export async function fetchSeaIceClimatology(pole: Pole): Promise<SeaIceClimatologyRow[]> {
  const url = `${NSIDC_BASE}/${pole}/daily/data/${pole === "north" ? "N" : "S"}_seaice_extent_climatology_1981-2010_v4.0.csv`;
  return parseSeaIceClimatology(await fetchText(url, "NSIDC sea-ice climatology"));
}
