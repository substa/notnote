/**
 * Graph block rendering and the task and journal views that are embedded in graph pages.
 */

import { saveSettings } from "./appearance.js";
import {
  closeBlockContextMenu,
  TASK_COMPLETIONS_KEY,
  currentSettings,
  keepActiveMobileBlockVisible,
  updateMobileToolbarPosition,
  usesMobileInput,
  vimRedoStack,
  vimUndoStack,
  requireFunctions,
} from "./core.js";
import { toast } from "./document.js";
import {
  $,
  $$,
  app,
  blockTree,
  graphAutocomplete,
  journalCalendar,
  mobileBlockToolbar,
  notnoteWrap,
  outliner,
  pageHierarchy,
  references,
  voiceRecorderPanel,
} from "./dom.js";
import {
  decodeHtmlEntities,
  escapeHtml,
  fenceClosing,
  fenceOpening,
  highlightedCodeBlock,
  inlineMarkdown,
  orgQuoteClosing,
  orgQuoteOpening,
} from "./markdown.js";
import { voiceRecording, voiceRecordingStartingTarget } from "./media.js";
import {
  handleGraphBlockBeforeInput,
  handleGraphBlockInput,
  handleGraphBlockKeydown,
  hideGraphAutocomplete,
  showGraphAutocomplete,
} from "./outliner.js";
import { Graph, session, state } from "./state.js";
import {
  captureVimSnapshot,
  finishVimInsertChange,
  pushVimSnapshot,
  recordVimChange,
  setVimMode,
  showVimCursor,
  updateVimUi,
} from "./vim.js";



let graphViewDependencies;

export function configureGraphViewDependencies(dependencies) {
  graphViewDependencies = requireFunctions("graph view", dependencies, [
    "graphChanged",
    "loadGraphPage",
    "openGraph",
    "renderPageHierarchy",
    "renderReferences",
  ]);
}

// Structural lookup and collapse helpers operate directly on the parsed graph model.
export function graphBlockLocation(
  id,
  blocks = state.graphDocument?.blocks || [],
  parent = null,
) {
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.id === id) return { block, blocks, index, parent };
    const nested = graphBlockLocation(id, block.children, block);
    if (nested) return nested;
  }
  return null;
}

export function visibleGraphBlocks(
  blocks = state.graphDocument?.blocks || [],
  result = [],
) {
  for (const block of blocks) {
    result.push(block);
    if (!block.collapsed) visibleGraphBlocks(block.children, result);
  }
  return result;
}

export function restoreGraphCollapse(
  document = state.graphDocument,
  page = state.graphPage,
) {
  const settings = currentSettings();
  const collapsed = new Set(settings.graphCollapsed?.[page?.path] || []);
  Graph.flattenBlocks(document?.blocks).forEach(({ block }) => {
    block.collapsed = collapsed.has(block.id);
  });
}

export function saveGraphCollapse(
  document = state.graphDocument,
  page = state.graphPage,
) {
  if (!page) return;
  const settings = currentSettings();
  const ids = Graph.flattenBlocks(document?.blocks)
    .filter(({ block }) => block.collapsed)
    .map(({ block }) => block.id);
  saveSettings({
    graphCollapsed: {
      ...(settings.graphCollapsed || {}),
      [page.path]: ids,
    },
  });
}

export function toggleGraphBlockCollapse(
  block,
  toggle,
  document = state.graphDocument,
  page = state.graphPage,
) {
  block.collapsed = !block.collapsed;
  saveGraphCollapse(document, page);
  toggle
    .closest(".block-node")
    ?.classList.toggle("collapsed", block.collapsed);
  toggle.setAttribute("aria-expanded", String(!block.collapsed));
  toggle.setAttribute(
    "aria-label",
    block.collapsed ? "Expand nested blocks" : "Collapse nested blocks",
  );
}

export function toggleAllGraphBlocks() {
  if (!state.graphMode || !state.graphDocument || !state.graphPage) return;
  if (state.sourceMode) return toast("Close Markdown source first");
  commitGraphBlock();
  const blocks = Graph.flattenBlocks(state.graphDocument.blocks)
    .map(({ block }) => block)
    .filter((block) => block.children.length);
  if (!blocks.length) return toast("This page has no nested blocks");
  const collapse = blocks.some((block) => !block.collapsed);
  const collapsedById = new Map();
  for (const block of blocks) {
    block.collapsed = collapse;
    collapsedById.set(block.id, collapse);
  }
  saveGraphCollapse();
  $$(".block-node", blockTree).forEach((node) => {
    if (node.dataset.pagePath !== state.graphPage.path) return;
    const collapsed = collapsedById.get(node.dataset.blockId);
    if (collapsed === undefined) return;
    node.classList.toggle("collapsed", collapsed);
    const toggle = $("[data-block-toggle]", node);
    toggle?.setAttribute("aria-expanded", String(!collapsed));
    toggle?.setAttribute(
      "aria-label",
      collapsed ? "Expand nested blocks" : "Collapse nested blocks",
    );
  });
  toast(collapse ? "All blocks collapsed" : "All blocks expanded");
}

// Rendering escapes source text before adding controlled Markdown and reference markup.
function visibleGraphPreamble(lines = []) {
  let frontmatter = false;
  return lines
    .filter((line, index) => {
      if (/^\s*---\s*$/.test(line) && (frontmatter || index === 0)) {
        frontmatter = !frontmatter;
        return false;
      }
      if (frontmatter) return false;
      return !/^\s*[\w-]+::\s*/.test(line);
    })
    .join("\n")
    .trim();
}

function blockReferenceLabel(uuid) {
  const resolved = session.graphIndex?.resolveBlock(uuid);
  if (!resolved) return uuid;
  const line = resolved.content
    .split("\n")
    .find((value) => value.trim() && !/^\s*[\w-]+::/.test(value));
  if (!line) return uuid;
  return (
    line
      .replace(
        /^\s*(?:TODO|DOING|DONE|LATER|NOW|WAITING|CANCELED|CANCELLED)(?:\s+|$)/,
        "",
      )
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .trim() || uuid
  );
}

