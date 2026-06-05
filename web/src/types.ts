export type BBox = [number, number, number, number]; // west, south, east, north

export interface Card {
  id: string;
  type: "imagery" | "index" | "fires" | "events" | "compare" | "search";
  ts: string;
  title: string;
  bbox?: BBox;
  payload: Record<string, unknown>;
  imageUrl?: string;
}

export interface EventItem {
  id: string;
  title: string;
  category: string;
  coordinates: [number, number] | null;
  lastDate: string | null;
  magnitude: string | null;
  link: string;
}
