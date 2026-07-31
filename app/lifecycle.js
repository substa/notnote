/**
 * Global shortcuts, remote synchronization, browser lifecycle events, and lazy journal loading.
 */

import { loadGraphSettings } from "./appearance.js";
import {
  exportHtml,
  headingCommand,
  prefixMarkdownLines,
  runBlockContextAction,
  selectedBlockActionContext,
  showCommandPalette,
  wrapMarkdownSelection,
} from "./commands.js";
import {
  closeBlockContextMenu,
  settingsTabFromPath,
  shortcutMatches,
  shortcutValue,
} from "./core.js";
import {
  closeFind,
  loadMarkdown,
  moveFind,
  newDocument,
  openFile,
  requestAction,
  saveFile,
  showFind,
  toast,
  toggleSource,
  updateDocumentSearch,
  updateStats,
} from "./document.js";
import {
  $,
  app,
  documentationView,
  fileName,
  notnoteWrap,
  saveState,
} from "./dom.js";
import {
  flushGraphSave,
  graphRoute,
  graphStatusLabel,
  loadGraphPage,
  navigateGraphHistory,
  openToday,
  pageFromGraphRoute,
  renderReferences,
} from "./graph-session.js";
import {
  commitGraphBlock,
  openTasksPage,
  orderedJournalPages,
  renderGraphPage,
  restoreGraphCollapse,
  toggleAllGraphBlocks,
} from "./graph-view.js";
import {
  closeDocumentation,
  moveDocumentationSearch,
  resetDocumentationSearch,
  showDocumentation,
  showSettings,
} from "./settings.js";
import { Graph, session, state } from "./state.js";
import { commitActiveBlock } from "./vim.js";



// Global controls are registered here after composition has wired every feature contract.
$("#findInput").addEventListener("input", updateDocumentSearch);
$("#findInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    moveFind(event.shiftKey ? -1 : 1);
  }
  if (event.key === "Escape") closeFind();
});
$("#findNext").addEventListener("click", () => moveFind(1));
$("#findPrev").addEventListener("click", () => moveFind(-1));
$("#findClose").addEventListener("click", closeFind);

$("#confirmDialog").addEventListener("click", async (event) => {
  const action = event.target.dataset.dialog;
  if (!action) return;
  if (action === "cancel") {
    state.pendingAction = null;
    $("#confirmDialog").hidden = true;
  }
  if (action === "discard") {
    const pending = state.pendingAction;
    state.pendingAction = null;
    $("#confirmDialog").hidden = true;
    pending?.();
  }
  if (action === "save") {
    if (await saveFile()) {
      const pending = state.pendingAction;
      state.pendingAction = null;
      $("#confirmDialog").hidden = true;
      pending?.();
    }
  }
});