function graphTextHtml(text, block) {
  // Transform only text nodes: applying wiki-link regexes to serialized HTML could
  // otherwise corrupt attributes generated by Markdown images and links.
  const value = text
    .replace(/^\n+|\n+$/g, "")
    .replace(/\n(?:[ \t]*\n)+(?=[ \t]*(?:SCHEDULED|DEADLINE):)/g, "\n");
  if (!value) return "";
  const quote = value.split("\n").every((line) => /^\s*>/.test(line));
  const html = quote
    ? `<blockquote>${inlineMarkdown(
        value
          .split("\n")
          .map((line) => line.replace(/^\s*>\s?/, ""))
          .join("\n"),
      ).replace(/\n/g, "<br>")}</blockquote>`
    : inlineMarkdown(value).replace(/\n/g, "<br>");
  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(
    template.content,
    NodeFilter.SHOW_TEXT,
  );
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.parentElement?.closest("code,a,button")) nodes.push(node);
  }
  let firstText = true;
  for (const textNode of nodes) {
    let rendered = escapeHtml(textNode.nodeValue || "");
    if (firstText) {
      rendered = rendered.replace(
        /^(TODO|DOING|DONE|LATER|NOW|WAITING|CANCELED|CANCELLED)\b/,
        (status) => {
          const taskState = /^(DONE|CANCELED|CANCELLED)$/.test(status)
            ? "done"
            : /^(DOING|NOW)$/.test(status)
              ? "doing"
              : "todo";
          return `<button class="graph-task graph-task-${taskState}" data-task-block="${escapeHtml(block.id)}" aria-label="Task status: ${status}. Click to complete; Shift-click or hold to mark in progress" title="${status} · click to complete · Shift-click or hold for DOING"><span aria-hidden="true"></span></button>`;
        },
      );
      firstText = false;
    }
    rendered = rendered.replace(
      /\s*(SCHEDULED|DEADLINE):\s*&lt;([^&]+)&gt;/g,
      (_, type, date) =>
        `<button type="button" class="graph-scheduled" data-scheduled-block="${escapeHtml(block.id)}" data-scheduled-date="${escapeHtml(date.slice(0, 10))}" title="Edit ${type === "DEADLINE" ? "deadline" : "scheduled date"}"><span class="graph-scheduled-icon" aria-hidden="true"></span>${escapeHtml(date)}</button>`,
    );
    rendered = rendered.replace(/\[\[([^\]]+?)\]\]/g, (_, target) => {
      const [encodedPage, encodedAlias] = target.split("|");
      const page = decodeHtmlEntities(encodedPage).trim();
      const alias = decodeHtmlEntities(encodedAlias || encodedPage).trim();
      return `<button class="graph-page-ref" data-page="${escapeHtml(page)}">${escapeHtml(alias)}</button>`;
    });
    rendered = rendered.replace(/\(\(([0-9a-z-]{8,})\)\)/gi, (_, uuid) => {
      const label = blockReferenceLabel(uuid);
      return `<button class="graph-block-ref" data-block-ref="${escapeHtml(uuid)}" title="${escapeHtml(uuid)}">${escapeHtml(label)}</button>`;
    });
    rendered = rendered.replace(
      /(^|\s)#([\p{L}\p{N}_/-]+)/gu,
      (_, space, tag) =>
        `${space}<button class="graph-tag" data-page="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`,
    );
    const replacement = document.createElement("template");
    replacement.innerHTML = rendered;
    textNode.replaceWith(replacement.content);
  }
  return template.innerHTML;
}

