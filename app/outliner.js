/**
 * Interactive outliner editing, block mutations, selection delimiters, templates, and autocomplete.
 */

import {
  keepActiveMobileBlockVisible,
  requireFunctions,
  shortcutMatches,
  usesMobileInput,
  vimRedoStack,
  vimUndoStack,
} from "./core.js";
import { toast } from "./document.js";
import {
  $$,
  blockTree,
  graphAutocomplete,
  mobileBlockToolbar,
} from "./dom.js";
import {
  caretInsideFence,
  escapeHtml,
  fenceOpening,
  orgQuoteOpening,
} from "./markdown.js";
import { startVoiceRecording, uploadGraphAsset } from "./media.js";
import { Graph, session, state } from "./state.js";



let outlinerDependencies;

export function configureOutlinerDependencies(dependencies) {
  outlinerDependencies = requireFunctions("outliner", dependencies, [
    "captureVimSnapshot",
    "commitGraphBlock",
    "flushGraphSave",
    "focusGraphBlock",
    "graphBlockLocation",
    "graphChanged",
    "loadGraphPage",
    "notifyMarkdownField",
    "pushVimSnapshot",
    "recordTaskHistory",
    "relativeJournalDate",
    "renderGraphPage",
    "resizeGraphEditor",
    "saveGraphCollapse",
    "syncGraphNewBlockElement",
    "toggleJournalCalendar",
    "updateTaskCompletionMetadata",
    "visibleGraphBlocks",
  ]);
}

// Input handlers preserve the graph tree while browser textareas expose flat text edits.
export function graphMutationFocus(block, position = null) {
  if (block.transient && block.content) delete block.transient;
  outlinerDependencies.graphChanged();
  outlinerDependencies.focusGraphBlock(block.id, position);
}

export function handleGraphBlockInput(event) {
  const field = event.currentTarget;
  const location = outlinerDependencies.graphBlockLocation(field.dataset.blockId);
  if (!location) return;
  const previousContent = location.block.content;
  const mobileEmptyBackspace =
    usesMobileInput() &&
    event.inputType === "deleteContentBackward" &&
    !previousContent &&
    !field.value;
  if (mobileEmptyBackspace && deleteEmptyGraphBlock(location.block)) return;
  // Some mobile keyboards mutate the textarea before either beforeinput or
  // input is observed. Recover the selection from the actual newline diff so
  // a parent block is never split away from its children.
  const insertedMobileLine =
    usesMobileInput() && field.dataset.allowGraphLineBreak !== "true"
      ? insertedSingleLineChange(previousContent, field.value)
      : null;
  if (insertedMobileLine) {
    field.value = previousContent;
    field.setSelectionRange(insertedMobileLine.start, insertedMobileLine.end);
    if (
      splitGraphBlock(
        field,
        location.block,
        insertedMobileLine.start,
        insertedMobileLine.end,
      )
    )
      return;
  }
  const code = field.value.split("\n").some((line) => fenceOpening(line));
  const quote =
    !code &&
    field.value &&
    (field.value.split("\n").every((line) => /^\s*>/.test(line)) ||
      field.value.split("\n").some(orgQuoteOpening));
  field.classList.toggle("graph-code-editor", code);
  field.classList.toggle("graph-quote-editor", Boolean(quote));
  location.block.content = field.value;
  if (location.block.transient && field.value)
    delete location.block.transient;
  session.activeGraphBlock.block = location.block;
  outlinerDependencies.syncGraphNewBlockElement(
    field.closest(".journal-blocks") || blockTree,
    state.graphDocument,
    session.activeGraphBlock.page,
  );
  outlinerDependencies.resizeGraphEditor(field);
  keepActiveMobileBlockVisible();
  outlinerDependencies.graphChanged();
  showGraphAutocomplete(field);
}

let pendingSelectionDelimiter = null;

function flushSelectionDelimiter() {
  const pending = pendingSelectionDelimiter;
  pendingSelectionDelimiter = null;
  if (!pending) return;
  clearTimeout(pending.timer);
  const { field, key, start, end, value } = pending;
  if (!field.isConnected || field.value !== value) return;
  field.setRangeText(key, start, end, "end");
  outlinerDependencies.notifyMarkdownField(field);
}

