/**
 * Cross-feature constants and small browser helpers for routes, shortcuts, persisted settings,
 * mobile viewport behavior, lightweight dependency validation, and shared overlay positioning.
 */

import {
  $$,
  blockContextMenu,
  mobileBlockToolbar,
  notnoteWrap,
  toastElement,
} from "./dom.js";
import { session } from "./state.js";



/** Validate a cycle-breaking callback contract once during application composition. */
export function requireFunctions(owner, dependencies, names) {
  const contract = {};
  for (const name of names) {
    const implementation = dependencies[name];
    if (typeof implementation !== "function")
      throw new TypeError(`${owner} dependency “${name}” must be a function`);
    contract[name] = implementation;
  }
  return Object.freeze(contract);
}

export const settingsTabFromPath = (path = location.pathname) => {
  if (/^\/docs\/?$/.test(path)) return "documentation";
  const match = path.match(/^\/settings(?:\/(general|shortcuts|git))?\/?$/);
  return match ? match[1] || "general" : null;
};
const settingsPaths = {
  general: "/settings",
  shortcuts: "/settings/shortcuts",
  git: "/settings/git",
  documentation: "/docs",
};
export const initialUrlParameters = new URLSearchParams(location.search);
const querySettingsTab =
  initialUrlParameters.get("documentation") === "1"
    ? "documentation"
    : initialUrlParameters.get("settings");
export const initialSettingsTab =
  settingsTabFromPath() ||
  (["general", "shortcuts", "git", "documentation"].includes(
    querySettingsTab,
  )
    ? querySettingsTab
    : null);
initialUrlParameters.delete("documentation");
initialUrlParameters.delete("settings");
export const settingsRouteUrl = (tab) =>
  `${settingsPaths[tab] || settingsPaths.general}${initialUrlParameters.size ? `?${initialUrlParameters}` : ""}`;
let mobileBlockScrollFrame = 0;
let mobileViewportHeight = Math.max(
  window.innerHeight,
  window.visualViewport?.height || 0,
);

// Keep transient messages inside the visual viewport and above the iOS keyboard toolbar.
export const positionToastInVisualViewport = () => {
  const viewport = window.visualViewport;
  if (!viewport) {
    toastElement.style.top = "";
    toastElement.style.bottom = "";
    return;
  }
  const viewportTop = viewport.offsetTop || 0;
  const viewportBottom = viewportTop + viewport.height;
  const toolbarBounds = mobileBlockToolbar.getBoundingClientRect();
  const toolbarVisible =
    !mobileBlockToolbar.hidden && toolbarBounds.height > 0;
  const bottomEdge = toolbarVisible
    ? Math.min(viewportBottom, toolbarBounds.top) - 10
    : viewportBottom - 38;
  toastElement.style.top =
    `${Math.max(viewportTop + 12, bottomEdge - toastElement.offsetHeight)}px`;
  toastElement.style.bottom = "auto";
};
// Keep the active block above both the software keyboard and the mobile toolbar.
export const keepActiveMobileBlockVisible = () => {
  cancelAnimationFrame(mobileBlockScrollFrame);
  mobileBlockScrollFrame = requestAnimationFrame(() => {
    const field = session.activeGraphBlock?.field;
    if (
      !field?.isConnected ||
      !mobileBlockToolbar.classList.contains("keyboard-visible")
    )
      return;
    const viewport = window.visualViewport;
    const wrapBounds = notnoteWrap.getBoundingClientRect();
    const toolbarBounds = mobileBlockToolbar.getBoundingClientRect();
    const visibleTop = Math.max(
      wrapBounds.top,
      viewport?.offsetTop || 0,
    );
    const visibleBottom = Math.min(
      wrapBounds.bottom,
      (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight),
      toolbarBounds.top,
    );
    const bounds = field.getBoundingClientRect();
    // Leave a comfortable gap so the caret and the last line are not
    // visually touched by the toolbar border or its shadow.
    const padding = 32;
    let delta = 0;
    if (bounds.bottom > visibleBottom - padding)
      delta = bounds.bottom - visibleBottom + padding;
    else if (bounds.top < visibleTop + padding)
      delta = bounds.top - visibleTop - padding;
    if (Math.abs(delta) > 1)
      notnoteWrap.scrollTo({
        top: Math.max(0, notnoteWrap.scrollTop + delta),
        // Keyboard viewport changes can interrupt smooth scrolling and leave
        // a newly created final block underneath the mobile toolbar.
        behavior: "auto",
      });
  });
};
// VisualViewport coordinates are required because mobile keyboards do not resize every layout viewport.
export function resetMobileViewportHeight() {
  const viewport = window.visualViewport;
  mobileViewportHeight = Math.max(
    window.innerHeight,
    (viewport?.height || 0) + (viewport?.offsetTop || 0),
  );
  updateMobileToolbarPosition();
}

