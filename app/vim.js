/**
 * Block source editing, Vim navigation, and application undo and redo history.
 */

import { saveSettings } from "./appearance.js";
import {
  shortcutMatches,
  taskRedoStack,
  taskUndoStack,
  vimRedoStack,
  vimUndoStack,
  requireFunctions,
} from "./core.js";
import {
  centerCaret,
  changed,
  toast,
  updateOutline,
  updateStats,
} from "./document.js";
import {
  $,
  $$,
  app,
  editor,
  notnoteWrap,
  outliner,
  sourceEditor,
} from "./dom.js";
import {
  currentMarkdown,
  editorToMarkdown,
  markdownToHtml,
  sourceBlockText,
} from "./markdown.js";
import {
  createNextGraphBlock,
  graphMutationFocus,
  handleSelectionDelimiter,
  handleWikiPair,
} from "./outliner.js";
import { Graph, session, state } from "./state.js";



let vimDependencies;

export function configureVimDependencies(dependencies) {
  vimDependencies = requireFunctions("vim", dependencies, [
    "activateGraphBlock",
    "activateJournalBlock",
    "cachedJournalDocument",
    "clearGraphBlockSelection",
    "deleteSelectedGraphBlocks",
    "focusGraphBlock",
    "graphBlockLocation",
    "graphChanged",
    "notifyMarkdownField",
    "orderedJournalPages",
    "renderGraphPage",
    "restoreGraphCollapse",
    "showCommandPalette",
    "showDocumentation",
    "updateTaskCompletionMetadata",
    "visibleGraphBlocks",
  ]);
}

// Convert rendered blocks into focused source editors without changing document ownership.
function markdownForBlock(block) {
  const holder = document.createElement("div");
  holder.append(block.cloneNode(true));
  return editorToMarkdown(holder);
}

export function resizeSourceBlock(source) {
  source.style.height = "0";
  source.style.height = `${Math.max(source.scrollHeight, 31)}px`;
}

function placeCaretInSource(source, x, y) {
  source.focus();
  let offset = source.value.length;
  if (x >= 0 && y >= 0) {
    const style = getComputedStyle(source);
    const rect = source.getBoundingClientRect();
    const lines = source.value.split("\n");
    const lineHeight = parseFloat(style.lineHeight) || 24;
    const lineIndex = Math.max(
      0,
      Math.min(
        lines.length - 1,
        Math.floor(
          (y - rect.top - parseFloat(style.paddingTop)) / lineHeight,
        ),
      ),
    );
    const targetX = Math.max(
      0,
      x - rect.left - parseFloat(style.paddingLeft),
    );
    const context = document.createElement("canvas").getContext("2d");
    context.font = style.font;
    let column = lines[lineIndex].length;
    for (let i = 0; i < lines[lineIndex].length; i++) {
      if (
        context.measureText(lines[lineIndex].slice(0, i + 1)).width > targetX
      ) {
        column = i;
        break;
      }
    }
    offset =
      lines
        .slice(0, lineIndex)
        .reduce((total, line) => total + line.length + 1, 0) + column;
  }
  source.setSelectionRange(offset, offset);
}

function moveToAdjacentBlock(
  direction,
  createIfMissing = false,
  preferredColumn = null,
) {
  const source = session.activeSourceBlock;
  if (!source) return;
  let target =
    direction < 0 ? source.previousElementSibling : source.nextElementSibling;
  if (!target && createIfMissing && direction > 0) {
    target = document.createElement("p");
    target.append(document.createElement("br"));
    source.after(target);
  }
  if (!target) return;
  commitActiveBlock();
  if (!target.isConnected) return;
  activateSourceBlock(target);
  requestAnimationFrame(() => {
    if (!session.activeSourceBlock) return;
    let offset = direction < 0 ? session.activeSourceBlock.value.length : 0;
    if (preferredColumn !== null) {
      const value = session.activeSourceBlock.value;
      const lineStart = direction < 0 ? value.lastIndexOf("\n") + 1 : 0;
      const lineEnd =
        direction < 0
          ? value.length
          : value.indexOf("\n") < 0
            ? value.length
            : value.indexOf("\n");
      offset =
        lineStart +
        Math.min(preferredColumn, Math.max(0, lineEnd - lineStart - 1));
    }
    if (state.vimEnabled && state.vimMode === "normal")
      showVimCursor(session.activeSourceBlock, offset);
    else session.activeSourceBlock.setSelectionRange(offset, offset);
    session.activeSourceBlock.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  });
}

