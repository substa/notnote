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
  navigateJournalDate,
  openToday,
  pageFromGraphRoute,
  renderReferences,
  resolveGraphConflict,
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

$("#graphConflictDialog").addEventListener("click", (event) => {
  const choice = event.target.dataset.graphConflict;
  if (choice) resolveGraphConflict(choice === "cancel" ? null : choice);
});

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
  if (state.graphMode && shortcutMatches("journalPrevious", event)) {
    event.preventDefault();
    requestAction(() => navigateJournalDate(-1));
    return;
  }
  if (state.graphMode && shortcutMatches("journalNext", event)) {
    event.preventDefault();
    requestAction(() => navigateJournalDate(1));
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
const remoteEvents = new Map();

export function scheduleRemoteRefresh(event = null) {
  if (event?.path) remoteEvents.set(`${event.type}:${event.oldPath || ""}:${event.path}`, event);
  clearTimeout(remoteRefreshTimer);
  remoteRefreshTimer = setTimeout(async () => {
    const pending = [...remoteEvents.values()];
    remoteEvents.clear();
    if (pending.length && session.graphStore?.refreshEvent) {
      for (const item of pending) await refreshRemoteEvent(item);
    } else await checkExternalGraphPage(true);
  }, 120);
}

async function refreshRemoteEvent(event) {
  try {
    const previous = session.graphStore.pages.find(
      (page) => page.path === (event.oldPath || event.path),
    );
    const result = await session.graphStore.refreshEvent(event);
    if (result.ignored) return;
    if (previous && (result.removed || result.oldPath))
      session.graphIndex.removePage(previous);
    if (result.page)
      session.graphIndex.updatePage(result.page, result.page.content);
    const currentPath = state.graphPage?.path;
    if (result.removed === currentPath || result.oldPath === currentPath) {
      session.remoteRefreshPending = false;
      saveState.textContent = "Page removed";
      return;
    }
    if (result.page?.path === currentPath && !state.dirty) {
      state.graphPage = result.page;
      state.graphDocument = Graph.parseDocument(result.page.content);
      restoreGraphCollapse();
      if (state.journalMode)
        session.journalDocuments.set(result.page.path, state.graphDocument);
      renderGraphPage();
      updateStats();
      saveState.textContent = "Reloaded";
    } else if (state.journalMode && result.page) {
      // Continuous journals can display several pages at once. Keep all visible
      // days live, not only the currently editable one.
      session.journalDocuments.set(
        result.page.path,
        Graph.parseDocument(result.page.content),
      );
      renderGraphPage();
    } else renderReferences();
    session.remoteRefreshPending = false;
  } catch {
    // A missed rename/delete or transient request is reconciled by one manifest scan.
    await checkExternalGraphPage(true);
  }
}

export function watchRemoteGraph() {
  session.closeRemoteEvents?.();
  session.closeRemoteEvents = null;
  if (!session.graphStore?.isRemote || session.graphStore.offline || !session.graphStore.subscribe)
    return;
  const store = session.graphStore;
  session.closeRemoteEvents = store.subscribe(
    (event) => {
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
      scheduleRemoteRefresh(event);
    },
    () => scheduleRemoteRefresh(),
  );
  // Brave Shields and some mobile proxies can delay or block EventSource. This
  // manifest check also closes the startup race when no `open` event arrives.
  setTimeout(() => {
    if (session.graphStore === store && !state.dirty)
      checkExternalGraphPage(true);
  }, 1200);
}

let remoteSyncing = null;
let remoteLocking = null;
export async function syncOfflineGraph(lockHeld = false) {
  if (!session.graphStore?.isRemote) return false;
  if (!lockHeld && navigator.locks?.request) {
    if (remoteLocking) return remoteLocking;
    remoteLocking = navigator.locks
      .request("notnote-remote-sync", { mode: "exclusive" }, () =>
        syncOfflineGraph(true),
      )
      .finally(() => {
        remoteLocking = null;
      });
    return remoteLocking;
  }
  if (remoteSyncing) return remoteSyncing;
  const store = session.graphStore;
  remoteSyncing = (async () => {
    try {
      await store.reloadPendingOperations?.();
      const pendingPaths = store.pendingWritePaths?.() || [];
      const migrated = await store.quarantineLegacyWrites?.();
      const pending = store.pendingCount || 0;
      saveState.textContent = pending
        ? `Syncing ${pending} changes…`
        : "Checking connection…";
      await store.reconnect();
      await loadGraphSettings();
      // Refresh the authoritative replica before replaying any current-version
      // operation. A stale queue must never define what the user sees at startup.
      await store.refreshAuthoritative?.(pendingPaths);
      await store.scan();
      // A later verification scan can report "unchanged" because this first
      // scan has already refreshed the replica. Preserve that result so the UI
      // still adopts the newly downloaded server pages.
      let replicaChanged = store.lastRefreshChanged !== false;
      let synced = 0;
      let recovered = migrated || 0;
      while (store.pendingCount) {
        const before = store.pendingCount;
        try {
          synced += await store.syncPending();
        } catch (error) {
          // Startup/background synchronization never offers a whole-file force
          // overwrite. Preserve local text and continue with the server version.
          const operation = store.pendingOperation();
          if (
            !operation ||
            operation.type !== "write" ||
            (error.name !== "ConflictError" && error.status !== 404)
          )
            throw error;
          synced += before - store.pendingCount;
          await store.resolvePendingConflict();
          recovered++;
        }
      }
      if (session.graphStore !== store) return false;
      const pages = await store.scan();
      replicaChanged ||= store.lastRefreshChanged !== false;
      if (session.graphStore !== store) return false;
      if (pendingPaths.length || replicaChanged) {
        session.graphIndex = new Graph.GraphIndex(pages);
        session.journalDocuments.clear();
        const current =
          state.graphPage &&
          pages.find((page) => page.path === state.graphPage.path);
        if (current && (!state.dirty || pendingPaths.length)) {
          state.graphPage = current;
          state.graphDocument = Graph.parseDocument(current.content);
          restoreGraphCollapse();
          if (pendingPaths.length) {
            // The local text is already represented by a queued operation or
            // recovery draft. Show the authoritative server page after sync.
            state.dirty = false;
            state.graphConflict = false;
            app.classList.remove("dirty");
          }
          if (state.journalMode)
            session.journalDocuments.set(current.path, state.graphDocument);
          renderGraphPage();
          updateStats();
        }
      }
      watchRemoteGraph();
      app.classList.remove("offline-mode");
      saveState.textContent = "Ready";
      if (synced)
        toast(`Synced ${synced} offline change${synced === 1 ? "" : "s"}`);
      if (recovered)
        toast(
          `${recovered} conflicting change${recovered === 1 ? " was" : "s were"} preserved as a recovery draft. Reopen the page to review it.`,
        );
      return true;
    } catch (error) {
      saveState.textContent = store.offline
        ? graphStatusLabel()
        : "Sync conflict";
      // navigator.onLine is unreliable during iOS PWA startup. Probe the
      // server directly, but keep a genuine offline failure silent.
      if (!store.networkFailure?.(error))
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
    if (
      session.graphStore.isRemote &&
      session.graphStore.lastRefreshChanged === false
    ) {
      session.remoteRefreshPending = false;
      return;
    }
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

// Installed iOS PWAs can be resumed without restoring their EventSource connection.
// Reconcile the replica on every foreground lifecycle signal rather than relying on
// a push event that may have been missed while WebKit suspended the page.
let lastForegroundRefresh = Date.now();
function refreshGraphAfterForeground() {
  if (!state.graphMode || !session.graphStore) return;
  lastForegroundRefresh = Date.now();
  if (session.graphStore.isRemote) syncOfflineGraph();
  else checkExternalGraphPage(true);
}
window.addEventListener("focus", refreshGraphAfterForeground);
window.addEventListener("pageshow", refreshGraphAfterForeground);

// WebKit can restore an installed PWA from a frozen snapshot without dispatching
// focus, pageshow, or visibilitychange. Timers are suspended with the page, so a
// heartbeat gap reliably detects that resume and reconciles the remote graph.
let foregroundHeartbeat = Date.now();
setInterval(() => {
  const now = Date.now();
  const resumed = now - foregroundHeartbeat > 3000;
  const pollingDue = now - lastForegroundRefresh > 15000;
  foregroundHeartbeat = now;
  if (document.visibilityState !== "visible") return;
  if (resumed) refreshGraphAfterForeground();
  else if (pollingDue) {
    lastForegroundRefresh = now;
    checkExternalGraphPage(true);
  }
}, 1000);

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
  if (document.visibilityState === "visible") refreshGraphAfterForeground();
  else if (state.graphMode) flushGraphSave(false);
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
