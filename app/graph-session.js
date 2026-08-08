/**
 * Graph persistence, page navigation, journal routing, references, and graph maintenance operations.
 */

import { loadGraphSettings, saveSettings } from "./appearance.js";
import {
  currentSettings,
  requireFunctions,
  taskRedoStack,
  taskUndoStack,
  vimRedoStack,
  vimUndoStack,
} from "./core.js";
import {
  getStoredDocs,
  loadMarkdown,
  requestAction,
  toast,
  updateStats,
} from "./document.js";
import {
  $,
  $$,
  app,
  blockTree,
  editor,
  fileName,
  journalCalendar,
  notnoteWrap,
  outliner,
  pageHierarchy,
  references,
  saveState,
  sourceEditor,
} from "./dom.js";
import {
  clearGraphBlockSelection,
  commitGraphBlock,
  graphBlockLocation,
  graphContextBlockElement,
  orderedJournalPages,
  renderGraphPage,
  resolveGraphContentAssets,
  restoreGraphCollapse,
  saveTaskCompletedTodayIds,
  taskCompletedTodayIds,
  taskDate,
  taskOverviewGroups,
  taskPersistenceId,
  taskTextHtml,
  updateTaskCompletionMetadata,
} from "./graph-view.js";
import { currentMarkdown, escapeHtml } from "./markdown.js";
import { finishVoiceRecording, voiceRecording } from "./media.js";
import { Graph, session, state } from "./state.js";
import { focusVimEditor, recordTaskHistory, updateVimUi } from "./vim.js";



let graphSessionDependencies;

export function configureGraphSessionDependencies(dependencies) {
  graphSessionDependencies = requireFunctions("graph session", dependencies, [
    "finishTitleEdit",
    "scheduleRemoteRefresh",
  ]);
}

// Graph mutations update the in-memory index immediately and persist through one save queue.
let graphIndexTimer = null;
function updateGraphIndex() {
  if (!session.graphIndex || !state.graphPage) return;
  if (!state.graphPage.virtual)
    session.graphIndex.updatePage(state.graphPage, currentMarkdown());
  renderReferences();
}

export function graphStatusLabel(fallback = "Ready") {
  const offline = Boolean(session.graphStore?.isRemote && session.graphStore.offline);
  app.classList.toggle("offline-mode", offline);
  if (!offline) return fallback;
  const pending = session.graphStore.pendingCount || 0;
  return pending ? `Offline · ${pending} pending` : "Offline";
}

export function graphChanged() {
  if (!state.graphMode || !state.graphPage) return;
  state.dirty = true;
  saveState.textContent = state.graphConflict ? "Conflict" : "Modified";
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => flushGraphSave(false), 650);
  clearTimeout(session.graphDraftTimer);
  session.graphDraftTimer = setTimeout(() => {
    Graph.saveDraft(state.graphPage.path, {
      content: currentMarkdown(),
      modified: state.graphPage.lastModified,
    }).catch(() => {});
  }, 120);
  clearTimeout(graphIndexTimer);
  graphIndexTimer = setTimeout(updateGraphIndex, 240);
  updateStats();
}

let graphSaving = null;
// Persist recovery data before disk/server writes so interrupted saves can be resumed safely.
export async function flushGraphSave(interactive = false, force = false) {
  if (!state.graphMode || !state.graphPage || !state.dirty) return true;
  if (state.graphConflict && !force) {
    saveState.textContent = "Conflict";
    if (
      !interactive ||
      !confirm(
        "The recovered draft conflicts with the file on disk. Overwrite the disk version?",
      )
    )
      return false;
    force = true;
  }
  if (graphSaving) {
    await graphSaving;
    if (!state.dirty) return true;
  }
  const page = state.graphPage;
  const content = currentMarkdown();
  clearTimeout(session.graphDraftTimer);
  if (page.virtual) {
    saveState.textContent = "Creating page…";
    try {
      const created = await session.graphStore.createPage(page.title, { content });
      state.graphPage = created;
      session.graphIndex.rebuild(session.graphStore.pages);
      await Graph.removeDraft(page.path).catch(() => {});
      state.dirty = false;
      app.classList.remove("dirty");
      saveState.textContent = graphStatusLabel("Saved");
      return true;
    } catch (error) {
      saveState.textContent = "Save failed";
      if (interactive) toast(error.message || "Could not create the page");
      return false;
    }
  }
  await Graph.saveDraft(page.path, {
    content,
    modified: page.lastModified,
  }).catch(() => {});
  saveState.textContent = "Saving…";
  graphSaving = (async () => {
    try {
      try {
        await session.graphStore.writePage(page, content, { force });
      } catch (error) {
        if (error.name !== "ConflictError") throw error;
        state.graphConflict = true;
        saveState.textContent = "Conflict";
        if (
          !interactive ||
          !confirm(
            "This page changed on disk. Overwrite the external changes?",
          )
        )
          return false;
        await session.graphStore.writePage(page, content, { force: true });
      }
      session.graphIndex.updatePage(page, content);
      await Graph.removeDraft(page.path).catch(() => {});
      if (state.graphPage === page && currentMarkdown() === content) {
        state.dirty = false;
        app.classList.remove("dirty");
        saveState.textContent = graphStatusLabel("Saved");
      }
      state.graphConflict = false;
      if (session.remoteRefreshPending) graphSessionDependencies.scheduleRemoteRefresh();
      return true;
    } catch (error) {
      saveState.textContent = "Save failed";
      if (interactive) toast(error.message || "Could not save the page");
      return false;
    }
  })();
  const result = await graphSaving;
  graphSaving = null;
  return result;
}

