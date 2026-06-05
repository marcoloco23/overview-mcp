import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { events } from "../clients/nasa.js";
import { pushCard } from "../dashboard/push.js";
import { safe } from "../result.js";
import type { BBox } from "../types.js";
import { bboxCenter, newId, nowIso } from "../util.js";

const bboxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .optional()
  .describe("Optional bbox [west, south, east, north] to restrict to a region");

/** Register live-event tools. Phase 1: events (no key). */
export function registerEventsTools(server: McpServer): void {
  server.registerTool(
    "events",
    {
      title: "Live natural-disaster events (no API key)",
      description:
        "List current natural events worldwide from NASA EONET — wildfires, severe storms, " +
        "volcanoes, floods, icebergs, dust/haze. No API key. Optionally restrict by bbox, " +
        "category, or recency. Returns a normalized list and posts an events card to the dashboard.",
      inputSchema: {
        status: z.enum(["open", "closed", "all"]).optional().describe("Default 'open' (active)."),
        category: z
          .string()
          .optional()
          .describe("EONET category id, e.g. wildfires, severeStorms, volcanoes, floods."),
        bbox: bboxSchema,
        days: z.number().int().min(1).max(365).optional().describe("Look back N days (default 30)."),
        limit: z.number().int().min(1).max(200).optional().describe("Max events (default 50)."),
      },
    },
    async ({ status, category, bbox, days, limit }) =>
      safe(async () => {
        const box = bbox as BBox | undefined;
        const list = await events({
          status: status ?? "open",
          category,
          bbox: box,
          days: days ?? 30,
          limit: limit ?? 50,
        });

        const pushed = await pushCard({
          id: newId(),
          type: "events",
          ts: nowIso(),
          title: `${list.length} ${status ?? "open"} event(s)${category ? " · " + category : ""}`,
          bbox: box,
          payload: {
            events: list.map((e) => ({
              id: e.id,
              title: e.title,
              category: e.category,
              coordinates: e.coordinates,
              lastDate: e.lastDate,
              magnitude: e.magnitude,
              link: e.link,
            })),
          },
        });

        return {
          count: list.length,
          dashboard: pushed ? "pushed" : "dashboard offline",
          events: list,
          center: box ? bboxCenter(box) : undefined,
        };
      }),
  );
}
