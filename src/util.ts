import { randomUUID } from "node:crypto";
import type { BBox } from "./types.js";

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** YYYY-MM-DD for `daysAgo` days before now (UTC). 0 = today, 1 = yesterday. */
export function isoDate(daysAgo = 0): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Validate that a bbox is well-formed: west<east, south<north, within world bounds. */
export function assertBBox(bbox: BBox): void {
  const [west, south, east, north] = bbox;
  if (![west, south, east, north].every(Number.isFinite)) {
    throw new Error(`bbox must be four finite numbers, got ${JSON.stringify(bbox)}`);
  }
  if (west >= east) throw new Error(`bbox west (${west}) must be < east (${east})`);
  if (south >= north) throw new Error(`bbox south (${south}) must be < north (${north})`);
  if (west < -180 || east > 180 || south < -90 || north > 90) {
    throw new Error(`bbox out of bounds: ${JSON.stringify(bbox)} (lon −180..180, lat −90..90)`);
  }
}

/**
 * Pick an integer image height from a width and a bbox, preserving aspect ratio so the
 * picture isn't stretched. Clamped to [64, maxDim].
 */
export function heightFor(bbox: BBox, width: number, maxDim = 2048): number {
  const [west, south, east, north] = bbox;
  const lonSpan = east - west;
  const latSpan = north - south;
  const ratio = lonSpan > 0 ? latSpan / lonSpan : 1;
  const h = Math.round(width * ratio);
  return Math.max(64, Math.min(maxDim, h));
}

/** Clamp a requested image width to a sane range. */
export function clampWidth(width: number, maxDim = 2048): number {
  if (!Number.isFinite(width)) return 1024;
  return Math.max(64, Math.min(maxDim, Math.round(width)));
}

/** Center [lon, lat] of a bbox. */
export function bboxCenter(bbox: BBox): [number, number] {
  const [west, south, east, north] = bbox;
  return [(west + east) / 2, (south + north) / 2];
}