// Use an explicit instant scroll because the workspace has CSS smooth scrolling enabled.
function scrollWorkspaceTo(top = 0) {
  notnoteWrap.scrollTo({ top: Math.max(0, top), behavior: "instant" });
}

// Browser routes and the internal graph history are updated as one navigation boundary.
function updateCurrentHistoryPosition() {
  const entry = session.graphHistory[session.graphHistoryIndex];
  if (!entry || entry.path !== state.graphPage?.path) return;
  entry.scrollTop = notnoteWrap.scrollTop;
  entry.blockId = state.graphZoomId || null;
  entry.journalMode = state.journalMode;
}

function recordGraphHistory(page, options) {
  if (options.historyNavigation) return;
  updateCurrentHistoryPosition();
  const entry = {
    path: page.path,
    title: page.title,
    journalMode: Boolean(options.journalMode),
    blockId: options.blockId || null,
    scrollTop: 0,
  };
  const current = session.graphHistory[session.graphHistoryIndex];
  if (
    current &&
    current.path === entry.path &&
    current.journalMode === entry.journalMode &&
    current.blockId === entry.blockId
  )
    return;
  session.graphHistory = session.graphHistory.slice(0, session.graphHistoryIndex + 1);
  session.graphHistory.push(entry);
  session.graphHistoryIndex = session.graphHistory.length - 1;
}

function rememberGraphPage(page) {
  const settings = currentSettings();
  const item = {
    graph: session.graphStore?.name || "",
    path: page.path,
    title: page.title,
  };
  const recentGraphPages = [
    item,
    ...(settings.recentGraphPages || []).filter(
      (recent) => recent.graph !== item.graph || recent.path !== item.path,
    ),
  ].slice(0, 20);
  saveSettings({ lastGraphPage: page.title, recentGraphPages });
}

