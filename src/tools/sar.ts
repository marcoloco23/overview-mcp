import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCopernicus, type DataSourceSpec } from "../clients/copernicus.js";
import { SAR_EVALSCRIPTS, sarWaterEvalscript } from "../evalscripts.js";
import { pushCard } from "../dashboard/push.js";
import { sarProvenance } from "../provenance.js";
import { imageResult, safe, safeResult } from "../result.js";
import type { BBox } from "../types.js";
import { addDays, clampWidth, heightFor, isoDate, newId, nowIso } from "../util.js";

/** Build the Sentinel-1 GRD data source (GAMMA0 terrain-corrected), optionally orbit-limited. */
function sarSource(orbitDirection?: string): DataSourceSpec {
  return {
    collection: "sentinel-1-grd",
    mosaickingOrder: "mostRecent",
    dataFilter: {
      acquisitionMode: "IW",
      polarization: "DV", // dual VV+VH
      resolution: "HIGH",
      ...(orbitDirection ? { orbitDirection } : {}),
    },
    processing: { orthorectify: true, backCoeff: "GAMMA0_TERRAIN" },
  };
}

export interface FloodSummary {
  waterPctBefore: number;
  waterPctAfter: number;
  floodDeltaPct: number; // after − before, in percentage points of the AOI
  validPctBefore: number;
  validPctAfter: number;
  thresholdDb: number;
  lowQuality: boolean;
  interpretation: string;
}

/**
 * Pure summary of a two-date SAR water comparison (flood onset). Positive Δ over a short
 * window suggests new water (flooding); negative means water receded. Kept pure so it can be
 * unit-tested without the network.
 */
export function floodResult(p: {
  beforePct: number;
  afterPct: number;
  validBefore: number;
  validAfter: number;
  thresholdDb: number;
  dateBefore: string;
  dateAfter: string;
}): FloodSummary {
  const floodDeltaPct = Math.round((p.afterPct - p.beforePct) * 10) / 10;
  const lowQuality = Math.min(p.validBefore, p.validAfter) < 60;
  const dir = floodDeltaPct > 0 ? "increased" : floodDeltaPct < 0 ? "receded" : "was unchanged";
  const interpretation =
    `Water extent ${dir} by ${Math.abs(floodDeltaPct)} pts of the AOI ` +
    `(${p.beforePct}% → ${p.afterPct}%) from ${p.dateBefore} to ${p.dateAfter}, ` +
    `VV γ⁰ < ${p.thresholdDb} dB (valid pixels ${p.validBefore}% / ${p.validAfter}%).` +
    (floodDeltaPct > 0 ? ` Positive Δ over a short window suggests flooding.` : ``) +
    (lowQuality ? ` ⚠️ Low valid coverage on at least one date — treat with caution.` : ``);
  return {
    waterPctBefore: p.beforePct,
    waterPctAfter: p.afterPct,
    floodDeltaPct,
    validPctBefore: p.validBefore,
    validPctAfter: p.validAfter,
    thresholdDb: p.thresholdDb,
    lowQuality,
    interpretation,
  };
}

const bboxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .describe("Bounding box [west, south, east, north] in degrees (EPSG:4326)");

const SAR_VIEWS = Object.keys(SAR_EVALSCRIPTS) as [string, ...string[]];

