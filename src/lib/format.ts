import type { PriceLevel } from "./types";

/** Haversine distance in meters. */
export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10}m`;
  return `${(m / 1000).toFixed(1)}km`;
}

/** Rough walking time at ~67 m/min. */
export function walkMinutes(m: number): number {
  return Math.max(1, Math.round(m / 67));
}

const PRICE_STEPS: Record<PriceLevel, number> = {
  FREE: 0,
  INEXPENSIVE: 1,
  MODERATE: 2,
  EXPENSIVE: 3,
  VERY_EXPENSIVE: 4,
};

/** Number of ₩ signs (0–4), or null when unknown. */
export function priceSteps(level: PriceLevel | null): number | null {
  return level ? PRICE_STEPS[level] : null;
}

export const PRICE_TEXT: Record<PriceLevel, string> = {
  FREE: "무료",
  INEXPENSIVE: "저렴",
  MODERATE: "보통",
  EXPENSIVE: "비쌈",
  VERY_EXPENSIVE: "매우 비쌈",
};