export function graphRoutePath(page) {
  const journal = page.journal || page.path.startsWith("journals/");
  let name = journal
    ? page.path.replace(/^journals\//, "").replace(/\.(?:md|markdown)$/i, "")
    : page.title;
  name = name
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `/${journal ? "journals" : "pages"}/${name}`;
}

export function graphRoute() {
  const clean = location.pathname.match(/^\/(pages|journals)\/(.+?)\/?$/);
  if (clean) {
    try {
      return {
        cleanPath: `/${clean[1]}/${decodeURIComponent(clean[2])}`,
        journalMode: clean[1] === "journals",
      };
    } catch {
      return null;
    }
  }
  const legacy = location.hash.match(/^#\/(page|journal)\/(.+)$/);
  if (!legacy) return null;
  try {
    return {
      path: decodeURIComponent(legacy[2]),
      journalMode: legacy[1] === "journal",
      legacy: true,
    };
  } catch {
    return null;
  }
}

export function syncGraphRoute(page, options = {}) {
  if (!page || options.routeNavigation) return;
  const path = graphRoutePath(page);
  if (location.pathname === path && !location.hash) return;
  const method =
    options.replaceRoute || options.historyNavigation
      ? "replaceState"
      : "pushState";
  history[method]({ notnotePage: page.path }, "", `${path}${location.search}`);
}

export function pageFromGraphRoute(route) {
  if (!route) return null;
  if (route.path)
    return session.graphStore?.pages.find((page) => page.path === route.path);
  return (
    session.graphStore?.pages.find((page) => {
      try {
        return decodeURIComponent(graphRoutePath(page)) === route.cleanPath;
      } catch {
        return false;
      }
    }) || null
  );
}

export async function openGraphLanding(options = {}) {
  const route = graphRoute();
  const page = pageFromGraphRoute(route);
  if (page)
    return loadGraphPage(page, {
      journalMode: route.journalMode,
      routeNavigation: !route.legacy,
      replaceRoute: Boolean(route.legacy),
    });
  await openToday(true, { replaceRoute: Boolean(options.replaceRoute) });
}

export async function navigateGraphHistory(direction) {
  if (!state.graphMode) return;
  updateCurrentHistoryPosition();
  const targetIndex = session.graphHistoryIndex + direction;
  const entry = session.graphHistory[targetIndex];
  if (!entry)
    return toast(direction < 0 ? "No previous page" : "No next page");
  const page =
    session.graphStore.pages.find((item) => item.path === entry.path) ||
    session.graphIndex.resolvePage(entry.title);
  if (!page) return toast("Page no longer exists");
  await loadGraphPage(page, {
    journalMode: entry.journalMode,
    blockId: entry.blockId,
    historyNavigation: true,
  });
  if (
    state.graphPage?.path !== page.path ||
    state.journalMode !== entry.journalMode
  )
    return;
  session.graphHistoryIndex = targetIndex;
  requestAnimationFrame(() => scrollWorkspaceTo(entry.scrollTop));
}

// Page loading is the navigation boundary: save current work, update history, then render.
export async function loadGraphPage(pageOrTitle, options = {}) {
  if (!session.graphStore || !session.graphIndex) return;
  const preservedScrollTop = options.preserveScroll
    ? notnoteWrap.scrollTop
    : null;
  if (voiceRecording?.finishing)
    return toast("Wait for the voice note to finish saving");
  if (voiceRecording) finishVoiceRecording(false);
  if (state.graphMode && state.dirty && !(await flushGraphSave(true))) return;
  if (state.journalMode && state.graphPage && state.graphDocument)
    session.journalDocuments.set(state.graphPage.path, state.graphDocument);
  let page =
    typeof pageOrTitle === "string"
      ? session.graphIndex.resolvePage(pageOrTitle)
      : pageOrTitle;
  if (!page && typeof pageOrTitle === "string" && options.virtual) {
    const title = pageOrTitle.trim();
    page = {
      title,
      name: "",
      path: `virtual:${Graph.normalizePage(title)}`,
      folder: "pages",
      content: "- ",
      lastModified: null,
      virtual: true,
    };
  } else if (
    !page &&
    typeof pageOrTitle === "string" &&
    options.create !== false
  ) {
    page = await session.graphStore.createPage(pageOrTitle, options);
    session.graphIndex.rebuild(session.graphStore.pages);
  }
  if (!page) return toast("Page not found");
  const draft = await Graph.getDraft(page.path).catch(() => null);
  const content = draft?.content ?? page.content;
  const draftConflict = Boolean(
    draft?.modified && draft.modified !== page.lastModified,
  );
  recordGraphHistory(page, options);
  state.graphMode = true;
  state.graphPage = page;
  state.graphDocument = Graph.parseDocument(content);
  restoreGraphCollapse();
  state.journalMode = Boolean(options.journalMode);
  state.journalLimit = options.resetJournalLimit ? 1 : state.journalLimit;
  state.referencesExpanded = false;
  state.onThisDayExpanded = false;
  state.onThisDayEmptyDismissed = false;
  state.taskView = page.name.toLowerCase() === "tasks.md" ? "all" : null;
  if (state.journalMode) session.journalDocuments.set(page.path, state.graphDocument);
  state.graphZoomId = options.blockId || null;
  state.sourceMode = false;
  state.dirty = Boolean(draft);
  state.graphConflict = draftConflict;
  state.fileHandle = null;
  session.activeSourceBlock = null;
  session.activeGraphBlock = null;
  clearGraphBlockSelection();
  vimUndoStack.length = 0;
  vimRedoStack.length = 0;
  session.vimInsertSnapshot = null;
  state.vimMode = "normal";
  editor.hidden = true;
  sourceEditor.hidden = true;
  outliner.hidden = false;
  app.classList.add("graph-mode");
  app.classList.toggle("journal-mode", state.journalMode);
  app.classList.toggle("dirty", Boolean(draft));
  updateVimUi();
  graphSessionDependencies.finishTitleEdit();
  fileName.value = page.title;
  fileName.readOnly = Boolean(page.journal);
  document.title = `${page.title} — ${session.graphStore.name} — notnote`;
  rememberGraphPage(page);
  syncGraphRoute(page, options);
  renderGraphPage();
  // Fresh navigation starts at the top. Switching the editable journal within
  // the continuous timeline keeps the reader's current position instead.
  scrollWorkspaceTo(preservedScrollTop ?? 0);
  updateStats();
  saveState.textContent = draftConflict
    ? "Recovery conflict"
    : draft
      ? "Recovered draft"
      : graphStatusLabel();
  requestAnimationFrame(() => {
    if (options.blockId)
      blockTree
        .querySelector(`[data-block-id="${CSS.escape(options.blockId)}"]`)
        ?.scrollIntoView({ block: "center" });
    if (state.vimEnabled) focusVimEditor();
  });
}

let assetCleanupResolve = null;
function reviewOrphanedAssets(paths) {
  const dialog = $("#assetCleanupDialog");
  $("#assetCleanupMessage").textContent = `Review all ${paths.length} unreferenced file${paths.length === 1 ? "" : "s"} before deleting them. This cannot be undone.`;
  $("#assetCleanupList").value = paths.join("\n");
  dialog.hidden = false;
  requestAnimationFrame(() =>
    dialog.querySelector('[data-asset-cleanup="cancel"]')?.focus(),
  );
  return new Promise((resolve) => {
    assetCleanupResolve = resolve;
  });
}

export function closeAssetCleanupDialog(confirmed = false) {
  const dialog = $("#assetCleanupDialog");
  if (dialog.hidden) return;
  dialog.hidden = true;
  $("#assetCleanupList").value = "";
  const resolve = assetCleanupResolve;
  assetCleanupResolve = null;
  resolve?.(confirmed);
}

export async function cleanOrphanedAssets() {
  if (!session.graphStore) return toast("Open a graph first");
  try {
    saveState.textContent = "Checking assets…";
    const pages = await session.graphStore.scan();
    session.graphIndex = new Graph.GraphIndex(pages);
    // Search one corpus instead of comparing every asset with every page separately.
    const corpus = Graph.assetReferenceCorpus(
      pages.map((page) => String(page.content || "")).join("\n"),
    );
    const assets = await session.graphStore.listAssets();
    const referenced = Graph.referencedAssetPaths(corpus, assets);
    const orphans = assets.filter((path) => !referenced.has(path));
    if (!orphans.length) {
      saveState.textContent = "Ready";
      return toast("No orphaned assets found");
    }
    if (!(await reviewOrphanedAssets(orphans))) {
      saveState.textContent = "Ready";
      return;
    }
    // Re-scan after review so a newly added link always wins over deletion.
    saveState.textContent = "Verifying assets…";
    const latestPages = await session.graphStore.scan();
    session.graphIndex = new Graph.GraphIndex(latestPages);
    const latestCorpus = Graph.assetReferenceCorpus(
      latestPages.map((page) => String(page.content || "")).join("\n"),
    );
    const existingAssets = await session.graphStore.listAssets();
    const latestReferenced = Graph.referencedAssetPaths(
      latestCorpus,
      existingAssets,
    );
    const reviewed = new Set(orphans);
    const verified = existingAssets.filter(
      (path) => reviewed.has(path) && !latestReferenced.has(path),
    );
    if (!verified.length) {
      saveState.textContent = "Ready";
      return toast("No reviewed assets are still orphaned");
    }
    saveState.textContent = `Deleting ${verified.length} assets…`;
    const result = await session.graphStore.removeAssets(
      verified.map((path) => `/${path}`),
    );
    const failed = result.failed || 0;
    const skipped = result.skipped || 0;
    saveState.textContent = failed ? "Cleanup incomplete" : "Ready";
    const details = [
      `${result.deleted || 0} deleted`,
      skipped ? `${skipped} newly referenced` : "",
      failed ? `${failed} failed` : "",
    ].filter(Boolean);
    toast(`Asset cleanup: ${details.join(" · ")}`);
  } catch (error) {
    saveState.textContent = "Cleanup failed";
    toast(error.message || "Could not check assets");
  }
}

// Remove generated placeholder files only when no page or tag points to them.
export async function cleanEmptyPages() {
  if (!session.graphStore) return toast("Open a graph first");
  if (session.graphStore.isRemote && session.graphStore.offline)
    return toast("Cleaning empty pages requires a connection");
  try {
    commitGraphBlock();
    if (!(await flushGraphSave(true))) return;
    saveState.textContent = "Checking empty pages…";
    const pages = await session.graphStore.scan();
    const freshIndex = new Graph.GraphIndex(pages);
    const candidates = pages.filter((page) => {
      if (page.journal || page.virtual) return false;
      return (
        Graph.isEmptyPageContent(page.content) &&
        !freshIndex.referencesToPage(page.title).length
      );
    });
    if (!candidates.length) {
      session.graphIndex = freshIndex;
      saveState.textContent = "Ready";
      return toast("No unreferenced empty pages found");
    }
    const preview = candidates
      .slice(0, 20)
      .map((page) => `• ${page.path}`)
      .join("\n");
    const remaining =
      candidates.length > 20
        ? `\n• …and ${candidates.length - 20} more`
        : "";
    if (
      !confirm(
        `Delete these ${candidates.length} empty, unreferenced page${candidates.length === 1 ? "" : "s"}? This cannot be undone.\n\n${preview}${remaining}`,
      )
    ) {
      saveState.textContent = "Ready";
      return;
    }
    const results = await Promise.allSettled(
      candidates.map((page) => session.graphStore.deletePage(page)),
    );
    const failed = results.filter(
      (result) => result.status === "rejected",
    ).length;
    session.graphIndex = new Graph.GraphIndex(session.graphStore.pages);
    session.journalDocuments.clear();
    updateStats();
    const currentWasDeleted =
      state.graphPage &&
      !session.graphStore.pages.some((page) => page.path === state.graphPage.path);
    if (currentWasDeleted) await openToday(true, { replaceRoute: true });
    else renderGraphPage();
    saveState.textContent = failed ? "Cleanup incomplete" : "Ready";
    toast(
      failed
        ? `Deleted ${candidates.length - failed} pages; ${failed} failed`
        : `Deleted ${candidates.length} empty page${candidates.length === 1 ? "" : "s"}`,
    );
  } catch (error) {
    saveState.textContent = "Cleanup failed";
    toast(error.message || "Could not clean empty pages");
  }
}

export async function syncGraphIndex() {
  if (!session.graphStore) return toast("Open a graph first");
  try {
    saveState.textContent = "Syncing graph…";
    const pages = await session.graphStore.scan();
    session.graphIndex = new Graph.GraphIndex(pages);
    session.journalDocuments.clear();
    const current =
      state.graphPage &&
      pages.find((page) => page.path === state.graphPage.path);
    if (current) {
      state.graphPage = current;
      state.graphDocument = Graph.parseDocument(current.content);
      restoreGraphCollapse();
      if (state.journalMode)
        session.journalDocuments.set(current.path, state.graphDocument);
      if (state.sourceMode) sourceEditor.value = current.content;
      else renderGraphPage();
    }
    updateStats();
    saveState.textContent = "Synced";
    toast(`Synced ${pages.length} notes and backlinks`);
  } catch (error) {
    saveState.textContent = "Sync failed";
    toast(error.message || "Could not sync the graph");
  }
}

export async function openGraph() {
  try {
    if (voiceRecording?.finishing)
      return toast("Wait for the voice note to finish saving");
    if (voiceRecording) finishVoiceRecording(false);
    if (state.graphMode && state.dirty && !(await flushGraphSave(true)))
      return;
    saveState.textContent = "Opening graph…";
    session.closeRemoteEvents?.();
    session.closeRemoteEvents = null;
    session.graphStore?.disposeAssets();
    session.graphStore = await Graph.GraphStore.open();
    session.graphSettings = null;
    taskUndoStack.length = 0;
    taskRedoStack.length = 0;
    state.taskCompletedTodayIds = [];
    state.taskCompletedDate = "";
    await loadGraphSettings();
    const pages = await session.graphStore.scan();
    session.graphIndex = new Graph.GraphIndex(pages);
    session.journalDocuments.clear();
    session.graphHistory = [];
    session.graphHistoryIndex = -1;
    await openGraphLanding();
    toast(`Opened ${session.graphStore.name}`);
  } catch (error) {
    if (error.name !== "AbortError")
      toast(error.message || "Could not open the graph");
  }
}

// Journal navigation normalizes configured filenames, display titles, and calendar dates.
async function openJournalDate(date, options = {}) {
  if (!session.graphStore) return openGraph();
  const journal = Graph.journalInfo(date, session.graphStore.config);
  let page =
    session.graphStore.pages.find((item) => item.journalDate === journal.date) ||
    session.graphIndex.resolvePage(journal.title);
  if (!page) {
    page = await session.graphStore.createPage(journal.title, {
      journal: true,
      journalDate: journal.value,
      filename: journal.filename,
    });
    session.graphIndex.rebuild(session.graphStore.pages);
  }
  await loadGraphPage(page, {
    journalMode: true,
    resetJournalLimit: Boolean(options.reset),
    replaceRoute: Boolean(options.replaceRoute),
  });
  const index = orderedJournalPages().findIndex(
    (item) => item.path === page.path,
  );
  if (index >= state.journalLimit) {
    state.journalLimit = index + 1;
    renderGraphPage();
  }
  requestAnimationFrame(() => {
    const entry = blockTree.querySelector(
      `[data-journal-path="${CSS.escape(page.path)}"]`,
    );
    if (options.reset) scrollWorkspaceTo();
    else entry?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (state.vimEnabled) focusVimEditor();
  });
  return page;
}

export function relativeJournalDate(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date;
}

async function openSingleJournalDate(date) {
  if (!session.graphStore) await openGraph();
  if (!session.graphStore) return;
  const journal = Graph.journalInfo(date, session.graphStore.config);
  let page =
    session.graphStore.pages.find((item) => item.journalDate === journal.date) ||
    session.graphIndex.resolvePage(journal.title);
  if (!page) {
    page = await session.graphStore.createPage(journal.title, {
      journal: true,
      journalDate: journal.value,
      filename: journal.filename,
    });
    session.graphIndex.rebuild(session.graphStore.pages);
  }
  await loadGraphPage(page, { journalMode: false });
}

function calendarTaskRowsHtml(tasks) {
  if (!tasks.length) return "<p>No tasks</p>";
  const today = taskDate();
  return tasks
    .map(
      (task) =>
        `<div class="calendar-task" data-calendar-task-page="${escapeHtml(task.page.path)}" data-calendar-task-block="${escapeHtml(task.block.id)}" role="button" tabindex="0"><span${task.progress ? ' class="calendar-task-progress"' : ""} aria-hidden="true"></span><b>${task.scheduled && task.scheduled < today ? '<i class="task-overdue-icon" title="Overdue" aria-label="Overdue">!</i>' : ""}${taskTextHtml(task)}</b></div>`,
    )
    .join("");
}

let calendarViewDate = new Date();
let calendarFocusDate = new Date();
let calendarSelectAction = null;

function renderJournalCalendar() {
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  $("#calendarMonth").textContent = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(calendarViewDate);
  const first = new Date(year, month, 1, 12);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offset, 12);
  const today = Graph.journalInfo(new Date(), session.graphStore?.config).date;
  const focused = Graph.journalInfo(
    calendarFocusDate,
    session.graphStore?.config,
  ).date;
  const current = calendarSelectAction
    ? focused
    : state.graphPage?.journalDate;
  $("#calendarDays").innerHTML = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const value = Graph.journalInfo(date, session.graphStore?.config).date;
    const classes = [
      date.getMonth() !== month ? "outside" : "",
      value === today ? "today" : "",
      value === current ? "current" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `<button type="button" class="${classes}" data-calendar-date="${value}" tabindex="${value === focused ? "0" : "-1"}" aria-label="${escapeHtml(date.toLocaleDateString(undefined, { dateStyle: "full" }))}">${date.getDate()}</button>`;
  }).join("");
  const calendarTasks = $("#calendarTasks");
  calendarTasks.hidden = Boolean(calendarSelectAction);
  if (calendarSelectAction) {
    calendarTasks.innerHTML = "";
    return;
  }
  const overview = taskOverviewGroups();
  calendarTasks.innerHTML = `<section><h3>Today <span>${overview.today.length}</span></h3>${calendarTaskRowsHtml(overview.today)}</section><button type="button" class="calendar-all-tasks" data-calendar-all-tasks>All tasks <span aria-hidden="true">→</span></button>`;
}

