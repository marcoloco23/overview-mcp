import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_COLLECTION, stacSearch } from "../clients/stac.js";
import { stacUrl } from "../config.js";
import { pushCard } from "../dashboard/push.js";
import { safe } from "../result.js";
import type { BBox } from "../types.js";
import { addDays, isoDate, newId, nowIso } from "../util.js";

const bboxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .describe("Bounding box [west, south, east, north] in degrees (EPSG:4326)");

/** Register the open STAC search tool: stac_search (Earth Search, no API key). */
export function registerStacTools(server: McpServer): void {
  server.registerTool(
    "stac_search",
    {
      title: "Open STAC scene search (Earth Search, no key)",
      description:
        "Search open satellite archives for scenes intersecting a bbox over a date range via " +
        "the Earth Search (Element 84) STAC API — NO API KEY. Returns scene ids, dates, cloud " +
        "cover, and Cloud-Optimized GeoTIFF (COG) asset URLs (the raw bands). A " +
        "provider-independent companion to eo_search (Copernicus): use it when you have no " +
        "CDSE creds, or to get direct COG links. Common collections: sentinel-2-l2a (default), " +
        "sentinel-2-l1c, sentinel-1-grd, landsat-c2-l2. Posts a search card to the dashboard.",
      inputSchema: {
        bbox: bboxSchema,
        dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date (default 30 days ago)."),
        dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date (default today)."),
        collection: z.string().min(1).optional().describe(`STAC collection (default ${DEFAULT_COLLECTION}).`),
        maxCloud: z.number().min(0).max(100).optional().describe("Drop scenes cloudier than this %%."),
        limit: z.number().int().min(1).max(50).optional().describe("Max scenes (default 8)."),
      },
    },
    async ({ bbox, dateFrom, dateTo, collection, maxCloud, limit }) =>
      safe(async () => {
        const box = bbox as BBox;
        const to = dateTo ?? isoDate(0);
        const from = dateFrom ?? addDays(to, -30);
        const { endpoint, collection: coll, scenes } = await stacSearch({
          bbox: box,
          dateFrom: from,
          dateTo: to,
          collection,
          maxCloud,
          limit,
        });
        const source = endpoint.includes("element84")
          ? "Earth Search (Element 84) — open STAC, anonymous"
          : `STAC: ${endpoint}`;
        const pushed = await pushCard({
          id: newId(),
          type: "search",
          ts: nowIso(),
          title: `${scenes.length} ${coll} scene(s) · ${from}…${to}`,
          bbox: box,
          payload: { scenes, window: { from, to }, source, collection: coll, endpoint },
        });
        return {
          source,
          endpoint,
          collection: coll,
          window: { from, to },
          count: scenes.length,
          scenes,
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );
}
