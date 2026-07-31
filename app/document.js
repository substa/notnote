/**
 * Standalone document loading, persistence, formatting, statistics, search, and editor shortcuts.
 */

import {
  STORAGE_KEY,
  positionToastInVisualViewport,
  requireFunctions,
  vimRedoStack,
  vimUndoStack,
} from "./core.js";
import {
  $,
  $$,
  app,
  editor,
  fileInput,
  fileName,
  mobileBlockToolbar,
  notnoteWrap,
  outliner,
  saveState,
  sourceEditor,
  toastElement,
} from "./dom.js";
import { currentMarkdown, editorToMarkdown, markdownToHtml } from "./markdown.js";
import { Graph, session, state } from "./state.js";



let documentDependencies;

export function configureDocumentDependencies(dependencies) {
  documentDependencies = requireFunctions("document", dependencies, [
    "commitActiveBlock",
    "commitGraphBlock",
    "finishTitleEdit",
    "flushGraphSave",
    "focusVimEditor",
    "graphChanged",
    "graphRoute",
    "renderGraphPage",
    "restoreGraphCollapse",
    "updateVimUi",
  ]);
}

// Document lifecycle and local recovery persistence.
export function loadMarkdown(markdown, name = "Untitled", options = {}) {
  if (state.graphMode && session.graphStore?.isRemote) {
    session.closeRemoteEvents?.();
    session.closeRemoteEvents = null;
  }
  if (documentDependencies.graphRoute() && !options.preserveGraphRoute)
    history.pushState({}, "", `/${location.search}`);
  state.graphMode = false;
  state.graphPage = null;
  state.graphDocument = null;
  state.graphZoomId = null;
  state.graphConflict = false;
  state.sourceMode = false;
  state.journalMode = false;
  outliner.hidden = true;
  editor.hidden = false;
  sourceEditor.hidden = true;
  app.classList.remove("graph-mode", "journal-mode", "source-mode");
  documentDependencies.updateVimUi();
  state.markdown = markdown;
  session.activeSourceBlock = null;
  session.activeGraphBlock = null;
  mobileBlockToolbar.hidden = true;
  vimUndoStack.length = 0;
  vimRedoStack.length = 0;
  session.vimInsertSnapshot = null;
  state.fileHandle = options.handle || null;
  state.currentId = options.id || crypto.randomUUID?.() || String(Date.now());
  state.dirty = false;
  editor.innerHTML = markdownToHtml(markdown);
  sourceEditor.value = markdown;
  documentDependencies.finishTitleEdit();
  fileName.value = name.replace(/\.(md|markdown|txt)$/i, "");
  fileName.readOnly = false;
  document.title = `${fileName.value} — notnote`;
  app.classList.remove("dirty");
  updateStats();
  updateOutline();
  persistLocal(false);
  saveState.textContent = "Ready";
  requestAnimationFrame(() =>
    state.vimEnabled ? documentDependencies.focusVimEditor() : editor.focus(),
  );
}

export function changed() {
  if (state.graphMode) {
    documentDependencies.graphChanged();
    return;
  }
  state.dirty = true;
  state.markdown = currentMarkdown();
  app.classList.add("dirty");
  saveState.textContent = "Modified";
  document.title = `• ${fileName.value || "Untitled"} — notnote`;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    persistLocal(true);
    updateStats();
    updateOutline();
  }, 450);
}

export function getStoredDocs() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

export function persistLocal(showStatus = true) {
  if (!state.currentId) return;
  const docs = getStoredDocs().filter((d) => d.id !== state.currentId);
  docs.unshift({
    id: state.currentId,
    name: fileName.value || "Untitled",
    markdown: currentMarkdown(),
    updated: Date.now(),
  });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(docs.slice(0, 10)));
    if (showStatus) saveState.textContent = "Local copy saved";
  } catch {
    saveState.textContent = "Local storage is full";
  }
}

export function relativeDate(time) {
  const seconds = Math.floor((Date.now() - time) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
  }).format(time);
}

