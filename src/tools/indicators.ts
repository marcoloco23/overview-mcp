import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  co2Series,
  ensoPhase,
  fetchCo2,
  fetchGistemp,
  fetchOni,
  fetchSeaIce,
  fetchSeaIceClimatology,
  seaIceStatus,
  type Pole,
} from "../clients/indicators.js";
import { events } from "../clients/nasa.js";
import { quakes } from "../clients/usgs.js";
import { pushCard } from "../dashboard/push.js";
import { safe } from "../result.js";
import { decimate, linearTrend, round, summarize, type SeriesPoint } from "../series.js";
import { addDays, isoDate, newId, nowIso } from "../util.js";

const CO2_SOURCE = "NOAA GML, Mauna Loa Observatory monthly mean CO₂ (Keeling curve)";
const GISTEMP_SOURCE = "NASA GISTEMP v4 global land+ocean anomaly vs 1951–1980";
const NSIDC_SOURCE = "NSIDC Sea Ice Index v4 (G02135), daily extent + 1981–2010 climatology";

/** Year-over-year change of the latest point vs the point ~12 months earlier. */
function yoy(points: SeriesPoint[]): number | null {
  const valid = points.filter((p) => p.v !== null);
  const latest = valid[valid.length - 1];
  const prior = valid[valid.length - 13];
  return latest?.v != null && prior?.v != null ? round(latest.v - prior.v, 2) : null;
}