function graphMixedMarkdownHtml(value, block) {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let text = [];
  const flushText = () => {
    const rendered = graphTextHtml(text.join("\n"), block);
    if (rendered) html.push(rendered);
    text = [];
  };
  for (let index = 0; index < lines.length;) {
    if (orgQuoteOpening(lines[index])) {
      flushText();
      const quote = [];
      index++;
      while (index < lines.length && !orgQuoteClosing(lines[index]))
        quote.push(lines[index++]);
      if (index < lines.length) index++;
      html.push(
        `<blockquote>${graphTextHtml(quote.join("\n"), block)}</blockquote>`,
      );
      continue;
    }
    const opening = fenceOpening(lines[index]);
    if (opening) {
      flushText();
      const code = [];
      index++;
      while (
        index < lines.length &&
        !fenceClosing(lines[index], opening.marker)
      )
        code.push(lines[index++]);
      if (index < lines.length) index++;
      html.push(highlightedCodeBlock(code.join("\n"), opening.language));
      continue;
    }
    const heading = lines[index].match(/^\s*(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) {
      flushText();
      const level = heading[1].length;
      html.push(
        `<h${level} class="graph-heading">${graphTextHtml(heading[2], block)}</h${level}>`,
      );
      index++;
      continue;
    }
    text.push(lines[index]);
    index++;
  }
  flushText();
  return html.join("");
}

function graphDisplayContent(block) {
  let activeFence = null;
  let activeOrgQuote = false;
  const visible = String(block.content || "")
    .split("\n")
    .filter((line) => {
      if (!activeFence && !activeOrgQuote && orgQuoteOpening(line)) {
        activeOrgQuote = true;
        return true;
      }
      if (activeOrgQuote) {
        if (orgQuoteClosing(line)) activeOrgQuote = false;
        return true;
      }
      const opening = !activeFence && fenceOpening(line);
      if (opening) {
        activeFence = opening.marker;
        return true;
      }
      if (activeFence) {
        if (fenceClosing(line, activeFence)) activeFence = null;
        return true;
      }
      // Logseq properties are metadata. Keep every key/value in the Markdown
      // source, but do not render unsupported or custom properties in the page.
      if (/^\s*[\w-]+::\s*/.test(line)) return false;
      return true;
    })
    .join("\n")
    .trimEnd();
  return graphMixedMarkdownHtml(visible, block);
}

export function resolveGraphContentAssets(content, page) {
  if (!session.graphStore || !page) return;
  const fromFolder = page.path?.includes("/")
    ? page.path.split("/").slice(0, -1).join("/")
    : page.folder || "";
  $$("img, audio, video", content).forEach((media) => {
    const source = media.getAttribute("src");
    if (source && !/^[a-z]+:/i.test(source))
      session.graphStore
        .assetUrl(source, fromFolder)
        .then((url) => {
          if (media.isConnected) media.src = url;
        })
        .catch(() => {
          media.classList.add("asset-error");
          media.title = `Media not found: ${source}`;
        });
  });
  $$("a[href]", content).forEach((link) => {
    const source = link.getAttribute("href");
    if (!source || /^[a-z]+:/i.test(source) || source.startsWith("#")) return;
    if (!Graph.resolveAssetPath(source, fromFolder).startsWith("assets/"))
      return;
    link.dataset.graphAsset = source;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    session.graphStore
      .assetUrl(source, fromFolder)
      .then((url) => {
        if (link.isConnected) {
          link.href = url;
          link.dataset.graphAssetReady = "true";
        }
      })
      .catch(() => {
        link.classList.add("asset-error");
        link.title = `Attachment not found: ${source}`;
      });
  });
}

function graphContentElement(block, page = state.graphPage) {
  const content = document.createElement("div");
  content.className = "graph-block-content";
  content.dataset.blockId = block.id;
  content.dataset.pagePath = page?.path || "";
  content.innerHTML = graphDisplayContent(block);
  if (content.querySelector("audio.media-embed"))
    content.classList.add("audio-block-content");
  resolveGraphContentAssets(content, page);
  return content;
}

// Task and journal panels are derived from the shared graph index.
export function orderedJournalPages() {
  if (!session.graphStore) return [];
  const today = Graph.journalInfo(new Date(), session.graphStore.config).date;
  return session.graphStore.pages
    .filter(
      (page) =>
        page.journal && (!page.journalDate || page.journalDate <= today),
    )
    .sort((a, b) => {
      if (a.journalDate === today) return -1;
      if (b.journalDate === today) return 1;
      return (b.journalDate || b.name).localeCompare(a.journalDate || a.name);
    });
}

export function cachedJournalDocument(page) {
  if (page.path === state.graphPage?.path) return state.graphDocument;
  if (!session.journalDocuments.has(page.path)) {
    const document = Graph.parseDocument(page.content);
    restoreGraphCollapse(document, page);
    session.journalDocuments.set(page.path, document);
  }
  return session.journalDocuments.get(page.path);
}

// Build task records from the graph index so every dashboard shares one source of truth.
function graphTasks() {
  if (!session.graphIndex) return [];
  const tasks = [];
  let sequence = 0;
  for (const page of session.graphIndex.allPages()) {
    const document =
      page.path === state.graphPage?.path
        ? state.graphDocument
        : session.graphIndex.documents.get(page.path);
    for (const { block } of Graph.flattenBlocks(document?.blocks)) {
      const marker = block.content.match(
        /^(TODO|DOING|DONE|LATER|NOW|WAITING|CANCELED|CANCELLED)(?:\s+|$)/,
      )?.[1];
      if (!marker) continue;
      const scheduled =
        block.content.match(
          /^\s*(?:SCHEDULED|DEADLINE):\s*<(\d{4}-\d{2}-\d{2})\b[^>]*>/m,
        )?.[1] || "";
      const text = block.content
        .replace(/^[A-Z]+(?:\s+|$)/, "")
        .replace(/^\s*(?:SCHEDULED|DEADLINE):.*$/gm, "")
        .replace(/^\s*[\w-]+::.*$/gm, "")
        .trim();
      tasks.push({
        page,
        block,
        marker,
        scheduled,
        text,
        done: /^(DONE|CANCELED|CANCELLED)$/.test(marker),
        progress: /^(DOING|NOW)$/.test(marker),
        later: /^(LATER|WAITING)$/.test(marker),
        completedAt:
          Graph.propertiesFrom(block.content)["completed-at"] || "",
        sequence: sequence++,
      });
    }
  }
  return tasks;
}

export function taskDate(days = 0) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return Graph.formatJournalDate(date, "yyyy-MM-dd");
}

export function taskCompletedTodayIds() {
  const today = taskDate();
  if (state.taskCompletedDate === today)
    return state.taskCompletedTodayIds;
  state.taskCompletedDate = today;
  state.taskCompletedTodayIds = [];
  try {
    const saved = JSON.parse(
      localStorage.getItem(
        `${TASK_COMPLETIONS_KEY}:${session.graphStore?.name || "default"}`,
      ),
    );
    if (saved?.date === today && Array.isArray(saved.ids))
      state.taskCompletedTodayIds = saved.ids.filter(
        (id) => typeof id === "string",
      );
  } catch {}
  return state.taskCompletedTodayIds;
}

export function saveTaskCompletedTodayIds() {
  try {
    localStorage.setItem(
      `${TASK_COMPLETIONS_KEY}:${session.graphStore?.name || "default"}`,
      JSON.stringify({
        date: state.taskCompletedDate,
        ids: state.taskCompletedTodayIds,
      }),
    );
  } catch {}
}

function taskTimestamp(value) {
  if (!value) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric))
    return numeric > 1e15 ? numeric / 1e6 : numeric;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function taskSourceTimestamp(task) {
  return (
    taskTimestamp(
      task.page.journalDate && `${task.page.journalDate}T12:00:00`,
    ) || taskTimestamp(task.page.lastModified)
  );
}

function compareTaskFallback(left, right) {
  return (
    taskSourceTimestamp(right) - taskSourceTimestamp(left) ||
    left.text.localeCompare(right.text) ||
    left.sequence - right.sequence
  );
}

function compareScheduledTasks(left, right) {
  if (left.scheduled !== right.scheduled) {
    if (!left.scheduled) return 1;
    if (!right.scheduled) return -1;
    return left.scheduled.localeCompare(right.scheduled);
  }
  return compareTaskFallback(left, right);
}

function compareCompletedTasks(left, right) {
  return (
    (taskTimestamp(right.completedAt) || taskSourceTimestamp(right)) -
      (taskTimestamp(left.completedAt) || taskSourceTimestamp(left)) ||
    compareTaskFallback(left, right)
  );
}

function taskWasCompletedToday(task) {
  const timestamp = taskTimestamp(task.completedAt);
  if (!task.done || !timestamp) return false;
  const completed = new Date(timestamp);
  return (
    !Number.isNaN(completed.getTime()) &&
    Graph.formatJournalDate(completed, "yyyy-MM-dd") === taskDate()
  );
}