export function handleSelectionDelimiter(event) {
  const pairs = {
    "~": ["~~", "~~"],
    "[": ["[[", "]]"],
    "(": ["((", "))"],
    "*": ["**", "**"],
    _: ["__", "__"],
  };
  const field = event.currentTarget;
  if (
    !pairs[event.key] ||
    event.metaKey ||
    (event.ctrlKey && !event.altKey) ||
    event.isComposing
  ) {
    if (pendingSelectionDelimiter) flushSelectionDelimiter();
    return false;
  }
  const start = field.selectionStart;
  const end = field.selectionEnd;
  if (start === end) {
    if (pendingSelectionDelimiter) flushSelectionDelimiter();
    return false;
  }
  const pending = pendingSelectionDelimiter;
  if (
    pending &&
    pending.field === field &&
    pending.key === event.key &&
    pending.start === start &&
    pending.end === end &&
    pending.value === field.value
  ) {
    event.preventDefault();
    clearTimeout(pending.timer);
    pendingSelectionDelimiter = null;
    const selected = field.value.slice(start, end);
    const [before, after] = pairs[event.key];
    field.setRangeText(`${before}${selected}${after}`, start, end, "end");
    field.setSelectionRange(
      start + before.length,
      start + before.length + selected.length,
    );
    outlinerDependencies.notifyMarkdownField(field);
    return true;
  }
  if (pending) flushSelectionDelimiter();
  event.preventDefault();
  pendingSelectionDelimiter = {
    field,
    key: event.key,
    start,
    end,
    value: field.value,
  };
  pendingSelectionDelimiter.timer = setTimeout(flushSelectionDelimiter, 600);
  return true;
}

export function handleWikiPair(event) {
  const field = event.currentTarget;
  if (!state.graphMode || field.selectionStart !== field.selectionEnd)
    return false;
  const position = field.selectionStart;
  if (event.key === "[" && field.value[position - 1] === "[") {
    event.preventDefault();
    field.setRangeText("[]]", position, position, "end");
    field.setSelectionRange(position + 1, position + 1);
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "[",
      }),
    );
    return true;
  }
  if (event.key === "]" && field.value[position] === "]") {
    event.preventDefault();
    field.setSelectionRange(position + 1, position + 1);
    hideGraphAutocomplete();
    return true;
  }
  return false;
}

// Structural mutations always finish through graphMutationFocus for consistent persistence.
export function moveGraphBlock(block, direction) {
  const location = outlinerDependencies.graphBlockLocation(block.id);
  if (!location) return false;
  const target = location.index + direction;
  if (target < 0 || target >= location.blocks.length) return false;
  location.blocks.splice(location.index, 1);
  location.blocks.splice(target, 0, block);
  graphMutationFocus(block);
  return true;
}

export function indentGraphBlock(block, outdent = false, focus = true) {
  const location = outlinerDependencies.graphBlockLocation(block.id);
  if (!location) return false;
  if (!outdent) {
    const previous = location.blocks[location.index - 1];
    if (!previous) return false;
    location.blocks.splice(location.index, 1);
    previous.children.push(block);
    previous.collapsed = false;
  } else {
    if (!location.parent) return false;
    const parentLocation = outlinerDependencies.graphBlockLocation(location.parent.id);
    if (!parentLocation) return false;
    location.blocks.splice(location.index, 1);
    parentLocation.blocks.splice(parentLocation.index + 1, 0, block);
  }
  if (focus) graphMutationFocus(block);
  else {
    outlinerDependencies.graphChanged();
    outlinerDependencies.renderGraphPage();
  }
  return true;
}

function cycledTaskContent(content) {
  const match = content.match(
    /^(TODO|DOING|DONE|LATER|NOW|WAITING|CANCELED|CANCELLED)(?:\s+|$)/,
  );
  return !match
    ? `TODO ${content}`
    : /^(TODO|LATER|WAITING)$/.test(match[1])
      ? content.replace(/^[A-Z]+/, "DOING")
      : /^(DOING|NOW)$/.test(match[1])
        ? content.replace(/^[A-Z]+/, "DONE")
        : content.replace(/^[A-Z]+/, "TODO");
}

export function toggleGraphTask(block, focus = true, keepEmptyTaskSpace = false) {
  const before = block.content.match(
    /^(TODO|DOING|DONE|LATER|NOW|WAITING|CANCELED|CANCELLED)(?:\s+|$)/,
  )?.[1];
  block.content = cycledTaskContent(block.content);
  const after = block.content.match(/^(TODO|DOING|DONE)(?:\s+|$)/)?.[1];
  block.content = outlinerDependencies.updateTaskCompletionMetadata(block.content, after);
  if (!before && keepEmptyTaskSpace && block.content === "TODO")
    block.content += " ";
  if (before && after)
    outlinerDependencies.recordTaskHistory(
      state.graphPage?.path,
      block.id,
      before,
      after,
      Graph.flattenBlocks(state.graphDocument?.blocks).findIndex(
        (item) => item.block === block,
      ),
    );
  if (focus) graphMutationFocus(block, block.content.length);
  else {
    outlinerDependencies.graphChanged();
    outlinerDependencies.renderGraphPage();
  }
}