/** Register global-indicator tools: co2, global_temp, sea_ice, planet_pulse. */
export function registerIndicatorTools(server: McpServer): void {
  server.registerTool(
    "co2",
    {
      title: "Atmospheric CO₂ (Keeling curve, 1958→now)",
      description:
        "Monthly mean atmospheric CO₂ at Mauna Loa from NOAA — the Keeling curve, 1958 to " +
        "now, no key. Returns the latest concentration, year-over-year growth, the decadal " +
        "trend, and the (decimated) full series. The single most fundamental indicator of " +
        "the changing planet. Posts a chart card to the dashboard.",
      inputSchema: {
        sinceYear: z.number().int().min(1958).max(2100).optional()
          .describe("Trim the returned series to start at this year (default: full record)."),
      },
    },
    async ({ sinceYear }) =>
      safe(async () => {
        const rows = await fetchCo2();
        let points = co2Series(rows);
        if (sinceYear) points = points.filter((p) => Number(p.t.slice(0, 4)) >= sinceYear);
        const s = summarize(points);
        const growth = yoy(points);
        const trend = linearTrend(points.slice(-120)); // last decade
        const summary =
          `Atmospheric CO₂: ${s.latest?.v} ppm (${s.latest?.t}), ` +
          `${growth != null ? `${growth >= 0 ? "+" : ""}${growth} ppm vs a year earlier, ` : ""}` +
          `last-decade trend ${trend ? `+${round(trend.perDecade, 1)} ppm/decade` : "n/a"}. ` +
          `Pre-industrial level was ~280 ppm.`;
        const series = decimate(points);
        const pushed = await pushCard({
          id: newId(),
          type: "series",
          ts: nowIso(),
          title: `CO₂ ${s.latest?.v} ppm · ${s.latest?.t}`,
          payload: {
            series: [{ label: "CO₂ (Mauna Loa)", unit: "ppm", points: series }],
            summary,
            source: CO2_SOURCE,
          },
        });
        return {
          source: CO2_SOURCE,
          latest: s.latest,
          yearOverYearPpm: growth,
          lastDecadeTrendPpmPerDecade: trend ? round(trend.perDecade, 2) : null,
          range: { min: s.min, max: s.max },
          series,
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );

  server.registerTool(
    "global_temp",
    {
      title: "Global temperature record (GISTEMP, 1880→now)",
      description:
        "NASA GISTEMP v4 global mean surface-temperature anomaly (land+ocean, vs the " +
        "1951–1980 baseline), monthly since 1880, no key. Returns the latest monthly anomaly, " +
        "the annual series, the warmest years on record, and the recent warming rate. " +
        "Posts a chart card to the dashboard.",
      inputSchema: {},
    },
    async () =>
      safe(async () => {
        const g = await fetchGistemp();
        const sM = summarize(g.monthly);
        const warmest = [...g.annual]
          .filter((p) => p.v !== null)
          .sort((a, b) => (b.v ?? 0) - (a.v ?? 0))
          .slice(0, 5);
        const trend = linearTrend(g.monthly.filter((p) => Number(p.t.slice(0, 4)) >= 1980));
        const summary =
          `Global temperature anomaly: ${sM.latest?.v != null && sM.latest.v >= 0 ? "+" : ""}${sM.latest?.v} °C ` +
          `(${sM.latest?.t}, vs 1951–1980). Warming since 1980: ` +
          `${trend ? `${round(trend.perDecade, 2)} °C/decade` : "n/a"}. ` +
          `Warmest years: ${warmest.map((p) => `${p.t} (+${p.v})`).join(", ")}.`;
        const annual = decimate(g.annual);
        const pushed = await pushCard({
          id: newId(),
          type: "series",
          ts: nowIso(),
          title: `Global temp +${sM.latest?.v} °C · ${sM.latest?.t}`,
          payload: {
            series: [{ label: "Global anomaly (annual)", unit: "°C", points: annual }],
            thresholds: [0, 1.5],
            summary,
            source: GISTEMP_SOURCE,
          },
        });
        return {
          source: GISTEMP_SOURCE,
          baseline: "1951–1980",
          latestMonthly: sM.latest,
          warmestYears: warmest,
          trendSince1980PerDecade: trend ? round(trend.perDecade, 3) : null,
          annualSeries: annual,
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );

  server.registerTool(
    "sea_ice",
    {
      title: "Polar sea ice extent (NSIDC, 1978→yesterday)",
      description:
        "Daily Arctic or Antarctic sea-ice extent from the NSIDC Sea Ice Index (satellite " +
        "passive microwave, 1978 to ~yesterday), no key. Returns the latest extent, the " +
        "anomaly vs the 1981–2010 climatology for the same day-of-year (and whether it's " +
        "below the 10th percentile), the current-year daily series, and the long-term trend " +
        "for this calendar month. Posts a chart card with the climatology overlay.",
      inputSchema: {
        pole: z.enum(["north", "south"]).describe("north = Arctic, south = Antarctic."),
      },
    },
    async ({ pole }) =>
      safe(async () => {
        const p = pole as Pole;
        const [daily, clim] = await Promise.all([fetchSeaIce(p), fetchSeaIceClimatology(p)]);
        const status = seaIceStatus(p, daily, clim);
        const year = status.latest.t.slice(0, 4);
        const thisYear = daily.filter((d) => d.t.startsWith(year));
        const climSeries: SeriesPoint[] = thisYear.map((d) => {
          const doy = clim.find((r) => r.doy === Math.min(365, dayIndex(d.t)));
          return { t: d.t, v: doy ? doy.average : null };
        });
        // Long-term trend: same calendar month across all years (avoids seasonal aliasing).
        const month = status.latest.t.slice(5, 7);
        const sameMonth = daily.filter((d) => d.t.slice(5, 7) === month);
        const trend = linearTrend(sameMonth);
        const label = p === "north" ? "Arctic" : "Antarctic";
        const summary =
          `${label} sea-ice extent: ${status.latest.v} M km² (${status.latest.t}), ` +
          `${status.anomalyVsAverage != null ? `${status.anomalyVsAverage >= 0 ? "+" : ""}${status.anomalyVsAverage} M km² vs the 1981–2010 average` : "no climatology match"}` +
          `${status.belowP10 ? " — below the 10th percentile" : ""}. ` +
          `Trend for month ${month}: ${trend ? `${round(trend.perDecade, 3)} M km²/decade` : "n/a"}.`;
        const pushed = await pushCard({
          id: newId(),
          type: "series",
          ts: nowIso(),
          title: `${label} sea ice ${status.latest.v} M km² · ${status.latest.t}`,
          payload: {
            series: [
              { label: `${label} extent ${year}`, unit: "M km²", points: decimate(thisYear) },
              { label: "1981–2010 average", unit: "M km²", points: decimate(climSeries) },
            ],
            summary,
            source: NSIDC_SOURCE,
          },
        });
        return {
          source: NSIDC_SOURCE,
          pole: p,
          latest: status.latest,
          anomalyVsAverage: status.anomalyVsAverage,
          belowP10: status.belowP10,
          climatologyForDay: status.climatology,
          monthTrendPerDecade: trend ? round(trend.perDecade, 4) : null,
          currentYearSeries: decimate(thisYear),
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );

  server.registerTool(
    "planet_pulse",
    {
      title: "Planet pulse — state of the Earth right now",
      description:
        "One call, the planet's vital signs: atmospheric CO₂ (latest + YoY), global " +
        "temperature anomaly, ENSO phase (El Niño/La Niña), Arctic & Antarctic sea-ice " +
        "anomalies, significant earthquakes (M5+, last 7 days), and open natural-disaster " +
        "events. All free/no-key sources, fetched in parallel; any source that fails is " +
        "reported as unavailable rather than failing the call. The fastest way to load " +
        "situational awareness of the Earth system. Posts a pulse card to the dashboard.",
      inputSchema: {},
    },
    async () =>
      safe(async () => {
        const today = isoDate(0);
        const [co2R, tempR, oniR, iceN, iceS, quakeR, eventsR] = await Promise.allSettled([
          fetchCo2(),
          fetchGistemp(),
          fetchOni(),
          Promise.all([fetchSeaIce("north"), fetchSeaIceClimatology("north")]),
          Promise.all([fetchSeaIce("south"), fetchSeaIceClimatology("south")]),
          quakes({ start: addDays(today, -7), minMagnitude: 5, limit: 500 }),
          events({ status: "open", limit: 200 }),
        ]);

        const fail = (r: PromiseSettledResult<unknown>) =>
          r.status === "rejected" ? String((r.reason as Error)?.message ?? r.reason).slice(0, 120) : null;

        const co2Latest =
          co2R.status === "fulfilled" ? summarize(co2Series(co2R.value)).latest : null;
        const co2Yoy = co2R.status === "fulfilled" ? yoy(co2Series(co2R.value)) : null;
        const tempLatest =
          tempR.status === "fulfilled" ? summarize(tempR.value.monthly).latest : null;
        const enso = oniR.status === "fulfilled" ? ensoPhase(oniR.value) : null;
        const ice = (r: typeof iceN, pole: Pole) =>
          r.status === "fulfilled" ? seaIceStatus(pole, r.value[0], r.value[1]) : null;
        const arctic = ice(iceN, "north");
        const antarctic = ice(iceS, "south");
        const quakeList = quakeR.status === "fulfilled" ? quakeR.value : null;
        const strongest = quakeList?.reduce(
          (a, b) => ((b.mag ?? 0) > (a?.mag ?? 0) ? b : a),
          quakeList[0] ?? null,
        );
        const openEvents = eventsR.status === "fulfilled" ? eventsR.value : null;

        const metrics = [
          {
            label: "CO₂",
            value: co2Latest ? `${co2Latest.v} ppm` : "unavailable",
            sub: co2Latest ? `${co2Latest.t} · ${co2Yoy != null ? `+${co2Yoy} YoY` : ""}` : fail(co2R) ?? "",
          },
          {
            label: "Global temp",
            value: tempLatest ? `+${tempLatest.v} °C` : "unavailable",
            sub: tempLatest ? `${tempLatest.t} vs 1951–80` : fail(tempR) ?? "",
          },
          {
            label: "ENSO",
            value: enso ? enso.phase : "unavailable",
            sub: enso ? `ONI ${enso.latest.anom >= 0 ? "+" : ""}${enso.latest.anom} (${enso.latest.season} ${enso.latest.year})` : fail(oniR) ?? "",
          },
          {
            label: "Arctic ice",
            value: arctic ? `${arctic.latest.v} M km²` : "unavailable",
            sub: arctic?.anomalyVsAverage != null ? `${arctic.anomalyVsAverage >= 0 ? "+" : ""}${arctic.anomalyVsAverage} vs 81–10` : fail(iceN) ?? "",
          },
          {
            label: "Antarctic ice",
            value: antarctic ? `${antarctic.latest.v} M km²` : "unavailable",
            sub: antarctic?.anomalyVsAverage != null ? `${antarctic.anomalyVsAverage >= 0 ? "+" : ""}${antarctic.anomalyVsAverage} vs 81–10` : fail(iceS) ?? "",
          },
          {
            label: "Quakes M5+ (7d)",
            value: quakeList ? String(quakeList.length) : "unavailable",
            sub: strongest ? `max M${strongest.mag} ${strongest.place}` : fail(quakeR) ?? "",
          },
          {
            label: "Open disasters",
            value: openEvents ? String(openEvents.length) : "unavailable",
            sub: openEvents ? "NASA EONET, open events" : fail(eventsR) ?? "",
          },
        ];

        const pushed = await pushCard({
          id: newId(),
          type: "pulse",
          ts: nowIso(),
          title: `Planet pulse · ${today}`,
          payload: { metrics },
        });
        return {
          asOf: today,
          co2: co2Latest ? { ...co2Latest, yoyPpm: co2Yoy, source: CO2_SOURCE } : { error: fail(co2R) },
          globalTemp: tempLatest ? { ...tempLatest, baseline: "1951–1980", source: GISTEMP_SOURCE } : { error: fail(tempR) },
          enso: enso
            ? { phase: enso.phase, oni: enso.latest.anom, season: `${enso.latest.season} ${enso.latest.year}`, meetsEventDefinition: enso.meetsEventDefinition }
            : { error: fail(oniR) },
          seaIce: {
            arctic: arctic ? { extent: arctic.latest.v, date: arctic.latest.t, anomaly: arctic.anomalyVsAverage, belowP10: arctic.belowP10 } : { error: fail(iceN) },
            antarctic: antarctic ? { extent: antarctic.latest.v, date: antarctic.latest.t, anomaly: antarctic.anomalyVsAverage, belowP10: antarctic.belowP10 } : { error: fail(iceS) },
            source: NSIDC_SOURCE,
          },
          earthquakesM5Last7d: quakeList
            ? { count: quakeList.length, strongest: strongest ? { mag: strongest.mag, place: strongest.place, time: strongest.time } : null }
            : { error: fail(quakeR) },
          openDisasterEvents: openEvents ? { count: openEvents.length } : { error: fail(eventsR) },
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );
}

/** Day-of-year (1-based) from YYYY-MM-DD, UTC. */
function dayIndex(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  return Math.round((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000);
}