// Keep in-progress tasks separate here; overview views append them to Today in a stable order.
function taskGroups(tasks = graphTasks()) {
  const today = taskDate();
  const week = taskDate(7);
  const now = new Date();
  const endOfWeek = taskDate((7 - now.getDay()) % 7);
  return {
    overdue: tasks
      .filter(
        (task) =>
          !task.done &&
          !task.progress &&
          task.scheduled &&
          task.scheduled < today,
      )
      .sort(compareScheduledTasks),
    today: tasks
      .filter(
        (task) =>
          !task.done &&
          !task.progress &&
          (task.scheduled === today ||
            (!task.scheduled && task.page.journalDate === today)),
      )
      .sort(compareScheduledTasks),
    progress: tasks
      .filter((task) => !task.done && task.progress)
      .sort(compareScheduledTasks),
    next: tasks
      .filter(
        (task) => !task.done && !task.progress && task.scheduled > today,
      )
      .sort(compareScheduledTasks),
    thisWeek: tasks
      .filter(
        (task) =>
          !task.done &&
          !task.progress &&
          task.scheduled >= today &&
          task.scheduled <= endOfWeek,
      )
      .sort(compareScheduledTasks),
    nextWeek: tasks
      .filter(
        (task) =>
          !task.done &&
          !task.progress &&
          task.scheduled > today &&
          task.scheduled <= week,
      )
      .sort(compareScheduledTasks),
    unscheduled: tasks
      .filter(
        (task) =>
          !task.done && !task.progress && !task.scheduled && !task.later,
      )
      .sort(compareTaskFallback),
    later: tasks
      .filter((task) => !task.done && task.later)
      .sort(compareScheduledTasks),
    done: tasks.filter((task) => task.done).sort(compareCompletedTasks),
  };
}

export function updateTaskCompletionMetadata(content, marker) {
  const withoutCompletion = content
    .replace(/^\s*completed-at::.*(?:\n|$)/gim, "")
    .trimEnd();
  return marker === "DONE"
    ? `${withoutCompletion}\ncompleted-at:: ${new Date().toISOString()}`
    : withoutCompletion;
}

const taskId = (task) => `${task.page.path}:${task.block.id}`;
export const taskPersistenceId = (task) =>
  `${task.page.path}:${
    task.block.uuid ||
    task.block.content
      .replace(/^[A-Z]+(?:\s+|$)/, "")
      .replace(/^\s*completed-at::.*$/gim, "")
      .trim()
  }`;

function uniqueTasks(...groups) {
  return [
    ...new Map(groups.flat().map((task) => [taskId(task), task])).values(),
  ];
}

export function taskOverviewGroups(groups = taskGroups()) {
  const progressIds = new Set(groups.progress.map(taskId));
  const today = uniqueTasks(groups.overdue, groups.today).filter((task) =>
    !progressIds.has(taskId(task)),
  );
  return {
    today: [...today, ...groups.progress],
    progress: groups.progress,
  };
}

function taskSummary() {
  const groups = taskGroups();
  const overview = taskOverviewGroups(groups);
  return {
    today: overview.today.filter((task) => !task.progress).length,
    progress: overview.progress.length,
  };
}

export function taskTextHtml(task) {
  return graphTextHtml(task.text || "Untitled task", task.block);
}

function taskRowsHtml(items) {
  const today = taskDate();
  return items.length
    ? items
        .map((task) => {
          const overdue =
            !task.done && task.scheduled && task.scheduled < today;
          return `<div class="task-dashboard-item${task.done ? " task-dashboard-item-done" : ""}"><button type="button" class="task-dashboard-state task-dashboard-state-${task.done ? "done" : task.progress ? "doing" : "todo"}" data-task-checkbox-page="${escapeHtml(task.page.path)}" data-task-checkbox-block="${escapeHtml(task.block.id)}" aria-label="Task status: ${escapeHtml(task.marker)}. Click to complete; Shift-click or hold to mark in progress" title="${escapeHtml(task.marker)} · click to complete · Shift-click or hold for DOING"></button><div class="task-dashboard-item-main" data-task-page="${escapeHtml(task.page.path)}" data-task-block-id="${escapeHtml(task.block.id)}" role="button" tabindex="0"><span>${overdue ? '<i class="task-overdue-icon" title="Overdue" aria-label="Overdue">!</i>' : ""}${taskTextHtml(task)}</span>${task.scheduled ? `<time class="graph-scheduled" data-scheduled-page="${escapeHtml(task.page.path)}" data-scheduled-block="${escapeHtml(task.block.id)}" data-scheduled-date="${escapeHtml(task.scheduled)}" title="Edit scheduled date"><span class="graph-scheduled-icon" aria-hidden="true"></span>${escapeHtml(task.scheduled)}</time>` : ""}</div></div>`;
        })
        .join("")
    : '<p class="task-dashboard-empty">No tasks</p>';
}

export function graphContextBlockElement(block, page, variant, expanded = false) {
  const node = document.createElement("div");
  node.className = "context-block-node";
  if (block.children.length) {
    node.classList.add("has-children");
    if (!expanded) node.classList.add("collapsed");
  }
  node.dataset.contextBlockId = block.id;
  const row = document.createElement("div");
  row.className = "context-block-row";
  if (block.children.length) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "context-block-toggle";
    toggle.dataset.contextBlockToggle = "";
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute(
      "aria-label",
      expanded ? "Collapse nested blocks" : "Expand nested blocks",
    );
    row.append(toggle);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "context-block-toggle-spacer";
    row.append(spacer);
  }
  if (variant === "on-this-day") {
    const point = document.createElement("button");
    point.type = "button";
    point.className = "context-block-point on-this-day-point";
    point.dataset.onThisDayPage = page.path;
    point.dataset.onThisDayBlock = block.id;
    point.setAttribute("aria-label", `Open ${page.title}`);
    row.append(point);
  } else {
    const point = document.createElement("span");
    point.className = "context-block-point";
    row.append(point);
  }
  const content = graphContentElement(block, page);
  content.classList.add(`${variant}-content`);
  const firstHeading = content.firstElementChild;
  if (firstHeading?.classList.contains("graph-heading")) {
    row.classList.add(
      "graph-heading-row",
      `graph-heading-row-${firstHeading.tagName.slice(1)}`,
    );
  }
  row.append(content);
  node.append(row);
  if (block.children.length) {
    const children = document.createElement("div");
    children.className = "context-block-children";
    block.children.forEach((child) =>
      children.append(graphContextBlockElement(child, page, variant)),
    );
    node.append(children);
  }
  return node;
}

