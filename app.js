/**
 * Application bootstrap.
 * Imports make feature dependencies explicit; this entry point restores appearance and content,
 * connects available graph storage, installs UI event adapters, and registers the PWA.
 */

import {
  loadGraphSettings,
  saveSettings,
  setAccent,
  setTheme,
  syncAssetCacheSize,
} from "./app/appearance.js";
import { composeApplication } from "./app/composition.js";
import {
  STORAGE_KEY,
  WELCOME_VERSION,
  bootAppearance,
  initialSettingsTab,
  localSettings,
  settingsRouteUrl,
  starter,
} from "./app/core.js";
import { getStoredDocs, loadMarkdown, requestAction } from "./app/document.js";
import { app, saveState } from "./app/dom.js";
import { graphRoute, graphStatusLabel, openGraphLanding } from "./app/graph-session.js";
import { syncOfflineGraph, watchRemoteGraph } from "./app/lifecycle.js";
import { showSettings } from "./app/settings.js";
import { Graph, session, state } from "./app/state.js";
import { setVimEnabled } from "./app/vim.js";



composeApplication();

let settings = { ...localSettings(), ...bootAppearance() };
const savedTheme = ["light", "dark", "system"].includes(settings.theme)
  ? settings.theme
  : "system";
setTheme(savedTheme, false);
setAccent(settings.accentColor || "#3f7fba", false);
setVimEnabled(Boolean(settings.vimEnabled), false, false);
let docs = getStoredDocs();
if (settings.welcomeVersion !== WELCOME_VERSION) {
  const welcome = docs.find(
    (doc) => doc.name === "Welcome" || doc.name === "Benvenuto",
  );
  if (welcome) {
    welcome.name = "Welcome";
    welcome.markdown = starter;
    welcome.updated = Date.now();
  } else if (docs.length)
    docs = [
      ...docs.slice(0, 9),
      {
        id: "notnote-welcome",
        name: "Welcome",
        markdown: starter,
        updated: Date.now(),
      },
    ];
  if (docs.length)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(docs.slice(0, 10)));
  saveSettings({ welcomeVersion: WELCOME_VERSION });
}
function loadInitialDocument(options = {}) {
  const storedDocs = getStoredDocs();
  if (storedDocs.length)
    loadMarkdown(storedDocs[0].markdown, storedDocs[0].name, {
      id: storedDocs[0].id,
      ...options,
    });
  else loadMarkdown(starter, "Welcome", options);
}

app.classList.add("initial-loading");
saveState.textContent = "Loading…";
(async () => {
  try {
    // Cold starts are network-first: opening an installed PWA must not expose
    // an IndexedDB replica before checking the authoritative server. connect()
    // still falls back to that replica when the server is genuinely offline.
    const remote = await Graph.RemoteGraphStore.connect("/api/graph");
    session.graphStore = remote;
    session.graphSettings = null;
    await loadGraphSettings();
    const pages = await session.graphStore.scan();
    session.graphIndex = new Graph.GraphIndex(pages);
    if (state.dirty) return;
    session.journalDocuments.clear();
    session.graphHistory = [];
    session.graphHistoryIndex = -1;
    await openGraphLanding({ replaceRoute: true });
    // Subscribe only after the current page exists: the stream's open callback
    // performs a final scan that closes the startup manifest/event race.
    watchRemoteGraph();
    saveState.textContent = graphStatusLabel();
    // An offline fallback may become reachable while startup is still running.
    if (remote.offline || remote.pendingCount) await syncOfflineGraph();
    return;
  } catch {}
  try {
    const restored = await Graph.GraphStore.restore();
    if (restored && (await restored.ensurePermission(false))) {
      session.graphStore = restored;
      session.graphSettings = null;
      await loadGraphSettings();
      const pages = await session.graphStore.scan();
      session.graphIndex = new Graph.GraphIndex(pages);
      if (state.dirty) return;
      session.journalDocuments.clear();
      session.graphHistory = [];
      session.graphHistoryIndex = -1;
      await openGraphLanding({ replaceRoute: true });
      return;
    }
  } catch {}
  if (!state.dirty)
    loadInitialDocument({ preserveGraphRoute: Boolean(graphRoute()) });
})().finally(async () => {
  if (initialSettingsTab) {
    const tab =
      initialSettingsTab === "git" && !session.graphStore?.isRemote
        ? "general"
        : initialSettingsTab;
    history.replaceState({ notnoteSettings: tab }, "", settingsRouteUrl(tab));
    await showSettings(tab, { routeNavigation: true });
  }
  app.classList.remove("initial-loading");
});

if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (launchParams) => {
    const handle = launchParams.files?.[0];
    if (!handle) return;
    const file = await handle.getFile();
    requestAction(async () =>
      loadMarkdown(await file.text(), file.name, { handle }),
    );
  });
}
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker
    .register("sw.js", { updateViaCache: "none" })
    .then((registration) => {
      syncAssetCacheSize();
      setTimeout(() => registration.update().catch(() => {}), 1000);
    })
    .catch(() => {});
  let workerReloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    syncAssetCacheSize();
    // The old worker may have served an obsolete cached shell for this launch.
    // Adopt the newly installed bundle immediately instead of requiring the user
    // to refresh manually. Never discard an edit already in progress.
    if (
      workerReloading ||
      state.dirty ||
      session.activeGraphBlock?.field?.isConnected ||
      session.activeSourceBlock?.isConnected
    )
      return;
    workerReloading = true;
    location.reload();
  });
}
