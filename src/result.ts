import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OverviewError } from "./errors.js";

/** Wrap an arbitrary JSON-serializable value as a text tool result. */
export function jsonText(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** An image result plus a text block of metadata, so Claude gets pixels and numbers. */
export function imageResult(
  dataBase64: string,
  mimeType: string,
  meta: unknown,
): CallToolResult {
  return {
    content: [
      { type: "image", data: dataBase64, mimeType },
      { type: "text", text: JSON.stringify(meta, null, 2) },
    ],
  };
}

/** Format any thrown value as an error tool result. */
export function errorResult(err: unknown): CallToolResult {
  const detail =
    err instanceof OverviewError
      ? { error: err.message, status: err.status, body: err.body }
      : { error: err instanceof Error ? err.message : String(err) };
  return {
    content: [{ type: "text", text: JSON.stringify(detail, null, 2) }],
    isError: true,
  };
}

/** Run a JSON-returning tool body, formatting success and errors uniformly. */
export async function safe<T>(fn: () => Promise<T>): Promise<CallToolResult> {
  try {
    return jsonText(await fn());
  } catch (err) {
    return errorResult(err);
  }
}

/** Run a tool body that builds its own CallToolResult (e.g. images), catching errors. */
export async function safeResult(
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return errorResult(err);
  }
}