// Vim and task changes share timestamped history so undo follows user action order.
function vimField() {
  if (session.activeGraphBlock?.field?.isConnected) return session.activeGraphBlock.field;
  if (session.activeSourceBlock?.isConnected) return session.activeSourceBlock;
  return state.sourceMode ? sourceEditor : null;
}

export function captureVimSnapshot(field = vimField()) {
  return {
    markdown: currentMarkdown(),
    blockIndex:
      field === session.activeSourceBlock ? [...editor.children].indexOf(field) : 0,
    blockId:
      field === session.activeGraphBlock?.field ? session.activeGraphBlock.block.id : null,
    graphBlockIndex:
      field === session.activeGraphBlock?.field
        ? Graph.flattenBlocks(state.graphDocument?.blocks).findIndex(
            ({ block }) => block === session.activeGraphBlock.block,
          )
        : 0,
    cursor: field?.selectionStart || 0,
    timestamp: Date.now(),
  };
}

export function pushVimSnapshot(stack, snapshot) {
  if (!snapshot || stack[stack.length - 1]?.markdown === snapshot.markdown)
    return;
  stack.push(snapshot);
  if (stack.length > 100) stack.shift();
}

export function recordVimChange(field) {
  pushVimSnapshot(vimUndoStack, captureVimSnapshot(field));
  vimRedoStack.length = 0;
}

export function finishVimInsertChange(field = vimField()) {
  if (!session.vimInsertSnapshot) return;
  const snapshot = session.vimInsertSnapshot;
  session.vimInsertSnapshot = null;
  if (snapshot.markdown !== currentMarkdown()) {
    pushVimSnapshot(vimUndoStack, snapshot);
    vimRedoStack.length = 0;
  }
}

function restoreVimSnapshot(snapshot) {
  session.vimInsertSnapshot = null;
  state.vimMode = "normal";
  session.vimPending = "";
  session.vimDesiredColumn = null;
  if (state.sourceMode) {
    sourceEditor.value = snapshot.markdown;
    setVimMode("normal", sourceEditor, snapshot.cursor);
  } else if (state.graphMode) {
    session.activeGraphBlock = null;
    state.graphDocument = Graph.parseDocument(snapshot.markdown);
    vimDependencies.restoreGraphCollapse();
    vimDependencies.renderGraphPage();
    vimDependencies.graphChanged();
    const block =
      vimDependencies.graphBlockLocation(snapshot.blockId)?.block ||
      Graph.flattenBlocks(state.graphDocument.blocks)[
        snapshot.graphBlockIndex
      ]?.block ||
      state.graphDocument.blocks[0];
    if (block) vimDependencies.focusGraphBlock(block.id, snapshot.cursor);
  } else {
    session.activeSourceBlock = null;
    editor.innerHTML = markdownToHtml(snapshot.markdown);
    const blocks = [...editor.children];
    const block =
      blocks[Math.max(0, Math.min(snapshot.blockIndex, blocks.length - 1))];
    if (block) {
      activateSourceBlock(block);
      requestAnimationFrame(
        () =>
          session.activeSourceBlock &&
          showVimCursor(session.activeSourceBlock, snapshot.cursor),
      );
    } else focusVimEditor();
  }
  changed();
  updateStats();
  updateOutline();
}

function applyVimHistory(redo = false) {
  const source = redo ? vimRedoStack : vimUndoStack;
  const destination = redo ? vimUndoStack : vimRedoStack;
  const snapshot = source.pop();
  if (!snapshot) {
    toast(redo ? "Nothing to redo" : "Nothing to undo");
    return;
  }
  pushVimSnapshot(destination, captureVimSnapshot());
  restoreVimSnapshot(snapshot);
}

export function recordTaskHistory(
  pagePath,
  blockId,
  before,
  after,
  blockIndex = -1,
) {
  taskUndoStack.push({
    graph: session.graphStore?.name || "",
    pagePath,
    blockId,
    blockIndex,
    before,
    after,
    timestamp: Date.now(),
  });
  if (taskUndoStack.length > 100) taskUndoStack.shift();
  taskRedoStack.length = 0;
}

