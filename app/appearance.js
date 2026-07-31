/**
 * Theme, accent, asset cache, and graph settings persistence.
 */

import {
  SETTINGS_KEY,
  currentSettings,
  localSettings,
  rememberBootAppearance,
  requireFunctions,
} from "./core.js";
import { toast } from "./document.js";
import { $, app } from "./dom.js";
import { session } from "./state.js";



// Dependency inversion is limited to Vim because Vim persists through this module.
let appearanceDependencies;

export function configureAppearanceDependencies(dependencies) {
  appearanceDependencies = requireFunctions("appearance", dependencies, [
    "setVimEnabled",
  ]);
}

// Theme values are applied immediately; persistence is debounced separately.
let graphSettingsTimer = null;

const systemColorScheme = matchMedia("(prefers-color-scheme: dark)");
export let selectedTheme = "system";
export let selectedAccent = "#3f7fba";
function applyTheme() {
  const effectiveTheme =
    selectedTheme === "system"
      ? systemColorScheme.matches
        ? "dark"
        : "light"
      : selectedTheme;
  document.documentElement.classList.toggle(
    "theme-dark",
    effectiveTheme === "dark",
  );
  document.documentElement.classList.toggle(
    "theme-system",
    selectedTheme === "system",
  );
  app.classList.toggle("theme-dark", effectiveTheme === "dark");
  app.classList.toggle("theme-system", selectedTheme === "system");
  document.documentElement.style.colorScheme = effectiveTheme;
  $('meta[name="theme-color"]')?.setAttribute(
    "content",
    effectiveTheme === "dark" ? "#282725" : "#fdfcfb",
  );
}
export function setTheme(theme, persist = true) {
  selectedTheme = ["light", "dark", "system"].includes(theme)
    ? theme
    : "system";
  applyTheme();
  rememberBootAppearance({ theme: selectedTheme });
  if (persist) saveSettings({ theme: selectedTheme });
}
export function setAccent(color, persist = true) {
  selectedAccent = /^#[0-9a-f]{6}$/i.test(color || "") ? color : "#3f7fba";
  document.documentElement.style.setProperty("--accent", selectedAccent);
  rememberBootAppearance({ accentColor: selectedAccent });
  if (persist) saveSettings({ accentColor: selectedAccent });
}
if (systemColorScheme.addEventListener)
  systemColorScheme.addEventListener("change", () => {
    if (selectedTheme === "system") applyTheme();
  });
else
  systemColorScheme.addListener(() => {
    if (selectedTheme === "system") applyTheme();
  });
export function saveSettings(change) {
  const updated = { ...currentSettings(), ...change };
  if (session.graphStore && session.graphSettings !== null) {
    session.graphSettings = updated;
    clearTimeout(graphSettingsTimer);
    const store = session.graphStore;
    const value = session.graphSettings;
    graphSettingsTimer = setTimeout(
      () =>
        store
          .writeSettings(value)
          .catch(() => toast("Could not save graph settings")),
      180,
    );
  } else localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
}

// The attachment cache is configured through the active Service Worker.
const ASSET_CACHE_SIZES = [50, 100, 200, 500, 1000];
export function assetCacheSize() {
  const value = Number(localSettings().assetCacheSizeMB);
  return ASSET_CACHE_SIZES.includes(value) ? value : 200;
}
export function syncAssetCacheSize() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.ready
    .then((registration) => {
      const worker =
        navigator.serviceWorker.controller || registration.active;
      worker?.postMessage({
        type: "configure-asset-cache",
        maxBytes: assetCacheSize() * 1024 * 1024,
      });
    })
    .catch(() => {});
}
export function setAssetCacheSize(value) {
  const size = Number(value);
  if (!ASSET_CACHE_SIZES.includes(size)) return;
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ ...localSettings(), assetCacheSizeMB: size }),
  );
  syncAssetCacheSize();
}

// Graph settings take precedence over local settings once a graph is connected.
export async function loadGraphSettings() {
  if (!session.graphStore.isRemote && session.graphStore.readConfig)
    await session.graphStore.readConfig();
  const importedJournal = { ...session.graphStore.config };
  const stored = await session.graphStore.readSettings();
  let migrated = false;
  if (stored) {
    session.graphSettings = stored;
    if (session.graphSettings.schemaVersion !== 1) {
      session.graphSettings = { ...session.graphSettings, schemaVersion: 1 };
      migrated = true;
    }
    if (!session.graphSettings.journal || typeof session.graphSettings.journal !== "object") {
      session.graphSettings = { ...session.graphSettings, journal: importedJournal };
      migrated = true;
    }
  } else {
    const local = localSettings();
    session.graphSettings = {
      schemaVersion: 1,
      ...Object.fromEntries(
        [
          "theme",
          "accentColor",
          "vimEnabled",
          "shortcuts",
          "graphCollapsed",
          "lastGraphPage",
          "recentGraphPages",
        ]
          .filter((key) => key in local)
          .map((key) => [key, local[key]]),
      ),
      journal: importedJournal,
    };
    migrated = true;
  }
  session.graphStore.applySettings(session.graphSettings);
  if (migrated) await session.graphStore.writeSettings(session.graphSettings);
  setTheme(session.graphSettings.theme || "system", false);
  setAccent(session.graphSettings.accentColor || "#3f7fba", false);
  appearanceDependencies.setVimEnabled(Boolean(session.graphSettings.vimEnabled), false, false);
}