export const updateMobileToolbarPosition = () => {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const viewportBottom = viewport.height + viewport.offsetTop;
  const keyboardInset = Math.max(0, mobileViewportHeight - viewportBottom);
  // offsetTop can increase when iOS pans the visual viewport, making the
  // bottom-based inset look too small even while the keyboard is open.
  const keyboardSpace = Math.max(
    keyboardInset,
    mobileViewportHeight - viewport.height,
  );
  if (keyboardSpace < 80)
    mobileViewportHeight = Math.max(
      mobileViewportHeight,
      window.innerHeight,
      viewportBottom,
    );
  mobileBlockToolbar.classList.toggle(
    "keyboard-visible",
    keyboardSpace >= 80,
  );
  notnoteWrap.style.setProperty(
    "--mobile-keyboard-inset",
    `${keyboardSpace}px`,
  );
  const toolbarHeight = mobileBlockToolbar.getBoundingClientRect().height;
  if (toolbarHeight) {
    mobileBlockToolbar.style.top = `${viewportBottom - toolbarHeight}px`;
    mobileBlockToolbar.style.bottom = "auto";
  }
  positionToastInVisualViewport();
  keepActiveMobileBlockVisible();
};
export const STORAGE_KEY = "notnote-markdown-documents-v1";
export const SETTINGS_KEY = "notnote-markdown-settings-v1";
const BOOT_APPEARANCE_KEY = "notnote-bootstrap-appearance-v1";
export const TASK_COMPLETIONS_KEY = "notnote-task-completions-v1";
export const localSettings = () => {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
};
export const currentSettings = () => session.graphSettings || localSettings();
export const bootAppearance = () => {
  try {
    return JSON.parse(localStorage.getItem(BOOT_APPEARANCE_KEY)) || {};
  } catch {
    return {};
  }
};
export const rememberBootAppearance = (change) => {
  try {
    localStorage.setItem(
      BOOT_APPEARANCE_KEY,
      JSON.stringify({ ...bootAppearance(), ...change }),
    );
  } catch {}
};