async function applyTaskHistory(redo = false) {
  const source = redo ? taskRedoStack : taskUndoStack;
  const destination = redo ? taskUndoStack : taskRedoStack;
  const operation = source.pop();
  if (!operation) return false;
  try {
    if (operation.graph !== (session.graphStore?.name || ""))
      throw new Error("The task belongs to another graph");
    const page = session.graphStore?.pages.find(
      (item) => item.path === operation.pagePath,
    );
    if (!page) throw new Error("Task page not found");
    const current = page.path === state.graphPage?.path;
    const document = current
      ? state.graphDocument
      : session.journalDocuments.get(page.path) ||
        session.graphIndex?.documents.get(page.path) ||
        Graph.parseDocument(page.content);
    const block =
      vimDependencies.graphBlockLocation(operation.blockId, document?.blocks)?.block ||
      Graph.flattenBlocks(document?.blocks)[operation.blockIndex]?.block;
    if (!block) throw new Error("Task block not found");
    const marker = block.content.match(
      /^(TODO|DOING|DONE|LATER|NOW|WAITING|CANCELED|CANCELLED)(?:\s+|$)/,
    )?.[1];
    if (!marker) throw new Error("The block is no longer a task");
    const target = redo ? operation.after : operation.before;
    const originalContent = block.content;
    block.content = vimDependencies.updateTaskCompletionMetadata(
      block.content.replace(/^[A-Z]+/, target),
      target,
    );
    if (current) vimDependencies.graphChanged();
    else {
      const content = Graph.serializeDocument(document);
      try {
        await session.graphStore.writePage(page, content);
        session.graphIndex.updatePage(page, content);
      } catch (error) {
        block.content = originalContent;
        throw error;
      }
      if (page.journal || session.journalDocuments.has(page.path))
        session.journalDocuments.set(page.path, document);
    }
    destination.push({ ...operation, timestamp: Date.now() });
    vimDependencies.renderGraphPage();
    toast(`Task state ${redo ? "redone" : "undone"}: ${target}`);
    return true;
  } catch (error) {
    source.push(operation);
    toast(error.message || `Could not ${redo ? "redo" : "undo"} task state`);
    return true;
  }
}

export function applyAppHistory(redo = false) {
  const taskStack = redo ? taskRedoStack : taskUndoStack;
  const vimStack = redo ? vimRedoStack : vimUndoStack;
  const taskTime = taskStack.at(-1)?.timestamp || 0;
  const vimTime = vimStack.at(-1)?.timestamp || 0;
  if (taskTime > vimTime) {
    applyTaskHistory(redo);
    return;
  }
  applyVimHistory(redo);
}

// Mode state and cursor rendering are shared by document and graph textareas.
function vimLineBounds(field, position = field.selectionStart) {
  const start = field.value.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
  const nextBreak = field.value.indexOf("\n", position);
  return { start, end: nextBreak < 0 ? field.value.length : nextBreak };
}

export function showVimCursor(field, position = field.selectionStart) {
  if (!field?.isConnected) return;
  field.classList.toggle("vim-empty", field.value.length === 0);
  const maximum = field.value.endsWith("\n")
    ? field.value.length
    : Math.max(0, field.value.length - 1);
  const cursor = Math.max(0, Math.min(position, maximum));
  field.setSelectionRange(cursor, Math.min(cursor + 1, field.value.length));
}

export function updateVimUi() {
  const status = $("#vimStatus");
  status.hidden = !state.vimEnabled;
  const pending = session.vimPending ? ` ${session.vimPending}` : "";
  status.textContent =
    state.vimMode === "insert" ? "-- INSERT --" : `-- NORMAL --${pending}`;
  app.classList.toggle("vim-enabled", state.vimEnabled);
}

export function setVimMode(mode, field = vimField(), cursor = null) {
  if (mode === "normal" && state.vimMode === "insert")
    finishVimInsertChange(field);
  if (mode === "insert" && state.vimMode !== "insert" && !session.vimInsertSnapshot)
    session.vimInsertSnapshot = captureVimSnapshot(field);
  state.vimMode = mode;
  session.vimPending = "";
  session.vimDesiredColumn = null;
  $$(".md-source-block, .graph-block-editor, #sourceEditor").forEach((item) =>
    item.classList.remove("vim-normal", "vim-insert", "vim-empty"),
  );
  if (field?.isConnected) {
    field.classList.add(mode === "normal" ? "vim-normal" : "vim-insert");
    field.focus();
    if (mode === "normal")
      showVimCursor(field, cursor ?? field.selectionStart);
    else {
      const position = cursor ?? field.selectionStart;
      field.setSelectionRange(position, position);
    }
  }
  updateVimUi();
}

export function focusVimEditor() {
  if (!state.vimEnabled) return;
  if (state.sourceMode) {
    setVimMode(state.vimMode, sourceEditor);
    return;
  }
  if (state.graphMode) {
    if (session.activeGraphBlock?.field) {
      setVimMode(state.vimMode, session.activeGraphBlock.field);
      return;
    }
    const block =
      (state.graphZoomId && vimDependencies.graphBlockLocation(state.graphZoomId)?.block) ||
      state.graphDocument?.blocks?.[0];
    if (block) vimDependencies.activateGraphBlock(block, 0, state.graphPage);
    return;
  }
  if (session.activeSourceBlock) {
    setVimMode(state.vimMode, session.activeSourceBlock);
    return;
  }
  let block = editor.firstElementChild;
  if (!block) {
    block = document.createElement("p");
    block.append(document.createElement("br"));
    editor.append(block);
  }
  activateSourceBlock(block);
}

