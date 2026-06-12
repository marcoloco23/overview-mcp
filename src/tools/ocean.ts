import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensoPhase, fetchOni, oniSeries } from "../clients/indicators.js";
import { OISST_START, oisstSeries } from "../clients/erddap.js";
import { pushCard } from "../dashboard/push.js";
import { safe } from "../result.js";
import { decimate, linearTrend, round, summarize } from "../series.js";
import { addDays, isoDate, newId, nowIso } from "../util.js";

const ONI_SOURCE = "NOAA CPC Oceanic Niño Index (ONI), ERSSTv5 Niño3.4 anomalies";
const OISST_SOURCE = "NOAA OISST v2.1 (0.25° daily SST) via CoastWatch ERDDAP";

/** Register ocean tools: enso (El Niño / La Niña tracking) and ocean_temp (SST history). */
export function registerOceanTools(server: McpServer): void {
  server.registerTool(
    "enso",
    {
      title: "ENSO / El Niño–La Niña tracker (ONI)",
      description:
        "Track El Niño / La Niña via NOAA's official Oceanic Niño Index (ONI): 3-month-mean " +
        "Niño3.4 SST anomalies from 1950 to now, no key. Returns the current ENSO phase " +
        "(El Niño ≥ +0.5 °C, La Niña ≤ −0.5 °C, with NOAA's 5-consecutive-season event rule), " +
        "the recent ONI series, and the strongest events in the window. ENSO drives global " +
        "weather patterns — droughts, floods, coral bleaching, fire seasons — so check it when " +
        "reasoning about climate anomalies anywhere on Earth. Posts a chart card to the dashboard.",
      inputSchema: {
        months: z.number().int().min(12).max(1000)
          .optional()
          .describe("History window in months for the returned series (default 120 = 10 years)."),
      },
    },
    async ({ months }) =>
      safe(async () => {
        const rows = await fetchOni();
        const phase = ensoPhase(rows);
        const all = oniSeries(rows);
        const window = all.slice(-(months ?? 120));
        const strongestElNino = rows.reduce((a, b) => (b.anom > a.anom ? b : a));
        const strongestLaNina = rows.reduce((a, b) => (b.anom < a.anom ? b : a));
        const interpretation =
          `${phase.phase} conditions: latest ONI ${phase.latest.anom >= 0 ? "+" : ""}${phase.latest.anom} °C ` +
          `(${phase.latest.season} ${phase.latest.year})` +
          (phase.phase === "Neutral"
            ? `, within ±0.5 °C of average.`
            : `, ${phase.consecutiveSeasons} consecutive season(s) beyond the ±0.5 °C threshold` +
              (phase.meetsEventDefinition
                ? ` — meets NOAA's official event definition (≥5).`
                : ` — not yet an official event (needs 5).`));
        const pushed = await pushCard({
          id: newId(),
          type: "series",
          ts: nowIso(),
          title: `ENSO: ${phase.phase} · ONI ${phase.latest.anom >= 0 ? "+" : ""}${phase.latest.anom} °C`,
          payload: {
            series: [{ label: "ONI (Niño3.4 anomaly)", unit: "°C", points: decimate(window) }],
            thresholds: [0.5, -0.5],
            summary: interpretation,
            source: ONI_SOURCE,
          },
        });
        return {
          source: ONI_SOURCE,
          phase: phase.phase,
          latest: { season: phase.latest.season, year: phase.latest.year, oni: phase.latest.anom },
          consecutiveSeasons: phase.consecutiveSeasons,
          meetsEventDefinition: phase.meetsEventDefinition,
          interpretation,
          strongestElNino: { season: strongestElNino.season, year: strongestElNino.year, oni: strongestElNino.anom },
          strongestLaNina: { season: strongestLaNina.season, year: strongestLaNina.year, oni: strongestLaNina.anom },
          series: window,
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );

  server.registerTool(
    "ocean_temp",
    {
      title: "Ocean temperature history (OISST, 1981→now)",
      description:
        "Daily sea-surface temperature at any ocean point from NOAA OISST (0.25° grid, " +
        "Sept 1981 to ~2 weeks ago), no key. Returns the series (auto-strided), latest value, " +
        "min/max/mean, and a °C-per-decade warming trend when the window allows. Use it for " +
        "marine heatwaves, coral-bleaching risk, and ENSO-region SST (Niño3.4 center: lat 0, " +
        "lon -145; combine with the enso tool for the official index). Posts a chart card.",
      inputSchema: {
        lat: z.number().min(-90).max(90).describe("Latitude of the ocean point."),
        lon: z.number().min(-180).max(180).describe("Longitude of the ocean point."),
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe(`Start date YYYY-MM-DD (default 5 years ago; earliest ${OISST_START}).`),
        end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe("End date YYYY-MM-DD (default today; clamped to the latest available)."),
      },
    },
    async ({ lat, lon, start, end }) =>
      safe(async () => {
        const endDate = end ?? isoDate(0);
        const startDate = start ?? addDays(endDate, -5 * 365);
        const r = await oisstSeries({ lat, lon, start: startDate, end: endDate });
        const s = summarize(r.points);
        if (s.n === 0) {
          throw new Error(
            `no SST data at ${lat}, ${lon} — likely a land cell. Try a point further offshore.`,
          );
        }
        const spanYears =
          (Date.parse(r.end) - Date.parse(r.start)) / (365.25 * 86_400_000);
        const trend = spanYears >= 3 ? linearTrend(r.points) : null;
        const summary =
          `SST at (${r.gridLat}, ${r.gridLon}): latest ${s.latest?.v} °C (${s.latest?.t}), ` +
          `${r.start}…${r.end} mean ${s.mean} °C, range ${s.min}–${s.max} °C` +
          (trend ? `, trend ${trend.perDecade >= 0 ? "+" : ""}${round(trend.perDecade, 2)} °C/decade.` : ".");
        const pushed = await pushCard({
          id: newId(),
          type: "series",
          ts: nowIso(),
          title: `SST ${s.latest?.v} °C · (${r.gridLat}, ${r.gridLon})`,
          bbox: [r.gridLon - 2, Math.max(-90, r.gridLat - 2), r.gridLon + 2, Math.min(90, r.gridLat + 2)],
          payload: {
            series: [{ label: "Sea-surface temperature", unit: "°C", points: r.points }],
            summary,
            source: OISST_SOURCE,
          },
        });
        return {
          source: OISST_SOURCE,
          gridCell: { lat: r.gridLat, lon: r.gridLon },
          window: { from: r.start, to: r.end, strideDays: r.strideDays },
          latest: s.latest,
          stats: { min: s.min, max: s.max, mean: s.mean, n: s.n },
          trendPerDecade: trend ? round(trend.perDecade, 3) : null,
          summary,
          series: r.points,
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );
}
