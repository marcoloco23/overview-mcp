// Shared domain types for overview-mcp.

/** Bounding box as [west, south, east, north] in EPSG:4326 lon/lat degrees. */
export type BBox = [number, number, number, number];

export type CardType =
  | "imagery"
  | "index"
  | "fires"
  | "events"
  | "compare"
  | "search";

/** A unit of visual output streamed to the dashboard. */
export interface Card {
  id: string;
  type: CardType;
  ts: string; // ISO timestamp
  title: string;
  bbox?: BBox;
  payload: Record<string, unknown>;
  imageUrl?: string; // set by the dashboard server when an image was attached
}

/** What a tool POSTs to the dashboard /ingest endpoint (image inlined as base64). */
export interface IngestPayload extends Omit<Card, "imageUrl"> {
  image?: {
    mimeType: string;
    dataBase64: string;
  };
}

/** A normalized EONET natural-disaster event. */
export interface EonetEvent {
  id: string;
  title: string;
  category: string;
  closed: boolean;
  lastDate: string | null;
  coordinates: [number, number] | null; // [lon, lat] of the latest geometry point
  magnitude: string | null;
  link: string;
}

/** A normalized FIRMS active-fire detection. */
export interface FireDetection {
  lat: number;
  lon: number;
  brightness: number | null;
  confidence: string | number | null;
  acqDate: string;
  acqTime: string | null;
  frp: number | null; // fire radiative power
  satellite: string | null;
}
