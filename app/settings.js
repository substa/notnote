/**
 * Settings and documentation views, shortcut configuration, and optional Git controls.
 */

import {
  assetCacheSize,
  saveSettings,
  selectedAccent,
  selectedTheme,
} from "./appearance.js";
import {
  currentSettings,
  initialUrlParameters,
  settingsRouteUrl,
  settingsTabFromPath,
  requireFunctions,
  shortcutDefinitions,
  shortcutLabel,
  shortcutValue,
} from "./core.js";
import { searchDom } from "./document.js";
import {
  $,
  $$,
  app,
  documentationContent,
  documentationView,
} from "./dom.js";
import { graphRoutePath } from "./graph-session.js";
import { escapeHtml, markdownToHtml } from "./markdown.js";
import { session, state } from "./state.js";



let settingsDependencies;

export function configureSettingsDependencies(dependencies) {
  settingsDependencies = requireFunctions("settings", dependencies, [
    "activeMarkdownField",
  ]);
}

// Documentation search uses the browser Highlight API without rewriting rendered markup.
let documentationLoaded = false;
let documentationReturnFocus = null;
let settingsRoutePushed = false;
let documentationMatches = [];
let currentDocumentationMatch = -1;
let gitSettingsTimer = null;

function clearDocumentationHighlights() {
  if (globalThis.CSS?.highlights) {
    CSS.highlights.delete("documentation-search");
    CSS.highlights.delete("documentation-search-current");
  }
}

function paintDocumentationHighlights() {
  clearDocumentationHighlights();
  if (!globalThis.CSS?.highlights || !globalThis.Highlight) return;
  const all = new Highlight();
  for (const match of documentationMatches) all.add(match.range);
  CSS.highlights.set("documentation-search", all);
  const current = documentationMatches[currentDocumentationMatch];
  if (current)
    CSS.highlights.set(
      "documentation-search-current",
      new Highlight(current.range),
    );
}

export function updateDocumentationSearch(scroll = true) {
  documentationMatches = [];
  currentDocumentationMatch = -1;
  clearDocumentationHighlights();
  const input = $("#documentationSearch");
  const query = input?.value.trim().toLocaleLowerCase() || "";
  if (query) searchDom(documentationContent, query, documentationMatches);
  if (documentationMatches.length) currentDocumentationMatch = 0;
  paintDocumentationHighlights();
  const count = $("#documentationSearchCount");
  if (count)
    count.textContent = documentationMatches.length
      ? `${currentDocumentationMatch + 1}/${documentationMatches.length}`
      : query
        ? "0/0"
        : "";
  $$('[data-documentation-search-move]', $("#documentationMenu")).forEach(
    (button) => (button.disabled = !documentationMatches.length),
  );
  if (scroll && documentationMatches.length)
    moveDocumentationSearch(0, false);
}

export function moveDocumentationSearch(direction = 1, repaint = true) {
  if (!documentationMatches.length) return;
  currentDocumentationMatch =
    (currentDocumentationMatch + direction + documentationMatches.length) %
    documentationMatches.length;
  if (repaint) {
    paintDocumentationHighlights();
    const count = $("#documentationSearchCount");
    if (count)
      count.textContent = `${currentDocumentationMatch + 1}/${documentationMatches.length}`;
  }
  const range = documentationMatches[currentDocumentationMatch].range;
  const element =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range.startContainer.parentElement;
  element?.scrollIntoView({
    behavior: "smooth",
    block: "center",
    inline: "nearest",
  });
}

export function resetDocumentationSearch() {
  const input = $("#documentationSearch");
  if (input) input.value = "";
  documentationMatches = [];
  currentDocumentationMatch = -1;
  clearDocumentationHighlights();
  const count = $("#documentationSearchCount");
  if (count) count.textContent = "";
  $$('[data-documentation-search-move]', $("#documentationMenu")).forEach(
    (button) => (button.disabled = true),
  );
}