export function focusCalendarDate(date) {
  calendarFocusDate = new Date(date);
  calendarFocusDate.setHours(12, 0, 0, 0);
  calendarViewDate = new Date(
    calendarFocusDate.getFullYear(),
    calendarFocusDate.getMonth(),
    1,
    12,
  );
  renderJournalCalendar();
  requestAnimationFrame(() => $('#calendarDays [tabindex="0"]')?.focus());
}

export function moveCalendarFocus(days) {
  const next = new Date(calendarFocusDate);
  next.setDate(next.getDate() + days);
  focusCalendarDate(next);
}

export function moveCalendarMonth(months) {
  const day = calendarFocusDate.getDate();
  const target = new Date(
    calendarFocusDate.getFullYear(),
    calendarFocusDate.getMonth() + months,
    1,
    12,
  );
  const lastDay = new Date(
    target.getFullYear(),
    target.getMonth() + 1,
    0,
    12,
  ).getDate();
  target.setDate(Math.min(day, lastDay));
  focusCalendarDate(target);
}

function showTaskUpdateFeedback(control, marker) {
  const row = control?.closest(".task-dashboard-item");
  if (!row) return null;
  const state =
    marker === "DONE" ? "done" : marker === "DOING" ? "doing" : "todo";
  control.classList.remove(
    "task-dashboard-state-todo",
    "task-dashboard-state-doing",
    "task-dashboard-state-done",
  );
  control.classList.add(`task-dashboard-state-${state}`);
  control.setAttribute("aria-label", `Task status: ${marker}`);
  row.classList.add("task-dashboard-item-updating");
  const feedback = document.createElement("span");
  feedback.className = `task-update-feedback task-update-feedback-${state}`;
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  feedback.textContent =
    marker === "DONE"
      ? "Completed"
      : marker === "DOING"
        ? "In progress"
        : "To do";
  row.append(feedback);
  row.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
  });
  return Date.now();
}