export function setVimEnabled(
  enabled = !state.vimEnabled,
  refocus = true,
  persist = true,
) {
  if (state.vimEnabled && state.vimMode === "insert") finishVimInsertChange();
  state.vimEnabled = enabled;
  state.vimMode = "normal";
  session.vimPending = "";
  $$(".md-source-block, .graph-block-editor, #sourceEditor").forEach((item) =>
    item.classList.remove("vim-normal", "vim-insert", "vim-empty"),
  );
  updateVimUi();
  if (persist) saveSettings({ vimEnabled: enabled });
  if (enabled && refocus) requestAnimationFrame(focusVimEditor);
  if (!enabled) {
    const field = vimField();
    if (field) {
      field.setSelectionRange(field.selectionStart, field.selectionStart);
      if (refocus) field.focus();
    } else if (refocus) (state.graphMode ? outliner : editor).focus();
  }
  if (refocus) toast(enabled ? "Vim mode enabled" : "Vim mode disabled");
}

// Normal-mode motions operate on a field first, then cross block boundaries when needed.
function replaceVimRange(field, start, end, text = "", record = true) {
  if (record && (start !== end || text)) recordVimChange(field);
  field.setRangeText(text, start, end, "start");
  vimDependencies.notifyMarkdownField(field);
}

function vimWordKind(character) {
  if (!character || /\s/.test(character)) return "space";
  return /[\p{L}\p{N}_]/u.test(character) ? "word" : "symbol";
}

function nextVimWord(value, position) {
  let cursor = Math.min(position + 1, value.length);
  const kind = vimWordKind(value[position]);
  while (
    cursor < value.length &&
    kind !== "space" &&
    vimWordKind(value[cursor]) === kind
  )
    cursor++;
  while (cursor < value.length && vimWordKind(value[cursor]) === "space")
    cursor++;
  return cursor;
}

function previousVimWord(value, position) {
  let cursor = Math.max(0, position - 1);
  while (cursor > 0 && vimWordKind(value[cursor]) === "space") cursor--;
  const kind = vimWordKind(value[cursor]);
  while (cursor > 0 && vimWordKind(value[cursor - 1]) === kind) cursor--;
  return cursor;
}

function endVimWord(value, position) {
  let cursor = position;
  if (
    cursor < value.length - 1 &&
    vimWordKind(value[cursor + 1]) === vimWordKind(value[cursor]) &&
    vimWordKind(value[cursor]) !== "space"
  )
    cursor++;
  else {
    cursor++;
    while (cursor < value.length && vimWordKind(value[cursor]) === "space")
      cursor++;
  }
  const kind = vimWordKind(value[cursor]);
  while (cursor < value.length - 1 && vimWordKind(value[cursor + 1]) === kind)
    cursor++;
  return cursor;
}

function vimGraphEntries() {
  if (state.journalMode && !state.graphZoomId) {
    return vimDependencies.orderedJournalPages()
      .slice(0, state.journalLimit)
      .flatMap((page) =>
        vimDependencies.visibleGraphBlocks(vimDependencies.cachedJournalDocument(page).blocks, []).map(
          (block) => ({ block, page }),
        ),
      );
  }
  const roots = state.graphZoomId
    ? [vimDependencies.graphBlockLocation(state.graphZoomId)?.block].filter(Boolean)
    : state.graphDocument?.blocks || [];
  return vimDependencies.visibleGraphBlocks(roots, []).map((block) => ({
    block,
    page: state.graphPage,
  }));
}

