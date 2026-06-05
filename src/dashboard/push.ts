import { dashboardUrl } from "../config.js";
import type { IngestPayload } from "../types.js";

const PUSH_TIMEOUT_MS = 1500;

/**
 * Best-effort push of a card to the dashboard server. NEVER throws and never blocks a
 * tool for long: if the dashboard is off or slow, we time out and silently give up. The
 * tool's result to Claude is unaffected.
 *
 * @returns true if the dashboard acknowledged, false otherwise.
 */
export async function pushCard(card: IngestPayload): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const res = await fetch(`${dashboardUrl()}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(card),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false; // dashboard not running / unreachable / timed out — that's fine
  } finally {
    clearTimeout(timer);
  }
}