export function taskUpdateFailed(error) {
  renderGraphPage();
  toast(error.message || "Could not update the task");
}

export async function updateTaskFromClick(
  pagePath,
  blockId,
  action = "complete",
  options = {},
) {
  const page = session.graphStore?.pages.find((item) => item.path === pagePath);
  if (!page) return;
  const current = page.path === state.graphPage?.path;
  const document = current
    ? state.graphDocument
    : session.journalDocuments.get(page.path) ||
      session.graphIndex?.documents.get(page.path) ||
      Graph.parseDocument(page.content);
  const block = graphBlockLocation(blockId, document?.blocks)?.block;
  if (!block) return;
  const marker = block.content.match(
    /^(TODO|DOING|DONE|LATER|NOW|WAITING|CANCELED|CANCELLED)(?:\s+|$)/,
  )?.[1];
  if (!marker) return;
  const originalContent = block.content;
  const inProgress = /^(DOING|NOW)$/.test(marker);
  const completed = /^(DONE|CANCELED|CANCELLED)$/.test(marker);
  const next =
    action === "doing"
      ? inProgress
        ? "TODO"
        : "DOING"
      : completed
        ? "TODO"
        : "DONE";
  block.content = updateTaskCompletionMetadata(
    block.content.replace(/^[A-Z]+/, next),
    next,
  );
  const feedbackStarted = showTaskUpdateFeedback(
    options.feedbackElement,
    next,
  );
  if (current) graphChanged();
  else {
    const content = Graph.serializeDocument(document);
    try {
      await session.graphStore.writePage(page, content);
      session.graphIndex.updatePage(page, content);
      if (page.journal || session.journalDocuments.has(page.path))
        session.journalDocuments.set(page.path, document);
    } catch (error) {
      block.content = originalContent;
      throw error;
    }
  }
  const id = taskPersistenceId({ page, block });
  taskCompletedTodayIds();
  if (next === "DONE") {
    if (!state.taskCompletedTodayIds.includes(id))
      state.taskCompletedTodayIds.push(id);
  } else if (next !== "DONE") {
    state.taskCompletedTodayIds = state.taskCompletedTodayIds.filter(
      (item) => item !== id,
    );
  }
  saveTaskCompletedTodayIds();
  recordTaskHistory(
    page.path,
    block.id,
    marker,
    next,
    Graph.flattenBlocks(document.blocks).findIndex(
      (item) => item.block === block,
    ),
  );
  if (feedbackStarted)
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, 550 - (Date.now() - feedbackStarted))),
    );
  renderGraphPage();
}

