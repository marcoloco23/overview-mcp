import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { snapshot, SNAPSHOT_LAYERS } from "../clients/nasa.js";
import { pushCard } from "../dashboard/push.js";
import { imageResult, safeResult } from "../result.js";
import type { BBox } from "../types.js";
import { isoDate, newId, nowIso } from "../util.js";

const bboxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .describe("Bounding box as [west, south, east, north] in degrees (EPSG:4326 lon/lat)");

/** Register imagery tools. Phase 1: eo_snapshot (no key). */
export function registerImageryTools(server: McpServer): void {
  server.registerTool(
    "eo_snapshot",
    {
      title: "Satellite snapshot (no API key)",
      description:
        "Render a satellite image of a bounding box from NASA Worldview/GIBS (MODIS/VIIRS). " +
        "No API key required. Good for a fast 'show me this place' view, recent wildfires " +
        "(layers='fires'), or false-color (layers='falseColor'). Returns the image plus " +
        "metadata, and posts it to the dashboard. Defaults to yesterday (most complete day).",
      inputSchema: {
        bbox: bboxSchema,
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Date YYYY-MM-DD (UTC). Defaults to yesterday."),
        layers: z
          .enum(Object.keys(SNAPSHOT_LAYERS) as [string, ...string[]])
          .optional()
          .describe("View: trueColor (default), trueColorModis, falseColor, or fires."),
        width: z.number().int().min(64).max(2048).optional().describe("Image width px (default 1024)."),
      },
    },
    async ({ bbox, date, layers, width }) =>
      safeResult(async () => {
        const box = bbox as BBox;
        const day = date ?? isoDate(1);
        const result = await snapshot(box, day, layers ?? "trueColor", width ?? 1024);
        const id = newId();
        const meta = {
          source: result.attribution,
          date: result.date,
          layers: result.layers,
          bbox: box,
          dimensions: { width: result.width, height: result.height },
          dashboard: await pushCard({
            id,
            type: "imagery",
            ts: nowIso(),
            title: `Snapshot ${day} · ${(layers ?? "trueColor")}`,
            bbox: box,
            payload: { date: day, layers: result.layers, source: result.attribution },
            image: { mimeType: result.mimeType, dataBase64: result.dataBase64 },
          })
            ? "pushed"
            : "dashboard offline",
        };
        return imageResult(result.dataBase64, result.mimeType, meta);
      }),
  );
}
