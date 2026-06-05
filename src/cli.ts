#!/usr/bin/env node
import { runMcp } from "./index.js";
import { startDashboard } from "./dashboard/server.js";
import { dashboardPort } from "./config.js";

function main(): void {
  const cmd = process.argv[2];

  if (cmd === "dashboard") {
    // Optional explicit port: `overview-mcp dashboard 5005`
    const portArg = process.argv[3];
    const port = portArg ? Number.parseInt(portArg, 10) : dashboardPort();
    startDashboard(Number.isFinite(port) ? port : dashboardPort());
    return;
  }

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(
      [
        "overview-mcp — Earth-observation MCP server + live dashboard",
        "",
        "Usage:",
        "  overview-mcp              start the MCP server on stdio (for Claude Code/Desktop)",
        "  overview-mcp dashboard    start the dashboard server (default :5005)",
        "  overview-mcp dashboard <port>",
        "",
        "Env: CDSE_CLIENT_ID, CDSE_CLIENT_SECRET, FIRMS_MAP_KEY,",
        "     OVERVIEW_DASHBOARD_URL, OVERVIEW_DASHBOARD_PORT",
        "",
      ].join("\n"),
    );
    return;
  }

  void runMcp().catch((err: unknown) => {
    process.stderr.write((err instanceof Error ? (err.stack ?? err.message) : String(err)) + "\n");
    process.exit(1);
  });
}

main();