/** Register the Sentinel-1 SAR tool: sar_render. Needs CDSE creds. */
export function registerSarTools(server: McpServer): void {
  server.registerTool(
    "sar_render",
    {
      title: "Sentinel-1 SAR imagery (all-weather)",
      description:
        "Render Sentinel-1 C-band SAR backscatter for a bbox via Copernicus — ALL-WEATHER " +
        "radar that sees through cloud, smoke, and at night, where optical (eo_render) is " +
        "blind. view: falseColor (VV/VH/ratio — urban bright, vegetation greenish, calm water " +
        "dark), vv, or vh. Uses the most recent scene in a lookback window; GAMMA0 " +
        "terrain-corrected. Requires CDSE creds. Returns the image + provenance, posts to the " +
        "dashboard.",
      inputSchema: {
        bbox: bboxSchema,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date YYYY-MM-DD (default today)."),
        view: z.enum(SAR_VIEWS).optional().describe("falseColor (default), vv, or vh."),
        windowDays: z.number().int().min(1).max(90).optional().describe("Lookback for the most-recent scene (default 14)."),
        orbitDirection: z.enum(["ASCENDING", "DESCENDING"]).optional().describe("Restrict to one orbit direction (compare like with like)."),
        width: z.number().int().min(64).max(2048).optional().describe("Image width px (default 1024)."),
      },
    },
    async ({ bbox, date, view, windowDays, orbitDirection, width }) =>
      safeResult(async () => {
        const client = getCopernicus();
        const box = bbox as BBox;
        const v = view ?? "falseColor";
        const dateTo = date ?? isoDate(0);
        const dateFrom = addDays(dateTo, -(windowDays ?? 14));
        const w = clampWidth(width ?? 1024);
        const h = heightFor(box, w);
        const polarization = "DV"; // dual VV+VH so every view works

        const png = await client.process(box, {
          dateFrom,
          dateTo,
          evalscript: SAR_EVALSCRIPTS[v]!,
          width: w,
          height: h,
          source: sarSource(orbitDirection),
        });
        const dataBase64 = png.toString("base64");
        const provenance = sarProvenance({ bbox: box, from: dateFrom, to: dateTo, polarization, orbitDirection });
        const meta = {
          source: "Copernicus Sentinel-1 GRD",
          view: v,
          window: { from: dateFrom, to: dateTo },
          bbox: box,
          dimensions: { width: w, height: h },
          provenance,
          dashboard: (await pushCard({
            id: newId(),
            type: "imagery",
            ts: nowIso(),
            title: `Sentinel-1 SAR ${v} · ${dateFrom}…${dateTo}`,
            bbox: box,
            payload: { source: "Copernicus Sentinel-1 GRD", view: v, provenance },
            image: { mimeType: "image/png", dataBase64 },
          }))
            ? "pushed"
            : "dashboard offline",
        };
        return imageResult(dataBase64, "image/png", meta);
      }),
  );

  // ---- sar_water: all-weather water/flood extent --------------------------------------
  server.registerTool(
    "sar_water",
    {
      title: "SAR water / flood extent (Sentinel-1)",
      description:
        "Estimate the water-covered fraction of a bbox from Sentinel-1 SAR — water and smooth " +
        "surfaces reflect radar away from the sensor, so low VV backscatter marks water. " +
        "All-weather: works through cloud and at night, when optical flood mapping fails. " +
        "Returns the water % of the AOI, % valid pixels, the threshold used, and provenance. " +
        "Tune thresholdDb per scene/orbit; compare like orbit directions. Requires CDSE creds.",
      inputSchema: {
        bbox: bboxSchema,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date YYYY-MM-DD (default today)."),
        windowDays: z.number().int().min(1).max(90).optional().describe("Lookback for the most-recent scene (default 14)."),
        thresholdDb: z.number().min(-30).max(0).optional().describe("VV γ⁰ cutoff in dB below which a pixel is water (default -17)."),
        orbitDirection: z.enum(["ASCENDING", "DESCENDING"]).optional().describe("Restrict to one orbit direction (compare like with like)."),
      },
    },
    async ({ bbox, date, windowDays, thresholdDb, orbitDirection }) =>
      safe(async () => {
        const client = getCopernicus();
        const box = bbox as BBox;
        const dateTo = date ?? isoDate(0);
        const dateFrom = addDays(dateTo, -(windowDays ?? 14));
        const db = thresholdDb ?? -17;
        const threshLinear = Math.pow(10, db / 10);

        const stats = await client.statistics(box, {
          dateFrom,
          dateTo,
          evalscript: sarWaterEvalscript(threshLinear),
          source: sarSource(orbitDirection),
        });
        const waterFractionPct = Math.round(stats.mean * 1000) / 10; // mean of the 0/1 band → %
        const provenance = sarProvenance({ bbox: box, from: dateFrom, to: dateTo, polarization: "DV", orbitDirection });

        const lowQuality = stats.validPct < 60;
        const pushed = await pushCard({
          id: newId(),
          type: "index",
          ts: nowIso(),
          title: `SAR water ${waterFractionPct}% · ${dateFrom}…${dateTo}`,
          bbox: box,
          payload: {
            index: "WATER",
            stats,
            window: { from: dateFrom, to: dateTo },
            provenance,
          },
        });
        return {
          waterFractionPct,
          validPct: stats.validPct,
          thresholdDb: db,
          window: { from: dateFrom, to: dateTo },
          provenance,
          interpretation:
            `${waterFractionPct}% of the AOI reads as water/smooth surface ` +
            `(VV γ⁰ < ${db} dB) on the most-recent Sentinel-1 pass in ${dateFrom}…${dateTo} ` +
            `(${stats.validPct}% valid pixels).` +
            (lowQuality ? ` ⚠️ Low valid coverage — treat with caution.` : ``),
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );

  // ---- sar_flood: water-extent change between two dates (flood onset) -----------------
  server.registerTool(
    "sar_flood",
    {
      title: "SAR flood onset (Sentinel-1, two dates)",
      description:
        "Compare Sentinel-1 water extent at two dates to find newly-flooded area: water % " +
        "before vs after, and the change (positive Δ over a short window = flooding). " +
        "All-weather, so it works for storm/monsoon events that optical can't see through. " +
        "Use a pre-event baseline as dateBefore and a post-event date as dateAfter; compare " +
        "like orbit directions. Requires CDSE creds.",
      inputSchema: {
        bbox: bboxSchema,
        dateBefore: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Pre-event (baseline) date YYYY-MM-DD."),
        dateAfter: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Post-event date YYYY-MM-DD."),
        windowDays: z.number().int().min(1).max(60).optional().describe("Lookback per date for the most-recent scene (default 12)."),
        thresholdDb: z.number().min(-30).max(0).optional().describe("VV γ⁰ cutoff in dB below which a pixel is water (default -17)."),
        orbitDirection: z.enum(["ASCENDING", "DESCENDING"]).optional().describe("Restrict to one orbit direction (compare like with like)."),
      },
    },
    async ({ bbox, dateBefore, dateAfter, windowDays, thresholdDb, orbitDirection }) =>
      safe(async () => {
        const client = getCopernicus();
        const box = bbox as BBox;
        const win = windowDays ?? 12;
        const db = thresholdDb ?? -17;
        const evalscript = sarWaterEvalscript(Math.pow(10, db / 10));
        const source = sarSource(orbitDirection);

        const one = async (date: string) => {
          const from = addDays(date, -win);
          const stats = await client.statistics(box, { dateFrom: from, dateTo: date, evalscript, source });
          return { date, from, pct: Math.round(stats.mean * 1000) / 10, stats };
        };
        const [b, a] = await Promise.all([one(dateBefore), one(dateAfter)]);

        const summary = floodResult({
          beforePct: b.pct,
          afterPct: a.pct,
          validBefore: b.stats.validPct,
          validAfter: a.stats.validPct,
          thresholdDb: db,
          dateBefore,
          dateAfter,
        });
        const provenanceBefore = sarProvenance({ bbox: box, from: b.from, to: dateBefore, polarization: "DV", orbitDirection });
        const provenanceAfter = sarProvenance({ bbox: box, from: a.from, to: dateAfter, polarization: "DV", orbitDirection });

        const sign = summary.floodDeltaPct >= 0 ? "+" : "";
        const pushed = await pushCard({
          id: newId(),
          type: "index",
          ts: nowIso(),
          title: `SAR flood ${sign}${summary.floodDeltaPct}% · ${dateBefore}→${dateAfter}`,
          bbox: box,
          payload: {
            index: "WATER Δ",
            stats: a.stats,
            window: { before: { from: b.from, to: dateBefore }, after: { from: a.from, to: dateAfter } },
            provenanceA: provenanceBefore,
            provenanceB: provenanceAfter,
            dateA: dateBefore,
            dateB: dateAfter,
          },
        });
        return {
          ...summary,
          window: { before: { from: b.from, to: dateBefore }, after: { from: a.from, to: dateAfter } },
          provenanceBefore,
          provenanceAfter,
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );
}
