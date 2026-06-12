import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { quakes } from "../clients/usgs.js";
import { pushCard } from "../dashboard/push.js";
import { safe } from "../result.js";
import type { BBox } from "../types.js";
import { addDays, isoDate, newId, nowIso } from "../util.js";

const USGS_SOURCE = "USGS Earthquake Hazards Program (FDSN event service)";

/** Register the earthquake tool: quakes (USGS, no key). */
export function registerQuakeTools(server: McpServer): void {
  server.registerTool(
    "quakes",
    {
      title: "Earthquakes (USGS, real-time)",
      description:
        "Recent earthquakes from the USGS catalog, no key: optionally constrain to a bbox, " +
        "set a magnitude floor and a day range. Returns magnitude, place, time, depth, " +
        "tsunami flag, and PAGER alert level per event, ordered by recency. Posts a map card " +
        "with magnitude-scaled markers to the dashboard.",
      inputSchema: {
        bbox: z
          .tuple([z.number(), z.number(), z.number(), z.number()])
          .optional()
          .describe("Bounding box [west, south, east, north] in degrees (default: worldwide)."),
        minMagnitude: z.number().min(0).max(10).optional().describe("Magnitude floor (default 4.5)."),
        days: z.number().int().min(1).max(365).optional().describe("Look back this many days (default 7)."),
        limit: z.number().int().min(1).max(500).optional().describe("Max events (default 100)."),
      },
    },
    async ({ bbox, minMagnitude, days, limit }) =>
      safe(async () => {
        const start = addDays(isoDate(0), -(days ?? 7));
        const list = await quakes({
          bbox: bbox as BBox | undefined,
          minMagnitude: minMagnitude ?? 4.5,
          start,
          limit: limit ?? 100,
        });
        const strongest = list.reduce(
          (a, b) => ((b.mag ?? 0) > (a?.mag ?? 0) ? b : a),
          list[0] ?? null,
        );
        const pushed = await pushCard({
          id: newId(),
          type: "quakes",
          ts: nowIso(),
          title: `${list.length} quake(s) M≥${minMagnitude ?? 4.5} · last ${days ?? 7}d`,
          ...(bbox ? { bbox: bbox as BBox } : {}),
          payload: {
            quakes: list.map((q) => ({
              lon: q.lon,
              lat: q.lat,
              mag: q.mag,
              place: q.place,
              time: q.time,
              depthKm: q.depthKm,
            })),
            total: list.length,
            maxMag: strongest?.mag ?? null,
            source: USGS_SOURCE,
          },
        });
        return {
          source: USGS_SOURCE,
          window: { from: start, to: isoDate(0) },
          count: list.length,
          strongest: strongest
            ? { mag: strongest.mag, place: strongest.place, time: strongest.time, url: strongest.url }
            : null,
          quakes: list,
          dashboard: pushed ? "pushed" : "dashboard offline",
        };
      }),
  );
}