export function updateStats() {
  const text = currentMarkdown()
    .replace(/```[\s\S]*?```|[#>*_`~\[\]()|\-]/g, " ")
    .trim();
  const words = text ? text.split(/\s+/).length : 0;
  const chars = text.replace(/\s/g, "").length;
  $("#wordCount").textContent =
    `${words} ${words === 1 ? "word" : "words"} · ${chars} characters`;
}

export function updateOutline() {
  if (state.sourceMode) return;
  $$("h1,h2,h3,h4,h5,h6", editor).forEach(
    (heading, index) => (heading.id = `heading-${index}`),
  );
}

export function toast(message) {
  toastElement.textContent = message;
  positionToastInVisualViewport();
  toastElement.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastElement.classList.remove("show"), 2800);
}

// Browser file handles are optional; downloads remain the portable fallback.
export async function openFile() {
  try {
    if ("showOpenFilePicker" in window) {
      const [handle] = await window.showOpenFilePicker({
        types: [
          {
            description: "Markdown",
            accept: {
              "text/markdown": [".md", ".markdown"],
              "text/plain": [".txt"],
            },
          },
        ],
        multiple: false,
      });
      const file = await handle.getFile();
      loadMarkdown(await file.text(), file.name, { handle });
    } else fileInput.click();
  } catch (error) {
    if (error.name !== "AbortError") toast("Could not open the file");
  }
}

export async function saveFile() {
  if (state.graphMode) return documentDependencies.flushGraphSave(true);
  let markdown = currentMarkdown();
  let name =
    (fileName.value.trim() || "Untitled").replace(/\.(md|markdown)$/i, "") +
    ".md";
  try {
    if (state.fileHandle) {
      const writable = await state.fileHandle.createWritable();
      await writable.write(markdown);
      await writable.close();
    } else if ("showSaveFilePicker" in window) {
      state.fileHandle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [
          { description: "Markdown", accept: { "text/markdown": [".md"] } },
        ],
      });
      const writable = await state.fileHandle.createWritable();
      await writable.write(markdown);
      await writable.close();
    } else {
      downloadBlob(markdown, name, "text/markdown");
    }
    state.markdown = markdown;
    state.dirty = false;
    app.classList.remove("dirty");
    document.title = `${fileName.value} — notnote`;
    saveState.textContent = "Saved";
    persistLocal(false);
    toast("Document saved");
    return true;
  } catch (error) {
    if (error.name !== "AbortError") toast("Could not save the document");
    return false;
  }
}

