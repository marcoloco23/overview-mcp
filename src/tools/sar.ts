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
}