function moveVimToGraphBlock(direction, distance = 1, preferredColumn = 0) {
  let entries = vimGraphEntries();
  const current = session.activeGraphBlock?.block;
  const currentPage = session.activeGraphBlock?.page;
  let index = entries.findIndex(
    (entry) =>
      entry.block === current && entry.page.path === currentPage?.path,
  );
  if (index < 0) return;
  if (
    state.journalMode &&
    direction > 0 &&
    index + distance >= entries.length &&
    state.journalLimit < vimDependencies.orderedJournalPages().length
  ) {
    state.journalLimit += 8;
    entries = vimGraphEntries();
    index = entries.findIndex(
      (entry) =>
        entry.block === current && entry.page.path === currentPage?.path,
    );
  }
  const target =
    entries[
      Math.max(0, Math.min(entries.length - 1, index + direction * distance))
    ];
  if (
    !target ||
    (target.block === current && target.page.path === currentPage?.path)
  )
    return;
  const lines = target.block.content.split("\n");
  const lineIndex = direction < 0 ? lines.length - 1 : 0;
  const start = lines
    .slice(0, lineIndex)
    .reduce((total, line) => total + line.length + 1, 0);
  const position =
    start +
    Math.min(preferredColumn, Math.max(0, lines[lineIndex].length - 1));
  if (target.page.path === state.graphPage?.path)
    vimDependencies.focusGraphBlock(target.block.id, position);
  else
    vimDependencies.activateJournalBlock(target.page.path, target.block.id, "edit", position);
}

function moveVimVertically(field, direction, firstNonBlank = false) {
  const bounds = vimLineBounds(field);
  const column = session.vimDesiredColumn ?? field.selectionStart - bounds.start;
  session.vimDesiredColumn = column;
  let targetStart;
  if (direction < 0) {
    if (bounds.start === 0) {
      if (field === session.activeGraphBlock?.field)
        moveVimToGraphBlock(-1, 1, column);
      else if (field === session.activeSourceBlock)
        moveToAdjacentBlock(-1, false, column);
      return;
    }
    const previousEnd = bounds.start - 1;
    targetStart =
      field.value.lastIndexOf("\n", Math.max(0, previousEnd - 1)) + 1;
  } else {
    if (bounds.end === field.value.length) {
      if (field === session.activeGraphBlock?.field)
        moveVimToGraphBlock(1, 1, column);
      else if (field === session.activeSourceBlock)
        moveToAdjacentBlock(1, false, column);
      return;
    }
    targetStart = bounds.end + 1;
  }
  const targetBreak = field.value.indexOf("\n", targetStart);
  const targetEnd = targetBreak < 0 ? field.value.length : targetBreak;
  let target =
    targetStart + Math.min(column, Math.max(0, targetEnd - targetStart - 1));
  if (firstNonBlank)
    target =
      targetStart +
      (field.value.slice(targetStart, targetEnd).match(/^\s*/)?.[0].length ||
        0);
  showVimCursor(field, target);
}