export function downloadBlob(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = Object.assign(document.createElement("a"), {
    href: url,
    download: name,
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

export function requestAction(action) {
  if (state.graphMode)
    return documentDependencies.flushGraphSave(true).then((saved) => saved && action());
  if (!state.dirty) return action();
  state.pendingAction = action;
  $("#confirmDialog").hidden = false;
}

export function newDocument() {
  loadMarkdown("", "Untitled");
}

export function toggleSource(force) {
  const shouldEnable = typeof force === "boolean" ? force : !state.sourceMode;
  if (shouldEnable === state.sourceMode) return;
  if (state.graphMode) {
    if (shouldEnable) {
      documentDependencies.commitGraphBlock();
      sourceEditor.value = Graph.serializeDocument(state.graphDocument);
      outliner.hidden = true;
      sourceEditor.hidden = false;
    } else {
      state.graphDocument = Graph.parseDocument(sourceEditor.value);
      documentDependencies.restoreGraphCollapse();
      sourceEditor.hidden = true;
      outliner.hidden = false;
      documentDependencies.renderGraphPage();
      documentDependencies.graphChanged();
    }
    state.sourceMode = shouldEnable;
    app.classList.toggle("source-mode", shouldEnable);
    updateStats();
    if (state.vimEnabled) requestAnimationFrame(documentDependencies.focusVimEditor);
    else (shouldEnable ? sourceEditor : outliner).focus?.();
    return;
  }
  if (shouldEnable) {
    documentDependencies.commitActiveBlock();
    sourceEditor.value = editorToMarkdown();
    editor.hidden = true;
    sourceEditor.hidden = false;
  } else {
    editor.innerHTML = markdownToHtml(sourceEditor.value);
    sourceEditor.hidden = true;
    editor.hidden = false;
  }
  state.sourceMode = shouldEnable;
  app.classList.toggle("source-mode", shouldEnable);
  updateStats();
  updateOutline();
  if (state.vimEnabled) requestAnimationFrame(documentDependencies.focusVimEditor);
  else (shouldEnable ? sourceEditor : editor).focus();
}

// Rich-text commands mutate either the active source field or the rendered selection.
function applyInlineTag(tag) {
  const selection = getSelection();
  if (!selection.rangeCount || selection.isCollapsed)
    return toast("Select some text first");
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return;
  const element = document.createElement(tag);
  try {
    range.surroundContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    changed();
  } catch {
    toast("This selection cannot be formatted");
  }
}

function addLink() {
  if (state.sourceMode) return wrapSource("[", "](https://)");
  const selection = getSelection();
  const label = selection.toString();
  if (!label) return toast("Select the text to link");
  const url = prompt("Link address:", "https://");
  if (url) {
    document.execCommand("createLink", false, url);
    changed();
  }
}

function wrapSource(before, after) {
  const start = sourceEditor.selectionStart,
    end = sourceEditor.selectionEnd;
  const selected = sourceEditor.value.slice(start, end);
  sourceEditor.setRangeText(before + selected + after, start, end, "end");
  sourceEditor.focus();
  changed();
}

function formatBlock(tag) {
  if (state.sourceMode) return;
  document.execCommand("formatBlock", false, tag === "p" ? "p" : tag);
  changed();
}

export function transformInlineMarkdown() {
  if (state.sourceMode) return false;
  const selection = getSelection();
  if (
    !selection.rangeCount ||
    !selection.isCollapsed ||
    selection.anchorNode?.nodeType !== Node.TEXT_NODE
  )
    return false;
  const node = selection.anchorNode;
  if (
    !editor.contains(node) ||
    node.parentElement?.closest(".md-source-block")
  )
    return false;
  const offset = selection.anchorOffset;
  const before = node.nodeValue.slice(0, offset);
  const patterns = [
    { regex: /\*\*([^*\n]+)\*\*$/, tag: "strong" },
    { regex: /__([^_\n]+)__$/, tag: "strong" },
    { regex: /~~([^~\n]+)~~$/, tag: "s" },
    { regex: /`([^`\n]+)`$/, tag: "code" },
    { regex: /(^|[^*])\*([^*\n]+)\*$/, tag: "em", prefix: true },
    { regex: /(^|[^_])_([^_\n]+)_$/, tag: "em", prefix: true },
  ];
  for (const pattern of patterns) {
    const match = before.match(pattern.regex);
    if (!match) continue;
    const prefixLength = pattern.prefix ? match[1].length : 0;
    const fullStart = offset - match[0].length;
    const start = fullStart + prefixLength;
    const content = pattern.prefix ? match[2] : match[1];
    if (!content?.trim()) return false;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, offset);
    range.deleteContents();
    const element = document.createElement(pattern.tag);
    element.textContent = content;
    range.insertNode(element);
    range.setStartAfter(element);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }
  return false;
}

export function markdownShortcut(event) {
  if (
    state.sourceMode ||
    event.target.matches?.(".md-source-block") ||
    ![" ", "Enter"].includes(event.key) ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  )
    return;
  const selection = getSelection();
  if (!selection.rangeCount || !selection.isCollapsed) return;
  const anchorElement =
    selection.anchorNode?.nodeType === Node.TEXT_NODE
      ? selection.anchorNode.parentElement
      : selection.anchorNode;
  const listItem = anchorElement?.closest?.("li");
  if (event.key === "Enter" && listItem && editor.contains(listItem)) {
    event.preventDefault();
    const list = listItem.parentElement;
    if (!listItem.textContent.trim()) {
      const paragraph = document.createElement("p");
      paragraph.append(document.createElement("br"));
      list.after(paragraph);
      listItem.remove();
      if (!list.children.length) list.remove();
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      const caret = selection.getRangeAt(0);
      const tail = document.createRange();
      tail.setStart(caret.startContainer, caret.startOffset);
      tail.setEnd(listItem, listItem.childNodes.length);
      const remainder = tail.extractContents();
      if (!listItem.textContent && !listItem.querySelector("*"))
        listItem.append(document.createElement("br"));
      const nextItem = document.createElement("li");
      if (remainder.textContent || remainder.querySelector?.("*"))
        nextItem.append(remainder);
      else nextItem.append(document.createElement("br"));
      listItem.after(nextItem);
      const range = document.createRange();
      range.selectNodeContents(nextItem);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    changed();
    return;
  }
  let block = anchorElement;
  while (block && block.parentElement !== editor) block = block.parentElement;
  if (!block || !/^(P|DIV)$/.test(block.tagName)) return;
  const text = block.textContent;
  if (event.key === "Enter") {
    const fence = text.match(/^```\s*([\w+-]*)$/);
    if (fence) {
      event.preventDefault();
      const pre = document.createElement("pre");
      if (fence[1]) pre.dataset.lang = fence[1];
      const code = document.createElement("code");
      code.append(document.createElement("br"));
      pre.append(code);
      block.replaceWith(pre);
      const range = document.createRange();
      range.selectNodeContents(code);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      changed();
    } else if (/^(---|\*\*\*)$/.test(text)) {
      event.preventDefault();
      const hr = document.createElement("hr");
      const paragraph = document.createElement("p");
      paragraph.append(document.createElement("br"));
      block.replaceWith(hr, paragraph);
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      changed();
    }
    return;
  }
  const heading = text.match(/^(#{1,6})$/);
  if (heading) {
    event.preventDefault();
    const h = document.createElement(`h${heading[1].length}`);
    h.innerHTML = "<br>";
    block.replaceWith(h);
    const range = document.createRange();
    range.selectNodeContents(h);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    changed();
  } else if (/^[-*+]$/.test(text)) {
    event.preventDefault();
    const list = document.createElement("ul");
    const item = document.createElement("li");
    item.append(document.createElement("br"));
    list.append(item);
    block.replaceWith(list);
    const range = document.createRange();
    range.selectNodeContents(item);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    changed();
  } else if (/^1\.$/.test(text)) {
    event.preventDefault();
    const list = document.createElement("ol");
    const item = document.createElement("li");
    item.append(document.createElement("br"));
    list.append(item);
    block.replaceWith(list);
    const range = document.createRange();
    range.selectNodeContents(item);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    changed();
  } else if (text === ">") {
    event.preventDefault();
    const quote = document.createElement("blockquote");
    const paragraph = document.createElement("p");
    paragraph.append(document.createElement("br"));
    quote.append(paragraph);
    block.replaceWith(quote);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    changed();
  }
}

export function centerCaret() {
  const selection = getSelection();
  if (state.sourceMode) {
    const lineHeight = parseFloat(getComputedStyle(sourceEditor).lineHeight);
    const line = sourceEditor.value
      .slice(0, sourceEditor.selectionStart)
      .split("\n").length;
    notnoteWrap.scrollTop = Math.max(
      0,
      line * lineHeight - notnoteWrap.clientHeight / 2,
    );
  } else if (selection.rangeCount && editor.contains(selection.anchorNode)) {
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    notnoteWrap.scrollBy({
      top: rect.top - innerHeight / 2,
      behavior: "smooth",
    });
  }
}

// Incremental document search.
let findMatches = [];
let currentFindMatch = -1;
let findRefreshFrame = 0;

function clearFindHighlights() {
  if (globalThis.CSS?.highlights) {
    CSS.highlights.delete("document-search");
    CSS.highlights.delete("document-search-current");
  }
}

export function closeFind() {
  $("#findbar").hidden = true;
  cancelAnimationFrame(findRefreshFrame);
  findRefreshFrame = 0;
  findMatches = [];
  currentFindMatch = -1;
  clearFindHighlights();
  $("#findCount").textContent = "";
}

function searchTextControl(control, query, matches) {
  const text = control.value.toLocaleLowerCase();
  let index = 0;
  while ((index = text.indexOf(query, index)) !== -1) {
    matches.push({ control, start: index, end: index + query.length });
    index += Math.max(1, query.length);
  }
}

export function searchDom(root, query, matches) {
  let text = "";
  const segments = [];
  const blockTags = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DETAILS",
    "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5",
    "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
    "SECTION", "TABLE", "TR", "UL",
  ]);
  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.data) return;
      const start = text.length;
      text += node.data;
      segments.push({ node, start, end: text.length });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node;
    if (
      element.hidden ||
      /^(SCRIPT|STYLE|INPUT|TEXTAREA|SELECT)$/.test(element.tagName) ||
      element.matches(".collapsed > .block-children, details:not([open]) > :not(summary)")
    ) return;
    if (element.tagName === "BR") text += "\n";
    else for (const child of element.childNodes) visit(child);
    if (blockTags.has(element.tagName) && text && !text.endsWith("\n"))
      text += "\n";
  };
  visit(root);

  const segmentAt = (offset) => {
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const segment = segments[middle];
      if (offset < segment.start) high = middle - 1;
      else if (offset >= segment.end) low = middle + 1;
      else return segment;
    }
    return null;
  };
  const normalized = text.toLocaleLowerCase();
  let index = 0;
  while ((index = normalized.indexOf(query, index)) !== -1) {
    const end = index + query.length;
    const first = segmentAt(index);
    const last = segmentAt(end - 1);
    if (first && last) {
      const range = document.createRange();
      range.setStart(first.node, index - first.start);
      range.setEnd(last.node, end - last.start);
      matches.push({ range });
    }
    index += Math.max(1, query.length);
  }
}