export async function updateScheduledDate(pagePath, blockId, date) {
  const page = session.graphStore?.pages.find((item) => item.path === pagePath);
  if (!page) return;
  const current = page.path === state.graphPage?.path;
  const document = current
    ? state.graphDocument
    : session.journalDocuments.get(page.path) ||
      Graph.parseDocument(page.content);
  const block = graphBlockLocation(blockId, document?.blocks)?.block;
  if (!block) return;
  const value = Graph.formatJournalDate(date, "yyyy-MM-dd EEE");
  block.content = block.content.replace(
    /^(\s*)(SCHEDULED|DEADLINE):\s*<[^>]+>\s*$/m,
    (_, space, type) => `${space}${type}: <${value}>`,
  );
  if (current) graphChanged();
  else {
    const content = Graph.serializeDocument(document);
    await session.graphStore.writePage(page, content);
    session.graphIndex.updatePage(page, content);
    if (page.journal || session.journalDocuments.has(page.path))
      session.journalDocuments.set(page.path, document);
  }
  renderGraphPage();
}

export function toggleJournalCalendar(
  selectAction = null,
  anchor = null,
  initialDate = null,
) {
  const opening = journalCalendar.hidden || selectAction;
  journalCalendar.hidden = !opening;
  $("#journalCalendarButton").setAttribute("aria-expanded", String(opening));
  if (opening) {
    calendarSelectAction = selectAction;
    const focusedDate =
      initialDate || (!selectAction && state.graphPage?.journalDate);
    const dateParts =
      typeof focusedDate === "string"
        ? focusedDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
        : null;
    calendarFocusDate = dateParts
      ? new Date(
          Number(dateParts[1]),
          Number(dateParts[2]) - 1,
          Number(dateParts[3]),
          12,
        )
      : focusedDate
        ? new Date(focusedDate)
        : new Date();
    calendarFocusDate.setHours(12, 0, 0, 0);
    calendarViewDate = new Date(calendarFocusDate);
    calendarViewDate.setDate(1);
    journalCalendar.classList.toggle("inline", Boolean(anchor));
    journalCalendar.style.left = anchor
      ? `${Math.min(innerWidth - 250, Math.max(8, anchor.left))}px`
      : "";
    journalCalendar.style.top = anchor
      ? `${Math.min(innerHeight - 280, anchor.bottom + 4)}px`
      : "";
    renderJournalCalendar();
    requestAnimationFrame(() => $('#calendarDays [tabindex="0"]')?.focus());
  }
}