export async function createGraphBlockFromPlaceholder(pagePath) {
  const page =
    state.graphPage?.path === pagePath
      ? state.graphPage
      : session.graphStore?.pages.find((item) => item.path === pagePath);
  if (!page) return;
  if (page.path !== state.graphPage?.path) {
    if (state.dirty && !(await outlinerDependencies.flushGraphSave(true))) return;
    await outlinerDependencies.loadGraphPage(page, { journalMode: state.journalMode });
  }
  outlinerDependencies.commitGraphBlock();
  const block = {
    id: Graph.newId(),
    uuid: null,
    content: "",
    marker: "-",
    children: [],
    collapsed: false,
    transient: true,
  };
  state.graphDocument.blocks.push(block);
  outlinerDependencies.focusGraphBlock(block.id, 0);
}

export function createNextGraphBlock(block, content = "", asFirstChild = false) {
  const location = outlinerDependencies.graphBlockLocation(block.id);
  if (!location) return null;
  const next = {
    id: Graph.newId(),
    uuid: null,
    content,
    marker: block.marker || "-",
    children: [],
    collapsed: false,
  };
  if (asFirstChild || state.graphZoomId === block.id) {
    block.collapsed = false;
    block.children.unshift(next);
    outlinerDependencies.saveGraphCollapse();
  } else location.blocks.splice(location.index + 1, 0, next);
  graphMutationFocus(next, 0);
  return next;
}

function createPreviousGraphBlock(block) {
  const location = outlinerDependencies.graphBlockLocation(block.id);
  if (!location) return null;
  const previous = {
    id: Graph.newId(),
    uuid: null,
    content: "",
    marker: block.marker || "-",
    children: [],
    collapsed: false,
  };
  location.blocks.splice(location.index, 0, previous);
  graphMutationFocus(previous, 0);
  return previous;
}

// Clipboard trees receive fresh IDs before insertion to prevent reference collisions.
export function pasteGraphBlockTree(event) {
  const field = event.target.closest?.(".graph-block-editor");
  const block = session.activeGraphBlock?.block;
  if (!field || !block || field !== session.activeGraphBlock.field) return false;
  const text = event.clipboardData?.getData("text/plain") || "";
  const firstLine = text.replace(/^\s*\n+/, "").split("\n", 1)[0];
  if (!/^\s*[-+*](?:\s|$)/.test(firstLine)) return false;
  const selectedAll =
    field.selectionStart === 0 && field.selectionEnd === field.value.length;
  if (field.selectionStart !== field.selectionEnd && !selectedAll)
    return false;
  const parsed = Graph.parseDocument(text);
  const pasted = Graph.copyBlocksForPaste(parsed.blocks);
  if (!pasted.length) return false;
  const location = outlinerDependencies.graphBlockLocation(block.id);
  if (!location) return false;
  event.preventDefault();
  const snapshot = outlinerDependencies.captureVimSnapshot(field);
  const replace = !field.value.trim() || selectedAll;
  if (replace) {
    location.blocks.splice(location.index, 1, ...pasted);
    if (state.graphZoomId === block.id)
      state.graphZoomId = pasted.length === 1 ? pasted[0].id : null;
  } else if (state.graphZoomId === block.id) {
    block.children.push(...pasted);
    block.collapsed = false;
  } else location.blocks.splice(location.index + 1, 0, ...pasted);
  outlinerDependencies.pushVimSnapshot(vimUndoStack, snapshot);
  vimRedoStack.length = 0;
  outlinerDependencies.graphChanged();
  const focus = pasted.at(-1);
  outlinerDependencies.focusGraphBlock(focus.id, focus.content.length);
  return true;
}

function insertedSingleLineChange(previous, current) {
  if (previous === current) return null;
  let start = 0;
  while (start < previous.length && current[start] === previous[start])
    start++;
  let suffix = 0;
  while (
    suffix < previous.length - start &&
    suffix < current.length - start &&
    current.at(-1 - suffix) === previous.at(-1 - suffix)
  )
    suffix++;
  const end = previous.length - suffix;
  return current.slice(start, current.length - suffix) === "\n"
    ? { start, end }
    : null;
}