function paintFindHighlights() {
  clearFindHighlights();
  if (!globalThis.CSS?.highlights || !globalThis.Highlight) return;
  const all = new Highlight();
  for (const match of findMatches) if (match.range) all.add(match.range);
  CSS.highlights.set("document-search", all);
  const current = findMatches[currentFindMatch];
  if (current?.range)
    CSS.highlights.set("document-search-current", new Highlight(current.range));
}

function updateFindCount() {
  const count = findMatches.length;
  $("#findCount").textContent = count
    ? `${currentFindMatch + 1}/${count}`
    : $("#findInput").value ? "0/0" : "";
  $("#findNext").disabled = !count;
  $("#findPrev").disabled = !count;
}

export function updateDocumentSearch() {
  cancelAnimationFrame(findRefreshFrame);
  findRefreshFrame = 0;
  findMatches = [];
  currentFindMatch = -1;
  clearFindHighlights();
  const query = $("#findInput").value.toLocaleLowerCase();
  if (query) {
    if (state.sourceMode) searchTextControl(sourceEditor, query, findMatches);
    else {
      const root = state.graphMode ? outliner : editor;
      searchDom(root, query, findMatches);
      $$('textarea', root).forEach((control) =>
        searchTextControl(control, query, findMatches),
      );
    }
    if (findMatches.length) currentFindMatch = 0;
  }
  paintFindHighlights();
  updateFindCount();
}

