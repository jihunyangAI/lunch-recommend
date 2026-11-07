export type PriceLevel =
  | "FREE"
  | "INEXPENSIVE"
  | "MODERATE"
  | "EXPENSIVE"
  | "VERY_EXPENSIVE";

export interface Restaurant {
  id: string;
  /** 1-based number shown on the marker and card (nearest = 1). */
  no: number;
  name: string;
  type: string;
  lat: number;
  lng: number;
  /** Straight-line distance from the user, in meters. */
  distance: number;
  rating: number | null;
  ratingCount: number;
  priceLevel: PriceLevel | null;
  address: string | null;
  mapsUrl: string | null;
}

/** What the browser sends to /api/recommend for each restaurant. */
export interface RestaurantSummary {
  id: string;
  name: string;
  type: string;
  distance: number;
  rating: number | null;
  ratingCount: number;
  priceLevel: PriceLevel | null;
}

export interface AiPick {
  id: string;
  reason: string;
}

export interface AiResult {
  model: string;
  summary: string;
  picks: AiPick[];
}