// Shortcut definitions drive matching, settings UI, and command-palette labels.
export const shortcutDefinitions = [
  {
    id: "settings",
    section: "General",
    label: "Open settings",
    keys: "Mod+,",
  },
  {
    id: "documentation",
    section: "General",
    label: "Open documentation",
    keys: "Shift+/",
  },
  {
    id: "commands",
    section: "General",
    label: "Command palette",
    keys: "Mod+K",
  },
  {
    id: "commandsF1",
    section: "General",
    label: "Command palette (alternate)",
    keys: "F1",
  },
  {
    id: "commandsSearch",
    section: "General",
    label: "Command palette (alternate 2)",
    keys: "Mod+Shift+P",
  },
  { id: "rename", section: "General", label: "Rename document", keys: "F2" },
  { id: "save", section: "Documents", label: "Save", keys: "Mod+S" },
  { id: "open", section: "Documents", label: "Open file", keys: "Mod+O" },
  { id: "new", section: "Documents", label: "New document", keys: "Mod+N" },
  {
    id: "find",
    section: "Documents",
    label: "Find in document",
    keys: "Mod+F",
  },
  {
    id: "findNext",
    section: "Documents",
    label: "Next search occurrence",
    keys: "Mod+G",
  },
  {
    id: "findPrevious",
    section: "Documents",
    label: "Previous search occurrence",
    keys: "Mod+Shift+G",
  },
  {
    id: "source",
    section: "Documents",
    label: "Toggle Markdown source",
    keys: "Mod+/",
  },
  {
    id: "export",
    section: "Documents",
    label: "Export HTML",
    keys: "Mod+Shift+E",
  },
  {
    id: "today",
    section: "Navigation",
    label: "Today's journal",
    keys: "Mod+Shift+J",
  },
  {
    id: "journalPrevious",
    section: "Navigation",
    label: "Previous journal day",
    keys: "Mod+Shift+ArrowLeft",
  },
  {
    id: "journalNext",
    section: "Navigation",
    label: "Next journal day",
    keys: "Mod+Shift+ArrowRight",
  },
  {
    id: "tasks",
    section: "Navigation",
    label: "Task dashboard",
    keys: "Mod+Shift+K",
  },
  {
    id: "back",
    section: "Navigation",
    label: "Previous page",
    keys: "Alt+ArrowLeft",
  },
  {
    id: "forward",
    section: "Navigation",
    label: "Next page",
    keys: "Alt+ArrowRight",
  },
  { id: "bold", section: "Formatting", label: "Bold", keys: "Mod+B" },
  { id: "italic", section: "Formatting", label: "Italic", keys: "Mod+I" },
  { id: "code", section: "Formatting", label: "Inline code", keys: "Mod+`" },
  {
    id: "heading1",
    section: "Formatting",
    label: "Heading 1",
    keys: "Mod+1",
  },
  {
    id: "heading2",
    section: "Formatting",
    label: "Heading 2",
    keys: "Mod+2",
  },
  {
    id: "heading3",
    section: "Formatting",
    label: "Heading 3",
    keys: "Mod+3",
  },
  {
    id: "orderedList",
    section: "Formatting",
    label: "Numbered list",
    keys: "Mod+Shift+7",
  },
  {
    id: "bulletList",
    section: "Formatting",
    label: "Bulleted list",
    keys: "Mod+Shift+8",
  },
  {
    id: "blockCollapseAll",
    section: "Blocks",
    label: "Collapse or expand all blocks",
    keys: "Mod+Shift+L",
  },
  {
    id: "blockCopyRef",
    section: "Blocks",
    label: "Copy block reference",
    keys: "Mod+Alt+R",
  },
  {
    id: "blockCopy",
    section: "Blocks",
    label: "Copy block and children",
    keys: "Mod+Alt+C",
  },
  {
    id: "blockMakeTemplate",
    section: "Blocks",
    label: "Make block a template",
    keys: "Mod+Alt+T",
  },
  {
    id: "blockDeleteTree",
    section: "Blocks",
    label: "Delete block and children",
    keys: "Mod+Alt+Backspace",
  },
  {
    id: "blockIndent",
    section: "Blocks",
    label: "Indent block",
    keys: "Tab",
  },
  {
    id: "blockOutdent",
    section: "Blocks",
    label: "Outdent block",
    keys: "Shift+Tab",
  },
  {
    id: "blockUp",
    section: "Blocks",
    label: "Move block up",
    keys: "Alt+ArrowUp",
  },
  {
    id: "blockDown",
    section: "Blocks",
    label: "Move block down",
    keys: "Alt+ArrowDown",
  },
  {
    id: "taskCycle",
    section: "Blocks",
    label: "Cycle task state",
    keys: "Mod+Enter",
  },
  {
    id: "blockNew",
    section: "Blocks",
    label: "Create next block",
    keys: "Enter",
  },
  {
    id: "blockLine",
    section: "Blocks",
    label: "Line break in block",
    keys: "Shift+Enter",
  },
  {
    id: "blockDelete",
    section: "Blocks",
    label: "Delete empty or selected blocks",
    keys: "Backspace",
  },
  {
    id: "blockEscape",
    section: "Blocks",
    label: "Finish editing or clear selection",
    keys: "Escape",
  },
  { id: "undo", section: "Editing", label: "Undo", keys: "Mod+Z" },
  { id: "redo", section: "Editing", label: "Redo", keys: "Mod+Shift+Z" },
  {
    id: "redoAlt",
    section: "Editing",
    label: "Redo (alternate)",
    keys: "Mod+Y",
  },
];
const shortcutDefinition = (id) =>
  shortcutDefinitions.find((item) => item.id === id);
export const shortcutValue = (id) =>
  currentSettings().shortcuts?.[id] || shortcutDefinition(id)?.keys || "";
export function eventBinding(event) {
  if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return "";
  const modifiers = [];
  if (event.metaKey || event.ctrlKey) modifiers.push("Mod");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.altKey) modifiers.push("Alt");
  let key = event.key;
  const punctuation = {
    Slash: "/",
    Backquote: "`",
    Comma: ",",
    Period: ".",
    Semicolon: ";",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Minus: "-",
    Equal: "=",
  };
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  else if (/^Digit\d$/.test(event.code)) key = event.code.slice(5);
  else if (punctuation[event.code]) key = punctuation[event.code];
  else if (key.length === 1 && /[a-z]/i.test(key)) key = key.toUpperCase();
  else if (key === " ") key = "Space";
  return [...modifiers, key].join("+");
}
export const shortcutMatches = (id, event) =>
  eventBinding(event) === shortcutValue(id);
export const usesMobileInput = () =>
  matchMedia("(max-width:720px), (pointer:coarse)").matches;
export const shortcutLabel = (value) =>
  String(value || "")
    .replace("Shift+/", "?")
    .replace("Mod", "⌘/Ctrl")
    .replace(/Arrow/g, "");

