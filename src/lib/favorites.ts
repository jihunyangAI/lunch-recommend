"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { Restaurant } from "./types";

/**
 * Favorites live in this browser's localStorage (no account needed).
 * We keep a snapshot of each restaurant so the favorites list still works
 * after the user moves somewhere the place no longer shows up in search.
 */
export type FavoriteRestaurant = Omit<Restaurant, "no" | "distance"> & { savedAt: number };

const KEY = "lunch-recommend:favorites:v1";
const EMPTY: FavoriteRestaurant[] = [];

let cache: FavoriteRestaurant[] | null = null;
const listeners = new Set<() => void>();

function isFavorite(x: unknown): x is FavoriteRestaurant {
  const f = x as FavoriteRestaurant;
  return !!f && typeof f.id === "string" && typeof f.name === "string" && typeof f.lat === "number" && typeof f.lng === "number";
}

function read(): FavoriteRestaurant[] {
  if (cache) return cache;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    cache = Array.isArray(parsed) ? parsed.filter(isFavorite) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(list: FavoriteRestaurant[]) {
  cache = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable (private mode / quota): keep the in-memory copy for this session.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Keep other tabs in sync.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    cache = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useFavorites() {
  const favorites = useSyncExternalStore(subscribe, read, () => EMPTY);
  const ids = useMemo(() => new Set(favorites.map((f) => f.id)), [favorites]);

  const toggle = useCallback((r: Restaurant) => {
    const list = read();
    if (list.some((f) => f.id === r.id)) {
      write(list.filter((f) => f.id !== r.id));
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { no, distance, ...snapshot } = r;
      write([{ ...snapshot, savedAt: Date.now() }, ...list]);
    }
  }, []);

  return { favorites, isFavorite: (id: string) => ids.has(id), toggle };
}
