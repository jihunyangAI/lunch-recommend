"use client";

import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
const STORAGE_KEY = "theme";

/**
 * Runs inline in <head> before first paint so the page never flashes the wrong theme.
 * Saved choice wins; otherwise follow the OS setting.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("${STORAGE_KEY}");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t}catch(e){}})()`;

function read(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function subscribe(onChange: () => void) {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => obs.disconnect();
}

export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {
    // private mode etc. — the toggle still works for this visit
  }
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => "light");
}

/** Current theme outside React (e.g. inside an effect that must not depend on it). */
export const currentTheme = read;
