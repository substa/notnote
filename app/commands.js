/**
 * Markdown and block actions, command palette, page navigation, and history operations.
 */

import { saveSettings, setTheme } from "./appearance.js";
import {
  currentSettings,
  shortcutLabel,
  shortcutValue,
  usesMobileInput,
  vimRedoStack,
  vimUndoStack,
} from "./core.js";
import {
  centerCaret,
  downloadBlob,
  getStoredDocs,
  loadMarkdown,
  relativeDate,
  requestAction,
  showFind,
  toast,
  toggleSource,
} from "./document.js";
import {
  $,
  $$,
  app,
  documentTitleActions,
  editor,
  fileName,
  notnoteWrap,
  saveState,
  sourceEditor,
} from "./dom.js";
import {
  cleanEmptyPages,
  cleanOrphanedAssets,
  closeGraph,
  flushGraphSave,
  graphChanged,
  loadGraphPage,
  navigateGraphHistory,
  navigateJournalDate,
  openGraph,
  openToday,
  syncGraphIndex,
  syncGraphRoute,
} from "./graph-session.js";
import {
  activateGraphBlock,
  commitGraphBlock,
  ensureTemplatesPage,
  focusGraphBlock,
  graphBlockLocation,
  openTasksPage,
  openTemplatesPage,
  renderGraphPage,
  resizeGraphEditor,
  restoreGraphCollapse,
  saveGraphCollapse,
} from "./graph-view.js";
import { currentMarkdown, escapeHtml, markdownToHtml } from "./markdown.js";
import { pageMatchRank, toggleGraphTask } from "./outliner.js";
import { showDocumentation, showSettings } from "./settings.js";
import { Graph, session, state } from "./state.js";
import {
  activateSourceBlock,
  captureVimSnapshot,
  commitActiveBlock,
  pushVimSnapshot,
  resizeSourceBlock,
  setVimEnabled,
} from "./vim.js";



// Standalone document formatting and export actions.
export function exportHtml() {
  const body = markdownToHtml(currentMarkdown());
  const title = escapeHtml(fileName.value || "Document");
  const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{max-width:760px;margin:60px auto;padding:0 24px;color:#333;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}h1{border-bottom:1px solid #ddd}a{color:#4183c4}blockquote{border-left:3px solid #ddd;padding-left:18px;color:#777}code,pre{font-family:monospace;background:#f5f5f5;border-radius:4px}code{padding:2px 4px}pre{padding:16px;overflow:auto}pre code{padding:0}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:7px}img,video,iframe{max-width:100%}audio{width:100%}iframe{border:0}</style><body>${body}</body></html>`;
  downloadBlob(page, `${fileName.value || "document"}.html`, "text/html");
  toast("HTML exported");
}

export function activeMarkdownField() {
  if (paletteContext?.field?.isConnected) return paletteContext.field;
  if (state.graphMode)
    return session.activeGraphBlock?.field?.isConnected
      ? session.activeGraphBlock.field
      : state.sourceMode
        ? sourceEditor
        : null;
  if (session.activeSourceBlock?.isConnected) return session.activeSourceBlock;
  return state.sourceMode ? sourceEditor : null;
}

export function notifyMarkdownField(field) {
  if (field === session.activeSourceBlock) resizeSourceBlock(field);
  if (field === session.activeGraphBlock?.field) resizeGraphEditor(field);
  field.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "insertText" }),
  );
  field.focus();
}

function withMarkdownField(callback) {
  const existing = activeMarkdownField();
  if (existing) {
    callback(existing);
    return;
  }
  if (state.graphMode) {
    const block = state.graphDocument?.blocks?.[0];
    if (!block) return;
    activateGraphBlock(block);
    requestAnimationFrame(
      () => session.activeGraphBlock && callback(session.activeGraphBlock.field),
    );
    return;
  }
  let block = getSelection().anchorNode;
  if (block?.nodeType === Node.TEXT_NODE) block = block.parentElement;
  while (block && block.parentElement !== editor) block = block.parentElement;
  if (!block || block === editor) {
    block = document.createElement("p");
    block.append(document.createElement("br"));
    editor.append(block);
  }
  activateSourceBlock(block);
  requestAnimationFrame(
    () => session.activeSourceBlock && callback(session.activeSourceBlock),
  );
}

function fieldRange(field) {
  let start = field.selectionStart ?? 0;
  let end = field.selectionEnd ?? start;
  if (field === sourceEditor) {
    start = field.value.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = field.value.indexOf("\n", end);
    end = lineEnd < 0 ? field.value.length : lineEnd;
  } else if (start === end) {
    start = 0;
    end = field.value.length;
  }
  return { start, end };
}

function transformMarkdownBlock(transform) {
  withMarkdownField((field) => {
    const range = fieldRange(field);
    const selected = field.value.slice(range.start, range.end);
    const replacement = transform(selected || "text");
    field.setRangeText(replacement, range.start, range.end, "select");
    notifyMarkdownField(field);
  });
}