export function selectCalendarDate(date) {
  const action = calendarSelectAction;
  closeJournalCalendar();
  if (action) action(date);
  else requestAction(() => openSingleJournalDate(date));
}

export function closeJournalCalendar() {
  journalCalendar.hidden = true;
  journalCalendar.classList.remove("inline");
  journalCalendar.style.left = "";
  journalCalendar.style.top = "";
  calendarSelectAction = null;
  $("#journalCalendarButton").setAttribute("aria-expanded", "false");
}

export async function openToday(reset = false, options = {}) {
  return openJournalDate(new Date(), { reset, ...options });
}

export async function navigateJournalDate(direction) {
  const journalDate = state.graphPage?.journalDate;
  if (!journalDate) return toast("Open a journal first");
  const [year, month, day] = journalDate.split("-").map(Number);
  const target = new Date(year, month - 1, day, 12);
  target.setDate(target.getDate() + (direction < 0 ? -1 : 1));
  return openSingleJournalDate(target);
}

export async function closeGraph() {
  if (voiceRecording?.finishing)
    return toast("Wait for the voice note to finish saving");
  if (voiceRecording) finishVoiceRecording(false);
  if (state.dirty && !(await flushGraphSave(true))) return;
  session.closeRemoteEvents?.();
  session.closeRemoteEvents = null;
  session.graphStore?.disposeAssets();
  state.graphMode = false;
  state.graphPage = null;
  state.graphDocument = null;
  state.graphZoomId = null;
  state.journalMode = false;
  state.taskView = null;
  state.taskCompletedTodayIds = [];
  state.taskCompletedDate = "";
  session.journalDocuments.clear();
  session.graphHistory = [];
  session.graphHistoryIndex = -1;
  taskUndoStack.length = 0;
  taskRedoStack.length = 0;
  outliner.hidden = true;
  app.classList.remove("graph-mode", "journal-mode", "task-view");
  const docs = getStoredDocs();
  if (docs.length)
    loadMarkdown(docs[0].markdown, docs[0].name, { id: docs[0].id });
  else loadMarkdown("", "Untitled");
}

// Hierarchy and references are derived views and never mutate page content.
function namespacePageTitle(page = state.graphPage) {
  if (!page) return "";
  if (String(page.title).includes("/")) return page.title;
  const filename = page.name || page.path?.split("/").at(-1) || "";
  const inferred = Graph.pageTitle("", filename);
  return inferred.includes("/") ? inferred : page.title;
}

function hierarchyBreadcrumb(title, current = false) {
  const segments = title
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments
    .map((segment, index) => {
      const target = segments.slice(0, index + 1).join("/");
      if (current && index === segments.length - 1)
        return `<span>${escapeHtml(segment)}</span>`;
      return `<button type="button" class="graph-page-ref" data-page="${escapeHtml(target)}">${escapeHtml(segment)}</button>`;
    })
    .join('<i aria-hidden="true">/</i>');
}

export function renderPageHierarchy() {
  if (
    !state.graphMode ||
    !session.graphIndex ||
    !state.graphPage ||
    state.journalMode
  ) {
    pageHierarchy.hidden = true;
    pageHierarchy.innerHTML = "";
    return;
  }
  const currentTitle = namespacePageTitle();
  const currentParts = currentTitle.split("/");
  const children = session.graphIndex
    .allPages()
    .map((page) => ({ page, title: namespacePageTitle(page) }))
    .filter((item) => {
      const parts = item.title.split("/");
      return (
        parts.length === currentParts.length + 1 &&
        Graph.normalizePage(parts.slice(0, -1).join("/")) ===
          Graph.normalizePage(currentTitle)
      );
    })
    .sort((a, b) => a.title.localeCompare(b.title));
  const rows = [];
  if (currentParts.length > 1)
    rows.push(
      `<div class="hierarchy-path current">${hierarchyBreadcrumb(currentTitle, true)}</div>`,
    );
  children.forEach((child) =>
    rows.push(
      `<div class="hierarchy-path">${hierarchyBreadcrumb(child.title)}</div>`,
    ),
  );
  pageHierarchy.hidden = !rows.length;
  pageHierarchy.innerHTML = rows.length
    ? `<h3>Hierarchy</h3>${rows.join("")}`
    : "";
}

