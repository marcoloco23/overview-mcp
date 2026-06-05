import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { registerImageryTools } from "./tools/imagery.js";
import { registerEventsTools } from "./tools/events.js";
import { registerFireTools } from "./tools/fires.js";

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Earth-observation tools over free, open data. Give yourself eyes on Earth: render " +
        "satellite imagery for a bounding box, list live natural-disaster events, (and with " +
        "keys) compute vegetation/water/burn indices, find active fires, and compare a place " +
        "across two dates. Bounding boxes are [west, south, east, north] in degrees. Results " +
        "also stream to a local dashboard if one is running (best-effort).",
    },
  );

  registerImageryTools(server);
  registerEventsTools(server);
  registerFireTools(server);
  // Later phases register: eo_search/eo_render/eo_index, eo_compare, geo_resolve.

  return server;
}

export async function runMcp(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = () => void server.close().finally(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.stderr.write(`${SERVER_NAME} v${SERVER_VERSION} running on stdio\n`);
}