function onThisDayPages(date = new Date()) {
  const monthDay = Graph.formatJournalDate(date, "MM-dd");
  const currentYear = date.getFullYear();
  return (session.graphStore?.pages || [])
    .filter((page) => {
      if (!page.journalDate || page.journalDate.slice(5) !== monthDay)
        return false;
      return Number(page.journalDate.slice(0, 4)) < currentYear;
    })
    .sort((a, b) => b.journalDate.localeCompare(a.journalDate));
}

function journalDocumentIsEmpty(document) {
  return !Graph.flattenBlocks(document?.blocks || []).some(({ block }) =>
    String(block.content || "").trim(),
  );
}

// Render historical journal blocks without making those source pages editable in place.
function onThisDayElement({
  expanded = state.onThisDayExpanded,
  featured = false,
} = {}) {
  const histories = onThisDayPages()
    .map((page) => ({
      page,
      blocks: cachedJournalDocument(page).blocks.filter(
        (block) =>
          !/(^|\s)#worklog\b/i.test(block.content) &&
          block.content
            .split("\n")
            .some((line) => line.trim() && !/^\s*[\w-]+::/.test(line)),
      ),
    }))
    .filter((history) => history.blocks.length);
  if (!histories.length) return null;
  const wrapper = document.createElement("section");
  wrapper.className = `on-this-day${featured ? " on-this-day-featured" : ""}`;
  const toggle = document.createElement("button");
  toggle.type = "button";
  if (featured) {
    toggle.dataset.onThisDayDismiss = "";
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-label", "Hide on this day timeline");
  } else {
    toggle.dataset.onThisDayToggle = "";
    toggle.setAttribute("aria-expanded", String(expanded));
  }
  toggle.className = "on-this-day-toggle";
  toggle.textContent = "on this day";
  wrapper.append(toggle);
  if (!expanded) return wrapper;
  const list = document.createElement("div");
  list.className = "on-this-day-list";
  for (const { page, blocks } of histories) {
    const group = document.createElement("section");
    group.className = "on-this-day-year";
    const year = document.createElement("button");
    year.type = "button";
    year.className = "on-this-day-year-link";
    year.dataset.journalPage = page.path;
    year.textContent = page.journalDate.slice(0, 4);
    group.append(year);
    for (const block of blocks) {
      const item = document.createElement("article");
      item.className = "on-this-day-item";
      item.dataset.pagePath = page.path;
      item.append(graphContextBlockElement(block, page, "on-this-day"));
      group.append(item);
    }
    list.append(group);
  }
  wrapper.append(list);
  return wrapper;
}

export function scrollOnThisDayIntoView() {
  const section = $(".on-this-day", blockTree);
  if (!section) return;
  const viewport = notnoteWrap.getBoundingClientRect();
  const bounds = section.getBoundingClientRect();
  let delta = 0;
  if (bounds.height > viewport.height) delta = bounds.top - viewport.top;
  else if (bounds.bottom > viewport.bottom)
    delta = bounds.bottom - viewport.bottom + 12;
  else if (bounds.top < viewport.top) delta = bounds.top - viewport.top;
  if (Math.abs(delta) > 1)
    notnoteWrap.scrollTo({
      top: Math.max(0, notnoteWrap.scrollTop + delta),
      behavior: "smooth",
    });
}

function journalTaskPanelElement() {
  const overview = taskOverviewGroups();
  taskCompletedTodayIds();
  const retainedIds = new Set(state.taskCompletedTodayIds);
  const completed = graphTasks()
    .filter(
      (task) =>
        task.done &&
        (taskWasCompletedToday(task) ||
          retainedIds.has(taskPersistenceId(task))),
    )
    .sort(compareCompletedTasks);
  const initialOrder = new Map(
    state.taskSummaryIds.map((id, index) => [id, index]),
  );
  const active = overview.today.sort(
    (left, right) =>
      (initialOrder.get(taskPersistenceId(left)) ?? Number.MAX_SAFE_INTEGER) -
      (initialOrder.get(taskPersistenceId(right)) ??
        Number.MAX_SAFE_INTEGER),
  );
  // Completed-today tasks always follow every active/in-progress task.
  overview.today = uniqueTasks(active, completed);
  const panel = document.createElement("section");
  panel.className = "journal-task-panel";
  const sections = [["Today", overview.today]];
  panel.innerHTML = `${sections.map(([label, tasks]) => `<details class="task-dashboard-group" open><summary><span>${label}</span><span class="task-section-count">${tasks.length}</span></summary>${taskRowsHtml(tasks)}</details>`).join("")}<button type="button" class="journal-all-tasks" data-task-filter="all">All tasks</button>`;
  return panel;
}

export async function openTasksPage() {
  if (!session.graphStore) await graphViewDependencies.openGraph();
  if (!session.graphStore) return;
  let page = session.graphStore.pages.find(
    (item) => item.name.toLowerCase() === "tasks.md",
  );
  if (!page) {
    page = await session.graphStore.createPage("Task dashboard", {
      filename: "tasks",
      content:
        "title:: Tasks\n\n<!-- This file is rendered as the notnote task dashboard. -->\n",
    });
    page.title = "Tasks";
    session.graphIndex.rebuild(session.graphStore.pages);
  }
  state.taskLimits = {};
  state.taskExpanded = {};
  await graphViewDependencies.loadGraphPage(page);
}

export async function ensureTemplatesPage() {
  if (!session.graphStore) return null;
  let page = session.graphStore.pages.find(
    (item) => item.name.toLowerCase() === "templates.md",
  );
  if (!page) {
    page = await session.graphStore.createPage("Templates", {
      filename: "templates",
      content:
        "title:: Templates\n\n<!-- Each top-level block names a template; /template inserts its child blocks. -->\n",
    });
    session.graphIndex.rebuild(session.graphStore.pages);
  }
  return page;
}

