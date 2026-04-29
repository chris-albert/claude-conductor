import { useSyncExternalStore } from "react";

export type Verbosity = "low" | "med" | "high";

export interface Settings {
  // General
  defaultModel: string;
  defaultSessionFolder: string;
  defaultVerbosity: Verbosity;
  // Theme
  editorFontSize: number;
  backgroundColor: string;
  backgroundImage: string;
  backgroundImageOpacity: number;
}

const STORAGE_KEY = "conductor-settings";

const defaults: Settings = {
  defaultModel: "claude-opus-4-6",
  defaultSessionFolder: "",
  defaultVerbosity: "med",
  editorFontSize: 12,
  backgroundColor: "#0f0f14",
  backgroundImage: "",
  backgroundImageOpacity: 0.3,
};

type Listener = () => void;

let settings: Settings = loadFromStorage();
const listeners = new Set<Listener>();

function loadFromStorage(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return { ...defaults };
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((c) => Math.min(255, Math.max(0, c)).toString(16).padStart(2, "0")).join("");
}

function lighten(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + amount, g + amount, b + amount);
}

function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function applyCSSVariables() {
  const bg = settings.backgroundColor;
  const hasImage = settings.backgroundImage.length > 0;
  const root = document.documentElement.style;

  if (hasImage) {
    // Panel transparency when an image is set.
    // The image opacity slider also affects how transparent the panels are,
    // so you can actually see the image through them.
    // slider 0 → alpha 0.95 (barely see image), slider 1 → alpha 0.4 (image clearly visible)
    const alpha = 0.95 - settings.backgroundImageOpacity * 0.55;

    // Only the base bg gets the semi-transparent color.
    // Raised/surface variants are tiny additive white tints — no stacking.
    root.setProperty("--c-bg", hexToRgba(bg, alpha));
    root.setProperty("--c-bg-raised", `rgba(255, 255, 255, 0.04)`);
    root.setProperty("--c-surface", `rgba(255, 255, 255, 0.07)`);
    root.setProperty("--c-surface-hover", `rgba(255, 255, 255, 0.10)`);
    root.setProperty("--c-surface-active", `rgba(255, 255, 255, 0.13)`);
  } else {
    root.setProperty("--c-bg", bg);
    root.setProperty("--c-bg-raised", lighten(bg, 7));
    root.setProperty("--c-surface", lighten(bg, 13));
    root.setProperty("--c-surface-hover", lighten(bg, 19));
    root.setProperty("--c-surface-active", lighten(bg, 25));
  }
}

function emitChange() {
  settings = { ...settings };
  persist();
  applyCSSVariables();
  for (const listener of listeners) listener();
}

// Apply on initial load so persisted settings take effect immediately
applyCSSVariables();

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return settings;
}

export function useSettings() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function updateSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K]
) {
  settings[key] = value;
  emitChange();
}

export function resetSettings() {
  settings = { ...defaults };
  emitChange();
}

export { defaults as settingDefaults };