function moveVimByPage(field, direction) {
  const bounds = vimLineBounds(field);
  const column = field.selectionStart - bounds.start;
  if (field === sourceEditor) {
    const lines = field.value.split("\n");
    const currentLine =
      field.value.slice(0, bounds.start).split("\n").length - 1;
    const lineHeight = parseFloat(getComputedStyle(field).lineHeight) || 24;
    const jump = Math.max(
      5,
      Math.floor(notnoteWrap.clientHeight / lineHeight / 2),
    );
    const targetLine = Math.max(
      0,
      Math.min(lines.length - 1, currentLine + direction * jump),
    );
    const lineStart = lines
      .slice(0, targetLine)
      .reduce((total, line) => total + line.length + 1, 0);
    showVimCursor(
      field,
      lineStart + Math.min(column, Math.max(0, lines[targetLine].length - 1)),
    );
    centerCaret();
    return;
  }
  if (field === session.activeGraphBlock?.field) {
    moveVimToGraphBlock(direction, 5, column);
    return;
  }
  const blocks = [...editor.children];
  const currentIndex = blocks.indexOf(session.activeSourceBlock);
  if (currentIndex < 0) return;
  const target =
    blocks[
      Math.max(0, Math.min(blocks.length - 1, currentIndex + direction * 5))
    ];
  if (!target || target === session.activeSourceBlock) return;
  commitActiveBlock();
  if (!target.isConnected) return;
  activateSourceBlock(target);
  requestAnimationFrame(() => {
    if (!session.activeSourceBlock) return;
    showVimCursor(
      session.activeSourceBlock,
      Math.min(
        column,
        Math.max(0, vimLineBounds(session.activeSourceBlock, 0).end - 1),
      ),
    );
    session.activeSourceBlock.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

function moveVimToDocumentEdge(field, end) {
  if (field === sourceEditor) {
    const position = end ? vimLineBounds(field, field.value.length).start : 0;
    showVimCursor(field, position);
    centerCaret();
    return;
  }
  if (field === session.activeGraphBlock?.field) {
    const entries = vimGraphEntries();
    const target = end ? entries.at(-1) : entries[0];
    if (!target) return;
    const position = end
      ? Math.max(0, target.block.content.lastIndexOf("\n") + 1)
      : 0;
    if (target.page.path === state.graphPage?.path)
      vimDependencies.focusGraphBlock(target.block.id, position);
    else
      vimDependencies.activateJournalBlock(
        target.page.path,
        target.block.id,
        "edit",
        position,
      );
    return;
  }
  const source = session.activeSourceBlock;
  if (!source) return;
  const target = end ? editor.lastElementChild : editor.firstElementChild;
  if (!target || target === source) {
    showVimCursor(field, end ? field.value.length - 1 : 0);
    return;
  }
  commitActiveBlock();
  activateSourceBlock(
    end ? editor.lastElementChild : editor.firstElementChild,
  );
  requestAnimationFrame(() => {
    if (!session.activeSourceBlock) return;
    const position = end
      ? vimLineBounds(session.activeSourceBlock, session.activeSourceBlock.value.length).start
      : 0;
    showVimCursor(session.activeSourceBlock, position);
    session.activeSourceBlock.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

function createVimGraphBlock(before = false) {
  const block = session.activeGraphBlock?.block;
  const location = block && vimDependencies.graphBlockLocation(block.id);
  if (!location) return;
  session.vimInsertSnapshot = captureVimSnapshot(session.activeGraphBlock.field);
  let next;
  if (!before) next = createNextGraphBlock(block);
  else {
    next = {
      id: Graph.newId(),
      uuid: null,
      content: "",
      marker: block.marker || "-",
      children: [],
      collapsed: false,
    };
    if (state.graphZoomId === block.id) {
      block.collapsed = false;
      block.children.unshift(next);
    } else location.blocks.splice(location.index, 0, next);
    graphMutationFocus(next, 0);
  }
  if (next && session.activeGraphBlock?.field)
    setVimMode("insert", session.activeGraphBlock.field, 0);
}

function deleteVimGraphBlock(field) {
  const block = session.activeGraphBlock?.block;
  const location = block && vimDependencies.graphBlockLocation(block.id);
  if (!location) return;
  const pageBlocks = Graph.flattenBlocks(state.graphDocument.blocks).map(
    (entry) => entry.block,
  );
  if (pageBlocks.length <= 1) {
    replaceVimRange(field, 0, field.value.length);
    return;
  }
  const index = pageBlocks.indexOf(block);
  recordVimChange(field);
  const target = pageBlocks[index + 1] || pageBlocks[index - 1];
  location.blocks.splice(location.index, 1);
  vimDependencies.graphChanged();
  if (target) vimDependencies.focusGraphBlock(target.id, 0);
  else vimDependencies.renderGraphPage();
}

function deleteVimLine(field) {
  const bounds = vimLineBounds(field);
  let start = bounds.start;
  let end = bounds.end;
  if (end < field.value.length) end++;
  else if (start > 0) start--;
  replaceVimRange(field, start, end);
  showVimCursor(field, Math.min(start, field.value.length - 1));
}

function processVimNormalKey(field, key) {
  const value = field.value;
  const position = field.selectionStart;
  const bounds = vimLineBounds(field, position);
  const finish = (target) => {
    session.vimPending = "";
    session.vimDesiredColumn = null;
    showVimCursor(field, target);
    updateVimUi();
  };

  if (session.vimPending === "g") {
    session.vimPending = "";
    if (key === "g") moveVimToDocumentEdge(field, false);
    updateVimUi();
    return;
  }
  if (session.vimPending === "d") {
    session.vimPending = "";
    if (key === "d")
      field === session.activeGraphBlock?.field
        ? deleteVimGraphBlock(field)
        : deleteVimLine(field);
    else if (key === "w") {
      replaceVimRange(field, position, nextVimWord(value, position));
      showVimCursor(field, position);
    } else if (key === "$") {
      replaceVimRange(field, position, bounds.end);
      showVimCursor(field, position);
    }
    updateVimUi();
    return;
  }
  if (session.vimPending === "r") {
    session.vimPending = "";
    if (
      key.length === 1 &&
      position < value.length &&
      value[position] !== "\n"
    ) {
      replaceVimRange(field, position, position + 1, key);
      showVimCursor(field, position);
    }
    updateVimUi();
    return;
  }

  if (key === "Ctrl+d") {
    moveVimByPage(field, 1);
    return;
  }
  if (key === "Ctrl+u") {
    moveVimByPage(field, -1);
    return;
  }
  if (key === "u") {
    applyAppHistory(false);
    return;
  }
  if (key === "Ctrl+r") {
    applyAppHistory(true);
    return;
  }

  if (key !== "j" && key !== "k" && key !== "ArrowDown" && key !== "ArrowUp")
    session.vimDesiredColumn = null;
  if (key === "h" || key === "ArrowLeft")
    finish(Math.max(bounds.start, position - 1));
  else if (key === "l" || key === "ArrowRight")
    finish(Math.min(Math.max(bounds.start, bounds.end - 1), position + 1));
  else if (key === "j" || key === "ArrowDown") moveVimVertically(field, 1);
  else if (key === "k" || key === "ArrowUp") moveVimVertically(field, -1);
  else if (key === "w") finish(nextVimWord(value, position));
  else if (key === "b") finish(previousVimWord(value, position));
  else if (key === "e") finish(endVimWord(value, position));
  else if (key === "0" || key === "Home") finish(bounds.start);
  else if (key === "^")
    finish(
      bounds.start +
        (value.slice(bounds.start, bounds.end).match(/^\s*/)?.[0].length ||
          0),
    );
  else if (key === "$" || key === "End")
    finish(Math.max(bounds.start, bounds.end - 1));
  else if (key === "g") {
    session.vimPending = "g";
    updateVimUi();
  } else if (key === "G") moveVimToDocumentEdge(field, true);
  else if (key === "Enter") moveVimVertically(field, 1, true);
  else if (key === "i") setVimMode("insert", field, position);
  else if (key === "a")
    setVimMode(
      "insert",
      field,
      Math.min(position + (value[position] === "\n" ? 0 : 1), value.length),
    );
  else if (key === "I")
    setVimMode(
      "insert",
      field,
      bounds.start +
        (value.slice(bounds.start, bounds.end).match(/^\s*/)?.[0].length ||
          0),
    );
  else if (key === "A") setVimMode("insert", field, bounds.end);
  else if (key === "o" || key === "O") {
    if (field === session.activeGraphBlock?.field) createVimGraphBlock(key === "O");
    else {
      const insertion = key === "o" ? bounds.end : bounds.start;
      session.vimInsertSnapshot = captureVimSnapshot(field);
      replaceVimRange(field, insertion, insertion, "\n", false);
      setVimMode("insert", field, key === "o" ? insertion + 1 : insertion);
    }
  } else if (key === "x" || key === "Delete") {
    if (position < value.length && value[position] !== "\n")
      replaceVimRange(field, position, position + 1);
    showVimCursor(field, Math.min(position, field.value.length - 1));
  } else if (key === "X" || key === "Backspace") {
    if (position > bounds.start)
      replaceVimRange(field, position - 1, position);
    showVimCursor(field, Math.max(bounds.start, position - 1));
  } else if (key === "d") {
    session.vimPending = "d";
    updateVimUi();
  } else if (key === "D" || key === "C") {
    if (key === "C") session.vimInsertSnapshot = captureVimSnapshot(field);
    replaceVimRange(field, position, bounds.end, "", key !== "C");
    if (key === "C") setVimMode("insert", field, position);
    else showVimCursor(field, position);
  } else if (key === "r") {
    session.vimPending = "r";
    updateVimUi();
  } else if (key === ":") vimDependencies.showCommandPalette();
  else if (key === "?") vimDependencies.showDocumentation();
}

// Capture Vim keys before feature event adapters can interpret them as regular editing keys.
export function handleVimKeydown(event) {
  if (
    !state.vimEnabled ||
    !$("#commandPalette").hidden ||
    !$("#confirmDialog").hidden ||
    !$("#assetCleanupDialog").hidden
  )
    return;
  if (
    session.selectedGraphBlockIds.size &&
    (event.target === outliner || outliner.contains(event.target)) &&
    ["Backspace", "Escape"].includes(event.key)
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Backspace") vimDependencies.deleteSelectedGraphBlocks();
    else vimDependencies.clearGraphBlockSelection();
    return;
  }
  const field =
    event.target === sourceEditor
      ? sourceEditor
      : event.target === session.activeGraphBlock?.field
        ? session.activeGraphBlock.field
        : event.target === session.activeSourceBlock
          ? session.activeSourceBlock
          : null;
  const ctrlEscape = event.ctrlKey && event.key === "[";
  const ctrlCommand =
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    ["d", "u", "r"].includes(event.key.toLowerCase());
  const vimKey = ctrlCommand ? `Ctrl+${event.key.toLowerCase()}` : event.key;
  if (state.vimMode === "insert") {
    if (!field || (event.key !== "Escape" && !ctrlEscape)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const position = Math.max(0, (field?.selectionStart || 0) - 1);
    setVimMode("normal", field, position);
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) {
    if (!ctrlEscape && !ctrlCommand) return;
  }
  const handledKey =
    event.key.length === 1 ||
    [
      "Escape",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "Enter",
      "Backspace",
      "Delete",
    ].includes(event.key);
  if (!handledKey) return;
  if (
    !field &&
    (event.target === editor ||
      editor.contains(event.target) ||
      (state.graphMode &&
        (event.target === outliner || outliner.contains(event.target))))
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    focusVimEditor();
    requestAnimationFrame(() => {
      const active = vimField();
      if (active && event.key !== "Escape")
        processVimNormalKey(active, vimKey);
    });
    return;
  }
  if (!field) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.key === "Escape" || ctrlEscape) {
    session.vimPending = "";
    updateVimUi();
    return;
  }
  processVimNormalKey(field, vimKey);
}

// Rendered document blocks use temporary textareas and commit back to safe Markdown HTML.
function handleSourceBlockKeydown(event) {
  if (handleSelectionDelimiter(event) || handleWikiPair(event)) return;
  const source = event.currentTarget;
  const start = source.selectionStart;
  const end = source.selectionEnd;
  if (shortcutMatches("blockEscape", event)) {
    event.preventDefault();
    event.stopPropagation();
    commitActiveBlock();
    editor.focus();
    return;
  }
  const moveUp = shortcutMatches("blockUp", event);
  const moveDown = shortcutMatches("blockDown", event);
  if (
    moveUp ||
    moveDown ||
    (event.key === "ArrowUp" && start === 0 && end === 0) ||
    (event.key === "ArrowDown" &&
      start === source.value.length &&
      end === source.value.length)
  ) {
    const direction = moveUp || event.key === "ArrowUp" ? -1 : 1;
    event.preventDefault();
    event.stopPropagation();
    moveToAdjacentBlock(direction, direction > 0);
    return;
  }
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    event.stopPropagation();
    moveToAdjacentBlock(1, true);
    return;
  }
  if (event.key !== "Enter" || event.altKey || event.ctrlKey || event.metaKey)
    return;
  const currentLine = source.value.slice(0, start).split("\n").pop();
  const unordered = currentLine.match(/^(\s*)([-+*])\s+(.*)$/);
  const ordered = currentLine.match(/^(\s*)(\d+)\.\s+(.*)$/);
  const match = unordered || ordered;
  if (!match) return;
  event.preventDefault();
  event.stopPropagation();
  let inserted;
  if (!match[3]) {
    inserted = "\n";
    source.setRangeText(inserted, start - currentLine.length, end, "end");
  } else {
    const prefix = unordered
      ? `${match[1]}${match[2]} `
      : `${match[1]}${Number(match[2]) + 1}. `;
    inserted = `\n${prefix}`;
    source.setRangeText(inserted, start, end, "end");
  }
  source.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: inserted,
    }),
  );
}

export function activateSourceBlock(block, pointer = null) {
  if (
    state.sourceMode ||
    !block ||
    block === session.activeSourceBlock ||
    block.parentElement !== editor
  )
    return;
  commitActiveBlock();
  const source = document.createElement("textarea");
  source.className = "md-source-block";
  source.setAttribute("spellcheck", "true");
  source.dataset.block = block.tagName.toLowerCase();
  source.value = markdownForBlock(block);
  source.addEventListener("keydown", handleSourceBlockKeydown);
  source.addEventListener("beforeinput", (event) => {
    if (!state.vimEnabled && /^(insert|delete)/.test(event.inputType || ""))
      recordVimChange(source);
  });
  source.addEventListener("input", () => resizeSourceBlock(source));
  block.replaceWith(source);
  session.activeSourceBlock = source;
  resizeSourceBlock(source);
  requestAnimationFrame(() => {
    placeCaretInSource(source, pointer?.x ?? -1, pointer?.y ?? -1);
    if (state.vimEnabled)
      setVimMode(state.vimMode, source, source.selectionStart);
  });
}

export function commitActiveBlock() {
  const source = session.activeSourceBlock;
  if (!source) return;
  if (state.vimEnabled && state.vimMode === "insert")
    finishVimInsertChange(source);
  session.activeSourceBlock = null;
  if (state.vimEnabled) {
    state.vimMode = "normal";
    session.vimPending = "";
    session.vimDesiredColumn = null;
    updateVimUi();
  }
  if (!source.isConnected) return;
  const container = document.createElement("div");
  container.innerHTML = markdownToHtml(sourceBlockText(source));
  const nodes = [...container.childNodes];
  if (!nodes.length) {
    const paragraph = document.createElement("p");
    paragraph.append(document.createElement("br"));
    nodes.push(paragraph);
  }
  source.replaceWith(...nodes);
  updateOutline();
}

