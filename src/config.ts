// Centralized environment configuration.

export const SERVER_NAME = "overview-mcp";
export const SERVER_VERSION = "0.1.0";

/** Descriptive User-Agent — required/encouraged by NASA and Nominatim. */
export const USER_AGENT =
  "overview-mcp/0.1.0 (+https://github.com/marcoloco23/overview-mcp)";

/** Where tools push dashboard cards. */
export function dashboardUrl(): string {
  return process.env.OVERVIEW_DASHBOARD_URL ?? `http://127.0.0.1:${dashboardPort()}`;
}

/** Port the dashboard server listens on. */
export function dashboardPort(): number {
  const raw = process.env.OVERVIEW_DASHBOARD_PORT;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : 5005;
}

export interface CdseCreds {
  clientId: string;
  clientSecret: string;
}

/** Copernicus Data Space OAuth client, or null if not configured. */
export function cdseCreds(): CdseCreds | null {
  const clientId = process.env.CDSE_CLIENT_ID;
  const clientSecret = process.env.CDSE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** NASA FIRMS map key, or null if not configured. */
export function firmsMapKey(): string | null {
  return process.env.FIRMS_MAP_KEY ?? null;
}