function deleteEmptyGraphBlock(block) {
  const location = outlinerDependencies.graphBlockLocation(block.id);
  if (!location || block.content || outlinerDependencies.visibleGraphBlocks().length <= 1)
    return false;
  const visible = outlinerDependencies.visibleGraphBlocks();
  const position = visible.indexOf(block);
  const previous = visible[position - 1] || visible[position + 1];
  location.blocks.splice(location.index, 1, ...(block.children || []));
  outlinerDependencies.graphChanged();
  if (previous) outlinerDependencies.focusGraphBlock(previous.id);
  else outlinerDependencies.renderGraphPage();
  return true;
}

function splitGraphBlock(
  field,
  block,
  start = field.selectionStart,
  end = field.selectionEnd,
) {
  if (caretInsideFence(field.value, start)) return false;
  const createFirstChild =
    start === end && end === field.value.length && block.children.length > 0;
  if (start === 0 && end === 0 && !createFirstChild) {
    createPreviousGraphBlock(block);
    return true;
  }
  block.content = field.value.slice(0, start);
  createNextGraphBlock(
    block,
    field.value.slice(end),
    createFirstChild,
  );
  return true;
}

export function handleGraphBlockBeforeInput(event) {
  if (!usesMobileInput()) return false;
  const field = event.currentTarget;
  const block = outlinerDependencies.graphBlockLocation(field.dataset.blockId)?.block;
  if (
    event.inputType === "deleteContentBackward" &&
    !field.value &&
    field.selectionStart === 0 &&
    field.selectionEnd === 0
  ) {
    if (!block) return false;
    event.preventDefault();
    deleteEmptyGraphBlock(block);
    return true;
  }
  const enter =
    ["insertLineBreak", "insertParagraph"].includes(event.inputType) ||
    (event.inputType === "insertText" && event.data === "\n");
  if (!enter) return false;
  if (field.dataset.allowGraphLineBreak === "true") {
    delete field.dataset.allowGraphLineBreak;
    event.preventDefault();
    return true;
  }
  if (!block) return false;
  const insertedLine = insertedSingleLineChange(block.content, field.value);
  const start = insertedLine?.start ?? field.selectionStart;
  const end = insertedLine?.end ?? field.selectionEnd;
  if (insertedLine) {
    field.value = block.content;
    field.setSelectionRange(start, end);
  }
  if (caretInsideFence(field.value, start)) return false;
  // WebKit may expose the already-mutated value during beforeinput. Restore
  // it and cancel the event before rendering/focusing another textarea.
  event.preventDefault();
  splitGraphBlock(field, block, start, end);
  return true;
}

export function handleGraphBlockKeydown(event) {
  const field = event.currentTarget;
  const location = outlinerDependencies.graphBlockLocation(field.dataset.blockId);
  if (!location) return;
  const block = location.block;
  if (event.key === "Shift") {
    field.dataset.physicalShiftKey = "true";
    return;
  }
  // iOS enables the software keyboard's Shift lock automatically at the
  // beginning of a block. That sets shiftKey on Enter even though the user
  // did not request Shift+Enter. A real hardware Shift emits its own keydown.
  const automaticMobileShift =
    usesMobileInput() &&
    event.key === "Enter" &&
    event.shiftKey &&
    field.dataset.physicalShiftKey !== "true";
  if (handleSelectionDelimiter(event) || handleWikiPair(event)) return;
  if (
    !graphAutocomplete.hidden &&
    ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)
  ) {
    event.preventDefault();
    handleGraphAutocompleteKey(event.key, event.shiftKey);
    return;
  }
  if (shortcutMatches("blockIndent", event)) {
    event.preventDefault();
    indentGraphBlock(block, false);
    return;
  }
  if (shortcutMatches("blockOutdent", event)) {
    event.preventDefault();
    indentGraphBlock(block, true);
    return;
  }
  if (shortcutMatches("blockUp", event)) {
    event.preventDefault();
    moveGraphBlock(block, -1);
    return;
  }
  if (shortcutMatches("blockDown", event)) {
    event.preventDefault();
    moveGraphBlock(block, 1);
    return;
  }
  if (shortcutMatches("taskCycle", event)) {
    event.preventDefault();
    toggleGraphTask(block, true, true);
    return;
  }
  if (shortcutMatches("blockLine", event) && !automaticMobileShift) {
    event.preventDefault();
    field.dataset.allowGraphLineBreak = "true";
    field.setRangeText("\n", field.selectionStart, field.selectionEnd, "end");
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertLineBreak",
        data: "\n",
      }),
    );
    setTimeout(() => {
      if (field.isConnected) delete field.dataset.allowGraphLineBreak;
    }, 0);
    return;
  }
  if (shortcutMatches("blockNew", event) || automaticMobileShift) {
    if (caretInsideFence(field.value, field.selectionStart)) return;
    event.preventDefault();
    splitGraphBlock(field, block);
    return;
  }
  const mobileBackspace =
    usesMobileInput() &&
    (event.key === "Backspace" ||
      event.code === "Backspace" ||
      event.keyCode === 8);
  if (
    (shortcutMatches("blockDelete", event) || mobileBackspace) &&
    !field.value
  ) {
    event.preventDefault();
    if (deleteEmptyGraphBlock(block)) return;
  }
  if (
    (event.key === "ArrowUp" && field.selectionStart === 0) ||
    (event.key === "ArrowDown" && field.selectionStart === field.value.length)
  ) {
    const visible = outlinerDependencies.visibleGraphBlocks();
    const index = visible.indexOf(block);
    const target = visible[index + (event.key === "ArrowUp" ? -1 : 1)];
    if (target) {
      event.preventDefault();
      outlinerDependencies.focusGraphBlock(
        target.id,
        event.key === "ArrowUp" ? target.content.length : 0,
      );
    }
  }
  if (shortcutMatches("blockEscape", event)) {
    event.preventDefault();
    outlinerDependencies.commitGraphBlock();
  }
}