export const vimUndoStack = [];
export const vimRedoStack = [];
export const taskUndoStack = [];
export const taskRedoStack = [];
export const WELCOME_VERSION = "11";

export const starter = `# Welcome to notnote

notnote is a minimal **Markdown** editor: everything stays in your browser or in the files you choose to open.

## Contextual editing

Select a block to view and edit its Markdown source. When you move to another block, the content is formatted again automatically. Use **Arrow Up/Down** at the text boundaries or **Alt + Arrow Up/Down** to move between blocks without a mouse.

## Quick commands

Use **⌘/Ctrl + K** or **⌘/Ctrl + Shift + P** to open the command palette. Inside a graph block, type **/** for inline commands such as journals and date references, or type **<** to insert a quote or source-code block. Type a command name, move with the arrow keys, and press Enter.

## Vim mode

Enable **Vim mode** from the command palette. In Normal mode, use \`h/j/k/l\`, \`w/b/e\`, \`0/$\`, and \`gg/G\` to move; \`Ctrl-D\` and \`Ctrl-U\` jump forward or backward across several blocks. Press \`i\`, \`a\`, \`I\`, \`A\`, \`o\`, or \`O\` to type, and \`Esc\` to return to Normal mode. You can also use \`x\`, \`dd\`, \`D\`, \`C\`, and \`r\` to edit text, \`u\` to undo, and \`Ctrl-R\` to redo.

## Essential syntax

- \`# Heading\`, \`## Subheading\`, \`### Section\`
- \`**bold**\` and \`*italic*\`
- \`\`inline code\`\` and \`~~strikethrough~~\`
- \`- item\`, \`1. item\`, and \`- [ ] task\`
- \`> quote\` and \`---\` for a divider
- \`[text](https://example.com)\` for a link
- Three backticks for a code block

> Tip: press Enter after a list item to create another one; press Enter on an empty item to end the list.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| ⌘/Ctrl + N | New document |
| ⌘/Ctrl + O | Open file |
| ⌘/Ctrl + S | Save |
| ⌘/Ctrl + Shift + E | Export HTML |
| ⌘/Ctrl + F | Find |
| ⌘/Ctrl + K, ⌘/Ctrl + Shift + P, or F1 | Open commands |
| F2 | Rename document |
| ⌘/Ctrl + / | Show full source |
| ⌘/Ctrl + B | Bold |
| ⌘/Ctrl + I | Italic |
| ⌘/Ctrl + 1, 2, 3 | Heading 1, 2, 3 |
| ⌘/Ctrl + Shift + 7 | Numbered list |
| ⌘/Ctrl + Shift + 8 | Bulleted list |
| Alt + Arrow Up/Down | Previous or next block |
| ⌘/Ctrl + Shift + Arrow Left/Right | Previous or next journal day |
| Ctrl + D / Ctrl + U (Vim) | Jump forward or backward several blocks |
| U / Ctrl + R (Vim) | Undo or redo a change |
| ⌘/Ctrl + Enter | Commit the block and move to the next one |
| Esc | Close commands or return to Normal mode in Vim |

## Files and privacy

Open, save, export, and reach recent documents or headings from the command palette. An automatic copy is stored locally; no text is sent to external servers.
`;

// Block context menu.
export function closeBlockContextMenu() {
  blockContextMenu.hidden = true;
  session.blockContextTarget = null;
}

export function openBlockContextMenu(context, event, trigger, focusMenu = true) {
  closeBlockContextMenu();
  session.blockContextTarget = context;
  $$('[data-block-context-shortcut]', blockContextMenu).forEach((label) => {
    label.textContent = shortcutLabel(
      shortcutValue(label.dataset.blockContextShortcut),
    );
  });
  blockContextMenu.hidden = false;
  const triggerBounds = trigger.getBoundingClientRect();
  const menuBounds = blockContextMenu.getBoundingClientRect();
  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft || 0;
  const viewportTop = viewport?.offsetTop || 0;
  const viewportRight = viewportLeft + (viewport?.width || window.innerWidth);
  const viewportBottom =
    viewportTop + (viewport?.height || window.innerHeight);
  const x = event.clientX || triggerBounds.right;
  const y = event.clientY || triggerBounds.bottom;
  blockContextMenu.style.left =
    `${Math.max(viewportLeft + 8, Math.min(x, viewportRight - menuBounds.width - 8))}px`;
  blockContextMenu.style.top =
    `${Math.max(viewportTop + 8, Math.min(y, viewportBottom - menuBounds.height - 8))}px`;
  if (focusMenu)
    blockContextMenu.querySelector("button")?.focus({ preventScroll: true });
}
