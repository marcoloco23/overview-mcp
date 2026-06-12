// A small, provider-independent STAC search client. Defaults to Earth Search (Element 84),
// which is open and anonymous (no API key), so this is also a zero-setup scene-search path —
// the open counterpart to the Copernicus-OAuth eo_search. It returns Cloud-Optimized GeoTIFF
// (COG) asset URLs, the substrate later horizons read (stackstac / embeddings).
//
// parseStacFeatures() is deliberately a pure function (no network) so it can be unit-tested
// against recorded responses, mirroring parseFiresCsv() in clients/nasa.ts.

import { USER_AGENT, stacUrl } from "../config.js";
import { OverviewError } from "../errors.js";
import type { BBox } from "../types.js";
import { assertBBox } from "../util.js";

/** A single data asset (a COG band, a true-color visual, etc.) of a scene. */
export interface StacAsset {
  key: string; // e.g. "red", "nir", "scl", "visual"
  href: string; // COG / file URL
  type?: string; // media type, e.g. "image/tiff; application=geotiff; profile=cloud-optimized"
  title?: string;
}

/** A normalized STAC item (one scene). */
export interface StacScene {
  id: string;
  collection: string | null;
  datetime: string;
  cloudCover: number | null;
  bbox: BBox | null;
  assets: StacAsset[]; // data (COG) assets only
  thumbnail: string | null;
}

export interface StacSearchOpts {
  bbox: BBox;
  dateFrom: string; // YYYY-MM-DD
  dateTo: string; // YYYY-MM-DD
  collection?: string; // default sentinel-2-l2a
  maxCloud?: number;
  limit?: number;
  endpoint?: string; // override the configured STAC base URL
}

export interface StacSearchResult {
  endpoint: string;
  collection: string;
  scenes: StacScene[];
}

export const DEFAULT_COLLECTION = "sentinel-2-l2a";

interface RawFeature {
  id?: unknown;
  collection?: unknown;
  bbox?: unknown;
  properties?: { datetime?: unknown; "eo:cloud_cover"?: unknown } & Record<string, unknown>;
  assets?: Record<string, { href?: unknown; type?: unknown; title?: unknown; roles?: unknown }>;
}

/** A STAC bbox may be 4 ([w,s,e,n]) or 6 ([w,s,minz,e,n,maxz]) numbers. Normalize to 4. */
function normalizeBBox(raw: unknown): BBox | null {
  if (!Array.isArray(raw)) return null;
  const n = raw.map(Number);
  if (n.length === 4 && n.every(Number.isFinite)) return [n[0]!, n[1]!, n[2]!, n[3]!];
  if (n.length === 6 && n.every(Number.isFinite)) return [n[0]!, n[1]!, n[3]!, n[4]!];
  return null;
}

/** Pull the data (COG) assets and the thumbnail out of a STAC item's asset map. */
function splitAssets(assets: RawFeature["assets"]): { data: StacAsset[]; thumbnail: string | null } {
  const data: StacAsset[] = [];
  let thumbnail: string | null = null;
  const fallback: StacAsset[] = [];
  for (const [key, a] of Object.entries(assets ?? {})) {
    const href = typeof a?.href === "string" ? a.href : null;
    if (!href) continue;
    const roles = Array.isArray(a?.roles) ? (a.roles as unknown[]).map(String) : [];
    const type = typeof a?.type === "string" ? a.type : undefined;
    const title = typeof a?.title === "string" ? a.title : undefined;
    const isThumb = key === "thumbnail" || roles.includes("thumbnail") || roles.includes("overview");
    if (isThumb) {
      thumbnail ??= href;
      continue;
    }
    const asset: StacAsset = { key, href, ...(type ? { type } : {}), ...(title ? { title } : {}) };
    const isData = roles.includes("data") || (type?.includes("tiff") ?? false);
    if (isData) data.push(asset);
    else fallback.push(asset);
  }
  // If roles/types didn't identify any COG bands, fall back to every non-thumbnail asset.
  return { data: data.length > 0 ? data : fallback, thumbnail };
}

function toScene(raw: RawFeature): StacScene | null {
  if (typeof raw?.id !== "string") return null;
  const props = raw.properties ?? {};
  const cc = props["eo:cloud_cover"];
  const { data, thumbnail } = splitAssets(raw.assets);
  return {
    id: raw.id,
    collection: typeof raw.collection === "string" ? raw.collection : null,
    datetime: typeof props.datetime === "string" ? props.datetime : "",
    cloudCover: typeof cc === "number" && Number.isFinite(cc) ? cc : null,
    bbox: normalizeBBox(raw.bbox),
    assets: data,
    thumbnail,
  };
}

/**
 * Normalize a STAC ItemCollection (FeatureCollection) into scenes, drop the over-cloudy ones,
 * and sort least-cloudy first. Pure (no network) so it's unit-testable. Defensive: one odd
 * feature is skipped, never thrown.
 */
export function parseStacFeatures(json: unknown, maxCloud?: number): StacScene[] {
  const feats = (json as { features?: unknown })?.features;
  const list = Array.isArray(feats) ? (feats as RawFeature[]) : [];
  let scenes = list.map(toScene).filter((s): s is StacScene => s !== null);
  if (maxCloud != null) {
    scenes = scenes.filter((s) => s.cloudCover == null || s.cloudCover <= maxCloud);
  }
  scenes.sort((a, b) => (a.cloudCover ?? 101) - (b.cloudCover ?? 101));
  return scenes;
}

/** Search an open STAC API (Earth Search by default) for scenes. No API key. */
export async function stacSearch(opts: StacSearchOpts): Promise<StacSearchResult> {
  assertBBox(opts.bbox);
  const endpoint = (opts.endpoint ?? stacUrl()).replace(/\/+$/, "");
  const collection = opts.collection ?? DEFAULT_COLLECTION;
  const limit = Math.min(50, Math.max(1, opts.limit ?? 8));
  const body: Record<string, unknown> = {
    collections: [collection],
    bbox: opts.bbox,
    datetime: `${opts.dateFrom}T00:00:00Z/${opts.dateTo}T23:59:59Z`,
    limit,
  };
  // STAC `query` extension — Earth Search supports it; we also re-filter client-side.
  if (opts.maxCloud != null) body.query = { "eo:cloud_cover": { lt: opts.maxCloud } };

  const res = await fetch(`${endpoint}/search`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/geo+json",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new OverviewError(`STAC search failed (${res.status})`, res.status, text.slice(0, 300));
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OverviewError("STAC search returned a non-JSON response", res.status, text.slice(0, 200));
  }
  return { endpoint, collection, scenes: parseStacFeatures(json, opts.maxCloud) };
}