// One autocomplete surface serves pages, blocks, templates, commands, and date references.
let autocompleteItems = [];
let autocompleteIndex = 0;
const angleCommands = [
  { title: "<quote", keywords: "quote quotation org", angle: "quote" },
  { title: "<src", keywords: "source code fence", angle: "src" },
];
const slashCommands = [
  { title: "/todo", keywords: "task to do", taskStatus: "TODO" },
  { title: "/doing", keywords: "task in progress", taskStatus: "DOING" },
  { title: "/done", keywords: "task completed", taskStatus: "DONE" },
  {
    title: "/scheduled",
    keywords: "task schedule due date calendar",
    scheduled: true,
  },
  { title: "/today", keywords: "journal current date", days: 0 },
  { title: "/yesterday", keywords: "journal previous date", days: -1 },
  { title: "/tomorrow", keywords: "journal next date", days: 1 },
  {
    title: "/date picker",
    keywords: "journal calendar choose date",
    datePicker: true,
  },
  { title: "/upload", keywords: "attach file asset", upload: true },
  { title: "/record", keywords: "voice note microphone audio", record: true },
  {
    title: "/template",
    keywords: "template reusable predefined block structure",
    templatePicker: true,
  },
];
function graphTemplates() {
  const page = session.graphStore?.pages.find(
    (item) => item.name.toLowerCase() === "templates.md",
  );
  if (!page) return [];
  const document =
    page.path === state.graphPage?.path
      ? state.graphDocument
      : session.graphIndex?.documents.get(page.path) ||
        Graph.parseDocument(page.content);
  return Graph.templatesFromDocument(document);
}
export function pageMatchRank(value, query) {
  const normalized = Graph.normalizePage(value);
  if (!query || normalized === query) return 0;
  if (normalized.startsWith(query)) return 1;
  if (
    normalized
      .split(/[\s/._-]+/)
      .some((part) => part.startsWith(query))
  )
    return 2;
  return normalized.includes(query) ? 3 : Infinity;
}
function graphPageMatchRank(page, query) {
  return Math.min(
    pageMatchRank(page.title, query),
    ...(session.graphIndex?.aliasesForPage(page) || []).map((alias) =>
      pageMatchRank(alias, query),
    ),
  );
}
function blockAutocompleteResults(query) {
  if (!session.graphIndex) return [];
  const needle = Graph.normalizePage(query);
  const results = [];
  for (const page of session.graphIndex.allPages()) {
    const current = page.path === state.graphPage?.path;
    const document = current
      ? state.graphDocument
      : session.graphIndex.documents.get(page.path);
    for (const { block } of Graph.flattenBlocks(document?.blocks)) {
      if (current && block === session.activeGraphBlock?.block) continue;
      const content = block.content
        .replace(/^\s*[\w-]+::.*$/gm, "")
        .replace(/\[\[|\]\]|\(\(|\)\)/g, "")
        .trim();
      if (
        !content ||
        (needle && !Graph.normalizePage(content).includes(needle))
      )
        continue;
      results.push({
        title: content.slice(0, 80),
        blockAutocomplete: true,
        block,
        page,
        document,
      });
      if (results.length >= 12) return results;
    }
  }
  return results;
}
// Derive inline suggestions only from the text immediately before the caret.
export function showGraphAutocomplete(field) {
  const before = field.value.slice(0, field.selectionStart);
  const wikiMatch = before.match(/\[\[([^\]]*)$/);
  const blockMatch = before.match(/\(\(([^)]*)$/);
  const slashMatch = before.match(/\/([^/\n]*)$/);
  const angleMatch = before.match(/<([^<\n]*)$/);
  if (angleMatch) {
    const rawQuery = angleMatch[1].trim();
    const [name = "", ...remainder] = rawQuery.split(/\s+/);
    const typedCommand = `<${name.toLowerCase()}`;
    autocompleteItems = angleCommands
      .filter((command) => command.title.startsWith(typedCommand))
      .map((command) => ({
        ...command,
        angleCommand: true,
        remainder: remainder.join(" "),
      }));
  } else if (slashMatch) {
    const rawQuery = slashMatch[1].trim();
    const [name = "", ...remainder] = rawQuery.split(/\s+/);
    const typedCommand = `/${name.toLowerCase()}`;
    if (name.toLowerCase() === "template") {
      const query = Graph.normalizePage(remainder.join(" "));
      autocompleteItems = graphTemplates()
        .filter(
          (template) =>
            !query ||
            Graph.normalizePage(template.name).includes(query),
        )
        .slice(0, 12)
        .map((template) => ({
          title: template.name,
          slash: true,
          template: true,
          templateDefinition: template,
        }));
    } else {
      autocompleteItems = slashCommands
        .filter((command) => command.title.startsWith(typedCommand))
        .map((command) => ({
          ...command,
          slash: true,
          remainder: remainder.join(" "),
        }));
    }
  } else if (wikiMatch && session.graphIndex) {
    const title = wikiMatch[1].trim();
    if (title.length < 2) return hideGraphAutocomplete();
    const query = Graph.normalizePage(title);
    const pages = session.graphIndex.pageSuggestions();
    const matches = pages
      .map((page) => ({ page, rank: graphPageMatchRank(page, query) }))
      .filter((item) => Number.isFinite(item.rank))
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          a.page.title.length - b.page.title.length ||
          a.page.title.localeCompare(b.page.title),
      )
      .slice(0, 12)
      .map((item) => item.page);
    const exactMatch = query && session.graphIndex.resolvePage(title);
    autocompleteItems =
      title && !exactMatch
        ? [{ title, create: true }, ...matches].slice(0, 12)
        : matches;
  } else if (blockMatch)
    autocompleteItems = blockAutocompleteResults(blockMatch[1].trim());
  else return hideGraphAutocomplete();
  if (!autocompleteItems.length) return hideGraphAutocomplete();
  autocompleteIndex = 0;
  graphAutocomplete.innerHTML = autocompleteItems
    .map(
      (item, index) =>
        `<button type="button" data-autocomplete-index="${index}" class="${index === 0 ? "selected" : ""}">${item.create ? `<span class="autocomplete-create">Create page</span>` : item.template ? `<span class="autocomplete-create">Template</span>` : item.slash || item.angleCommand ? `<span class="autocomplete-create">Command</span>` : item.blockAutocomplete ? `<span class="autocomplete-create">Block · ${escapeHtml(item.page.title)}</span>` : ""}${escapeHtml(item.title)}</button>`,
    )
    .join("");
  graphAutocomplete.scrollTop = 0;
  graphAutocomplete.hidden = false;
  const rect = field.getBoundingClientRect();
  const viewport = window.visualViewport;
  const viewportTop = viewport?.offsetTop || 0;
  const viewportLeft = viewport?.offsetLeft || 0;
  const viewportRight = viewportLeft + (viewport?.width || innerWidth);
  const viewportBottom = viewportTop + (viewport?.height || innerHeight);
  const toolbarTop = !mobileBlockToolbar.hidden
    ? mobileBlockToolbar.getBoundingClientRect().top - 6
    : viewportBottom - 8;
  const availableBottom = Math.min(viewportBottom - 8, toolbarTop);
  const below = rect.bottom + 4;
  graphAutocomplete.style.maxHeight = "220px";
  const popupHeight = graphAutocomplete.offsetHeight;
  const belowSpace = Math.max(0, availableBottom - below);
  const aboveSpace = Math.max(0, rect.top - viewportTop - 12);
  let top;
  if (popupHeight <= belowSpace) top = below;
  else if (popupHeight <= aboveSpace) top = rect.top - popupHeight - 4;
  else if (belowSpace >= aboveSpace) {
    graphAutocomplete.style.maxHeight = `${belowSpace}px`;
    top = below;
  } else {
    graphAutocomplete.style.maxHeight = `${aboveSpace}px`;
    top = rect.top - graphAutocomplete.offsetHeight - 4;
  }
  graphAutocomplete.style.left = `${Math.min(viewportRight - graphAutocomplete.offsetWidth - 12, Math.max(viewportLeft + 12, rect.left + 20))}px`;
  graphAutocomplete.style.top = `${top}px`;
}
export function hideGraphAutocomplete() {
  graphAutocomplete.hidden = true;
  autocompleteItems = [];
}
function renderAutocompleteSelection() {
  let selected = null;
  $$("[data-autocomplete-index]", graphAutocomplete).forEach(
    (item, index) => {
      const active = index === autocompleteIndex;
      item.classList.toggle("selected", active);
      if (active) selected = item;
    },
  );
  if (!selected) return;
  const itemTop = selected.offsetTop;
  const itemBottom = itemTop + selected.offsetHeight;
  const viewTop = graphAutocomplete.scrollTop;
  const viewBottom = viewTop + graphAutocomplete.clientHeight;
  const padding = 5;
  if (itemTop < viewTop + padding)
    graphAutocomplete.scrollTop = Math.max(0, itemTop - padding);
  else if (itemBottom > viewBottom - padding)
    graphAutocomplete.scrollTop =
      itemBottom - graphAutocomplete.clientHeight + padding;
}
export function chooseGraphAutocomplete(index = autocompleteIndex) {
  const item = autocompleteItems[index];
  const field = session.activeGraphBlock?.field;
  const block = session.activeGraphBlock?.block;
  if (!item || !field || !block) return;
  const before = field.value.slice(0, field.selectionStart);
  if (item.blockAutocomplete) {
    const start = before.lastIndexOf("((");
    const end = field.selectionStart;
    let uuid = Graph.propertiesFrom(item.block.content).id;
    if (!uuid) {
      uuid = Graph.newId();
      item.block.uuid = uuid;
      item.block.content = `${item.block.content.replace(/\s+$/, "")}${item.block.content.trim() ? "\n" : ""}id:: ${uuid}`;
      if (item.page.path === state.graphPage?.path) outlinerDependencies.graphChanged();
      else {
        const content = Graph.serializeDocument(item.document);
        session.graphStore
          .writePage(item.page, content)
          .then(() => session.graphIndex.updatePage(item.page, content))
          .catch((error) =>
            toast(error.message || "Could not create the block reference"),
          );
      }
    }
    const closingLength = field.value.slice(end).startsWith("))") ? 2 : 0;
    field.setRangeText(`((${uuid}))`, start, end + closingLength, "end");
    field.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );
    hideGraphAutocomplete();
    field.focus();
    return;
  }
  if (item.angleCommand) {
    const start = before.lastIndexOf("<");
    const end = field.selectionStart;
    const opening =
      item.angle === "quote"
        ? "#+BEGIN_QUOTE"
        : `\`\`\`${item.remainder || ""}`;
    const closing = item.angle === "quote" ? "#+END_QUOTE" : "```";
    const replacement =
      item.angle === "src"
        ? `${opening}\n${closing}`
        : `${opening}\n\n${closing}`;
    field.setRangeText(replacement, start, end, "end");
    const caret =
      item.angle === "src" ? start + 3 : start + opening.length + 1;
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: replacement,
      }),
    );
    hideGraphAutocomplete();
    field.focus();
    field.setSelectionRange(caret, caret);
    return;
  }
  if (item.slash) {
    const start = before.lastIndexOf("/");
    const end = field.selectionStart;
    if (item.templatePicker) {
      field.setRangeText("/template ", start, end, "end");
      field.dispatchEvent(new InputEvent("input", { bubbles: true }));
      if (graphTemplates().length) showGraphAutocomplete(field);
      else {
        hideGraphAutocomplete();
        toast("Create a template with the Open templates command first");
      }
      field.focus();
    } else if (item.template) {
      if (!/^\s*\/template(?:\s+.*)?\s*$/i.test(field.value)) {
        hideGraphAutocomplete();
        return toast("Insert a template from an otherwise empty block");
      }
      const location = outlinerDependencies.graphBlockLocation(block.id);
      const sourceBlocks = item.templateDefinition?.block?.children || [];
      if (!location || !sourceBlocks.length) {
        hideGraphAutocomplete();
        return toast("This template has no blocks");
      }
      const now = new Date();
      const today = Graph.journalInfo(now, session.graphStore?.config);
      const instance = Graph.instantiateTemplate(sourceBlocks, {
        date: today.date,
        time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
        today: `[[${today.title}]]`,
        page: state.graphPage?.title || "",
      });
      location.blocks.splice(location.index, 1, ...instance.blocks);
      if (state.graphZoomId === block.id)
        state.graphZoomId = instance.blocks[0]?.id || null;
      hideGraphAutocomplete();
      outlinerDependencies.graphChanged();
      outlinerDependencies.focusGraphBlock(instance.cursorBlockId, instance.cursorPosition);
      toast(`Template “${item.templateDefinition.name}” inserted`);
    } else if (item.taskStatus) {
      const replacement = `${item.taskStatus}${item.remainder ? ` ${item.remainder}` : " "}`;
      field.setRangeText(replacement, start, end, "end");
      field.dispatchEvent(new InputEvent("input", { bubbles: true }));
      hideGraphAutocomplete();
      field.focus();
    } else if (item.scheduled) {
      const anchor = graphAutocomplete.getBoundingClientRect();
      hideGraphAutocomplete();
      outlinerDependencies.toggleJournalCalendar((date) => {
        const scheduled = `SCHEDULED: <${Graph.formatJournalDate(date, "yyyy-MM-dd EEE")}>`;
        let content =
          `${field.value.slice(0, start)}${field.value.slice(end)}`.trimEnd();
        content = content
          .replace(/^\s*SCHEDULED:\s*<[^>]+>\s*$/m, "")
          .trimEnd();
        if (
          !/^(TODO|DOING|DONE|LATER|NOW|WAITING|CANCELED|CANCELLED)(?:\s+|$)/.test(
            content,
          )
        )
          content = `TODO ${content.trimStart()}`;
        content = `${content}${content ? "\n" : ""}${scheduled}`;
        field.value = content;
        field.dispatchEvent(new InputEvent("input", { bubbles: true }));
        field.focus();
        field.setSelectionRange(content.length, content.length);
      }, anchor);
    } else if (item.upload) {
      hideGraphAutocomplete();
      uploadGraphAsset(field, block, start, end);
    } else if (item.record) {
      hideGraphAutocomplete();
      field.setRangeText("", start, end, "end");
      field.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "deleteContent" }),
      );
      startVoiceRecording(field, block, start, start);
    } else if (item.datePicker) {
      const anchor = graphAutocomplete.getBoundingClientRect();
      hideGraphAutocomplete();
      outlinerDependencies.toggleJournalCalendar((date) => {
        const title = Graph.journalInfo(date, session.graphStore?.config).title;
        const reference = `[[${title}]]`;
        if (field.isConnected) {
          field.setRangeText(reference, start, end, "end");
          field.dispatchEvent(new InputEvent("input", { bubbles: true }));
          field.focus();
        } else {
          block.content = `${block.content.slice(0, start)}${reference}${block.content.slice(end)}`;
          outlinerDependencies.graphChanged();
          outlinerDependencies.focusGraphBlock(block.id, start + reference.length);
        }
      }, anchor);
    } else {
      const date = outlinerDependencies.relativeJournalDate(item.days);
      const title = Graph.journalInfo(date, session.graphStore?.config).title;
      field.setRangeText(`[[${title}]]`, start, end, "end");
      field.dispatchEvent(new InputEvent("input", { bubbles: true }));
      hideGraphAutocomplete();
      field.focus();
    }
    return;
  }
  const start = before.lastIndexOf("[[");
  const closingLength = field.value
    .slice(field.selectionStart)
    .startsWith("]]")
    ? 2
    : 0;
  field.setRangeText(
    `[[${item.title}]]`,
    start,
    field.selectionStart + closingLength,
    "end",
  );
  field.dispatchEvent(new InputEvent("input", { bubbles: true }));
  hideGraphAutocomplete();
  field.focus();
  if (item.create)
    session.graphStore
      .createPage(item.title)
      .then(() => {
        session.graphIndex.rebuild(session.graphStore.pages);
        toast(`Page “${item.title}” created`);
      })
      .catch((error) => toast(error.message || "Could not create the page"));
}
function handleGraphAutocompleteKey(key, shiftKey = false) {
  if (key === "Escape") return hideGraphAutocomplete();
  if (key === "Enter") return chooseGraphAutocomplete(autocompleteIndex);
  const forward = key === "ArrowDown" || (key === "Tab" && !shiftKey);
  autocompleteIndex =
    (autocompleteIndex + (forward ? 1 : -1) + autocompleteItems.length) %
    autocompleteItems.length;
  renderAutocompleteSelection();
}