export async function openTemplatesPage() {
  if (!session.graphStore) await graphViewDependencies.openGraph();
  const page = await ensureTemplatesPage();
  if (page) await graphViewDependencies.loadGraphPage(page);
}

function taskDashboardElement() {
  const groups = taskGroups();
  const dashboard = document.createElement("section");
  dashboard.className = "task-dashboard";
  const sections = [
    ["today", "Today"],
    ["nextWeek", "Next 7 days"],
    ["later", "Later"],
    ["unscheduled", "Unscheduled"],
    ["done", "Done"],
  ];
  const collapsed = new Set(["later", "unscheduled", "done"]);
  const sectionHtml = ([key, label]) => {
    const tasks =
      key === "today" ? taskOverviewGroups(groups).today : groups[key];
    const limit = state.taskLimits[key] || 10;
    const remaining = tasks.length - limit;
    const more =
      remaining > 0
        ? `<button type="button" class="task-dashboard-more" data-task-more="${key}">Show next ${Math.min(10, remaining)}</button>`
        : "";
    return `<details class="task-dashboard-group"${collapsed.has(key) && !state.taskExpanded[key] ? "" : " open"}><summary><span>${label}</span><span class="task-section-count">${tasks.length}</span></summary>${taskRowsHtml(tasks.slice(0, limit))}${more}</details>`;
  };
  dashboard.innerHTML = sections.map(sectionHtml).join("");
  return dashboard;
}

function graphNewBlockElement(
  page = state.graphPage,
  visible = false,
) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `graph-new-block${visible ? " graph-new-block-visible" : ""}`;
  button.dataset.newBlockPage = page?.path || "";
  button.setAttribute("aria-label", "Create a new block");
  button.innerHTML = '<span aria-hidden="true"></span>';
  return button;
}

function graphDocumentHasContent(document) {
  return Graph.flattenBlocks(document?.blocks || []).some(({ block }) =>
    String(block.content || "").trim(),
  );
}

function graphDocumentHasEmptyBlock(document) {
  return Graph.flattenBlocks(document?.blocks || []).some(
    ({ block }) => !String(block.content || "").trim(),
  );
}

export function syncGraphNewBlockElement(container, document, page) {
  if (!container) return;
  const pagePath = page?.path || "";
  const existing = $$(".graph-new-block", container).find(
    (button) => button.dataset.newBlockPage === pagePath,
  );
  if (graphDocumentHasEmptyBlock(document)) existing?.remove();
  else if (existing)
    existing.classList.toggle(
      "graph-new-block-visible",
      !graphDocumentHasContent(document),
    );
  else
    container.append(
      graphNewBlockElement(page, !graphDocumentHasContent(document)),
    );
}

// Rebuild after structural changes; active text fields update in place elsewhere.
export function renderGraphPage() {
  if (!state.graphMode || !state.graphDocument) return;
  closeBlockContextMenu();
  session.activeGraphBlock = null;
  mobileBlockToolbar.hidden = true;
  const renderBlocks = (blocks, page = state.graphPage) => {
    const fragment = document.createDocumentFragment();
    for (const block of blocks) {
      const node = document.createElement("div");
      const selected =
        session.graphSelectionPagePath === (page?.path || "") &&
        session.selectedGraphBlockIds.has(block.id);
      node.className = `block-node${block.children.length ? " has-children" : ""}${block.collapsed ? " collapsed" : ""}${selected ? " block-selected" : ""}`;
      node.dataset.blockId = block.id;
      node.dataset.pagePath = page?.path || "";
      const row = document.createElement("div");
      row.className = "block-row";
      let toggle;
      if (block.children.length) {
        toggle = document.createElement("button");
        toggle.className = "block-toggle";
        toggle.type = "button";
        toggle.dataset.blockToggle = block.id;
        toggle.setAttribute("aria-expanded", String(!block.collapsed));
        toggle.setAttribute(
          "aria-label",
          block.collapsed ? "Expand nested blocks" : "Collapse nested blocks",
        );
      } else {
        toggle = document.createElement("span");
        toggle.className = "block-toggle-spacer";
      }
      const bullet = document.createElement("button");
      bullet.className = "block-bullet";
      bullet.type = "button";
      bullet.dataset.blockBullet = block.id;
      bullet.setAttribute("aria-label", "Zoom into block");
      const blockContent = graphContentElement(block, page);
      if (blockContent.classList.contains("audio-block-content"))
        row.classList.add("audio-embed-row");
      const firstHeading = blockContent.firstElementChild;
      if (firstHeading?.classList.contains("graph-heading"))
        row.classList.add(
          "graph-heading-row",
          `graph-heading-row-${firstHeading.tagName.slice(1)}`,
        );
      row.append(toggle, bullet, blockContent);
      node.append(row);
      if (block.children.length) {
        const children = document.createElement("div");
        children.className = "block-children";
        children.append(renderBlocks(block.children, page));
        node.append(children);
      }
      fragment.append(node);
    }
    return fragment;
  };

  if (state.taskView === "all") {
    blockTree.replaceChildren(taskDashboardElement());
    $("#pagePreamble").hidden = true;
    $("#zoomBreadcrumb").hidden = true;
    pageHierarchy.hidden = true;
    references.innerHTML = "";
    app.classList.add("task-view");
    return;
  }
  app.classList.remove("task-view");
  const fragment = document.createDocumentFragment();
  if (state.journalMode && !state.graphZoomId) {
    const pages = orderedJournalPages().slice(0, state.journalLimit);
    const today = Graph.journalInfo(new Date(), session.graphStore.config).date;
    for (const page of pages) {
      const journalDocument = cachedJournalDocument(page);
      const section = document.createElement("section");
      section.className = `journal-entry${page.path === state.graphPage.path ? " active" : ""}${page.journalDate === today ? " today" : ""}`;
      section.dataset.journalPath = page.path;
      const heading = document.createElement("button");
      heading.type = "button";
      heading.className = "journal-heading";
      heading.dataset.journalPage = page.path;
      heading.textContent = page.title;
      section.append(heading);
      const emptyToday =
        page.journalDate === today && journalDocumentIsEmpty(journalDocument);
      if (page.journalDate === today) {
        const summary = taskSummary();
        const button = document.createElement("button");
        button.type = "button";
        button.className = "journal-task-summary";
        button.dataset.openTaskView = "";
        const expanded = state.taskView === "summary";
        button.setAttribute("aria-expanded", String(expanded));
        const arrow = document.createElement("span");
        arrow.className = "journal-task-summary-arrow";
        arrow.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        label.textContent = `${summary.today} ${summary.today === 1 ? "task" : "tasks"} today, ${summary.progress} in progress`;
        button.append(arrow, label);
        section.append(button);
        if (state.taskView === "summary")
          section.append(journalTaskPanelElement());
      }
      const preamble = visibleGraphPreamble(journalDocument.preamble);
      if (preamble) {
        const properties = document.createElement("div");
        properties.className = "journal-preamble";
        properties.textContent = preamble;
        section.append(properties);
      }
      const tree = document.createElement("div");
      tree.className = "journal-blocks";
      tree.append(renderBlocks(journalDocument.blocks, page));
      syncGraphNewBlockElement(tree, journalDocument, page);
      section.append(tree);
      if (emptyToday && !state.onThisDayEmptyDismissed) {
        const history = onThisDayElement({ expanded: true, featured: true });
        if (history) section.append(history);
      } else if (page.journalDate === today) {
        const history = onThisDayElement();
        if (history) section.append(history);
      }
      fragment.append(section);
    }
    if (pages.length < orderedJournalPages().length) {
      const more = document.createElement("div");
      more.className = "journal-more";
      more.dataset.journalMore = "";
      fragment.append(more);
    }
  } else {
    let roots = state.graphDocument.blocks;
    if (state.graphZoomId)
      roots = [graphBlockLocation(state.graphZoomId)?.block].filter(Boolean);
    fragment.append(renderBlocks(roots));
    if (!graphDocumentHasEmptyBlock(state.graphDocument))
      fragment.append(
        graphNewBlockElement(
          state.graphPage,
          !graphDocumentHasContent(state.graphDocument),
        ),
      );
  }
  blockTree.replaceChildren(fragment);
  const preamble = $("#pagePreamble");
  const preambleText = visibleGraphPreamble(state.graphDocument.preamble);
  preamble.hidden = state.journalMode || !preambleText;
  preamble.textContent = preambleText;
  const breadcrumb = $("#zoomBreadcrumb");
  breadcrumb.hidden = !state.graphZoomId;
  breadcrumb.innerHTML = state.graphZoomId
    ? `<button type="button" data-clear-zoom>${escapeHtml(state.graphPage?.title || "Page")}</button> / Block`
    : "";
  graphViewDependencies.renderPageHierarchy();
  graphViewDependencies.renderReferences();
}