async function loadDocumentation() {
  if (documentationLoaded) return;
  documentationContent.innerHTML = "<p>Loading documentation…</p>";
  try {
    const response = await fetch("./docs/user-guide.md", {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Documentation is unavailable");
    documentationContent.innerHTML = markdownToHtml(await response.text());
    $$("a[href]", documentationContent).forEach((link) => {
      const href = link.getAttribute("href");
      if (href && !href.startsWith("#") && !/^(?:[a-z]+:|\/)/i.test(href)) {
        link.href = new URL(href, new URL("./docs/", location.href)).href;
      }
    });
    const used = new Set();
    $$("h1,h2,h3,h4,h5,h6", documentationContent).forEach(
      (heading, index) => {
        let id =
          heading.textContent
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || `section-${index}`;
        while (used.has(id)) id = `${id}-${index}`;
        used.add(id);
        heading.id = id;
      },
    );
    const sections = $$("h2", documentationContent);
    $("#documentationMenu").innerHTML = `<form class="documentation-search" role="search"><input id="documentationSearch" type="search" placeholder="Search documentation…" aria-label="Search documentation"><span id="documentationSearchCount" aria-live="polite"></span><button type="button" data-documentation-search-move="-1" aria-label="Previous result" title="Previous result" disabled>↑</button><button type="button" data-documentation-search-move="1" aria-label="Next result" title="Next result" disabled>↓</button></form>${sections.length ? `<strong>On this page</strong><select aria-label="Jump to documentation section"><option value="">Choose a section…</option>${sections.map((heading) => `<option value="${heading.id}">${escapeHtml(heading.textContent)}</option>`).join("")}</select><div>${sections.map((heading) => `<button type="button" data-documentation-target="${heading.id}">${escapeHtml(heading.textContent)}</button>`).join("")}</div>` : ""}`;
    documentationLoaded = true;
  } catch (error) {
    documentationContent.innerHTML = `<p>${escapeHtml(error.message || "Could not load the documentation.")}</p>`;
  }
}

// Shortcut controls are generated from the single definition table in core.js.
export function renderShortcutSettings(query = "") {
  const value = query.trim().toLowerCase();
  const groups = new Map();
  for (const item of shortcutDefinitions) {
    if (
      value &&
      !`${item.label} ${item.section} ${shortcutValue(item.id)}`
        .toLowerCase()
        .includes(value)
    )
      continue;
    if (!groups.has(item.section)) groups.set(item.section, []);
    groups.get(item.section).push(item);
  }
  $("#shortcutList").innerHTML =
    [...groups]
      .map(
        ([section, items]) =>
          `<section class="shortcut-section"><h2>${escapeHtml(section)}</h2>${items.map((item) => `<div class="shortcut-row"><span>${escapeHtml(item.label)}</span><button type="button" class="shortcut-binding" data-shortcut-record="${item.id}">${escapeHtml(shortcutLabel(shortcutValue(item.id)))}</button><button type="button" class="shortcut-reset" data-shortcut-reset="${item.id}" aria-label="Reset ${escapeHtml(item.label)}">Reset</button></div>`).join("")}</section>`,
      )
      .join("") || '<p class="task-dashboard-empty">No shortcuts found</p>';
}

// Git controls are visible only when the connected server reports the optional adapter.
function gitSyncSettings() {
  const value = currentSettings().gitSync;
  return value && typeof value === "object"
    ? value
    : { autoCommit: false, autoPush: false, debounceSeconds: 10 };
}

function updateGitSettingsControls() {
  const settings = gitSyncSettings();
  $("#settingsGitAutoCommit").checked = Boolean(settings.autoCommit);
  $("#settingsGitAutoPush").checked = Boolean(settings.autoPush);
  $("#settingsGitDelay").value = String(
    [5, 10, 30, 60].includes(Number(settings.debounceSeconds))
      ? Number(settings.debounceSeconds)
      : 10,
  );
  $("#gitSyncNow").textContent = settings.autoPush
    ? "Commit and push now"
    : "Commit now";
}

export function saveGitSyncSettings() {
  const gitSync = {
    autoCommit: $("#settingsGitAutoCommit").checked,
    autoPush: $("#settingsGitAutoPush").checked,
    debounceSeconds: Number($("#settingsGitDelay").value),
  };
  saveSettings({ gitSync });
  $("#gitSyncNow").textContent = gitSync.autoPush
    ? "Commit and push now"
    : "Commit now";
  clearTimeout(gitSettingsTimer);
  gitSettingsTimer = setTimeout(loadGitSettingsStatus, 500);
}

export async function loadGitSettingsStatus() {
  clearTimeout(gitSettingsTimer);
  if (
    documentationView.hidden ||
    $("[data-settings-panel=git]").hidden ||
    !session.graphStore?.isRemote
  )
    return;
  const container = $("#gitSettingsStatus");
  try {
    const status = await session.graphStore.api("/git/status");
    $("#gitSettingsBranch").textContent = status.branch || "—";
    $("#gitSettingsUpstream").textContent =
      status.upstream || "Not configured";
    const controls = [
      $("#settingsGitAutoCommit"),
      $("#settingsGitAutoPush"),
      $("#settingsGitDelay"),
      $("#gitSyncNow"),
    ];
    controls.forEach((control) => {
      control.disabled = !status.available || status.running;
    });
    let title = status.message || "Git repository ready";
    if (status.running) title = "Git sync in progress…";
    else if (status.pending) title = "Changes waiting to be committed";
    else if (status.lastError) title = "Git sync failed";
    else if (status.lastAction) title = status.lastAction;
    const details = status.lastError
      ? status.lastError
      : status.lastSyncedAt
        ? `Last update ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(status.lastSyncedAt)}`
        : status.available
          ? "No Git snapshot has been created in this session."
          : "Initialize a Git repository for this graph to enable snapshots.";
    $("strong", container).textContent = title;
    $("small", container).textContent = details;
    container.classList.toggle("error", Boolean(status.lastError));
  } catch (error) {
    $("strong", container).textContent = "Git status unavailable";
    $("small", container).textContent =
      error.message || "Could not contact the graph server.";
    container.classList.add("error");
  }
  gitSettingsTimer = setTimeout(loadGitSettingsStatus, 2000);
}

// Settings and documentation are route-backed overlays over the current workspace.
export async function showSettings(tab = "general", options = {}) {
  const opening = documentationView.hidden;
  if (opening)
    documentationReturnFocus =
      settingsDependencies.activeMarkdownField() || document.activeElement;
  documentationView.hidden = false;
  app.classList.add("documentation-open");
  $("#settingsGitTab").hidden = !session.graphStore?.isRemote;
  if (tab === "git" && !session.graphStore?.isRemote) tab = "general";
  if (!options.routeNavigation) {
    const route = settingsRouteUrl(tab);
    if (`${location.pathname}${location.search}` !== route) {
      if (opening && !settingsTabFromPath()) {
        settingsRoutePushed = true;
        history.pushState({ notnoteSettings: tab }, "", route);
      } else
        history.replaceState({ notnoteSettings: tab }, "", route);
    }
  }
  $$("[data-settings-tab]").forEach((button) =>
    button.classList.toggle("active", button.dataset.settingsTab === tab),
  );
  $$("[data-settings-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== tab;
  });
  $("#settingsTheme").value = selectedTheme;
  $("#settingsAccent").value = selectedAccent;
  $("#settingsVim").checked = state.vimEnabled;
  $("#settingsAssetCacheSize").value = String(assetCacheSize());
  if (tab === "git") {
    updateGitSettingsControls();
    await loadGitSettingsStatus();
  } else clearTimeout(gitSettingsTimer);
  if (tab === "shortcuts") renderShortcutSettings($("#shortcutSearch").value);
  if (tab === "documentation") await loadDocumentation();
  requestAnimationFrame(() =>
    (tab === "shortcuts"
      ? $("#shortcutSearch")
      : tab === "documentation"
        ? $("#documentationSearch")
        : $("#settingsClose")
    )?.focus(),
  );
}
export const showDocumentation = (options) =>
  showSettings("documentation", options);

function workspaceRouteUrl() {
  const query = initialUrlParameters.size ? `?${initialUrlParameters}` : "";
  return state.graphMode && state.graphPage
    ? `${graphRoutePath(state.graphPage)}${query}`
    : `/${query}`;
}

export function closeDocumentation(options = {}) {
  if (documentationView.hidden) return;
  clearTimeout(gitSettingsTimer);
  resetDocumentationSearch();
  documentationView.hidden = true;
  app.classList.remove("documentation-open");
  if (options.routeNavigation) settingsRoutePushed = false;
  else if (settingsTabFromPath()) {
    if (settingsRoutePushed) {
      settingsRoutePushed = false;
      history.back();
    } else history.replaceState({}, "", workspaceRouteUrl());
  }
  if (
    documentationReturnFocus?.isConnected &&
    !documentationReturnFocus.closest?.("[hidden]")
  )
    documentationReturnFocus.focus();
  else $("#footerMenuButton").focus();
}

