import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getCopernicus } from "../clients/copernicus.js";
import { SAR_EVALSCRIPTS } from "../evalscripts.js";
import { pushCard } from "../dashboard/push.js";
import { sarProvenance } from "../provenance.js";
import { imageResult, safeResult } from "../result.js";
import type { BBox } from "../types.js";
import { addDays, clampWidth, heightFor, isoDate, newId, nowIso } from "../util.js";

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
          source: {
            collection: "sentinel-1-grd",
            mosaickingOrder: "mostRecent",
            dataFilter: {
              acquisitionMode: "IW",
              polarization,
              resolution: "HIGH",
              ...(orbitDirection ? { orbitDirection } : {}),
            },
            processing: { orthorectify: true, backCoeff: "GAMMA0_TERRAIN" },
          },
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
}