export function resizeGraphEditor(field) {
  field.style.height = "0";
  field.style.height = `${Math.max(32, field.scrollHeight)}px`;
}

// Selection and editor activation remain view concerns; mutations delegate through dependencies.
let graphSelectionAnchor = null;

export function clearGraphBlockSelection() {
  session.selectedGraphBlockIds.clear();
  graphSelectionAnchor = null;
  session.graphSelectionPagePath = null;
  $$(".block-node.block-selected", blockTree).forEach((node) =>
    node.classList.remove("block-selected"),
  );
}

function graphSelectionNodes(pagePath = state.graphPage?.path) {
  return $$(".block-node", blockTree).filter(
    (node) =>
      node.dataset.pagePath === pagePath && node.getClientRects().length,
  );
}

export function selectGraphBlocksWithMouse(node, event) {
  const pagePath = node?.dataset.pagePath;
  if (!node || !pagePath || pagePath !== state.graphPage?.path) return false;
  commitGraphBlock();
  const nodes = graphSelectionNodes(pagePath);
  const id = node.dataset.blockId;
  if (
    event.shiftKey &&
    graphSelectionAnchor &&
    session.graphSelectionPagePath === pagePath
  ) {
    const anchorIndex = nodes.findIndex(
      (item) => item.dataset.blockId === graphSelectionAnchor,
    );
    const targetIndex = nodes.indexOf(node);
    if (!event.metaKey && !event.ctrlKey) session.selectedGraphBlockIds.clear();
    if (anchorIndex >= 0 && targetIndex >= 0) {
      const [start, end] = [anchorIndex, targetIndex].sort((a, b) => a - b);
      nodes
        .slice(start, end + 1)
        .forEach((item) => session.selectedGraphBlockIds.add(item.dataset.blockId));
    } else session.selectedGraphBlockIds.add(id);
  } else if (event.metaKey || event.ctrlKey) {
    if (session.selectedGraphBlockIds.has(id)) session.selectedGraphBlockIds.delete(id);
    else session.selectedGraphBlockIds.add(id);
    graphSelectionAnchor = id;
  } else {
    session.selectedGraphBlockIds.clear();
    session.selectedGraphBlockIds.add(id);
    graphSelectionAnchor = id;
  }
  session.graphSelectionPagePath = session.selectedGraphBlockIds.size ? pagePath : null;
  if (!session.selectedGraphBlockIds.size) graphSelectionAnchor = null;
  nodes.forEach((item) =>
    item.classList.toggle(
      "block-selected",
      session.selectedGraphBlockIds.has(item.dataset.blockId),
    ),
  );
  outliner.focus({ preventScroll: true });
  return true;
}