function scheduleDocumentSearch() {
  if ($("#findbar").hidden || findRefreshFrame) return;
  findRefreshFrame = requestAnimationFrame(updateDocumentSearch);
}

export function showFind() {
  $("#findbar").hidden = false;
  updateDocumentSearch();
  $("#findInput").focus();
  $("#findInput").select();
}

export function moveFind(direction = 1) {
  if ($("#findbar").hidden) showFind();
  if (!findMatches.length) return;
  currentFindMatch =
    (currentFindMatch + direction + findMatches.length) % findMatches.length;
  paintFindHighlights();
  updateFindCount();
  const match = findMatches[currentFindMatch];
  if (match.control) {
    match.control.focus({ preventScroll: true });
    match.control.setSelectionRange(match.start, match.end);
    const lineHeight = parseFloat(getComputedStyle(match.control).lineHeight);
    const line = match.control.value.slice(0, match.start).split("\n").length;
    match.control.scrollTop = Math.max(
      0,
      line * lineHeight - match.control.clientHeight / 2,
    );
  } else {
    match.range.startContainer.parentElement?.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }
}

new MutationObserver(scheduleDocumentSearch).observe(notnoteWrap, {
  childList: true,
  characterData: true,
  subtree: true,
});
notnoteWrap.addEventListener("input", scheduleDocumentSearch);