export function prefixMarkdownLines(prefix, ordered = false) {
  transformMarkdownBlock((text) =>
    text
      .split("\n")
      .map((line, index) => {
        const clean = line.replace(
          /^\s*(?:#{1,6}\s+|>\s+|[-+*]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)/,
          "",
        );
        return `${ordered ? `${index + 1}. ` : prefix}${clean}`;
      })
      .join("\n"),
  );
}

export function headingCommand(level) {
  transformMarkdownBlock(
    (text) => `${"#".repeat(level)} ${text.replace(/^#{1,6}\s+/, "").trim()}`,
  );
}

export function wrapMarkdownSelection(before, after = before, placeholder = "text") {
  withMarkdownField((field) => {
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const selected = field.value.slice(start, end) || placeholder;
    const replacement = `${before}${selected}${after}`;
    field.setRangeText(replacement, start, end, "end");
    const selectionStart = start + before.length;
    field.setSelectionRange(selectionStart, selectionStart + selected.length);
    notifyMarkdownField(field);
  });
}

// Block commands also support contexts rendered from another journal page.
export function selectedGraphBlock() {
  const id =
    session.activeGraphBlock?.block?.id || paletteContext?.field?.dataset?.blockId;
  return id ? graphBlockLocation(id)?.block : null;
}

async function writeTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Older iOS versions expose the API but reject writes in some contexts.
    }
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.position = "fixed";
  field.style.left = "-9999px";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  field.setSelectionRange(0, field.value.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    field.remove();
  }
  if (!copied) throw new Error("Clipboard access is not available");
}

async function persistContextDocument(context) {
  if (!context || context.page.path === state.graphPage?.path) {
    graphChanged();
    renderGraphPage();
    return;
  }
  const content = Graph.serializeDocument(context.document);
  await session.graphStore.writePage(context.page, content);
  session.graphIndex.updatePage(context.page, content);
  if (context.page.journal || session.journalDocuments.has(context.page.path))
    session.journalDocuments.set(context.page.path, context.document);
  renderGraphPage();
}

export async function copyGraphBlockReference(
  block = selectedGraphBlock(),
  context = null,
) {
  if (!state.graphMode || !block) return toast("Select a block first");
  const properties = Graph.propertiesFrom(block.content);
  const uuid = properties.id || Graph.newId();
  if (!properties.id) {
    block.content = `${block.content.replace(/\s+$/, "")}\n${block.content ? "" : ""}id:: ${uuid}`;
    block.uuid = uuid;
    const clipboardWrite = writeTextToClipboard(`((${uuid}))`);
    await Promise.all([clipboardWrite, persistContextDocument(context)]);
  } else await writeTextToClipboard(`((${uuid}))`);
  toast("Block reference copied");
}

export async function copyGraphBlock(block) {
  if (!block) return;
  const markdown = Graph.serializeDocument({
    preamble: [],
    blocks: [block],
    trailingNewline: true,
  });
  await writeTextToClipboard(markdown);
  toast("Block copied");
}