export function deleteSelectedGraphBlocks() {
  if (
    !session.selectedGraphBlockIds.size ||
    session.graphSelectionPagePath !== state.graphPage?.path
  )
    return false;
  commitGraphBlock();
  const snapshot = captureVimSnapshot();
  const selected = new Set(session.selectedGraphBlockIds);
  const count = selected.size;
  const remove = (blocks) =>
    blocks.filter((block) => {
      if (selected.has(block.id)) return false;
      block.children = remove(block.children || []);
      return true;
    });
  state.graphDocument.blocks = remove(state.graphDocument.blocks);
  if (!state.graphDocument.blocks.length)
    state.graphDocument.blocks.push({
      id: Graph.newId(),
      uuid: null,
      content: "",
      marker: "-",
      children: [],
      collapsed: false,
    });
  if (state.graphZoomId && !graphBlockLocation(state.graphZoomId))
    state.graphZoomId = null;
  clearGraphBlockSelection();
  pushVimSnapshot(vimUndoStack, snapshot);
  vimRedoStack.length = 0;
  graphViewDependencies.graphChanged();
  renderGraphPage();
  outliner.focus({ preventScroll: true });
  toast(`Deleted ${count} block${count === 1 ? "" : "s"}`);
  return true;
}

export function commitGraphBlock() {
  if (!session.activeGraphBlock) return;
  const { block, field, page } = session.activeGraphBlock;
  if (state.vimEnabled && state.vimMode === "insert")
    finishVimInsertChange(field);
  session.activeGraphBlock = null;
  mobileBlockToolbar.hidden = true;
  if (state.vimEnabled) {
    state.vimMode = "normal";
    session.vimPending = "";
    session.vimDesiredColumn = null;
    updateVimUi();
  }
  hideGraphAutocomplete();
  const recordingThisBlock =
    voiceRecording?.target?.block === block ||
    voiceRecordingStartingTarget?.block === block;
  if (block.transient && !field.value && !recordingThisBlock) {
    const location = graphBlockLocation(block.id);
    if (location) location.blocks.splice(location.index, 1);
    renderGraphPage();
    return;
  }
  if (field.isConnected) {
    const content = graphContentElement(block, page);
    field
      .closest(".block-row")
      ?.classList.toggle(
        "audio-embed-row",
        content.classList.contains("audio-block-content"),
      );
    field.replaceWith(content);
  }
}

export function activateGraphBlock(block, position = null, page = state.graphPage) {
  if (!block || state.sourceMode) return;
  const today = Graph.journalInfo(new Date(), session.graphStore?.config).date;
  if (
    state.journalMode &&
    page?.path === state.graphPage?.path &&
    page.journalDate === today &&
    journalDocumentIsEmpty(state.graphDocument) &&
    !state.onThisDayEmptyDismissed
  ) {
    state.onThisDayEmptyDismissed = true;
    state.onThisDayExpanded = false;
    const entry = blockTree.querySelector(".journal-entry.today");
    const featured = entry?.querySelector(".on-this-day-featured");
    const history = onThisDayElement();
    if (featured && history) {
      entry.append(history);
      featured.remove();
    } else featured?.remove();
  }
  clearGraphBlockSelection();
  if (session.activeGraphBlock?.block === block)
    return session.activeGraphBlock.field.focus();
  commitGraphBlock();
  const content = $$(".graph-block-content", blockTree).find(
    (element) =>
      element.dataset.blockId === block.id &&
      element.dataset.pagePath === (page?.path || ""),
  );
  if (!content) return;
  const field = document.createElement("textarea");
  field.className = "graph-block-editor";
  field.spellcheck = true;
  field.value = block.content;
  if (field.value.split("\n").some((line) => fenceOpening(line)))
    field.classList.add("graph-code-editor");
  else if (
    field.value &&
    (field.value.split("\n").every((line) => /^\s*>/.test(line)) ||
      field.value.split("\n").some(orgQuoteOpening))
  )
    field.classList.add("graph-quote-editor");
  field.dataset.blockId = block.id;
  field.addEventListener("beforeinput", (event) => {
    if (handleGraphBlockBeforeInput(event)) return;
    if (!state.vimEnabled && /^(insert|delete)/.test(event.inputType || ""))
      recordVimChange(field);
    else if (
      usesMobileInput() &&
      /^(insert|delete)/.test(event.inputType || "")
    )
      recordVimChange(field);
  });
  field.addEventListener("input", handleGraphBlockInput);
  field.addEventListener("keydown", handleGraphBlockKeydown);
  field.addEventListener("keyup", (event) => {
    if (event.key === "Shift") delete field.dataset.physicalShiftKey;
    if (event.key.length === 1 || ["Backspace", "Delete"].includes(event.key))
      showGraphAutocomplete(field);
  });
  field.addEventListener("compositionend", () =>
    showGraphAutocomplete(field),
  );
  field.addEventListener("blur", () =>
    setTimeout(() => {
      if (
        session.activeGraphBlock?.field === field &&
        $("#commandPalette").hidden &&
        !graphAutocomplete.contains(document.activeElement) &&
        !journalCalendar.contains(document.activeElement) &&
        !mobileBlockToolbar.contains(document.activeElement) &&
        !voiceRecorderPanel.contains(document.activeElement)
      )
        commitGraphBlock();
    }),
  );
  field.dataset.pagePath = page?.path || "";
  content.replaceWith(field);
  session.activeGraphBlock = { block, field, page };
  mobileBlockToolbar.hidden = false;
  updateMobileToolbarPosition();
  resizeGraphEditor(field);
  keepActiveMobileBlockVisible();
  const caret =
    position === null
      ? field.value.length
      : Math.max(0, Math.min(position, field.value.length));
  field.focus({ preventScroll: true });
  field.setSelectionRange(caret, caret);
  if (state.vimEnabled) setVimMode(state.vimMode, field, caret);
}

export function focusGraphBlock(id, position = null) {
  renderGraphPage();
  const focus = () => {
    const location = graphBlockLocation(id);
    if (!location) return false;
    activateGraphBlock(location.block, position);
    const field =
      session.activeGraphBlock?.block?.id === id ? session.activeGraphBlock.field : null;
    if (!field) return false;
    const caret =
      position === null
        ? field.value.length
        : Math.max(0, Math.min(position, field.value.length));
    field.focus({ preventScroll: true });
    if (state.vimEnabled && state.vimMode === "normal")
      showVimCursor(field, caret);
    else field.setSelectionRange(caret, caret);
    return true;
  };
  focus();
  requestAnimationFrame(() => {
    if (document.activeElement !== session.activeGraphBlock?.field) focus();
    session.activeGraphBlock?.field.scrollIntoView({ block: "nearest" });
  });
}