export function renderReferences(includeUnlinked = false) {
  if (
    !state.graphMode ||
    !session.graphIndex ||
    !state.graphPage ||
    (state.journalMode && !state.graphZoomId)
  ) {
    references.innerHTML = "";
    return;
  }
  const dateValueTimestamp = (value) => {
    if (!value) return 0;
    let date;
    if (
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
    ) {
      const [year, month, day] = value.trim().split("-").map(Number);
      date = new Date(year, month - 1, day);
    } else {
      const numeric = Number(value);
      const timestamp = Number.isFinite(numeric)
        ? numeric > 1e15
          ? numeric / 1e6
          : numeric
        : value;
      date = new Date(timestamp);
    }
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
  };
  const journalTitleTimestamp = (page) => {
    if (!page.journal && !String(page.path || "").startsWith("journals/"))
      return 0;
    const configured = Graph.parseJournalDate(
      String(page.title || ""),
      session.graphStore?.config?.pageTitleFormat,
    );
    if (configured) return configured.getTime();
    // Date.parse does not consistently accept English ordinal suffixes.
    const title = String(page.title || "").replace(
      /(\d)(st|nd|rd|th)\b/gi,
      "$1",
    );
    const parsed = Date.parse(title);
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  const creationTimestamp = (page) => {
    // Imported journals can have a filename date different from their title.
    // The displayed title is authoritative, then the filename-derived date.
    const titleTimestamp = journalTitleTimestamp(page);
    if (titleTimestamp) return titleTimestamp;
    const journalTimestamp = dateValueTimestamp(page.journalDate);
    if (journalTimestamp) return journalTimestamp;
    const properties = Graph.propertiesFrom(page.content || "");
    return dateValueTimestamp(
      properties["created-at"] || properties.created || page.lastModified,
    );
  };
  const creationDate = (page) => {
    const timestamp = creationTimestamp(page);
    return timestamp
      ? new Intl.DateTimeFormat(undefined, {
          day: "numeric",
          month: "short",
          year: "numeric",
        }).format(timestamp)
      : "";
  };
  const referenceSnippet = (item, expandNested = false) =>
    graphContextBlockElement(
      item.block,
      item.page,
      "reference",
      expandNested,
    ).outerHTML;
  const renderGroups = (items, limit = false, expandNested = false) => {
    const groups = new Map();
    items.forEach((item) => {
      if (!groups.has(item.page.title)) groups.set(item.page.title, []);
      groups.get(item.page.title).push(item);
    });
    const ordered = [...groups].sort(([titleA, a], [titleB, b]) => {
      const chronological =
        creationTimestamp(b[0].page) - creationTimestamp(a[0].page);
      return chronological || titleA.localeCompare(titleB);
    });
    const visible = limit ? ordered.slice(0, 5) : ordered;
    const rows = visible
      .map(([title, group]) => {
        const date = creationDate(group[0].page);
        return `<div class="reference-group"><div class="reference-page-row"><button class="reference-page graph-page-ref" data-page="${escapeHtml(title)}">${escapeHtml(title)}</button><span class="reference-leader" aria-hidden="true"></span>${date ? `<time class="reference-date">${escapeHtml(date)}</time>` : ""}</div>${group.map((item) => `<div class="reference-result has-context-tree" role="button" tabindex="0" data-reference-page="${escapeHtml(title)}" data-reference-page-path="${escapeHtml(item.page.path)}" data-reference-block="${escapeHtml(item.block.id)}">${referenceSnippet(item, expandNested)}</div>`).join("")}</div>`;
      })
      .join("");
    return (
      rows +
      (limit && ordered.length > 5
        ? `<button class="references-more" type="button" data-show-all-references>Show all references · ${ordered.length}</button>`
        : "")
    );
  };
  const aggregatePages = new Set([
    "home",
    "journals",
    "today's journal",
    "today's journals",
    "todays journal",
    "todays journals",
    "today journal",
  ]);
  const pageTitle = namespacePageTitle();
  const linked = session.graphIndex
    .referencesToPage(pageTitle)
    .filter(
      (item) => !aggregatePages.has(Graph.normalizePage(item.page.title)),
    );
  const zoomedBlock = state.graphZoomId
    ? graphBlockLocation(state.graphZoomId)?.block
    : null;
  const blockUuid =
    zoomedBlock && Graph.propertiesFrom(zoomedBlock.content).id;
  const blockLinked = blockUuid
    ? session.graphIndex.referencesToBlock(blockUuid)
    : [];
  const unlinked = includeUnlinked
    ? session.graphIndex.unlinkedReferences(pageTitle)
    : [];
  references.innerHTML = `<details${linked.length ? " open" : ""}><summary>Linked references · ${linked.length}</summary>${renderGroups(linked, !state.referencesExpanded, true)}</details>${blockUuid ? `<details${blockLinked.length ? " open" : ""}><summary>Block references · ${blockLinked.length}</summary>${renderGroups(blockLinked)}</details>` : ""}${includeUnlinked ? `<details${unlinked.length ? " open" : ""}><summary>Unlinked references · ${unlinked.length}</summary>${renderGroups(unlinked)}</details>` : '<button class="unlinked-button" data-show-unlinked>Find unlinked references</button>'}`;
  $$(".reference-result[data-reference-page-path]", references).forEach(
    (result) => {
      const page = session.graphStore.pages.find(
        (item) => item.path === result.dataset.referencePagePath,
      );
      resolveGraphContentAssets(result, page);
    },
  );
}