export async function makeGraphBlockTemplate(block) {
  if (!block || !session.graphStore) return;
  const suggestedName = block.content
    .split("\n", 1)[0]
    .replace(/^(?:TODO|DOING|DONE|LATER|NOW|WAITING|CANCELED|CANCELLED)\s+/, "")
    .replace(/^#{1,6}\s+/, "")
    .trim()
    .slice(0, 60);
  const name = prompt("Template name:", suggestedName)
    ?.replace(/\s+/g, " ")
    .trim();
  if (!name) return;
  const copiedBlocks = Graph.copyBlocksForTemplate([block]);
  const page = await ensureTemplatesPage();
  if (!page) return;
  const current = page.path === state.graphPage?.path;
  const document = current
    ? state.graphDocument
    : session.graphIndex?.documents.get(page.path) ||
      Graph.parseDocument(page.content);
  if (
    Graph.templatesFromDocument(document).some(
      (template) =>
        Graph.normalizePage(template.name) ===
        Graph.normalizePage(name),
    )
  )
    return toast(`Template “${name}” already exists`);
  const definition = {
    id: Graph.newId(),
    uuid: null,
    content: name,
    marker: "-",
    children: copiedBlocks,
    collapsed: false,
  };
  if (current) {
    const snapshot = captureVimSnapshot();
    document.blocks.push(definition);
    pushVimSnapshot(vimUndoStack, snapshot);
    vimRedoStack.length = 0;
    graphChanged();
    renderGraphPage();
  } else {
    document.blocks.push(definition);
    const content = Graph.serializeDocument(document);
    await session.graphStore.writePage(page, content);
    session.graphIndex.updatePage(page, content);
  }
  toast(`Template “${name}” created`);
}

export async function deleteGraphBlock(block, context = null) {
  if (!confirm("Delete this block and all its nested blocks?")) return false;
  const current = !context || context.page.path === state.graphPage?.path;
  const document = context?.document || state.graphDocument;
  const location = graphBlockLocation(block?.id, document?.blocks);
  if (!location) return false;
  commitGraphBlock();
  const snapshot = current ? captureVimSnapshot() : null;
  location.blocks.splice(location.index, 1);
  let focus =
    location.blocks[location.index] ||
    location.blocks[location.index - 1] ||
    location.parent;
  if (!document.blocks.length) {
    focus = {
      id: Graph.newId(),
      uuid: null,
      content: "",
      marker: "-",
      children: [],
      collapsed: false,
    };
    document.blocks.push(focus);
  }
  if (current) {
    if (state.graphZoomId && !graphBlockLocation(state.graphZoomId))
      state.graphZoomId = null;
    pushVimSnapshot(vimUndoStack, snapshot);
    vimRedoStack.length = 0;
    graphChanged();
    if (focus) focusGraphBlock(focus.id);
    else renderGraphPage();
  } else await persistContextDocument(context);
  toast("Block deleted");
  return true;
}

function zoomGraphBlock() {
  const block = selectedGraphBlock();
  if (!state.graphMode || !block) return toast("Select a block first");
  commitGraphBlock();
  state.graphZoomId = block.id;
  renderGraphPage();
}

// Graph-level creation, navigation, and maintenance commands.
export async function createGraphPage() {
  if (!session.graphStore) return openGraph();
  const title = prompt("Page name:");
  if (title?.trim()) loadGraphPage(title.trim(), { create: true });
}

const commands = [
  {
    label: "Settings",
    shortcutId: "settings",
    keywords: "preferences general shortcuts appearance",
    run: () => showSettings("general"),
  },
  {
    label: "Documentation",
    shortcutId: "documentation",
    keywords: "help guide manual shortcuts",
    run: showDocumentation,
  },
  {
    label: "Open local graph",
    keywords: "folder logseq graph local",
    run: () => requestAction(openGraph),
  },
  {
    label: "Sync all notes and backlinks",
    keywords: "graph index refresh rescan autocomplete block references",
    run: () => requestAction(syncGraphIndex),
  },
  {
    label: "Clean orphaned assets",
    keywords: "attachments files upload unused cleanup delete assets",
    run: () => requestAction(cleanOrphanedAssets),
  },
  {
    label: "Clean empty pages",
    keywords: "graph files blank unused orphan cleanup backlinks delete",
    run: () => requestAction(cleanEmptyPages),
  },
  {
    label: "New graph page",
    keywords: "page create graph",
    run: () => requestAction(createGraphPage),
  },
  {
    label: "Today journal",
    shortcutId: "today",
    keywords: "daily notes journal today",
    aliases: "/today",
    run: () => requestAction(openToday),
  },
  {
    label: "Previous journal day",
    shortcutId: "journalPrevious",
    keywords: "journal previous yesterday older date navigate",
    run: () => requestAction(() => navigateJournalDate(-1)),
  },
  {
    label: "Next journal day",
    shortcutId: "journalNext",
    keywords: "journal next tomorrow newer date navigate",
    run: () => requestAction(() => navigateJournalDate(1)),
  },
  {
    label: "Task dashboard",
    shortcutId: "tasks",
    keywords: "tasks todo doing done dashboard all",
    run: () => requestAction(openTasksPage),
  },
  {
    label: "Open templates",
    keywords: "template reusable predefined block structure",
    run: () => requestAction(openTemplatesPage),
  },
  {
    label: "All pages",
    keywords: "pages directory index alphabet list browse",
    run: () => requestAction(showPageDirectory),
  },
  {
    label: "Previous page",
    shortcutId: "back",
    keywords: "history back navigate",
    run: () => navigateGraphHistory(-1),
  },
  {
    label: "Next page",
    shortcutId: "forward",
    keywords: "history forward navigate",
    run: () => navigateGraphHistory(1),
  },
  {
    label: "Copy block reference",
    keywords: "uuid block reference link",
    run: copyGraphBlockReference,
  },
  {
    label: "Zoom into block",
    keywords: "focus block outliner",
    run: zoomGraphBlock,
  },
  { label: "Close graph", keywords: "close folder graph", run: closeGraph },
  {
    label: "Rename document",
    shortcutId: "rename",
    keywords: "title name file page",
    run: () => {
      commitActiveBlock();
      commitGraphBlock();
      fileName.focus();
      fileName.select();
    },
  },
  {
    label: "Find in document",
    shortcutId: "find",
    keywords: "search",
    run: showFind,
  },
  {
    label: "Export HTML",
    shortcutId: "export",
    keywords: "download html document",
    run: exportHtml,
  },
  {
    label: "Full Markdown source",
    shortcutId: "source",
    keywords: "source code",
    run: () => toggleSource(),
  },
  {
    label: "Toggle Vim mode",
    keywords: "vim keyboard normal insert",
    run: () => setVimEnabled(),
  },
  {
    label: "Light theme",
    keywords: "appearance light",
    run: () => setTheme("light"),
  },
  {
    label: "Dark theme",
    keywords: "appearance dark",
    run: () => setTheme("dark"),
  },
  {
    label: "System theme",
    keywords: "appearance system automatic",
    run: () => setTheme("system"),
  },
];

function goToHeading(index, line) {
  if (state.sourceMode) {
    const position =
      sourceEditor.value
        .split("\n")
        .slice(0, line - 1)
        .join("\n").length + (line > 1 ? 1 : 0);
    sourceEditor.focus();
    sourceEditor.setSelectionRange(position, position);
    centerCaret();
    return;
  }
  commitActiveBlock();
  const heading = $$("h1,h2,h3,h4,h5,h6", editor)[index];
  heading?.scrollIntoView({ behavior: "smooth", block: "center" });
}

// The palette builds one contextual command list for documents and graphs.
let paletteContext = null;

function contextualCommands() {
  const markdown = currentMarkdown();
  return [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)].map(
    (match, index) => ({
      label: `Outline: ${match[2].replace(/[*_`]/g, "")}`,
      shortcut: `H${match[1].length}`,
      keywords: "outline title heading section",
      run: () =>
        goToHeading(index, markdown.slice(0, match.index).split("\n").length),
    }),
  );
}

function blockResultCommands(query) {
  if (!session.graphIndex || query.length < 2) return [];
  return session.graphIndex.search(query, 24).map((result) => ({
    label: result.content
      .replace(/^\s*[\w-]+::.*$/gm, "")
      .replace(/\[\[|\]\]/g, "")
      .trim()
      .slice(0, 80),
    shortcut: result.page.title,
    run: () => loadGraphPage(result.page, { blockId: result.block.id }),
  }));
}

function recentPageCommands(query) {
  const searchQuery = Graph.normalizeSearch(query);
  const normalizedQuery = query && searchQuery;
  const seen = new Set();
  const settings = currentSettings();
  const storedPages = (settings.recentGraphPages || [])
    .filter((item) => item.graph === session.graphStore?.name)
    .map((item) => session.graphStore?.pages.find((page) => page.path === item.path))
    .filter(Boolean);
  let graphPages = [...session.graphHistory]
    .reverse()
    .map((entry) =>
      session.graphStore?.pages.find((page) => page.path === entry.path),
    )
    .filter(Boolean);
  graphPages.push(...storedPages);
  if (query && session.graphIndex) graphPages.push(...session.graphIndex.pageSuggestions());
  const matchedPages = graphPages
    .flatMap((page) => {
      if (seen.has(page.path)) return [];
      seen.add(page.path);
      const aliases = session.graphIndex?.aliasesForPage(page) || [];
      if (!normalizedQuery)
        return [{ page, aliases, matchedAlias: "", rank: 0 }];
      const results = [];
      const aliasKeys = new Set();
      for (const alias of aliases) {
        const key = Graph.normalizeSearch(alias);
        if (
          !key.includes(normalizedQuery) ||
          key === Graph.normalizeSearch(page.title) ||
          aliasKeys.has(key)
        )
          continue;
        aliasKeys.add(key);
        results.push({
          page,
          aliases,
          matchedAlias: alias,
          rank: pageMatchRank(alias, normalizedQuery),
        });
      }
      if (Graph.normalizeSearch(page.title).includes(normalizedQuery))
        results.push({
          page,
          aliases,
          matchedAlias: "",
          rank: pageMatchRank(page.title, normalizedQuery),
        });
      return results;
    })
    .sort((a, b) => {
      if (!normalizedQuery) return 0;
      const labelA = a.matchedAlias || a.page.title;
      const labelB = b.matchedAlias || b.page.title;
      return (
        a.rank - b.rank ||
        labelA.length - labelB.length ||
        labelA.localeCompare(labelB)
      );
    })
    .slice(0, 80);
  const pages = matchedPages.map(({ page, aliases, matchedAlias }) => ({
    label: matchedAlias || page.title,
    shortcut: matchedAlias
      ? `Alias · ${page.title}`
      : page.journal
        ? "Journal"
        : "",
    keywords: `graph page ${page.title} ${aliases.join(" ")}`,
    run: () => loadGraphPage(page),
  }));
  const documents = getStoredDocs()
    .filter(
      (doc) => !query || Graph.normalizeSearch(doc.name).includes(searchQuery),
    )
    .map((doc) => ({
      label: doc.name,
      shortcut: relativeDate(doc.updated),
      keywords: "recent files documents open",
      run: () =>
        requestAction(() =>
          loadMarkdown(doc.markdown, doc.name, { id: doc.id }),
        ),
    }));
  const exactPage =
    Boolean(session.graphIndex?.resolvePage(query)) ||
    session.graphIndex
      ?.pageSuggestions()
      .some(
        (page) => Graph.normalizePage(page.title) === normalizedQuery,
      );
  const createPage =
    query && session.graphStore && !exactPage
      ? [
          {
            label: `Create page “${query}”`,
            shortcut: "Enter",
            createPage: true,
            run: () =>
              requestAction(() => loadGraphPage(query, { create: true })),
          },
        ]
      : [];
  return [...createPage, ...pages, ...documents];
}

let filteredCommands = [];
let expandedCommandSections = new Set();
let selectedCommand = 0;

function commandMarkup(command, index) {
  const shortcut = command.shortcutId
    ? shortcutLabel(shortcutValue(command.shortcutId))
    : command.shortcut;
  return `<button class="command-item${index === selectedCommand ? " selected" : ""}" data-command-index="${index}" role="option" aria-selected="${index === selectedCommand}"><span>${escapeHtml(command.label)}</span>${shortcut ? `<kbd>${escapeHtml(shortcut)}</kbd>` : ""}</button>`;
}

function formatGraphSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2)
    return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
}

let paletteGraphStatsCache = null;

function renderPaletteGraphStats() {
  const footer = $("#commandPaletteStats");
  const store = session.graphStore;
  footer.hidden = !store;
  if (!store) return;
  const applyStats = (stats) => {
    if (session.graphStore !== store || !stats) return;
    $("#paletteGraphFiles").textContent =
      `${stats.files} ${stats.files === 1 ? "file" : "files"}${stats.partial ? " indexed" : ""}`;
    $("#paletteGraphModified").textContent = stats.lastModified
      ? `Modified ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(stats.lastModified)}`
      : "No modifications";
    $("#paletteGraphSize").textContent =
      `${stats.partial ? "≥ " : ""}${formatGraphSize(stats.size)}`;
  };
  $("#paletteGraphName").textContent = store.name || "Graph";
  if (
    paletteGraphStatsCache?.store === store &&
    paletteGraphStatsCache.value &&
    Date.now() - paletteGraphStatsCache.time < 30000
  ) {
    applyStats(paletteGraphStatsCache.value);
    return;
  }
  $("#paletteGraphFiles").textContent = "Calculating folder…";
  $("#paletteGraphModified").textContent = "";
  $("#paletteGraphSize").textContent = "";
  if (
    paletteGraphStatsCache?.store === store &&
    paletteGraphStatsCache.promise
  )
    return;
  const cache = { store, promise: store.stats(), value: null, time: 0 };
  paletteGraphStatsCache = cache;
  cache.promise
    .then((stats) => {
      cache.value = stats;
      cache.time = Date.now();
      cache.promise = null;
      applyStats(stats);
    })
    .catch(() => {
      if (session.graphStore === store)
        $("#paletteGraphFiles").textContent = "Folder statistics unavailable";
      cache.promise = null;
    });
}

function renderCommandList() {
  const rawQuery = $("#commandInput").value.trim();
  const query = Graph.normalizeSearch(rawQuery);
  const searching = Boolean(query);
  const commandQuery = query.replace(/^\/+/, "");
  const slashQuery = query.startsWith("/");
  const commandItems = [...commands, ...contextualCommands()].filter(
    (command) =>
      slashQuery
        ? (command.aliases || "")
            .toLowerCase()
            .split(/\s+/)
            .some((alias) => alias.startsWith(query))
        : Graph.normalizeSearch(
            `${command.label} ${command.keywords || ""}`,
          ).includes(commandQuery),
  );
  const blockItems = slashQuery ? [] : blockResultCommands(query);
  const allPageItems = slashQuery ? [] : recentPageCommands(rawQuery);
  const createItems = allPageItems.filter((command) => command.createPage);
  const pageItems = allPageItems.filter((command) => !command.createPage);
  const visibleLimit = searching ? 5 : 3;
  const visibleItems = (items, section) =>
    expandedCommandSections.has(section)
      ? items
      : items.slice(0, visibleLimit);
  const visiblePageItems = visibleItems(pageItems, "pages");
  const visibleCommandItems = visibleItems(commandItems, "commands");
  const visibleBlockItems = visibleItems(blockItems, "blocks");
  filteredCommands = searching
    ? [
        ...createItems,
        ...visiblePageItems,
        ...visibleCommandItems,
        ...visibleBlockItems,
      ]
    : [...visibleCommandItems, ...visiblePageItems];
  selectedCommand = Math.max(
    0,
    Math.min(selectedCommand, filteredCommands.length - 1),
  );
  $(".command-palette").classList.toggle("searching", searching);
  $("#createPageSection").hidden = !createItems.length;
  $("#pageResultSection").hidden = !pageItems.length;
  $("#commandResultSection").hidden = !commandItems.length;
  $("#blockResultSection").hidden = !blockItems.length;
  $("#recentHeading").textContent = searching ? "Pages" : "Recent pages";
  const createOffset = 0;
  const pageOffset = searching
    ? createItems.length
    : visibleCommandItems.length;
  const commandOffset = searching
    ? createItems.length + visiblePageItems.length
    : 0;
  const blockOffset = commandOffset + visibleCommandItems.length;
  $("#createPageList").innerHTML = createItems
    .map((command, index) => commandMarkup(command, createOffset + index))
    .join("");
  $("#recentPageList").innerHTML = visiblePageItems
    .map((command, index) => commandMarkup(command, pageOffset + index))
    .join("");
  $("#commandList").innerHTML = visibleCommandItems
    .map((command, index) => commandMarkup(command, commandOffset + index))
    .join("");
  $("#blockResultList").innerHTML = visibleBlockItems
    .map((command, index) => commandMarkup(command, blockOffset + index))
    .join("");
  $$("[data-command-section-more]").forEach((button) => {
    const counts = {
      pages: pageItems.length,
      commands: commandItems.length,
      blocks: blockItems.length,
    };
    button.hidden =
      counts[button.dataset.commandSectionMore] <= visibleLimit ||
      expandedCommandSections.has(button.dataset.commandSectionMore);
  });
  $(".command-palette").classList.toggle(
    "has-expanded-section",
    expandedCommandSections.size > 0,
  );
  $$("[data-command-section]").forEach((section) =>
    section.classList.toggle(
      "expanded",
      expandedCommandSections.has(section.dataset.commandSection),
    ),
  );
  renderPaletteGraphStats();
  $(".command-item.selected")?.scrollIntoView({ block: "nearest" });
}

export function showCommandPalette(initialQuery = "") {
  const field = activeMarkdownField();
  paletteContext = field
    ? { field, start: field.selectionStart, end: field.selectionEnd }
    : null;
  const input = $("#commandInput");
  $("#commandPalette").hidden = false;
  input.value = initialQuery;
  // Mobile browsers only open the software keyboard when focus happens
  // synchronously inside the user gesture that opened the palette.
  input.focus();
  selectedCommand = 0;
  expandedCommandSections.clear();
  renderCommandList();
  requestAnimationFrame(() => input.focus());
}

export function closeCommandPalette(refocus = true) {
  $("#commandPalette").hidden = true;
  if (refocus && paletteContext?.field?.isConnected) {
    paletteContext.field.focus();
    paletteContext.field.setSelectionRange(
      paletteContext.start,
      paletteContext.end,
    );
  }
}

export function resetCommandSelection() {
  selectedCommand = -1;
  expandedCommandSections.clear();
  renderCommandList();
}

export function moveCommandSelection(direction) {
  selectedCommand = Math.max(
    0,
    Math.min(selectedCommand + direction, filteredCommands.length - 1),
  );
  renderCommandList();
}

export function selectCommand(index) {
  selectedCommand = Number(index);
}

export function expandCommandSectionState(section) {
  expandedCommandSections.add(section);
  renderCommandList();
}

export function runSelectedCommand(index = selectedCommand) {
  const command = filteredCommands[index];
  if (!command) return;
  closeCommandPalette(false);
  command.run();
  paletteContext = null;
}

// Journal activation bridges read-only historical rendering and the editable source page.
export async function activateJournalBlock(
  pagePath,
  blockId,
  action = "edit",
  position = null,
) {
  const page = session.graphStore?.pages.find((item) => item.path === pagePath);
  if (!page) return;
  if (page.path !== state.graphPage?.path) {
    if (state.dirty && !(await flushGraphSave(true))) return;
    await loadGraphPage(page, {
      journalMode: true,
      preserveScroll: true,
    });
  }
  const block = graphBlockLocation(blockId)?.block;
  if (!block) return;
  if (action === "toggle") {
    block.collapsed = !block.collapsed;
    saveGraphCollapse();
    renderGraphPage();
    return;
  }
  if (action === "task") {
    toggleGraphTask(block, false);
    return;
  }
  if (action === "zoom") {
    block.collapsed = false;
    saveGraphCollapse();
    state.graphZoomId = block.id;
    focusGraphBlock(block.id);
    return;
  }
  activateGraphBlock(block, position, page);
}

export async function openSingleJournalPage(pagePath) {
  const page = session.graphStore?.pages.find((item) => item.path === pagePath);
  if (!page) return;
  await loadGraphPage(page, { journalMode: false });
}

// Page title operations share the same validation and persistence boundary.
let titleEditOriginal = "";

export function beginTitleEdit() {
  if (
    !state.graphMode ||
    !state.graphPage ||
    state.graphPage.journal ||
    state.graphPage.virtual
  ) {
    documentTitleActions.hidden = true;
    return;
  }
  titleEditOriginal = state.graphPage.title;
  documentTitleActions.hidden = false;
  app.classList.add("title-editing");
}

export function finishTitleEdit(cancel = false) {
  if (cancel && state.graphMode && state.graphPage)
    fileName.value = titleEditOriginal || state.graphPage.title;
  documentTitleActions.hidden = true;
  app.classList.remove("title-editing");
  titleEditOriginal = "";
}

export async function renameGraphPage(title) {
  const page = state.graphPage;
  const nextTitle = title.trim();
  if (page?.journal) {
    fileName.value = page.title;
    return false;
  }
  if (!page || !nextTitle) {
    if (page) fileName.value = page.title;
    return false;
  }
  if (nextTitle === page.title) {
    fileName.value = page.title;
    return true;
  }
  try {
    commitGraphBlock();
    if (!(await flushGraphSave(true)))
      throw new Error("Save the current page before renaming it");
    const oldTitle = page.title;
    const duplicate = session.graphStore.pages.find(
      (candidate) =>
        candidate !== page &&
        Graph.normalizePage(candidate.title) ===
          Graph.normalizePage(nextTitle),
    );
    if (duplicate) throw new Error("A page with this name already exists");
    const updateLinks = confirm(
      `Rename “${oldTitle}” to “${nextTitle}” and update page references?`,
    );
    let currentContent = page.content.replace(
      /^(\s*title::\s*).+$/im,
      `$1${nextTitle}`,
    );
    if (updateLinks) {
      for (const linkedPage of [...session.graphStore.pages]) {
        const content =
          linkedPage === page ? currentContent : linkedPage.content;
        const updated = Graph.replacePageReferences(
          content,
          oldTitle,
          nextTitle,
        );
        if (updated !== content) {
          await session.graphStore.writePage(linkedPage, updated);
          if (linkedPage === page) currentContent = updated;
        }
      }
    }
    const renamed = await session.graphStore.renamePage(
      page,
      nextTitle,
      currentContent,
    );
    state.graphPage = renamed;
    state.graphDocument = Graph.parseDocument(currentContent);
    restoreGraphCollapse();
    state.dirty = false;
    session.graphIndex = new Graph.GraphIndex(session.graphStore.pages);
    fileName.value = nextTitle;
    document.title = `${nextTitle} — ${session.graphStore.name} — notnote`;
    saveSettings({ lastGraphPage: nextTitle });
    syncGraphRoute(renamed, {
      journalMode: state.journalMode,
      replaceRoute: true,
    });
    renderGraphPage();
    saveState.textContent = "Saved";
    toast("Page renamed");
    return true;
  } catch (error) {
    fileName.value = page.title;
    toast(error.message || "Could not rename the page");
    return false;
  }
}

let pagePendingDeletion = null;
export function deleteCurrentGraphPage() {
  const page = state.graphPage;
  if (!state.graphMode || !page || page.journal || page.virtual) return;
  pagePendingDeletion = page;
  $("#deleteDialogMessage").textContent =
    `Delete “${page.title}”? This cannot be undone.`;
  $("#deleteConfirmDialog").hidden = false;
  requestAnimationFrame(() => $('[data-delete-dialog="cancel"]').focus());
}

export function closeDeletePageDialog() {
  pagePendingDeletion = null;
  $("#deleteConfirmDialog").hidden = true;
}

export async function confirmDeleteCurrentGraphPage() {
  const page = pagePendingDeletion;
  closeDeletePageDialog();
  if (!page || page.path !== state.graphPage?.path) return;
  try {
    commitGraphBlock();
    clearTimeout(state.saveTimer);
    clearTimeout(session.graphDraftTimer);
    await session.graphStore.deletePage(page);
    session.graphIndex.removePage(page);
    session.journalDocuments.delete(page.path);
    state.dirty = false;
    state.graphConflict = false;
    app.classList.remove("dirty");
    finishTitleEdit();
    await openToday(true, { replaceRoute: true });
    toast(`Deleted “${page.title}”`);
  } catch (error) {
    toast(error.message || "Could not delete the page");
  }
}

// Contextual block actions.
export function selectedBlockActionContext() {
  if (session.blockContextTarget?.block) return session.blockContextTarget;
  let block = selectedGraphBlock();
  if (
    !block &&
    session.selectedGraphBlockIds.size === 1 &&
    session.graphSelectionPagePath === state.graphPage?.path
  )
    block = graphBlockLocation([...session.selectedGraphBlockIds][0])?.block;
  return block && state.graphPage && state.graphDocument
    ? { block, page: state.graphPage, document: state.graphDocument }
    : null;
}

export async function runBlockContextAction(action, context) {
  if (!context?.block) return toast("Select a block first");
  commitGraphBlock();
  if (action === "copy-ref")
    await copyGraphBlockReference(context.block, context);
  else if (action === "copy-block") await copyGraphBlock(context.block);
  else if (action === "make-template")
    await makeGraphBlockTemplate(context.block);
  else if (action === "delete-block")
    await deleteGraphBlock(context.block, context);
}

// Page directory, history, and footer navigation.
const PAGE_DIRECTORY_SIZE = 50;
let pageDirectoryReturnFocus = null;
export let pageDirectoryVisiblePages = [];
export const pageDirectoryGroupPages = new Map();
export const pageDirectoryExpandedGroups = new Set();
// Deduplicate physical and referenced pages before alphabetic grouping.
function allDirectoryPages() {
  if (!session.graphIndex) return [];
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  const seen = new Set();
  return session.graphIndex
    .pageSuggestions()
    .filter((page) => {
      if (seen.has(page.path)) return false;
      seen.add(page.path);
      return true;
    })
    .sort((left, right) => collator.compare(left.title, right.title));
}
function pageDirectoryLetter(title) {
  const first = Array.from(title.trim())[0] || "";
  const letter = first
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleUpperCase();
  return /^[A-Z]$/.test(letter) ? letter : "#";
}
// Paginate each alphabetic group independently so all section counts remain visible.
export function renderPageDirectory() {
  const pages = allDirectoryPages();
  const query = Graph.normalizeSearch($("#pageDirectoryFilter").value);
  const filtered = pages.filter((page) => {
    const aliases = session.graphIndex?.aliasesForPage(page) || [];
    return [page.title, ...aliases].some((value) =>
      Graph.normalizeSearch(value).includes(query),
    );
  });
  const groups = new Map();
  filtered.forEach((page) => {
    const letter = pageDirectoryLetter(page.title);
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(page);
  });
  pageDirectoryVisiblePages = [];
  $("#pageDirectoryContent").innerHTML = groups.size
    ? [...groups]
        .sort(([left], [right]) => {
          if (left === "#") return -1;
          if (right === "#") return 1;
          return left.localeCompare(right);
        })
        .map(([letter, groupPages]) => {
          const pageCount = Math.max(
            1,
            Math.ceil(groupPages.length / PAGE_DIRECTORY_SIZE),
          );
          const groupPage = Math.min(
            pageDirectoryGroupPages.get(letter) || 0,
            pageCount - 1,
          );
          pageDirectoryGroupPages.set(letter, groupPage);
          const start = groupPage * PAGE_DIRECTORY_SIZE;
          const entries = groupPages
            .slice(start, start + PAGE_DIRECTORY_SIZE)
            .map((page) => {
              const index = pageDirectoryVisiblePages.push(page) - 1;
              return `<button type="button" class="page-directory-page" data-page-directory-index="${index}"><span>${escapeHtml(page.title)}</span>${page.journal ? "<small>Journal</small>" : page.virtual ? "<small>Referenced</small>" : ""}</button>`;
            })
            .join("");
          const pagination =
            pageCount > 1
              ? `<nav class="page-directory-pagination" aria-label="${escapeHtml(letter)} pages"><button type="button" data-page-directory-group="${escapeHtml(letter)}" data-page-directory-move="-1"${groupPage === 0 ? " disabled" : ""}>Previous</button><span>${start + 1}–${Math.min(start + PAGE_DIRECTORY_SIZE, groupPages.length)} of ${groupPages.length}</span><button type="button" data-page-directory-group="${escapeHtml(letter)}" data-page-directory-move="1"${groupPage >= pageCount - 1 ? " disabled" : ""}>Next</button></nav>`
              : "";
          const open =
            query || pageDirectoryExpandedGroups.has(letter) ? " open" : "";
          return `<details class="page-directory-group" data-page-directory-letter="${escapeHtml(letter)}"${open}><summary><span>${escapeHtml(letter)}</span><small>${groupPages.length}</small></summary><div>${entries}</div>${pagination}</details>`;
        })
        .join("")
    : '<p class="page-directory-empty">No matching pages</p>';
  $("#pageDirectoryCount").textContent = query
    ? `${filtered.length} of ${pages.length} pages`
    : `${pages.length} ${pages.length === 1 ? "page" : "pages"}`;
}
export function closePageDirectory(refocus = true) {
  const view = $("#pageDirectoryView");
  if (view.hidden) return;
  view.hidden = true;
  if (refocus) {
    if (pageDirectoryReturnFocus?.isConnected)
      pageDirectoryReturnFocus.focus();
    else $("#commandButton").focus();
  }
}
export async function showPageDirectory() {
  if (!session.graphStore) await openGraph();
  if (!session.graphStore || !session.graphIndex) return;
  pageDirectoryReturnFocus = $("#commandButton");
  pageDirectoryGroupPages.clear();
  pageDirectoryExpandedGroups.clear();
  $("#pageDirectoryFilter").value = "";
  $("#pageDirectoryView").hidden = false;
  renderPageDirectory();
  if (!usesMobileInput())
    requestAnimationFrame(() => $("#pageDirectoryFilter").focus());
}

let pageHistoryReturnFocus = null;
export function closePageHistory() {
  const view = $("#pageHistoryView");
  if (view.hidden) return;
  view.hidden = true;
  if (pageHistoryReturnFocus?.isConnected) pageHistoryReturnFocus.focus();
  else $("#footerMenuButton").focus();
}
export async function showPageHistory() {
  const page = state.graphPage;
  if (!state.graphMode || !page || page.virtual)
    return toast("Open a saved graph page first");
  pageHistoryReturnFocus = $("#footerMenuButton");
  $("#pageHistoryView").hidden = false;
  $("#pageHistoryTitle").textContent = page.title;
  $("#pageHistoryContent").innerHTML =
    '<p class="page-history-message">Loading Git history…</p>';
  if (!session.graphStore?.isRemote) {
    $("#pageHistoryContent").innerHTML =
      '<p class="page-history-message">Page history is available when the graph is served by notnote server.</p>';
    return;
  }
  commitGraphBlock();
  await flushGraphSave(false);
  try {
    const result = await session.graphStore.api(
      `/history?path=${encodeURIComponent(page.path)}`,
    );
    if (!result.available) {
      $("#pageHistoryContent").innerHTML =
        `<p class="page-history-message">${escapeHtml(result.message || "Git history is unavailable.")}</p>`;
      return;
    }
    const dirty = result.dirty
      ? '<p class="page-history-dirty">This page has uncommitted changes.</p>'
      : "";
    const commits = (result.commits || [])
      .map((commit) => {
        const parsed = new Date(commit.date);
        const date = Number.isNaN(parsed.getTime())
          ? commit.date
          : new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(parsed);
        return `<details class="page-history-commit" data-history-commit="${escapeHtml(commit.hash)}" data-history-path="${escapeHtml(commit.gitPath || result.path)}"><summary><code title="${escapeHtml(commit.hash)}">${escapeHtml(commit.hash.slice(0, 8))}</code><div><strong>${escapeHtml(commit.subject || "Untitled commit")}</strong><span>${escapeHtml(commit.author)} · ${escapeHtml(date)}</span></div><i aria-hidden="true"></i></summary><div class="page-history-actions"><span class="page-history-restore-status" role="status"></span><button type="button" data-history-restore>Restore this version</button></div><pre class="page-history-diff">Open to load the diff…</pre></details>`;
      })
      .join("");
    $("#pageHistoryContent").innerHTML =
      `${dirty}${commits || '<p class="page-history-message">This page has not been committed yet.</p>'}`;
  } catch (error) {
    $("#pageHistoryContent").innerHTML =
      `<p class="page-history-message">${escapeHtml(error.message || "Could not load Git history.")}</p>`;
  }
}
export async function restorePageHistoryCommit(button) {
  const details = button.closest("[data-history-commit]");
  const page = state.graphPage;
  if (!details || !page || !session.graphStore?.isRemote) return;
  const commit = details.dataset.historyCommit;
  if (
    !confirm(
      `Restore “${page.title}” to commit ${commit.slice(0, 8)}? The current page content will be replaced.`,
    )
  )
    return;
  const originalLabel = button.textContent;
  const status = $(".page-history-restore-status", details);
  button.disabled = true;
  button.textContent = "Restoring…";
  status.textContent = "Loading version…";
  try {
    commitGraphBlock();
    if (!(await flushGraphSave(true))) {
      status.textContent = "Could not save the current page before restoring.";
      return;
    }
    const query = new URLSearchParams({
      path: page.path,
      commit,
      gitPath: details.dataset.historyPath,
    });
    const result = await session.graphStore.api(`/history/content?${query}`);
    if (!result.available)
      throw new Error(result.message || "This version cannot be restored");
    status.textContent = "Saving restored version…";
    await session.graphStore.writePage(page, result.content);
    session.graphIndex.updatePage(page, result.content);
    await Graph.removeDraft(page.path).catch(() => {});
    state.dirty = false;
    state.graphConflict = false;
    app.classList.remove("dirty");
    const journalMode = state.journalMode;
    const blockId = state.graphZoomId;
    closePageHistory();
    await loadGraphPage(page, {
      historyNavigation: true,
      journalMode,
      blockId,
    });
    toast(`Restored commit ${commit.slice(0, 8)}`);
  } catch (error) {
    const message = /Unknown graph endpoint/i.test(error.message || "")
      ? "Restore is unavailable until the notnote server is restarted."
      : error.message || "Could not restore this version";
    status.textContent = `Restore failed: ${message}`;
    toast(message);
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}
export function closeFooterMenu() {
  $("#footerMenu").hidden = true;
  $("#footerMenuButton").setAttribute("aria-expanded", "false");
}
export function toggleFooterMenu() {
  const opening = $("#footerMenu").hidden;
  if (!opening) return closeFooterMenu();
  const page = state.graphPage;
  $('[data-footer-action="delete-page"]').hidden =
    !state.graphMode || !page || page.journal || page.virtual;
  $('[data-footer-action="page-history"]').hidden =
    !state.graphMode || !page || page.virtual;
  $("#footerMenu").hidden = false;
  $("#footerMenuButton").setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => $("#footerMenu button:not([hidden])")?.focus());
}