document.addEventListener("keydown", (event) => {
  if (!documentationView.hidden) {
    const documentationPanel = $(
      '[data-settings-panel="documentation"]',
    );
    if (!documentationPanel.hidden && shortcutMatches("find", event)) {
      event.preventDefault();
      $("#documentationSearch")?.focus();
      $("#documentationSearch")?.select();
    } else if (
      !documentationPanel.hidden &&
      shortcutMatches("findNext", event)
    ) {
      event.preventDefault();
      moveDocumentationSearch(1);
    } else if (
      !documentationPanel.hidden &&
      shortcutMatches("findPrevious", event)
    ) {
      event.preventDefault();
      moveDocumentationSearch(-1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (!documentationPanel.hidden && $("#documentationSearch")?.value) {
        resetDocumentationSearch();
        $("#documentationSearch").focus();
      } else closeDocumentation();
    }
    return;
  }
  const plainTarget = !event.target.matches?.(
    'input,textarea,[contenteditable="true"]',
  );
  if (shortcutMatches("settings", event)) {
    event.preventDefault();
    showSettings("general");
    return;
  }
  if (
    (plainTarget || /^(?:Mod|Alt)\+/.test(shortcutValue("documentation"))) &&
    shortcutMatches("documentation", event)
  ) {
    event.preventDefault();
    showDocumentation();
    return;
  }
  if (
    ["commands", "commandsF1", "commandsSearch"].some((id) =>
      shortcutMatches(id, event),
    )
  ) {
    event.preventDefault();
    showCommandPalette();
    return;
  }
  if (!$("#commandPalette").hidden) return;
  const blockShortcut = [
    ["blockCopyRef", "copy-ref"],
    ["blockCopy", "copy-block"],
    ["blockMakeTemplate", "make-template"],
    ["blockDeleteTree", "delete-block"],
  ].find(([id]) => shortcutMatches(id, event));
  if (state.graphMode && blockShortcut) {
    event.preventDefault();
    const context = selectedBlockActionContext();
    closeBlockContextMenu();
    runBlockContextAction(blockShortcut[1], context).catch((error) =>
      toast(error.message || "Could not complete the block action"),
    );
    return;
  }
  if (shortcutMatches("tasks", event)) {
    event.preventDefault();
    requestAction(openTasksPage);
    return;
  }
  if (state.graphMode && shortcutMatches("today", event)) {
    event.preventDefault();
    requestAction(openToday);
    return;
  }
  if (state.graphMode && shortcutMatches("blockCollapseAll", event)) {
    event.preventDefault();
    toggleAllGraphBlocks();
    return;
  }
  if (state.graphMode && shortcutMatches("back", event)) {
    event.preventDefault();
    navigateGraphHistory(-1);
    return;
  }
  if (state.graphMode && shortcutMatches("forward", event)) {
    event.preventDefault();
    navigateGraphHistory(1);
    return;
  }
  if (shortcutMatches("rename", event)) {
    event.preventDefault();
    commitActiveBlock();
    commitGraphBlock();
    fileName.focus();
    fileName.select();
    return;
  }
  const actions = [
    ["export", exportHtml],
    ["orderedList", () => prefixMarkdownLines("", true)],
    ["bulletList", () => prefixMarkdownLines("- ")],
    ["heading1", () => headingCommand(1)],
    ["heading2", () => headingCommand(2)],
    ["heading3", () => headingCommand(3)],
    ["save", saveFile],
    ["open", () => requestAction(openFile)],
    ["new", () => requestAction(newDocument)],
    ["find", showFind],
    ["findNext", () => moveFind(1)],
    ["findPrevious", () => moveFind(-1)],
    ["bold", () => wrapMarkdownSelection("**")],
    ["italic", () => wrapMarkdownSelection("*")],
    ["code", () => wrapMarkdownSelection("`")],
    ["source", toggleSource],
  ];
  const action = actions.find(([id]) => shortcutMatches(id, event));
  if (action) {
    event.preventDefault();
    action[1]();
    return;
  }
  if (event.key === "Escape") closeFind();
});

window.addEventListener("beforeunload", (event) => {
  if (state.dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
// Remote events coalesce index refreshes and offline queue synchronization.
let externalCheckTime = 0;
let remoteRefreshTimer = null;

export function scheduleRemoteRefresh() {
  clearTimeout(remoteRefreshTimer);
  remoteRefreshTimer = setTimeout(() => checkExternalGraphPage(true), 120);
}

export function watchRemoteGraph() {
  session.closeRemoteEvents?.();
  session.closeRemoteEvents = null;
  if (!session.graphStore?.isRemote || session.graphStore.offline || !session.graphStore.subscribe)
    return;
  session.closeRemoteEvents = session.graphStore.subscribe((event) => {
    const currentPath = state.graphPage?.path;
    if (
      event.path === currentPath &&
      event.revision &&
      String(event.revision) === String(state.graphPage.lastModified)
    )
      return;
    if (state.dirty) {
      session.remoteRefreshPending = true;
      if (event.path === currentPath || event.oldPath === currentPath) {
        state.graphConflict = true;
        saveState.textContent = "Conflict";
      }
      return;
    }
    scheduleRemoteRefresh();
  });
}

let remoteSyncing = null;
export async function syncOfflineGraph() {
  if (!session.graphStore?.isRemote || !navigator.onLine) return false;
  if (remoteSyncing) return remoteSyncing;
  const store = session.graphStore;
  remoteSyncing = (async () => {
    try {
      const pending = store.pendingCount || 0;
      saveState.textContent = pending
        ? `Syncing ${pending} changes…`
        : "Checking connection…";
      await store.reconnect();
      const synced = await store.syncPending();
      if (session.graphStore !== store) return false;
      await loadGraphSettings();
      const pages = await store.scan();
      if (session.graphStore !== store) return false;
      session.graphIndex = new Graph.GraphIndex(pages);
      session.journalDocuments.clear();
      const current =
        state.graphPage &&
        pages.find((page) => page.path === state.graphPage.path);
      if (current && !state.dirty) {
        state.graphPage = current;
        state.graphDocument = Graph.parseDocument(current.content);
        restoreGraphCollapse();
        if (state.journalMode)
          session.journalDocuments.set(current.path, state.graphDocument);
        renderGraphPage();
        updateStats();
      }
      watchRemoteGraph();
      app.classList.remove("offline-mode");
      saveState.textContent = "Ready";
      if (synced)
        toast(`Synced ${synced} offline change${synced === 1 ? "" : "s"}`);
      return true;
    } catch (error) {
      saveState.textContent = store.offline
        ? graphStatusLabel()
        : "Sync conflict";
      toast(
        error.name === "ConflictError"
          ? "Offline changes conflict with the server"
          : error.message || "Could not sync offline changes",
      );
      return false;
    } finally {
      remoteSyncing = null;
    }
  })();
  return remoteSyncing;
}

// Local graph handles have no push events, so visibility and focus trigger conflict checks.
async function checkExternalGraphPage(force = false) {
  if (
    !state.graphMode ||
    !state.graphPage ||
    (!force && Date.now() - externalCheckTime < 1500)
  )
    return;
  externalCheckTime = Date.now();
  try {
    if (state.dirty) {
      const fresh = await session.graphStore.freshFile(state.graphPage);
      if (fresh.lastModified !== state.graphPage.lastModified) {
        state.graphConflict = true;
        saveState.textContent = "Conflict";
      }
      return;
    }
    const currentPath = state.graphPage.path;
    const previousModified = state.graphPage.lastModified;
    const pages = await session.graphStore.scan();
    const current = pages.find((page) => page.path === currentPath);
    session.graphIndex = new Graph.GraphIndex(pages);
    if (!current) {
      session.remoteRefreshPending = false;
      saveState.textContent = "Page removed";
      return;
    }
    state.graphPage = current;
    session.journalDocuments.clear();
    session.remoteRefreshPending = false;
    if (current.lastModified !== previousModified) {
      state.graphDocument = Graph.parseDocument(current.content);
      restoreGraphCollapse();
      updateStats();
      saveState.textContent = "Reloaded";
      toast("Page reloaded from disk");
    }
    if (state.journalMode) {
      session.journalDocuments.set(current.path, state.graphDocument);
      renderGraphPage();
    } else if (current.lastModified !== previousModified) renderGraphPage();
    else renderReferences();
  } catch {
    if (session.graphStore?.isRemote && session.graphStore.offline)
      saveState.textContent = graphStatusLabel();
  }
}
window.addEventListener("online", () => syncOfflineGraph());
window.addEventListener("focus", () => {
  if (session.graphStore?.isRemote && (session.graphStore.offline || session.graphStore.pendingCount))
    syncOfflineGraph();
  else checkExternalGraphPage();
});
window.addEventListener("popstate", async () => {
  const settingsTab = settingsTabFromPath();
  if (settingsTab) {
    await showSettings(settingsTab, { routeNavigation: true });
    return;
  }
  if (!documentationView.hidden)
    closeDocumentation({ routeNavigation: true });
  const route = graphRoute();
  if (!route) {
    if (!state.graphMode) return;
    if (state.dirty && !(await flushGraphSave(true))) return;
    loadInitialDocument();
    return;
  }
  if (!session.graphStore || !session.graphIndex) return;
  const page = pageFromGraphRoute(route);
  if (!page) return toast("Page in URL not found in this graph");
  await loadGraphPage(page, {
    journalMode: route.journalMode,
    routeNavigation: !route.legacy,
    replaceRoute: Boolean(route.legacy),
    resetJournalLimit: route.journalMode,
  });
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (
      session.graphStore?.isRemote &&
      (session.graphStore.offline || session.graphStore.pendingCount)
    )
      syncOfflineGraph();
    else checkExternalGraphPage();
  } else if (state.graphMode) flushGraphSave(false);
});
// Journal history grows in bounded batches as the user approaches the scroll boundary.
let journalScrollLoading = false;
notnoteWrap.addEventListener("scroll", () => {
  if (
    !state.journalMode ||
    state.graphZoomId ||
    session.activeGraphBlock ||
    journalScrollLoading
  )
    return;
  if (
    notnoteWrap.scrollTop + notnoteWrap.clientHeight <
    notnoteWrap.scrollHeight - 240
  )
    return;
  if (state.journalLimit >= orderedJournalPages().length) return;
  journalScrollLoading = true;
  const scrollTop = notnoteWrap.scrollTop;
  state.journalLimit += 8;
  renderGraphPage();
  notnoteWrap.scrollTop = scrollTop;
  requestAnimationFrame(() => {
    journalScrollLoading = false;
  });
});
notnoteWrap.addEventListener("dragover", (event) => {
  if ([...event.dataTransfer.items].some((item) => item.kind === "file"))
    event.preventDefault();
});
notnoteWrap.addEventListener("drop", async (event) => {
  const file = [...event.dataTransfer.files].find((item) =>
    /\.(md|markdown|txt)$/i.test(item.name),
  );
  if (!file) return;
  event.preventDefault();
  requestAction(async () => loadMarkdown(await file.text(), file.name));
});

// Initial state
