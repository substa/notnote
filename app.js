(() => {
  "use strict";

  // Keep DOM lookup helpers small because the application has no component framework.
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [
    ...root.querySelectorAll(selector),
  ];
  const app = $("#app");
  const editor = $("#editor");
  const sourceEditor = $("#sourceEditor");
  const notnoteWrap = $("#notnoteWrap");
  const outliner = $("#outliner");
  const blockTree = $("#blockTree");
  const pageHierarchy = $("#pageHierarchy");
  const references = $("#references");
  const graphAutocomplete = $("#graphAutocomplete");
  const mobileBlockToolbar = $("#mobileBlockToolbar");
  const voiceRecorderPanel = $("#voiceRecorder");
  const toastElement = $("#toast");
  const imageLightbox = $("#imageLightbox");
  const imageLightboxImage = $("#imageLightboxImage");
  let imageLightboxTrigger = null;
  let mobileViewportHeight = Math.max(
    window.innerHeight,
    window.visualViewport?.height || 0,
  );
  let mobileBlockScrollFrame = 0;
  // Keep transient messages inside the visual viewport and above the iOS keyboard toolbar.
  const positionToastInVisualViewport = () => {
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
  const keepActiveMobileBlockVisible = () => {
    cancelAnimationFrame(mobileBlockScrollFrame);
    mobileBlockScrollFrame = requestAnimationFrame(() => {
      const field = activeGraphBlock?.field;
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
      const padding = 12;
      let delta = 0;
      if (bounds.bottom > visibleBottom - padding)
        delta = bounds.bottom - visibleBottom + padding;
      else if (bounds.top < visibleTop + padding)
        delta = bounds.top - visibleTop - padding;
      if (Math.abs(delta) > 1)
        notnoteWrap.scrollTo({
          top: Math.max(0, notnoteWrap.scrollTop + delta),
          behavior: "smooth",
        });
    });
  };
  // VisualViewport coordinates are required because mobile keyboards do not resize every layout viewport.
  const updateMobileToolbarPosition = () => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const viewportBottom = viewport.height + viewport.offsetTop;
    const keyboardInset = Math.max(0, mobileViewportHeight - viewportBottom);
    if (keyboardInset < 80)
      mobileViewportHeight = Math.max(
        mobileViewportHeight,
        window.innerHeight,
        viewportBottom,
      );
    mobileBlockToolbar.classList.toggle(
      "keyboard-visible",
      keyboardInset >= 80,
    );
    const toolbarHeight = mobileBlockToolbar.getBoundingClientRect().height;
    if (toolbarHeight) {
      mobileBlockToolbar.style.top = `${viewportBottom - toolbarHeight}px`;
      mobileBlockToolbar.style.bottom = "auto";
    }
    positionToastInVisualViewport();
    keepActiveMobileBlockVisible();
  };
  const documentationView = $("#settingsView");
  const documentationContent = $("#documentationContent");
  const journalCalendar = $("#journalCalendar");
  const fileName = $("#fileName");
  const documentTitleActions = $("#documentTitleActions");
  const fileInput = $("#fileInput");
  const assetInput = $("#assetInput");
  const saveState = $("#saveState");
  const STORAGE_KEY = "notnote-markdown-documents-v1";
  const SETTINGS_KEY = "notnote-markdown-settings-v1";
  const BOOT_APPEARANCE_KEY = "notnote-bootstrap-appearance-v1";
  const TASK_COMPLETIONS_KEY = "notnote-task-completions-v1";
  const localSettings = () => {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch {
      return {};
    }
  };
  let graphSettings = null;
  let graphSettingsTimer = null;
  const currentSettings = () => graphSettings || localSettings();
  const bootAppearance = () => {
    try {
      return JSON.parse(localStorage.getItem(BOOT_APPEARANCE_KEY)) || {};
    } catch {
      return {};
    }
  };
  const rememberBootAppearance = (change) => {
    try {
      localStorage.setItem(
        BOOT_APPEARANCE_KEY,
        JSON.stringify({ ...bootAppearance(), ...change }),
      );
    } catch {}
  };

  // Centralize serializable view state; transient DOM and storage handles stay outside this object.
  let state = {
    markdown: "",
    fileHandle: null,
    dirty: false,
    sourceMode: false,
    vimEnabled: false,
    vimMode: "normal",
    currentId: null,
    pendingAction: null,
    saveTimer: null,
    graphMode: false,
    graphPage: null,
    graphDocument: null,
    graphZoomId: null,
    graphConflict: false,
    journalMode: false,
    journalLimit: 1,
    referencesExpanded: false,
    onThisDayExpanded: false,
    onThisDayEmptyDismissed: false,
    taskView: null,
    taskSummaryIds: [],
    taskCompletedTodayIds: [],
    taskCompletedDate: "",
    taskLimits: {},
    taskExpanded: {},
  };
  // Shortcut definitions drive matching, settings UI, and command-palette labels.
  const shortcutDefinitions = [
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
  const shortcutValue = (id) =>
    currentSettings().shortcuts?.[id] || shortcutDefinition(id)?.keys || "";
  function eventBinding(event) {
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
  const shortcutMatches = (id, event) =>
    eventBinding(event) === shortcutValue(id);
  const usesMobileInput = () =>
    matchMedia("(max-width:720px), (pointer:coarse)").matches;
  const shortcutLabel = (value) =>
    String(value || "")
      .replace("Shift+/", "?")
      .replace("Mod", "⌘/Ctrl")
      .replace(/Arrow/g, "");

  let journalDocuments = new Map();
  let graphHistory = [];
  let graphHistoryIndex = -1;
  let graphStore = null;
  let graphIndex = null;
  let paletteGraphStatsCache = null;
  let closeRemoteEvents = null;
  let remoteRefreshTimer = null;
  let remoteRefreshPending = false;
  let activeGraphBlock = null;
  let selectedGraphBlockIds = new Set();
  let graphSelectionAnchor = null;
  let graphSelectionPagePath = null;
  let graphDraftTimer = null;
  let activeSourceBlock = null;
  let paletteContext = null;
  let filteredCommands = [];
  let expandedCommandSections = new Set();
  let selectedCommand = 0;
  let titleEditOriginal = "";
  let titleActionPointerActive = false;
  let calendarViewDate = new Date();
  let calendarFocusDate = new Date();
  let calendarSelectAction = null;
  let vimPending = "";
  let vimDesiredColumn = null;
  let vimInsertSnapshot = null;
  const vimUndoStack = [];
  const vimRedoStack = [];
  const taskUndoStack = [];
  const taskRedoStack = [];
  const WELCOME_VERSION = "11";

  const starter = `# Welcome to notnote

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
| Ctrl + D / Ctrl + U (Vim) | Jump forward or backward several blocks |
| U / Ctrl + R (Vim) | Undo or redo a change |
| ⌘/Ctrl + Enter | Commit the block and move to the next one |
| Esc | Close commands or return to Normal mode in Vim |

## Files and privacy

Open, save, export, and reach recent documents or headings from the command palette. An automatic copy is stored locally; no text is sent to external servers.
`;

  function escapeHtml(value = "") {
    return value.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  function decodeHtmlEntities(value = "") {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = value;
    return textarea.value;
  }

  function safeUrl(url) {
    const decoded = url.trim().replace(/&amp;/g, "&");
    return /^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i.test(decoded) ||
      !/^[a-z][a-z0-9+.-]*:/i.test(decoded)
      ? escapeHtml(decoded)
      : "#";
  }

  function referenceExtension(url) {
    let decoded = String(url || "")
      .replace(/&amp;/g, "&")
      .split(/[?#]/)[0];
    try {
      decoded = decodeURIComponent(decoded);
    } catch {}
    return decoded.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "";
  }

  function isPdfReference(url) {
    return referenceExtension(url) === "pdf";
  }

  function mediaReferenceType(url) {
    const extension = referenceExtension(url);
    if (
      [
        "mp3",
        "wav",
        "ogg",
        "oga",
        "m4a",
        "aac",
        "flac",
        "opus",
        "weba",
      ].includes(
        extension,
      )
    )
      return "audio";
    if (["mp4", "webm", "ogv", "mov", "m4v"].includes(extension))
      return "video";
    return "";
  }

  function safeIframeEmbed(markup) {
    const template = document.createElement("template");
    template.innerHTML = markup;
    const iframe = template.content.firstElementChild;
    if (!iframe || iframe.tagName !== "IFRAME") return "";
    let source;
    try {
      source = new URL(iframe.getAttribute("src") || "");
    } catch {
      return "";
    }
    const host = source.hostname.toLowerCase();
    const trusted =
      host === "youtu.be" ||
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtube-nocookie.com" ||
      host.endsWith(".youtube-nocookie.com") ||
      host === "player.vimeo.com" ||
      host === "open.spotify.com" ||
      host === "w.soundcloud.com";
    if (source.protocol !== "https:" || !trusted) return "";
    const dimension = (name, fallback) =>
      /^\d{1,4}$|^100%$/.test(iframe.getAttribute(name) || "")
        ? iframe.getAttribute(name)
        : fallback;
    const title = iframe.getAttribute("title") || "Embedded media";
    const allow = iframe.getAttribute("allow");
    return `<iframe class="media-frame" width="${dimension("width", "560")}" height="${dimension("height", "315")}" src="${escapeHtml(source.href)}" title="${escapeHtml(title)}" loading="lazy" referrerpolicy="no-referrer"${allow ? ` allow="${escapeHtml(allow)}"` : ""}${iframe.hasAttribute("allowfullscreen") ? " allowfullscreen" : ""}></iframe>`;
  }

  const syntaxKeywords = {
    javascript: new Set(
      "as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch throw try typeof var void while with yield true false null undefined".split(
        " ",
      ),
    ),
    python: new Set(
      "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield".split(
        " ",
      ),
    ),
    shell: new Set(
      "case do done elif else esac fi for function if in select then time until while".split(
        " ",
      ),
    ),
    json: new Set("true false null".split(" ")),
    css: new Set(
      "@charset @font-face @import @keyframes @media @page @supports important".split(
        " ",
      ),
    ),
    sql: new Set(
      "all alter and as asc between by case create delete desc distinct drop else end exists from group having in inner insert into is join left like limit not null on or order outer right select set table then union update values when where".split(
        " ",
      ),
    ),
  };

  const syntaxBuiltins = {
    javascript: new Set(
      "Array Boolean console Date document Error JSON Map Math Number Object Promise RegExp Set String window".split(
        " ",
      ),
    ),
    python: new Set(
      "bool dict enumerate filter float int len list map max min open print range set str sum tuple zip".split(
        " ",
      ),
    ),
    shell: new Set(
      "alias cd echo env exec exit export printf pwd read set source test trap unset".split(
        " ",
      ),
    ),
    css: new Set(
      "background border color display flex font gap grid height margin padding position transform transition width".split(
        " ",
      ),
    ),
    sql: new Set("avg count max min sum".split(" ")),
  };

  function syntaxLanguage(language = "") {
    const name = language.toLowerCase().replace(/[^a-z0-9+#-]/g, "");
    if (["js", "jsx", "ts", "tsx", "node"].includes(name)) return "javascript";
    if (["py", "python3"].includes(name)) return "python";
    if (["sh", "bash", "zsh", "fish", "console", "terminal"].includes(name))
      return "shell";
    if (["html", "xml", "svg", "markup"].includes(name)) return "html";
    if (["yml", "yaml"].includes(name)) return "shell";
    return name || "plain";
  }

  function highlightCode(code, language = "") {
    const lang = syntaxLanguage(language);
    const pieces = [];
    let last = 0;
    const emitMatches = (pattern) => {
      for (const match of code.matchAll(pattern)) {
        pieces.push(escapeHtml(code.slice(last, match.index)));
        let type = "";
        const token = match[0];
        if (/^(?:\/\*|\/\/|#|--|<!--)/.test(token)) type = "comment";
        else if (lang === "html" && /^<\/?[A-Za-z]/.test(token)) type = "tag";
        else if (/^["'`]/.test(token)) type = "string";
        else if (/^(?:\d|\.\d)/.test(token)) type = "number";
        else if (
          syntaxKeywords[lang]?.has(token) ||
          syntaxKeywords[lang]?.has(token.toLowerCase())
        )
          type = "keyword";
        else if (
          syntaxBuiltins[lang]?.has(token) ||
          syntaxBuiltins[lang]?.has(token.toLowerCase())
        )
          type = "builtin";
        else if (/^[+*/%=!<>&|?:~^$@-]+$/.test(token)) type = "operator";
        pieces.push(
          type
            ? `<span class="syntax-${type}">${escapeHtml(token)}</span>`
            : escapeHtml(token),
        );
        last = match.index + token.length;
      }
      pieces.push(escapeHtml(code.slice(last)));
      return pieces.join("");
    };

    if (lang === "html")
      return emitMatches(/<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g);
    const comments = ["python", "shell"].includes(lang)
      ? "#.*$"
      : lang === "sql"
        ? "--.*$|\\/\\*[\\s\\S]*?\\*\\/"
        : lang === "json"
          ? "(?!)"
          : "\\/\\*[\\s\\S]*?\\*\\/|\\/\\/.*$";
    const pattern = new RegExp(
      `${comments}|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`|\\b(?:0x[\\da-f]+|\\d+(?:\\.\\d+)?)\\b|[A-Za-z_$@][\\w$@-]*|[+*/%=!<>&|?:~^$@-]+`,
      "gmi",
    );
    return emitMatches(pattern);
  }

  function highlightedCodeBlock(code, language = "") {
    const label = language.trim();
    const safeLanguage = syntaxLanguage(label);
    return `<pre${label ? ` data-lang="${escapeHtml(label)}"` : ""} class="graph-code-block"><code class="language-${safeLanguage}">${highlightCode(code, label)}</code></pre>`;
  }

  function highlightedGitDiff(diff = "") {
    return String(diff)
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => {
        let type = "context";
        if (/^\+\+\+|^---|^diff --git|^index\s/.test(line)) type = "metadata";
        else if (line.startsWith("+")) type = "addition";
        else if (line.startsWith("-")) type = "removal";
        else if (line.startsWith("@@")) type = "hunk";
        else if (/^\\ No newline/.test(line) || /diff truncated/.test(line))
          type = "notice";
        return `<span class="diff-line diff-line-${type}">${escapeHtml(line) || " "}</span>`;
      })
      .join("");
  }

  function fenceOpening(line = "") {
    const opening = line.match(/^\s*(`{3,}|~{3,})[^\S\n]*([^\s`]*)[^\n]*$/);
    if (!opening) return null;
    return { marker: opening[1], language: opening[2] || "" };
  }

  function fenceClosing(line, marker) {
    return new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(line);
  }

  function caretInsideFence(value, position) {
    let marker = null;
    for (const line of value.slice(0, position).split("\n")) {
      if (!marker) marker = fenceOpening(line)?.marker || null;
      else if (fenceClosing(line, marker)) marker = null;
    }
    return Boolean(marker);
  }

  function orgQuoteOpening(line = "") {
    return /^\s*#\+BEGIN_QUOTE\b.*$/i.test(line);
  }
  function orgQuoteClosing(line = "") {
    return /^\s*#\+END_QUOTE\s*$/i.test(line);
  }

  function inlineMarkdown(text) {
    const code = [];
    const links = [];
    const embeds = [];
    let raw = String(text).replace(
      /<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi,
      (markup) => {
        const iframe = safeIframeEmbed(markup);
        if (!iframe) return markup;
        embeds.push(iframe);
        return `\u0000EMBED${embeds.length - 1}\u0000`;
      },
    );
    let value = escapeHtml(raw);
    value = value.replace(/`([^`]+)`/g, (_, content) => {
      code.push(`<code>${content}</code>`);
      return `\u0000CODE${code.length - 1}\u0000`;
    });
    value = value.replace(
      /!\[([^\]]*)\]\(([^\s)]+)(?:\s+["']([^"']*)["'])?\)/g,
      (_, alt, url, title) => {
        const mediaType = mediaReferenceType(url);
        if (isPdfReference(url)) {
          links.push(
            `<a href="${safeUrl(url)}"${title ? ` title="${title}"` : ""} rel="noopener noreferrer" referrerpolicy="no-referrer">${alt || "PDF"}</a>`,
          );
        } else if (mediaType) {
          links.push(
            `<${mediaType} class="media-embed" src="${safeUrl(url)}" controls preload="metadata" data-embed-label="${alt}"${title ? ` title="${title}"` : ""}>${escapeHtml(alt || `Your browser does not support ${mediaType}.`)}</${mediaType}>`,
          );
        } else {
          links.push(
            `<span class="image-embed-wrap"><img class="image-embed" src="${safeUrl(url)}" alt="${alt}"${title ? ` title="${title}"` : ""} loading="lazy" decoding="async" referrerpolicy="no-referrer"><button class="image-expand-button" type="button" contenteditable="false" aria-label="Open image full screen" title="Open image full screen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5"/></svg></button></span>`,
          );
        }
        return `\u0000LINK${links.length - 1}\u0000`;
      },
    );
    value = value.replace(
      /\[([^\]]+)\]\(([^\s)]+)(?:\s+["']([^"']*)["'])?\)/g,
      (_, label, url, title) => {
        links.push(
          `<a href="${safeUrl(url)}"${title ? ` title="${title}"` : ""} rel="noopener noreferrer" referrerpolicy="no-referrer">${label}</a>`,
        );
        return `\u0000LINK${links.length - 1}\u0000`;
      },
    );
    value = value.replace(
      /\*\*\*([^*\n]+)\*\*\*|___([^_\n]+)___/g,
      "<strong><em>$1$2</em></strong>",
    );
    value = value.replace(
      /\*\*([^*\n]+)\*\*|__([^_\n]+)__/g,
      "<strong>$1$2</strong>",
    );
    value = value.replace(/~~([^~]+)~~/g, "<s>$1</s>");
    value = value.replace(
      /(^|[^*])\*([^*\n]+)\*|(^|[^_])_([^_\n]+)_/g,
      (_, a, b, c, d) => `${a ?? c ?? ""}<em>${b ?? d}</em>`,
    );
    value = value.replace(/ {2}$/g, "<br>");
    value = value.replace(
      /\u0000CODE(\d+)\u0000/g,
      (_, index) => code[Number(index)],
    );
    value = value.replace(
      /\u0000LINK(\d+)\u0000/g,
      (_, index) => links[Number(index)],
    );
    value = value.replace(
      /\u0000EMBED(\d+)\u0000/g,
      (_, index) => embeds[Number(index)],
    );
    return value;
  }

  function isBlockStart(lines, i) {
    const line = lines[i] || "";
    const next = lines[i + 1] || "";
    return (
      /^\s*(#{1,6})\s+/.test(line) ||
      /^\s*(```|~~~)/.test(line) ||
      orgQuoteOpening(line) ||
      /^\s*>/.test(line) ||
      /^\s*([-+*]|\d+\.)\s+/.test(line) ||
      /^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line) ||
      (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(next))
    );
  }

  function markdownToHtml(markdown) {
    const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
    const html = [];
    let i = 0;

    if (lines[0] === "---") {
      const end = lines.indexOf("---", 1);
      if (end > 0) {
        html.push(
          `<div class="frontmatter">${escapeHtml(lines.slice(1, end).join("\n"))}</div>`,
        );
        i = end + 1;
      }
    }

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }

      const fence = line.match(/^\s*(```|~~~)\s*([^\s]*)/);
      if (fence) {
        const marker = fence[1];
        const lang = fence[2] || "";
        const content = [];
        i++;
        while (i < lines.length && !new RegExp(`^\\s*${marker}`).test(lines[i]))
          content.push(lines[i++]);
        if (i < lines.length) i++;
        const safeLanguage = syntaxLanguage(lang);
        html.push(
          `<pre${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code class="language-${safeLanguage}">${highlightCode(content.join("\n"), lang)}</code></pre>`,
        );
        continue;
      }

      const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*$/);
      if (heading) {
        const level = heading[1].length;
        html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
        i++;
        continue;
      }

      if (/^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
        html.push("<hr>");
        i++;
        continue;
      }

      if (orgQuoteOpening(line)) {
        const quote = [];
        i++;
        while (i < lines.length && !orgQuoteClosing(lines[i]))
          quote.push(lines[i++]);
        if (i < lines.length) i++;
        html.push(
          `<blockquote>${markdownToHtml(quote.join("\n"))}</blockquote>`,
        );
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quote = [];
        while (
          i < lines.length &&
          (/^\s*>/.test(lines[i]) || !lines[i].trim())
        ) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        html.push(
          `<blockquote>${markdownToHtml(quote.join("\n"))}</blockquote>`,
        );
        continue;
      }

      const listMatch = line.match(/^\s*([-+*]|\d+\.)\s+(.+)/);
      if (listMatch) {
        const ordered = /\d+\./.test(listMatch[1]);
        const tag = ordered ? "ol" : "ul";
        const items = [];
        while (i < lines.length) {
          const match = lines[i].match(/^\s*([-+*]|\d+\.)\s+(.+)/);
          if (!match || /\d+\./.test(match[1]) !== ordered) break;
          let item = match[2];
          const task = item.match(/^\[([ xX])\]\s*(.*)/);
          if (task)
            item = `<input type="checkbox"${task[1].toLowerCase() === "x" ? " checked" : ""}>${inlineMarkdown(task[2])}`;
          else item = inlineMarkdown(item);
          items.push(
            `<li${task ? ' class="task-list-item"' : ""}>${item}</li>`,
          );
          i++;
        }
        html.push(`<${tag}>${items.join("")}</${tag}>`);
        continue;
      }

      if (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || "")) {
        const splitRow = (row) =>
          row
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((c) => c.trim());
        const heads = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim())
          rows.push(splitRow(lines[i++]));
        html.push(
          `<table><thead><tr>${heads.map((x) => `<th>${inlineMarkdown(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((x) => `<td>${inlineMarkdown(x)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
        );
        continue;
      }

      const paragraph = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i))
        paragraph.push(lines[i++]);
      html.push(
        `<p>${inlineMarkdown(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`,
      );
    }
    return html.join("\n");
  }

  function inlineToMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE)
      return node.nodeValue.replace(/\u00a0/g, " ");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const inner = [...node.childNodes].map(inlineToMarkdown).join("");
    switch (node.tagName) {
      case "STRONG":
      case "B":
        return `**${inner}**`;
      case "EM":
      case "I":
        return `*${inner}*`;
      case "S":
      case "STRIKE":
        return `~~${inner}~~`;
      case "CODE":
        return node.parentElement?.tagName === "PRE" ? inner : `\`${inner}\``;
      case "A":
        return `[${inner}](${node.getAttribute("href") || ""}${node.title ? ` "${node.title}"` : ""})`;
      case "IMG":
        return `![${node.alt || ""}](${node.getAttribute("src") || ""}${node.title ? ` "${node.title}"` : ""})`;
      case "AUDIO":
      case "VIDEO":
        return `![${node.dataset.embedLabel || ""}](${node.getAttribute("src") || ""}${node.title ? ` "${node.title}"` : ""})`;
      case "BUTTON":
        return "";
      case "IFRAME": {
        const attributes = [
          `width="${node.getAttribute("width") || "560"}"`,
          `height="${node.getAttribute("height") || "315"}"`,
          `src="${node.getAttribute("src") || ""}"`,
          `title="${node.title || "Embedded media"}"`,
        ];
        if (node.getAttribute("allow"))
          attributes.push(`allow="${node.getAttribute("allow")}"`);
        if (node.hasAttribute("allowfullscreen"))
          attributes.push("allowfullscreen");
        return `<iframe ${attributes.join(" ")}></iframe>`;
      }
      case "BR":
        return "  \n";
      default:
        return inner;
    }
  }

  function sourceBlockText(node) {
    const text =
      "value" in node ? node.value : (node.innerText ?? node.textContent);
    return text.replace(/\u00a0/g, " ").replace(/\n$/, "");
  }

  function editorToMarkdown(root = editor) {
    const blocks = [];
    const block = (node) => {
      if (node.nodeType === Node.TEXT_NODE)
        return node.nodeValue.trim() ? node.nodeValue : "";
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const tag = node.tagName;
      if (node.classList.contains("md-source-block"))
        return sourceBlockText(node);
      if (node.classList.contains("frontmatter"))
        return `---\n${node.textContent}\n---`;
      if (/^H[1-6]$/.test(tag))
        return `${"#".repeat(Number(tag[1]))} ${inlineToMarkdown(node)}`;
      if (tag === "P" || tag === "DIV") return inlineToMarkdown(node);
      if (tag === "HR") return "---";
      if (tag === "PRE")
        return `\`\`\`${node.dataset.lang || ""}\n${node.textContent.replace(/\n$/, "")}\n\`\`\``;
      if (tag === "BLOCKQUOTE")
        return editorToMarkdown(node)
          .split("\n")
          .map((x) => (x ? `> ${x}` : ">"))
          .join("\n");
      if (tag === "UL" || tag === "OL") {
        return [...node.children]
          .filter((x) => x.tagName === "LI")
          .map((li, index) => {
            const checkbox = $('input[type="checkbox"]', li);
            const clone = li.cloneNode(true);
            clone.querySelectorAll("ul,ol").forEach((x) => x.remove());
            clone.querySelectorAll("input").forEach((x) => x.remove());
            const prefix = tag === "OL" ? `${index + 1}.` : "-";
            return `${prefix} ${checkbox ? `[${checkbox.checked ? "x" : " "}] ` : ""}${inlineToMarkdown(clone).trim()}`;
          })
          .join("\n");
      }
      if (tag === "TABLE") {
        const rows = [...node.rows].map((row) =>
          [...row.cells].map((cell) =>
            inlineToMarkdown(cell).replace(/\|/g, "\\|").trim(),
          ),
        );
        if (!rows.length) return "";
        return `| ${rows[0].join(" | ")} |\n| ${rows[0].map(() => "---").join(" | ")} |${rows
          .slice(1)
          .map((row) => `\n| ${row.join(" | ")} |`)
          .join("")}`;
      }
      return inlineToMarkdown(node);
    };
    [...root.childNodes].forEach((node) => {
      const result = block(node);
      if (result !== "") blocks.push(result);
    });
    return blocks
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd();
  }

  function currentMarkdown() {
    if (state.graphMode)
      return state.sourceMode
        ? sourceEditor.value
        : NotnoteGraph.serializeDocument(state.graphDocument);
    return state.sourceMode ? sourceEditor.value : editorToMarkdown();
  }

  function graphBlockLocation(
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

  function visibleGraphBlocks(
    blocks = state.graphDocument?.blocks || [],
    result = [],
  ) {
    for (const block of blocks) {
      result.push(block);
      if (!block.collapsed) visibleGraphBlocks(block.children, result);
    }
    return result;
  }

  function restoreGraphCollapse(
    document = state.graphDocument,
    page = state.graphPage,
  ) {
    const settings = currentSettings();
    const collapsed = new Set(settings.graphCollapsed?.[page?.path] || []);
    NotnoteGraph.flattenBlocks(document?.blocks).forEach(({ block }) => {
      block.collapsed = collapsed.has(block.id);
    });
  }

  function saveGraphCollapse(
    document = state.graphDocument,
    page = state.graphPage,
  ) {
    if (!page) return;
    const settings = currentSettings();
    const ids = NotnoteGraph.flattenBlocks(document?.blocks)
      .filter(({ block }) => block.collapsed)
      .map(({ block }) => block.id);
    saveSettings({
      graphCollapsed: {
        ...(settings.graphCollapsed || {}),
        [page.path]: ids,
      },
    });
  }

  function toggleGraphBlockCollapse(
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

  function toggleAllGraphBlocks() {
    if (!state.graphMode || !state.graphDocument || !state.graphPage) return;
    if (state.sourceMode) return toast("Close Markdown source first");
    commitGraphBlock();
    const blocks = NotnoteGraph.flattenBlocks(state.graphDocument.blocks)
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
    const resolved = graphIndex?.resolveBlock(uuid);
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

  function resolveGraphContentAssets(content, page) {
    if (!graphStore || !page) return;
    const fromFolder = page.path?.includes("/")
      ? page.path.split("/").slice(0, -1).join("/")
      : page.folder || "";
    $$("img, audio, video", content).forEach((media) => {
      const source = media.getAttribute("src");
      if (source && !/^[a-z]+:/i.test(source))
        graphStore
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
      if (!NotnoteGraph.resolveAssetPath(source, fromFolder).startsWith("assets/"))
        return;
      link.dataset.graphAsset = source;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      graphStore
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

  function orderedJournalPages() {
    if (!graphStore) return [];
    const today = NotnoteGraph.journalInfo(new Date(), graphStore.config).date;
    return graphStore.pages
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

  function cachedJournalDocument(page) {
    if (page.path === state.graphPage?.path) return state.graphDocument;
    if (!journalDocuments.has(page.path)) {
      const document = NotnoteGraph.parseDocument(page.content);
      restoreGraphCollapse(document, page);
      journalDocuments.set(page.path, document);
    }
    return journalDocuments.get(page.path);
  }

  // Build task records from the graph index so every dashboard shares one source of truth.
  function graphTasks() {
    if (!graphIndex) return [];
    const tasks = [];
    let sequence = 0;
    for (const page of graphIndex.allPages()) {
      const document =
        page.path === state.graphPage?.path
          ? state.graphDocument
          : graphIndex.documents.get(page.path);
      for (const { block } of NotnoteGraph.flattenBlocks(document?.blocks)) {
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
            NotnoteGraph.propertiesFrom(block.content)["completed-at"] || "",
          sequence: sequence++,
        });
      }
    }
    return tasks;
  }

  function taskDate(days = 0) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + days);
    return NotnoteGraph.formatJournalDate(date, "yyyy-MM-dd");
  }

  function taskCompletedTodayIds() {
    const today = taskDate();
    if (state.taskCompletedDate === today)
      return state.taskCompletedTodayIds;
    state.taskCompletedDate = today;
    state.taskCompletedTodayIds = [];
    try {
      const saved = JSON.parse(
        localStorage.getItem(
          `${TASK_COMPLETIONS_KEY}:${graphStore?.name || "default"}`,
        ),
      );
      if (saved?.date === today && Array.isArray(saved.ids))
        state.taskCompletedTodayIds = saved.ids.filter(
          (id) => typeof id === "string",
        );
    } catch {}
    return state.taskCompletedTodayIds;
  }

  function saveTaskCompletedTodayIds() {
    try {
      localStorage.setItem(
        `${TASK_COMPLETIONS_KEY}:${graphStore?.name || "default"}`,
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
      NotnoteGraph.formatJournalDate(completed, "yyyy-MM-dd") === taskDate()
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

  function updateTaskCompletionMetadata(content, marker) {
    const withoutCompletion = content
      .replace(/^\s*completed-at::.*(?:\n|$)/gim, "")
      .trimEnd();
    return marker === "DONE"
      ? `${withoutCompletion}\ncompleted-at:: ${new Date().toISOString()}`
      : withoutCompletion;
  }

  const taskId = (task) => `${task.page.path}:${task.block.id}`;
  const taskPersistenceId = (task) =>
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

  function taskOverviewGroups(groups = taskGroups()) {
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

  function taskTextHtml(task) {
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

  function graphContextBlockElement(block, page, variant) {
    const node = document.createElement("div");
    node.className = `context-block-node${block.children.length ? " has-children collapsed" : ""}`;
    node.dataset.contextBlockId = block.id;
    const row = document.createElement("div");
    row.className = "context-block-row";
    if (block.children.length) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "context-block-toggle";
      toggle.dataset.contextBlockToggle = "";
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", "Expand nested blocks");
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
    const monthDay = NotnoteGraph.formatJournalDate(date, "MM-dd");
    const currentYear = date.getFullYear();
    return (graphStore?.pages || [])
      .filter((page) => {
        if (!page.journalDate || page.journalDate.slice(5) !== monthDay)
          return false;
        return Number(page.journalDate.slice(0, 4)) < currentYear;
      })
      .sort((a, b) => b.journalDate.localeCompare(a.journalDate));
  }

  function journalDocumentIsEmpty(document) {
    return !NotnoteGraph.flattenBlocks(document?.blocks || []).some(({ block }) =>
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

  function scrollOnThisDayIntoView() {
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

  async function openTasksPage() {
    if (!graphStore) await openGraph();
    if (!graphStore) return;
    let page = graphStore.pages.find(
      (item) => item.name.toLowerCase() === "tasks.md",
    );
    if (!page) {
      page = await graphStore.createPage("Task dashboard", {
        filename: "tasks",
        content:
          "title:: Tasks\n\n<!-- This file is rendered as the notnote task dashboard. -->\n",
      });
      page.title = "Tasks";
      graphIndex.rebuild(graphStore.pages);
    }
    state.taskLimits = {};
    state.taskExpanded = {};
    await loadGraphPage(page);
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
    return NotnoteGraph.flattenBlocks(document?.blocks || []).some(({ block }) =>
      String(block.content || "").trim(),
    );
  }

  function graphDocumentHasEmptyBlock(document) {
    return NotnoteGraph.flattenBlocks(document?.blocks || []).some(
      ({ block }) => !String(block.content || "").trim(),
    );
  }

  function syncGraphNewBlockElement(container, document, page) {
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

  // Rebuild the outliner from the graph model after structural mutations.
  function renderGraphPage() {
    if (!state.graphMode || !state.graphDocument) return;
    activeGraphBlock = null;
    mobileBlockToolbar.hidden = true;
    const renderBlocks = (blocks, page = state.graphPage) => {
      const fragment = document.createDocumentFragment();
      for (const block of blocks) {
        const node = document.createElement("div");
        const selected =
          graphSelectionPagePath === (page?.path || "") &&
          selectedGraphBlockIds.has(block.id);
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
      const today = NotnoteGraph.journalInfo(new Date(), graphStore.config).date;
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
    renderPageHierarchy();
    renderReferences();
  }

  function resizeGraphEditor(field) {
    field.style.height = "0";
    field.style.height = `${Math.max(32, field.scrollHeight)}px`;
  }

  function clearGraphBlockSelection() {
    selectedGraphBlockIds.clear();
    graphSelectionAnchor = null;
    graphSelectionPagePath = null;
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

  function selectGraphBlocksWithMouse(node, event) {
    const pagePath = node?.dataset.pagePath;
    if (!node || !pagePath || pagePath !== state.graphPage?.path) return false;
    commitGraphBlock();
    const nodes = graphSelectionNodes(pagePath);
    const id = node.dataset.blockId;
    if (
      event.shiftKey &&
      graphSelectionAnchor &&
      graphSelectionPagePath === pagePath
    ) {
      const anchorIndex = nodes.findIndex(
        (item) => item.dataset.blockId === graphSelectionAnchor,
      );
      const targetIndex = nodes.indexOf(node);
      if (!event.metaKey && !event.ctrlKey) selectedGraphBlockIds.clear();
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [start, end] = [anchorIndex, targetIndex].sort((a, b) => a - b);
        nodes
          .slice(start, end + 1)
          .forEach((item) => selectedGraphBlockIds.add(item.dataset.blockId));
      } else selectedGraphBlockIds.add(id);
    } else if (event.metaKey || event.ctrlKey) {
      if (selectedGraphBlockIds.has(id)) selectedGraphBlockIds.delete(id);
      else selectedGraphBlockIds.add(id);
      graphSelectionAnchor = id;
    } else {
      selectedGraphBlockIds.clear();
      selectedGraphBlockIds.add(id);
      graphSelectionAnchor = id;
    }
    graphSelectionPagePath = selectedGraphBlockIds.size ? pagePath : null;
    if (!selectedGraphBlockIds.size) graphSelectionAnchor = null;
    nodes.forEach((item) =>
      item.classList.toggle(
        "block-selected",
        selectedGraphBlockIds.has(item.dataset.blockId),
      ),
    );
    outliner.focus({ preventScroll: true });
    return true;
  }

  function deleteSelectedGraphBlocks() {
    if (
      !selectedGraphBlockIds.size ||
      graphSelectionPagePath !== state.graphPage?.path
    )
      return false;
    commitGraphBlock();
    const snapshot = captureVimSnapshot();
    const selected = new Set(selectedGraphBlockIds);
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
        id: NotnoteGraph.newId(),
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
    graphChanged();
    renderGraphPage();
    outliner.focus({ preventScroll: true });
    toast(`Deleted ${count} block${count === 1 ? "" : "s"}`);
    return true;
  }

  function commitGraphBlock() {
    if (!activeGraphBlock) return;
    const { block, field, page } = activeGraphBlock;
    if (state.vimEnabled && state.vimMode === "insert")
      finishVimInsertChange(field);
    activeGraphBlock = null;
    mobileBlockToolbar.hidden = true;
    if (state.vimEnabled) {
      state.vimMode = "normal";
      vimPending = "";
      vimDesiredColumn = null;
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

  function activateGraphBlock(block, position = null, page = state.graphPage) {
    if (!block || state.sourceMode) return;
    const today = NotnoteGraph.journalInfo(new Date(), graphStore?.config).date;
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
    if (activeGraphBlock?.block === block)
      return activeGraphBlock.field.focus();
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
          activeGraphBlock?.field === field &&
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
    activeGraphBlock = { block, field, page };
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

  function focusGraphBlock(id, position = null) {
    renderGraphPage();
    const focus = () => {
      const location = graphBlockLocation(id);
      if (!location) return false;
      activateGraphBlock(location.block, position);
      const field =
        activeGraphBlock?.block?.id === id ? activeGraphBlock.field : null;
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
      if (document.activeElement !== activeGraphBlock?.field) focus();
      activeGraphBlock?.field.scrollIntoView({ block: "nearest" });
    });
  }

  let graphIndexTimer = null;
  function updateGraphIndex() {
    if (!graphIndex || !state.graphPage) return;
    if (!state.graphPage.virtual)
      graphIndex.updatePage(state.graphPage, currentMarkdown());
    renderReferences();
  }

  function graphStatusLabel(fallback = "Ready") {
    const offline = Boolean(graphStore?.isRemote && graphStore.offline);
    app.classList.toggle("offline-mode", offline);
    if (!offline) return fallback;
    const pending = graphStore.pendingCount || 0;
    return pending ? `Offline · ${pending} pending` : "Offline";
  }

  function graphChanged() {
    if (!state.graphMode || !state.graphPage) return;
    state.dirty = true;
    saveState.textContent = state.graphConflict ? "Conflict" : "Modified";
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => flushGraphSave(false), 650);
    clearTimeout(graphDraftTimer);
    graphDraftTimer = setTimeout(() => {
      NotnoteGraph.saveDraft(state.graphPage.path, {
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
  async function flushGraphSave(interactive = false, force = false) {
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
    clearTimeout(graphDraftTimer);
    if (page.virtual) {
      saveState.textContent = "Creating page…";
      try {
        const created = await graphStore.createPage(page.title, { content });
        state.graphPage = created;
        graphIndex.rebuild(graphStore.pages);
        await NotnoteGraph.removeDraft(page.path).catch(() => {});
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
    await NotnoteGraph.saveDraft(page.path, {
      content,
      modified: page.lastModified,
    }).catch(() => {});
    saveState.textContent = "Saving…";
    graphSaving = (async () => {
      try {
        try {
          await graphStore.writePage(page, content, { force });
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
          await graphStore.writePage(page, content, { force: true });
        }
        graphIndex.updatePage(page, content);
        await NotnoteGraph.removeDraft(page.path).catch(() => {});
        if (state.graphPage === page && currentMarkdown() === content) {
          state.dirty = false;
          app.classList.remove("dirty");
          saveState.textContent = graphStatusLabel("Saved");
        }
        state.graphConflict = false;
        if (remoteRefreshPending) scheduleRemoteRefresh();
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

  function updateCurrentHistoryPosition() {
    const entry = graphHistory[graphHistoryIndex];
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
    const current = graphHistory[graphHistoryIndex];
    if (
      current &&
      current.path === entry.path &&
      current.journalMode === entry.journalMode &&
      current.blockId === entry.blockId
    )
      return;
    graphHistory = graphHistory.slice(0, graphHistoryIndex + 1);
    graphHistory.push(entry);
    graphHistoryIndex = graphHistory.length - 1;
  }

  function rememberGraphPage(page) {
    const settings = currentSettings();
    const item = {
      graph: graphStore?.name || "",
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

  function graphRoutePath(page) {
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

  function graphRoute() {
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

  function syncGraphRoute(page, options = {}) {
    if (!page || options.routeNavigation) return;
    const path = graphRoutePath(page);
    if (location.pathname === path && !location.hash) return;
    const method =
      options.replaceRoute || options.historyNavigation
        ? "replaceState"
        : "pushState";
    history[method]({ notnotePage: page.path }, "", `${path}${location.search}`);
  }

  function pageFromGraphRoute(route) {
    if (!route) return null;
    if (route.path)
      return graphStore?.pages.find((page) => page.path === route.path);
    return (
      graphStore?.pages.find((page) => {
        try {
          return decodeURIComponent(graphRoutePath(page)) === route.cleanPath;
        } catch {
          return false;
        }
      }) || null
    );
  }

  async function openGraphLanding(options = {}) {
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

  async function navigateGraphHistory(direction) {
    if (!state.graphMode) return;
    updateCurrentHistoryPosition();
    const targetIndex = graphHistoryIndex + direction;
    const entry = graphHistory[targetIndex];
    if (!entry)
      return toast(direction < 0 ? "No previous page" : "No next page");
    const page =
      graphStore.pages.find((item) => item.path === entry.path) ||
      graphIndex.resolvePage(entry.title);
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
    graphHistoryIndex = targetIndex;
    requestAnimationFrame(() => {
      notnoteWrap.scrollTop = entry.scrollTop || 0;
    });
  }

  // Page loading is the navigation boundary: save current work, update history, then render.
  async function loadGraphPage(pageOrTitle, options = {}) {
    if (!graphStore || !graphIndex) return;
    if (voiceRecording?.finishing)
      return toast("Wait for the voice note to finish saving");
    if (voiceRecording) finishVoiceRecording(false);
    if (state.graphMode && state.dirty && !(await flushGraphSave(true))) return;
    if (state.journalMode && state.graphPage && state.graphDocument)
      journalDocuments.set(state.graphPage.path, state.graphDocument);
    let page =
      typeof pageOrTitle === "string"
        ? graphIndex.resolvePage(pageOrTitle)
        : pageOrTitle;
    if (!page && typeof pageOrTitle === "string" && options.virtual) {
      const title = pageOrTitle.trim();
      page = {
        title,
        name: "",
        path: `virtual:${NotnoteGraph.normalizePage(title)}`,
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
      page = await graphStore.createPage(pageOrTitle, options);
      graphIndex.rebuild(graphStore.pages);
    }
    if (!page) return toast("Page not found");
    const draft = await NotnoteGraph.getDraft(page.path).catch(() => null);
    const content = draft?.content ?? page.content;
    const draftConflict = Boolean(
      draft?.modified && draft.modified !== page.lastModified,
    );
    recordGraphHistory(page, options);
    state.graphMode = true;
    state.graphPage = page;
    state.graphDocument = NotnoteGraph.parseDocument(content);
    restoreGraphCollapse();
    state.journalMode = Boolean(options.journalMode);
    state.journalLimit = options.resetJournalLimit ? 1 : state.journalLimit;
    state.referencesExpanded = false;
    state.onThisDayExpanded = false;
    state.onThisDayEmptyDismissed = false;
    state.taskView = page.name.toLowerCase() === "tasks.md" ? "all" : null;
    if (state.journalMode) journalDocuments.set(page.path, state.graphDocument);
    state.graphZoomId = options.blockId || null;
    state.sourceMode = false;
    state.dirty = Boolean(draft);
    state.graphConflict = draftConflict;
    state.fileHandle = null;
    activeSourceBlock = null;
    activeGraphBlock = null;
    clearGraphBlockSelection();
    vimUndoStack.length = 0;
    vimRedoStack.length = 0;
    vimInsertSnapshot = null;
    state.vimMode = "normal";
    editor.hidden = true;
    sourceEditor.hidden = true;
    outliner.hidden = false;
    app.classList.add("graph-mode");
    app.classList.toggle("journal-mode", state.journalMode);
    app.classList.toggle("dirty", Boolean(draft));
    updateVimUi();
    finishTitleEdit();
    fileName.value = page.title;
    fileName.readOnly = Boolean(page.journal);
    document.title = `${page.title} — ${graphStore.name} — notnote`;
    rememberGraphPage(page);
    syncGraphRoute(page, options);
    renderGraphPage();
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

  function closeAssetCleanupDialog(confirmed = false) {
    const dialog = $("#assetCleanupDialog");
    if (dialog.hidden) return;
    dialog.hidden = true;
    $("#assetCleanupList").value = "";
    const resolve = assetCleanupResolve;
    assetCleanupResolve = null;
    resolve?.(confirmed);
  }

  async function cleanOrphanedAssets() {
    if (!graphStore) return toast("Open a graph first");
    try {
      saveState.textContent = "Checking assets…";
      const pages = await graphStore.scan();
      graphIndex = new NotnoteGraph.GraphIndex(pages);
      // Search one corpus instead of comparing every asset with every page separately.
      const corpus = NotnoteGraph.assetReferenceCorpus(
        pages.map((page) => String(page.content || "")).join("\n"),
      );
      const assets = await graphStore.listAssets();
      const referenced = NotnoteGraph.referencedAssetPaths(corpus, assets);
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
      const latestPages = await graphStore.scan();
      graphIndex = new NotnoteGraph.GraphIndex(latestPages);
      const latestCorpus = NotnoteGraph.assetReferenceCorpus(
        latestPages.map((page) => String(page.content || "")).join("\n"),
      );
      const existingAssets = await graphStore.listAssets();
      const latestReferenced = NotnoteGraph.referencedAssetPaths(
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
      const result = await graphStore.removeAssets(
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
  async function cleanEmptyPages() {
    if (!graphStore) return toast("Open a graph first");
    if (graphStore.isRemote && graphStore.offline)
      return toast("Cleaning empty pages requires a connection");
    try {
      commitGraphBlock();
      if (!(await flushGraphSave(true))) return;
      saveState.textContent = "Checking empty pages…";
      const pages = await graphStore.scan();
      const freshIndex = new NotnoteGraph.GraphIndex(pages);
      const candidates = pages.filter((page) => {
        if (page.journal || page.virtual) return false;
        return (
          NotnoteGraph.isEmptyPageContent(page.content) &&
          !freshIndex.referencesToPage(page.title).length
        );
      });
      if (!candidates.length) {
        graphIndex = freshIndex;
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
        candidates.map((page) => graphStore.deletePage(page)),
      );
      const failed = results.filter(
        (result) => result.status === "rejected",
      ).length;
      graphIndex = new NotnoteGraph.GraphIndex(graphStore.pages);
      journalDocuments.clear();
      updateStats();
      const currentWasDeleted =
        state.graphPage &&
        !graphStore.pages.some((page) => page.path === state.graphPage.path);
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

  async function syncGraphIndex() {
    if (!graphStore) return toast("Open a graph first");
    try {
      saveState.textContent = "Syncing graph…";
      const pages = await graphStore.scan();
      graphIndex = new NotnoteGraph.GraphIndex(pages);
      journalDocuments.clear();
      const current =
        state.graphPage &&
        pages.find((page) => page.path === state.graphPage.path);
      if (current) {
        state.graphPage = current;
        state.graphDocument = NotnoteGraph.parseDocument(current.content);
        restoreGraphCollapse();
        if (state.journalMode)
          journalDocuments.set(current.path, state.graphDocument);
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

  async function openGraph() {
    try {
      if (voiceRecording?.finishing)
        return toast("Wait for the voice note to finish saving");
      if (voiceRecording) finishVoiceRecording(false);
      if (state.graphMode && state.dirty && !(await flushGraphSave(true)))
        return;
      saveState.textContent = "Opening graph…";
      closeRemoteEvents?.();
      closeRemoteEvents = null;
      graphStore?.disposeAssets();
      graphStore = await NotnoteGraph.GraphStore.open();
      graphSettings = null;
      taskUndoStack.length = 0;
      taskRedoStack.length = 0;
      state.taskCompletedTodayIds = [];
      state.taskCompletedDate = "";
      await loadGraphSettings();
      const pages = await graphStore.scan();
      graphIndex = new NotnoteGraph.GraphIndex(pages);
      journalDocuments.clear();
      graphHistory = [];
      graphHistoryIndex = -1;
      await openGraphLanding();
      toast(`Opened ${graphStore.name}`);
    } catch (error) {
      if (error.name !== "AbortError")
        toast(error.message || "Could not open the graph");
    }
  }

  async function openJournalDate(date, options = {}) {
    if (!graphStore) return openGraph();
    const journal = NotnoteGraph.journalInfo(date, graphStore.config);
    let page =
      graphStore.pages.find((item) => item.journalDate === journal.date) ||
      graphIndex.resolvePage(journal.title);
    if (!page) {
      page = await graphStore.createPage(journal.title, {
        journal: true,
        journalDate: journal.value,
        filename: journal.filename,
      });
      graphIndex.rebuild(graphStore.pages);
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
      if (options.reset) notnoteWrap.scrollTop = 0;
      else entry?.scrollIntoView({ block: "start", behavior: "smooth" });
      if (state.vimEnabled) focusVimEditor();
    });
    return page;
  }

  function relativeJournalDate(days) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + days);
    return date;
  }

  async function openSingleJournalDate(date) {
    if (!graphStore) await openGraph();
    if (!graphStore) return;
    const journal = NotnoteGraph.journalInfo(date, graphStore.config);
    let page =
      graphStore.pages.find((item) => item.journalDate === journal.date) ||
      graphIndex.resolvePage(journal.title);
    if (!page) {
      page = await graphStore.createPage(journal.title, {
        journal: true,
        journalDate: journal.value,
        filename: journal.filename,
      });
      graphIndex.rebuild(graphStore.pages);
    }
    await loadGraphPage(page, { journalMode: false });
    notnoteWrap.scrollTop = 0;
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
    const today = NotnoteGraph.journalInfo(new Date(), graphStore?.config).date;
    const focused = NotnoteGraph.journalInfo(
      calendarFocusDate,
      graphStore?.config,
    ).date;
    const current = calendarSelectAction
      ? focused
      : state.graphPage?.journalDate;
    $("#calendarDays").innerHTML = Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const value = NotnoteGraph.journalInfo(date, graphStore?.config).date;
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

  function focusCalendarDate(date) {
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

  function moveCalendarMonth(months) {
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

  function taskUpdateFailed(error) {
    renderGraphPage();
    toast(error.message || "Could not update the task");
  }

  async function updateTaskFromClick(
    pagePath,
    blockId,
    action = "complete",
    options = {},
  ) {
    const page = graphStore?.pages.find((item) => item.path === pagePath);
    if (!page) return;
    const current = page.path === state.graphPage?.path;
    const document = current
      ? state.graphDocument
      : journalDocuments.get(page.path) ||
        graphIndex?.documents.get(page.path) ||
        NotnoteGraph.parseDocument(page.content);
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
      const content = NotnoteGraph.serializeDocument(document);
      try {
        await graphStore.writePage(page, content);
        graphIndex.updatePage(page, content);
        if (page.journal || journalDocuments.has(page.path))
          journalDocuments.set(page.path, document);
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
      NotnoteGraph.flattenBlocks(document.blocks).findIndex(
        (item) => item.block === block,
      ),
    );
    if (feedbackStarted)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 550 - (Date.now() - feedbackStarted))),
      );
    renderGraphPage();
  }

  async function updateScheduledDate(pagePath, blockId, date) {
    const page = graphStore?.pages.find((item) => item.path === pagePath);
    if (!page) return;
    const current = page.path === state.graphPage?.path;
    const document = current
      ? state.graphDocument
      : journalDocuments.get(page.path) ||
        NotnoteGraph.parseDocument(page.content);
    const block = graphBlockLocation(blockId, document?.blocks)?.block;
    if (!block) return;
    const value = NotnoteGraph.formatJournalDate(date, "yyyy-MM-dd EEE");
    block.content = block.content.replace(
      /^(\s*)(SCHEDULED|DEADLINE):\s*<[^>]+>\s*$/m,
      (_, space, type) => `${space}${type}: <${value}>`,
    );
    if (current) graphChanged();
    else {
      const content = NotnoteGraph.serializeDocument(document);
      await graphStore.writePage(page, content);
      graphIndex.updatePage(page, content);
      if (page.journal || journalDocuments.has(page.path))
        journalDocuments.set(page.path, document);
    }
    renderGraphPage();
  }

  function toggleJournalCalendar(
    selectAction = null,
    anchor = null,
    initialDate = null,
  ) {
    const opening = journalCalendar.hidden || selectAction;
    journalCalendar.hidden = !opening;
    $("#journalCalendarButton").setAttribute("aria-expanded", String(opening));
    if (opening) {
      calendarSelectAction = selectAction;
      calendarFocusDate = initialDate ? new Date(initialDate) : new Date();
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

  function closeJournalCalendar() {
    journalCalendar.hidden = true;
    journalCalendar.classList.remove("inline");
    journalCalendar.style.left = "";
    journalCalendar.style.top = "";
    calendarSelectAction = null;
    $("#journalCalendarButton").setAttribute("aria-expanded", "false");
  }

  async function openToday(reset = false, options = {}) {
    return openJournalDate(new Date(), { reset, ...options });
  }

  async function closeGraph() {
    if (voiceRecording?.finishing)
      return toast("Wait for the voice note to finish saving");
    if (voiceRecording) finishVoiceRecording(false);
    if (state.dirty && !(await flushGraphSave(true))) return;
    closeRemoteEvents?.();
    closeRemoteEvents = null;
    graphStore?.disposeAssets();
    state.graphMode = false;
    state.graphPage = null;
    state.graphDocument = null;
    state.graphZoomId = null;
    state.journalMode = false;
    state.taskView = null;
    state.taskCompletedTodayIds = [];
    state.taskCompletedDate = "";
    journalDocuments.clear();
    graphHistory = [];
    graphHistoryIndex = -1;
    taskUndoStack.length = 0;
    taskRedoStack.length = 0;
    outliner.hidden = true;
    app.classList.remove("graph-mode", "journal-mode", "task-view");
    const docs = getStoredDocs();
    if (docs.length)
      loadMarkdown(docs[0].markdown, docs[0].name, { id: docs[0].id });
    else loadMarkdown("", "Untitled");
  }

  function namespacePageTitle(page = state.graphPage) {
    if (!page) return "";
    if (String(page.title).includes("/")) return page.title;
    const filename = page.name || page.path?.split("/").at(-1) || "";
    const inferred = NotnoteGraph.pageTitle("", filename);
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

  function renderPageHierarchy() {
    if (
      !state.graphMode ||
      !graphIndex ||
      !state.graphPage ||
      state.journalMode
    ) {
      pageHierarchy.hidden = true;
      pageHierarchy.innerHTML = "";
      return;
    }
    const currentTitle = namespacePageTitle();
    const currentParts = currentTitle.split("/");
    const children = graphIndex
      .allPages()
      .map((page) => ({ page, title: namespacePageTitle(page) }))
      .filter((item) => {
        const parts = item.title.split("/");
        return (
          parts.length === currentParts.length + 1 &&
          NotnoteGraph.normalizePage(parts.slice(0, -1).join("/")) ===
            NotnoteGraph.normalizePage(currentTitle)
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

  function renderReferences(includeUnlinked = false) {
    if (
      !state.graphMode ||
      !graphIndex ||
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
      const configured = NotnoteGraph.parseJournalDate(
        String(page.title || ""),
        graphStore?.config?.pageTitleFormat,
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
      const properties = NotnoteGraph.propertiesFrom(page.content || "");
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
    const referenceSnippet = (item) =>
      graphContextBlockElement(item.block, item.page, "reference").outerHTML;
    const renderGroups = (items, limit = false) => {
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
          return `<div class="reference-group"><div class="reference-page-row"><button class="reference-page graph-page-ref" data-page="${escapeHtml(title)}">${escapeHtml(title)}</button><span class="reference-leader" aria-hidden="true"></span>${date ? `<time class="reference-date">${escapeHtml(date)}</time>` : ""}</div>${group.map((item) => `<div class="reference-result has-context-tree" role="button" tabindex="0" data-reference-page="${escapeHtml(title)}" data-reference-page-path="${escapeHtml(item.page.path)}" data-reference-block="${escapeHtml(item.block.id)}">${referenceSnippet(item)}</div>`).join("")}</div>`;
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
    const linked = graphIndex
      .referencesToPage(pageTitle)
      .filter(
        (item) => !aggregatePages.has(NotnoteGraph.normalizePage(item.page.title)),
      );
    const zoomedBlock = state.graphZoomId
      ? graphBlockLocation(state.graphZoomId)?.block
      : null;
    const blockUuid =
      zoomedBlock && NotnoteGraph.propertiesFrom(zoomedBlock.content).id;
    const blockLinked = blockUuid
      ? graphIndex.referencesToBlock(blockUuid)
      : [];
    const unlinked = includeUnlinked
      ? graphIndex.unlinkedReferences(pageTitle)
      : [];
    references.innerHTML = `<details${linked.length ? " open" : ""}><summary>Linked references · ${linked.length}</summary>${renderGroups(linked, !state.referencesExpanded)}</details>${blockUuid ? `<details${blockLinked.length ? " open" : ""}><summary>Block references · ${blockLinked.length}</summary>${renderGroups(blockLinked)}</details>` : ""}${includeUnlinked ? `<details${unlinked.length ? " open" : ""}><summary>Unlinked references · ${unlinked.length}</summary>${renderGroups(unlinked)}</details>` : '<button class="unlinked-button" data-show-unlinked>Find unlinked references</button>'}`;
    $$(".reference-result[data-reference-page-path]", references).forEach(
      (result) => {
        const page = graphStore.pages.find(
          (item) => item.path === result.dataset.referencePagePath,
        );
        resolveGraphContentAssets(result, page);
      },
    );
  }

  function graphMutationFocus(block, position = null) {
    if (block.transient && block.content) delete block.transient;
    graphChanged();
    focusGraphBlock(block.id, position);
  }

  function handleGraphBlockInput(event) {
    const field = event.currentTarget;
    const location = graphBlockLocation(field.dataset.blockId);
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
    activeGraphBlock.block = location.block;
    syncGraphNewBlockElement(
      field.closest(".journal-blocks") || blockTree,
      state.graphDocument,
      activeGraphBlock.page,
    );
    resizeGraphEditor(field);
    keepActiveMobileBlockVisible();
    graphChanged();
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
    notifyMarkdownField(field);
  }

  function handleSelectionDelimiter(event) {
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
      notifyMarkdownField(field);
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

  function handleWikiPair(event) {
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

  function moveGraphBlock(block, direction) {
    const location = graphBlockLocation(block.id);
    if (!location) return false;
    const target = location.index + direction;
    if (target < 0 || target >= location.blocks.length) return false;
    location.blocks.splice(location.index, 1);
    location.blocks.splice(target, 0, block);
    graphMutationFocus(block);
    return true;
  }

  function indentGraphBlock(block, outdent = false, focus = true) {
    const location = graphBlockLocation(block.id);
    if (!location) return false;
    if (!outdent) {
      const previous = location.blocks[location.index - 1];
      if (!previous) return false;
      location.blocks.splice(location.index, 1);
      previous.children.push(block);
      previous.collapsed = false;
    } else {
      if (!location.parent) return false;
      const parentLocation = graphBlockLocation(location.parent.id);
      if (!parentLocation) return false;
      location.blocks.splice(location.index, 1);
      parentLocation.blocks.splice(parentLocation.index + 1, 0, block);
    }
    if (focus) graphMutationFocus(block);
    else {
      graphChanged();
      renderGraphPage();
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

  function toggleGraphTask(block, focus = true, keepEmptyTaskSpace = false) {
    const before = block.content.match(
      /^(TODO|DOING|DONE|LATER|NOW|WAITING|CANCELED|CANCELLED)(?:\s+|$)/,
    )?.[1];
    block.content = cycledTaskContent(block.content);
    const after = block.content.match(/^(TODO|DOING|DONE)(?:\s+|$)/)?.[1];
    block.content = updateTaskCompletionMetadata(block.content, after);
    if (!before && keepEmptyTaskSpace && block.content === "TODO")
      block.content += " ";
    if (before && after)
      recordTaskHistory(
        state.graphPage?.path,
        block.id,
        before,
        after,
        NotnoteGraph.flattenBlocks(state.graphDocument?.blocks).findIndex(
          (item) => item.block === block,
        ),
      );
    if (focus) graphMutationFocus(block, block.content.length);
    else {
      graphChanged();
      renderGraphPage();
    }
  }

  async function createGraphBlockFromPlaceholder(pagePath) {
    const page =
      state.graphPage?.path === pagePath
        ? state.graphPage
        : graphStore?.pages.find((item) => item.path === pagePath);
    if (!page) return;
    if (page.path !== state.graphPage?.path) {
      if (state.dirty && !(await flushGraphSave(true))) return;
      await loadGraphPage(page, { journalMode: state.journalMode });
    }
    commitGraphBlock();
    const block = {
      id: NotnoteGraph.newId(),
      uuid: null,
      content: "",
      marker: "-",
      children: [],
      collapsed: false,
      transient: true,
    };
    state.graphDocument.blocks.push(block);
    focusGraphBlock(block.id, 0);
  }

  function createNextGraphBlock(block, content = "") {
    const location = graphBlockLocation(block.id);
    if (!location) return null;
    const next = {
      id: NotnoteGraph.newId(),
      uuid: null,
      content,
      marker: block.marker || "-",
      children: [],
      collapsed: false,
    };
    if (state.graphZoomId === block.id) {
      block.collapsed = false;
      block.children.unshift(next);
      saveGraphCollapse();
    } else location.blocks.splice(location.index + 1, 0, next);
    graphMutationFocus(next, 0);
    return next;
  }

  function createPreviousGraphBlock(block) {
    const location = graphBlockLocation(block.id);
    if (!location) return null;
    const previous = {
      id: NotnoteGraph.newId(),
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
    const location = graphBlockLocation(block.id);
    if (!location || block.content || visibleGraphBlocks().length <= 1)
      return false;
    const visible = visibleGraphBlocks();
    const position = visible.indexOf(block);
    const previous = visible[position - 1] || visible[position + 1];
    location.blocks.splice(location.index, 1, ...(block.children || []));
    graphChanged();
    if (previous) focusGraphBlock(previous.id);
    else renderGraphPage();
    return true;
  }

  function splitGraphBlock(
    field,
    block,
    start = field.selectionStart,
    end = field.selectionEnd,
  ) {
    if (caretInsideFence(field.value, start)) return false;
    if (start === 0 && end === 0) {
      createPreviousGraphBlock(block);
      return true;
    }
    block.content = field.value.slice(0, start);
    createNextGraphBlock(block, field.value.slice(end));
    return true;
  }

  function handleGraphBlockBeforeInput(event) {
    if (!usesMobileInput()) return false;
    const field = event.currentTarget;
    const block = graphBlockLocation(field.dataset.blockId)?.block;
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

  function handleGraphBlockKeydown(event) {
    const field = event.currentTarget;
    const location = graphBlockLocation(field.dataset.blockId);
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
      handleGraphAutocompleteKey(event.key);
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
      const visible = visibleGraphBlocks();
      const index = visible.indexOf(block);
      const target = visible[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (target) {
        event.preventDefault();
        focusGraphBlock(
          target.id,
          event.key === "ArrowUp" ? target.content.length : 0,
        );
      }
    }
    if (shortcutMatches("blockEscape", event)) {
      event.preventDefault();
      commitGraphBlock();
    }
  }

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
  ];
  function pageMatchRank(value, query) {
    const normalized = NotnoteGraph.normalizePage(value);
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
      ...(graphIndex?.aliasesForPage(page) || []).map((alias) =>
        pageMatchRank(alias, query),
      ),
    );
  }
  function blockAutocompleteResults(query) {
    if (!graphIndex) return [];
    const needle = NotnoteGraph.normalizePage(query);
    const results = [];
    for (const page of graphIndex.allPages()) {
      const current = page.path === state.graphPage?.path;
      const document = current
        ? state.graphDocument
        : graphIndex.documents.get(page.path);
      for (const { block } of NotnoteGraph.flattenBlocks(document?.blocks)) {
        if (current && block === activeGraphBlock?.block) continue;
        const content = block.content
          .replace(/^\s*[\w-]+::.*$/gm, "")
          .replace(/\[\[|\]\]|\(\(|\)\)/g, "")
          .trim();
        if (
          !content ||
          (needle && !NotnoteGraph.normalizePage(content).includes(needle))
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
  function showGraphAutocomplete(field) {
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
      autocompleteItems = slashCommands
        .filter((command) => command.title.startsWith(typedCommand))
        .map((command) => ({
          ...command,
          slash: true,
          remainder: remainder.join(" "),
        }));
    } else if (wikiMatch && graphIndex) {
      const title = wikiMatch[1].trim();
      if (title.length < 2) return hideGraphAutocomplete();
      const query = NotnoteGraph.normalizePage(title);
      const pages = graphIndex.pageSuggestions();
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
      const exactMatch = query && graphIndex.resolvePage(title);
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
          `<button type="button" data-autocomplete-index="${index}" class="${index === 0 ? "selected" : ""}">${item.create ? `<span class="autocomplete-create">Create page</span>` : item.slash || item.angleCommand ? `<span class="autocomplete-create">Command</span>` : item.blockAutocomplete ? `<span class="autocomplete-create">Block · ${escapeHtml(item.page.title)}</span>` : ""}${escapeHtml(item.title)}</button>`,
      )
      .join("");
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
  function hideGraphAutocomplete() {
    graphAutocomplete.hidden = true;
    autocompleteItems = [];
  }
  function renderAutocompleteSelection() {
    $$("[data-autocomplete-index]", graphAutocomplete).forEach((item, index) =>
      item.classList.toggle("selected", index === autocompleteIndex),
    );
  }
  function chooseGraphAutocomplete(index = autocompleteIndex) {
    const item = autocompleteItems[index];
    const field = activeGraphBlock?.field;
    const block = activeGraphBlock?.block;
    if (!item || !field || !block) return;
    const before = field.value.slice(0, field.selectionStart);
    if (item.blockAutocomplete) {
      const start = before.lastIndexOf("((");
      const end = field.selectionStart;
      let uuid = NotnoteGraph.propertiesFrom(item.block.content).id;
      if (!uuid) {
        uuid = NotnoteGraph.newId();
        item.block.uuid = uuid;
        item.block.content = `${item.block.content.replace(/\s+$/, "")}${item.block.content.trim() ? "\n" : ""}id:: ${uuid}`;
        if (item.page.path === state.graphPage?.path) graphChanged();
        else {
          const content = NotnoteGraph.serializeDocument(item.document);
          graphStore
            .writePage(item.page, content)
            .then(() => graphIndex.updatePage(item.page, content))
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
      if (item.taskStatus) {
        const replacement = `${item.taskStatus}${item.remainder ? ` ${item.remainder}` : " "}`;
        field.setRangeText(replacement, start, end, "end");
        field.dispatchEvent(new InputEvent("input", { bubbles: true }));
        hideGraphAutocomplete();
        field.focus();
      } else if (item.scheduled) {
        const anchor = graphAutocomplete.getBoundingClientRect();
        hideGraphAutocomplete();
        toggleJournalCalendar((date) => {
          const scheduled = `SCHEDULED: <${NotnoteGraph.formatJournalDate(date, "yyyy-MM-dd EEE")}>`;
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
        toggleJournalCalendar((date) => {
          const title = NotnoteGraph.journalInfo(date, graphStore?.config).title;
          const reference = `[[${title}]]`;
          if (field.isConnected) {
            field.setRangeText(reference, start, end, "end");
            field.dispatchEvent(new InputEvent("input", { bubbles: true }));
            field.focus();
          } else {
            block.content = `${block.content.slice(0, start)}${reference}${block.content.slice(end)}`;
            graphChanged();
            focusGraphBlock(block.id, start + reference.length);
          }
        }, anchor);
      } else {
        const date = relativeJournalDate(item.days);
        const title = NotnoteGraph.journalInfo(date, graphStore?.config).title;
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
      graphStore
        .createPage(item.title)
        .then(() => {
          graphIndex.rebuild(graphStore.pages);
          toast(`Page “${item.title}” created`);
        })
        .catch((error) => toast(error.message || "Could not create the page"));
  }
  function handleGraphAutocompleteKey(key) {
    if (key === "Escape") return hideGraphAutocomplete();
    if (key === "Enter" || key === "Tab")
      return chooseGraphAutocomplete(autocompleteIndex);
    autocompleteIndex =
      (autocompleteIndex +
        (key === "ArrowDown" ? 1 : -1) +
        autocompleteItems.length) %
      autocompleteItems.length;
    renderAutocompleteSelection();
  }

  let assetUploadTarget = null;
  function uploadGraphAsset(field, block, start, end) {
    if (!graphStore || !state.graphMode) return toast("Open a graph first");
    assetUploadTarget = { field, block, start, end };
    assetInput.click();
  }

  let voiceRecording = null;
  let voiceRecordingStarting = false;
  let voiceRecordingStartingTarget = null;

  function preferredVoiceMimeType() {
    if (typeof MediaRecorder === "undefined") return "";
    return [
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
    ].find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
  }

  function requestMicrophoneStream() {
    if (navigator.mediaDevices?.getUserMedia)
      return navigator.mediaDevices.getUserMedia({ audio: true });
    const legacy =
      navigator.getUserMedia ||
      navigator.webkitGetUserMedia ||
      navigator.mozGetUserMedia;
    if (!legacy) return null;
    return new Promise((resolve, reject) =>
      legacy.call(navigator, { audio: true }, resolve, reject),
    );
  }

  function wavBlob(chunks, sampleRate) {
    const samples = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    const text = (offset, value) => {
      for (let index = 0; index < value.length; index++)
        view.setUint8(offset + index, value.charCodeAt(index));
    };
    text(0, "RIFF");
    view.setUint32(4, 36 + samples * 2, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, samples * 2, true);
    let offset = 44;
    for (const chunk of chunks) {
      for (const value of chunk) {
        const sample = Math.max(-1, Math.min(1, value));
        view.setInt16(
          offset,
          sample < 0 ? sample * 0x8000 : sample * 0x7fff,
          true,
        );
        offset += 2;
      }
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  // Older iOS webviews expose microphone capture but not MediaRecorder.
  function createWavVoiceRecorder(stream, preparedContext = null) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass)
      throw new Error("Audio recording is not supported by this browser");
    const context = preparedContext || new AudioContextClass();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const silentOutput = context.createGain();
    silentOutput.gain.value = 0;
    const chunks = [];
    let state = "inactive";
    const recorder = new EventTarget();
    Object.defineProperties(recorder, {
      mimeType: { value: "audio/wav" },
      state: { get: () => state },
    });
    processor.onaudioprocess = (event) => {
      if (state !== "recording") return;
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    recorder.start = () => {
      state = "recording";
      context.resume();
      source.connect(processor);
      processor.connect(silentOutput);
      silentOutput.connect(context.destination);
    };
    recorder.stop = () => {
      if (state === "inactive") return;
      state = "inactive";
      processor.disconnect();
      source.disconnect();
      silentOutput.disconnect();
      const event = new Event("dataavailable");
      Object.defineProperty(event, "data", {
        value: wavBlob(chunks, context.sampleRate),
      });
      recorder.dispatchEvent(event);
      context.close();
      recorder.dispatchEvent(new Event("stop"));
    };
    return recorder;
  }

  function createVoiceRecorder(stream, preparedContext = null) {
    if (typeof MediaRecorder !== "undefined") {
      try {
        const mimeType = preferredVoiceMimeType();
        return mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
      } catch {}
    }
    return createWavVoiceRecorder(stream, preparedContext);
  }

  function voiceFileExtension(type) {
    if (/wav/i.test(type)) return "wav";
    if (/mp4/i.test(type)) return "m4a";
    if (/ogg/i.test(type)) return "ogg";
    if (/mpeg|mp3/i.test(type)) return "mp3";
    return "weba";
  }

  function setVoiceRecordingUi(recording, saving = false) {
    voiceRecorderPanel.hidden = !recording;
    const recordButton = $("[data-block-action=\"record\"]", mobileBlockToolbar);
    recordButton?.classList.toggle("recording", recording && !saving);
    if (recordButton) {
      recordButton.setAttribute(
        "aria-label",
        recording ? "Stop and embed voice note" : "Record voice note",
      );
      recordButton.title = recording
        ? "Stop and embed voice note"
        : "Record voice note";
    }
    if (!recording) return;
    $("strong", voiceRecorderPanel).textContent = saving
      ? "Saving voice note"
      : "Recording";
    $$("button", voiceRecorderPanel).forEach((button) => {
      button.disabled = saving;
    });
  }

  function updateVoiceRecordingTime(session) {
    if (voiceRecording !== session) return;
    const seconds = Math.floor((Date.now() - session.startedAt) / 1000);
    const minutes = Math.floor(seconds / 60);
    $("#voiceRecorderTime").textContent =
      `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function insertVoiceRecording(target, markdown) {
    if (target.field.isConnected) {
      target.field.setRangeText(markdown, target.start, target.end, "end");
      target.field.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText" }),
      );
      target.field.focus();
      return;
    }
    const location = graphBlockLocation(target.block.id);
    if (target.pagePath !== state.graphPage?.path || !location?.block)
      throw new Error("The source block changed while recording");
    const block = location.block;
    block.content =
      `${block.content.slice(0, target.start)}${markdown}${block.content.slice(target.end)}`;
    if (block.transient) delete block.transient;
    graphChanged();
    focusGraphBlock(block.id, target.start + markdown.length);
  }

  async function completeVoiceRecording(session) {
    if (session.completing) return;
    session.completing = true;
    clearInterval(session.timer);
    session.stream.getTracks().forEach((track) => track.stop());
    if (!session.save) {
      if (voiceRecording === session) voiceRecording = null;
      setVoiceRecordingUi(false);
      targetVoiceRecordingField(session)?.focus();
      return;
    }
    setVoiceRecordingUi(true, true);
    try {
      const type =
        session.recorder.mimeType || session.chunks[0]?.type || "audio/webm";
      const blob = new Blob(session.chunks, { type });
      if (!blob.size || (/wav/i.test(type) && blob.size <= 44))
        throw new Error("The recording is empty");
      const now = new Date();
      const stamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
        "-",
        String(now.getHours()).padStart(2, "0"),
        String(now.getMinutes()).padStart(2, "0"),
        String(now.getSeconds()).padStart(2, "0"),
      ].join("");
      const extension = voiceFileExtension(type);
      const file = new File([blob], `voice-note-${stamp}.${extension}`, { type });
      const path = await session.store.writeAsset(file);
      if (graphStore !== session.store)
        throw new Error("The graph changed while recording");
      const label = `Voice note ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      insertVoiceRecording(session.target, `![${label}](${path})`);
      toast("Voice note embedded");
    } catch (error) {
      toast(error.message || "Could not save the voice note");
    } finally {
      if (voiceRecording === session) voiceRecording = null;
      setVoiceRecordingUi(false);
    }
  }

  function targetVoiceRecordingField(session = voiceRecording) {
    return session?.target.field?.isConnected ? session.target.field : null;
  }

  async function startVoiceRecording(field, block, start, end) {
    if (!graphStore || !state.graphMode) return toast("Open a graph first");
    if (voiceRecording) return finishVoiceRecording(true);
    if (voiceRecordingStarting) return;
    const streamRequest = requestMicrophoneStream();
    if (!streamRequest)
      return toast(
        window.isSecureContext
          ? "Microphone capture is not available in this browser"
          : "Microphone access requires HTTPS",
      );
    voiceRecordingStarting = true;
    const store = graphStore;
    const pagePath = state.graphPage?.path;
    const target = { field, block, start, end, pagePath };
    voiceRecordingStartingTarget = target;
    let stream = null;
    let preparedContext = null;
    try {
      if (typeof MediaRecorder === "undefined") {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          preparedContext = new AudioContextClass();
          preparedContext.resume();
        }
      }
      stream = await streamRequest;
      if (graphStore !== store || state.graphPage?.path !== pagePath)
        throw new Error("The source page changed before recording started");
      const recorder = createVoiceRecorder(stream, preparedContext);
      const session = {
        recorder,
        stream,
        store,
        target,
        chunks: [],
        startedAt: Date.now(),
        timer: null,
        save: true,
        finishing: false,
      };
      voiceRecording = session;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) session.chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => completeVoiceRecording(session), {
        once: true,
      });
      stream.getTracks().forEach((track) => {
        track.addEventListener(
          "ended",
          () => {
            if (voiceRecording === session && recorder.state !== "inactive")
              finishVoiceRecording(true);
          },
          { once: true },
        );
      });
      recorder.start(1000);
      session.timer = setInterval(() => updateVoiceRecordingTime(session), 500);
      $("#voiceRecorderTime").textContent = "00:00";
      setVoiceRecordingUi(true);
      toast("Recording voice note");
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      preparedContext?.close();
      toast(
        error.name === "NotAllowedError"
          ? "Microphone permission was denied"
          : error.message || "Could not start audio recording",
      );
    } finally {
      voiceRecordingStarting = false;
      if (voiceRecordingStartingTarget === target)
        voiceRecordingStartingTarget = null;
    }
  }

  function finishVoiceRecording(save = true) {
    const session = voiceRecording;
    if (!session || session.finishing) return;
    session.finishing = true;
    session.save = save;
    if (session.recorder.state === "inactive") completeVoiceRecording(session);
    else session.recorder.stop();
  }

  function markdownForBlock(block) {
    const holder = document.createElement("div");
    holder.append(block.cloneNode(true));
    return editorToMarkdown(holder);
  }

  function resizeSourceBlock(source) {
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
    const source = activeSourceBlock;
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
      if (!activeSourceBlock) return;
      let offset = direction < 0 ? activeSourceBlock.value.length : 0;
      if (preferredColumn !== null) {
        const value = activeSourceBlock.value;
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
        showVimCursor(activeSourceBlock, offset);
      else activeSourceBlock.setSelectionRange(offset, offset);
      activeSourceBlock.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    });
  }

  function vimField() {
    if (activeGraphBlock?.field?.isConnected) return activeGraphBlock.field;
    if (activeSourceBlock?.isConnected) return activeSourceBlock;
    return state.sourceMode ? sourceEditor : null;
  }

  function captureVimSnapshot(field = vimField()) {
    return {
      markdown: currentMarkdown(),
      blockIndex:
        field === activeSourceBlock ? [...editor.children].indexOf(field) : 0,
      blockId:
        field === activeGraphBlock?.field ? activeGraphBlock.block.id : null,
      graphBlockIndex:
        field === activeGraphBlock?.field
          ? NotnoteGraph.flattenBlocks(state.graphDocument?.blocks).findIndex(
              ({ block }) => block === activeGraphBlock.block,
            )
          : 0,
      cursor: field?.selectionStart || 0,
      timestamp: Date.now(),
    };
  }

  function pushVimSnapshot(stack, snapshot) {
    if (!snapshot || stack[stack.length - 1]?.markdown === snapshot.markdown)
      return;
    stack.push(snapshot);
    if (stack.length > 100) stack.shift();
  }

  function recordVimChange(field) {
    pushVimSnapshot(vimUndoStack, captureVimSnapshot(field));
    vimRedoStack.length = 0;
  }

  function finishVimInsertChange(field = vimField()) {
    if (!vimInsertSnapshot) return;
    const snapshot = vimInsertSnapshot;
    vimInsertSnapshot = null;
    if (snapshot.markdown !== currentMarkdown()) {
      pushVimSnapshot(vimUndoStack, snapshot);
      vimRedoStack.length = 0;
    }
  }

  function restoreVimSnapshot(snapshot) {
    vimInsertSnapshot = null;
    state.vimMode = "normal";
    vimPending = "";
    vimDesiredColumn = null;
    if (state.sourceMode) {
      sourceEditor.value = snapshot.markdown;
      setVimMode("normal", sourceEditor, snapshot.cursor);
    } else if (state.graphMode) {
      activeGraphBlock = null;
      state.graphDocument = NotnoteGraph.parseDocument(snapshot.markdown);
      restoreGraphCollapse();
      renderGraphPage();
      graphChanged();
      const block =
        graphBlockLocation(snapshot.blockId)?.block ||
        NotnoteGraph.flattenBlocks(state.graphDocument.blocks)[
          snapshot.graphBlockIndex
        ]?.block ||
        state.graphDocument.blocks[0];
      if (block) focusGraphBlock(block.id, snapshot.cursor);
    } else {
      activeSourceBlock = null;
      editor.innerHTML = markdownToHtml(snapshot.markdown);
      const blocks = [...editor.children];
      const block =
        blocks[Math.max(0, Math.min(snapshot.blockIndex, blocks.length - 1))];
      if (block) {
        activateSourceBlock(block);
        requestAnimationFrame(
          () =>
            activeSourceBlock &&
            showVimCursor(activeSourceBlock, snapshot.cursor),
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

  function recordTaskHistory(
    pagePath,
    blockId,
    before,
    after,
    blockIndex = -1,
  ) {
    taskUndoStack.push({
      graph: graphStore?.name || "",
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
      if (operation.graph !== (graphStore?.name || ""))
        throw new Error("The task belongs to another graph");
      const page = graphStore?.pages.find(
        (item) => item.path === operation.pagePath,
      );
      if (!page) throw new Error("Task page not found");
      const current = page.path === state.graphPage?.path;
      const document = current
        ? state.graphDocument
        : journalDocuments.get(page.path) ||
          graphIndex?.documents.get(page.path) ||
          NotnoteGraph.parseDocument(page.content);
      const block =
        graphBlockLocation(operation.blockId, document?.blocks)?.block ||
        NotnoteGraph.flattenBlocks(document?.blocks)[operation.blockIndex]?.block;
      if (!block) throw new Error("Task block not found");
      const marker = block.content.match(
        /^(TODO|DOING|DONE|LATER|NOW|WAITING|CANCELED|CANCELLED)(?:\s+|$)/,
      )?.[1];
      if (!marker) throw new Error("The block is no longer a task");
      const target = redo ? operation.after : operation.before;
      const originalContent = block.content;
      block.content = updateTaskCompletionMetadata(
        block.content.replace(/^[A-Z]+/, target),
        target,
      );
      if (current) graphChanged();
      else {
        const content = NotnoteGraph.serializeDocument(document);
        try {
          await graphStore.writePage(page, content);
          graphIndex.updatePage(page, content);
        } catch (error) {
          block.content = originalContent;
          throw error;
        }
        if (page.journal || journalDocuments.has(page.path))
          journalDocuments.set(page.path, document);
      }
      destination.push({ ...operation, timestamp: Date.now() });
      renderGraphPage();
      toast(`Task state ${redo ? "redone" : "undone"}: ${target}`);
      return true;
    } catch (error) {
      source.push(operation);
      toast(error.message || `Could not ${redo ? "redo" : "undo"} task state`);
      return true;
    }
  }

  function applyAppHistory(redo = false) {
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

  function vimLineBounds(field, position = field.selectionStart) {
    const start = field.value.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
    const nextBreak = field.value.indexOf("\n", position);
    return { start, end: nextBreak < 0 ? field.value.length : nextBreak };
  }

  function showVimCursor(field, position = field.selectionStart) {
    if (!field?.isConnected) return;
    field.classList.toggle("vim-empty", field.value.length === 0);
    const maximum = field.value.endsWith("\n")
      ? field.value.length
      : Math.max(0, field.value.length - 1);
    const cursor = Math.max(0, Math.min(position, maximum));
    field.setSelectionRange(cursor, Math.min(cursor + 1, field.value.length));
  }

  function updateVimUi() {
    const status = $("#vimStatus");
    status.hidden = !state.vimEnabled;
    const pending = vimPending ? ` ${vimPending}` : "";
    status.textContent =
      state.vimMode === "insert" ? "-- INSERT --" : `-- NORMAL --${pending}`;
    app.classList.toggle("vim-enabled", state.vimEnabled);
  }

  function setVimMode(mode, field = vimField(), cursor = null) {
    if (mode === "normal" && state.vimMode === "insert")
      finishVimInsertChange(field);
    if (mode === "insert" && state.vimMode !== "insert" && !vimInsertSnapshot)
      vimInsertSnapshot = captureVimSnapshot(field);
    state.vimMode = mode;
    vimPending = "";
    vimDesiredColumn = null;
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

  function focusVimEditor() {
    if (!state.vimEnabled) return;
    if (state.sourceMode) {
      setVimMode(state.vimMode, sourceEditor);
      return;
    }
    if (state.graphMode) {
      if (activeGraphBlock?.field) {
        setVimMode(state.vimMode, activeGraphBlock.field);
        return;
      }
      const block =
        (state.graphZoomId && graphBlockLocation(state.graphZoomId)?.block) ||
        state.graphDocument?.blocks?.[0];
      if (block) activateGraphBlock(block, 0, state.graphPage);
      return;
    }
    if (activeSourceBlock) {
      setVimMode(state.vimMode, activeSourceBlock);
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

  function setVimEnabled(
    enabled = !state.vimEnabled,
    refocus = true,
    persist = true,
  ) {
    if (state.vimEnabled && state.vimMode === "insert") finishVimInsertChange();
    state.vimEnabled = enabled;
    state.vimMode = "normal";
    vimPending = "";
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

  function replaceVimRange(field, start, end, text = "", record = true) {
    if (record && (start !== end || text)) recordVimChange(field);
    field.setRangeText(text, start, end, "start");
    notifyMarkdownField(field);
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
      return orderedJournalPages()
        .slice(0, state.journalLimit)
        .flatMap((page) =>
          visibleGraphBlocks(cachedJournalDocument(page).blocks, []).map(
            (block) => ({ block, page }),
          ),
        );
    }
    const roots = state.graphZoomId
      ? [graphBlockLocation(state.graphZoomId)?.block].filter(Boolean)
      : state.graphDocument?.blocks || [];
    return visibleGraphBlocks(roots, []).map((block) => ({
      block,
      page: state.graphPage,
    }));
  }

  function moveVimToGraphBlock(direction, distance = 1, preferredColumn = 0) {
    let entries = vimGraphEntries();
    const current = activeGraphBlock?.block;
    const currentPage = activeGraphBlock?.page;
    let index = entries.findIndex(
      (entry) =>
        entry.block === current && entry.page.path === currentPage?.path,
    );
    if (index < 0) return;
    if (
      state.journalMode &&
      direction > 0 &&
      index + distance >= entries.length &&
      state.journalLimit < orderedJournalPages().length
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
      focusGraphBlock(target.block.id, position);
    else
      activateJournalBlock(target.page.path, target.block.id, "edit", position);
  }

  function moveVimVertically(field, direction, firstNonBlank = false) {
    const bounds = vimLineBounds(field);
    const column = vimDesiredColumn ?? field.selectionStart - bounds.start;
    vimDesiredColumn = column;
    let targetStart;
    if (direction < 0) {
      if (bounds.start === 0) {
        if (field === activeGraphBlock?.field)
          moveVimToGraphBlock(-1, 1, column);
        else if (field === activeSourceBlock)
          moveToAdjacentBlock(-1, false, column);
        return;
      }
      const previousEnd = bounds.start - 1;
      targetStart =
        field.value.lastIndexOf("\n", Math.max(0, previousEnd - 1)) + 1;
    } else {
      if (bounds.end === field.value.length) {
        if (field === activeGraphBlock?.field)
          moveVimToGraphBlock(1, 1, column);
        else if (field === activeSourceBlock)
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
    if (field === activeGraphBlock?.field) {
      moveVimToGraphBlock(direction, 5, column);
      return;
    }
    const blocks = [...editor.children];
    const currentIndex = blocks.indexOf(activeSourceBlock);
    if (currentIndex < 0) return;
    const target =
      blocks[
        Math.max(0, Math.min(blocks.length - 1, currentIndex + direction * 5))
      ];
    if (!target || target === activeSourceBlock) return;
    commitActiveBlock();
    if (!target.isConnected) return;
    activateSourceBlock(target);
    requestAnimationFrame(() => {
      if (!activeSourceBlock) return;
      showVimCursor(
        activeSourceBlock,
        Math.min(
          column,
          Math.max(0, vimLineBounds(activeSourceBlock, 0).end - 1),
        ),
      );
      activeSourceBlock.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  function moveVimToDocumentEdge(field, end) {
    if (field === sourceEditor) {
      const position = end ? vimLineBounds(field, field.value.length).start : 0;
      showVimCursor(field, position);
      centerCaret();
      return;
    }
    if (field === activeGraphBlock?.field) {
      const entries = vimGraphEntries();
      const target = end ? entries.at(-1) : entries[0];
      if (!target) return;
      const position = end
        ? Math.max(0, target.block.content.lastIndexOf("\n") + 1)
        : 0;
      if (target.page.path === state.graphPage?.path)
        focusGraphBlock(target.block.id, position);
      else
        activateJournalBlock(
          target.page.path,
          target.block.id,
          "edit",
          position,
        );
      return;
    }
    const source = activeSourceBlock;
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
      if (!activeSourceBlock) return;
      const position = end
        ? vimLineBounds(activeSourceBlock, activeSourceBlock.value.length).start
        : 0;
      showVimCursor(activeSourceBlock, position);
      activeSourceBlock.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  function createVimGraphBlock(before = false) {
    const block = activeGraphBlock?.block;
    const location = block && graphBlockLocation(block.id);
    if (!location) return;
    vimInsertSnapshot = captureVimSnapshot(activeGraphBlock.field);
    let next;
    if (!before) next = createNextGraphBlock(block);
    else {
      next = {
        id: NotnoteGraph.newId(),
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
    if (next && activeGraphBlock?.field)
      setVimMode("insert", activeGraphBlock.field, 0);
  }

  function deleteVimGraphBlock(field) {
    const block = activeGraphBlock?.block;
    const location = block && graphBlockLocation(block.id);
    if (!location) return;
    const pageBlocks = NotnoteGraph.flattenBlocks(state.graphDocument.blocks).map(
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
    graphChanged();
    if (target) focusGraphBlock(target.id, 0);
    else renderGraphPage();
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
      vimPending = "";
      vimDesiredColumn = null;
      showVimCursor(field, target);
      updateVimUi();
    };

    if (vimPending === "g") {
      vimPending = "";
      if (key === "g") moveVimToDocumentEdge(field, false);
      updateVimUi();
      return;
    }
    if (vimPending === "d") {
      vimPending = "";
      if (key === "d")
        field === activeGraphBlock?.field
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
    if (vimPending === "r") {
      vimPending = "";
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
      vimDesiredColumn = null;
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
      vimPending = "g";
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
      if (field === activeGraphBlock?.field) createVimGraphBlock(key === "O");
      else {
        const insertion = key === "o" ? bounds.end : bounds.start;
        vimInsertSnapshot = captureVimSnapshot(field);
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
      vimPending = "d";
      updateVimUi();
    } else if (key === "D" || key === "C") {
      if (key === "C") vimInsertSnapshot = captureVimSnapshot(field);
      replaceVimRange(field, position, bounds.end, "", key !== "C");
      if (key === "C") setVimMode("insert", field, position);
      else showVimCursor(field, position);
    } else if (key === "r") {
      vimPending = "r";
      updateVimUi();
    } else if (key === ":") showCommandPalette();
    else if (key === "?") showDocumentation();
  }

  function handleVimKeydown(event) {
    if (
      !state.vimEnabled ||
      !$("#commandPalette").hidden ||
      !$("#confirmDialog").hidden ||
      !$("#assetCleanupDialog").hidden
    )
      return;
    if (
      selectedGraphBlockIds.size &&
      (event.target === outliner || outliner.contains(event.target)) &&
      ["Backspace", "Escape"].includes(event.key)
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Backspace") deleteSelectedGraphBlocks();
      else clearGraphBlockSelection();
      return;
    }
    const field =
      event.target === sourceEditor
        ? sourceEditor
        : event.target === activeGraphBlock?.field
          ? activeGraphBlock.field
          : event.target === activeSourceBlock
            ? activeSourceBlock
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
      vimPending = "";
      updateVimUi();
      return;
    }
    processVimNormalKey(field, vimKey);
  }

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

  function activateSourceBlock(block, pointer = null) {
    if (
      state.sourceMode ||
      !block ||
      block === activeSourceBlock ||
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
    activeSourceBlock = source;
    resizeSourceBlock(source);
    requestAnimationFrame(() => {
      placeCaretInSource(source, pointer?.x ?? -1, pointer?.y ?? -1);
      if (state.vimEnabled)
        setVimMode(state.vimMode, source, source.selectionStart);
    });
  }

  function commitActiveBlock() {
    const source = activeSourceBlock;
    if (!source) return;
    if (state.vimEnabled && state.vimMode === "insert")
      finishVimInsertChange(source);
    activeSourceBlock = null;
    if (state.vimEnabled) {
      state.vimMode = "normal";
      vimPending = "";
      vimDesiredColumn = null;
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

  function loadMarkdown(markdown, name = "Untitled", options = {}) {
    if (state.graphMode && graphStore?.isRemote) {
      closeRemoteEvents?.();
      closeRemoteEvents = null;
    }
    if (graphRoute() && !options.preserveGraphRoute)
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
    updateVimUi();
    state.markdown = markdown;
    activeSourceBlock = null;
    activeGraphBlock = null;
    mobileBlockToolbar.hidden = true;
    vimUndoStack.length = 0;
    vimRedoStack.length = 0;
    vimInsertSnapshot = null;
    state.fileHandle = options.handle || null;
    state.currentId = options.id || crypto.randomUUID?.() || String(Date.now());
    state.dirty = false;
    editor.innerHTML = markdownToHtml(markdown);
    sourceEditor.value = markdown;
    finishTitleEdit();
    fileName.value = name.replace(/\.(md|markdown|txt)$/i, "");
    fileName.readOnly = false;
    document.title = `${fileName.value} — notnote`;
    app.classList.remove("dirty");
    updateStats();
    updateOutline();
    persistLocal(false);
    saveState.textContent = "Ready";
    requestAnimationFrame(() =>
      state.vimEnabled ? focusVimEditor() : editor.focus(),
    );
  }

  function changed() {
    if (state.graphMode) {
      graphChanged();
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

  function getStoredDocs() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch {
      return [];
    }
  }

  function persistLocal(showStatus = true) {
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

  function relativeDate(time) {
    const seconds = Math.floor((Date.now() - time) / 1000);
    if (seconds < 60) return "now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
    return new Intl.DateTimeFormat("en", {
      day: "numeric",
      month: "short",
    }).format(time);
  }

  function updateStats() {
    const text = currentMarkdown()
      .replace(/```[\s\S]*?```|[#>*_`~\[\]()|\-]/g, " ")
      .trim();
    const words = text ? text.split(/\s+/).length : 0;
    const chars = text.replace(/\s/g, "").length;
    $("#wordCount").textContent =
      `${words} ${words === 1 ? "word" : "words"} · ${chars} characters`;
  }

  function updateOutline() {
    if (state.sourceMode) return;
    $$("h1,h2,h3,h4,h5,h6", editor).forEach(
      (heading, index) => (heading.id = `heading-${index}`),
    );
  }

  function toast(message) {
    toastElement.textContent = message;
    positionToastInVisualViewport();
    toastElement.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => toastElement.classList.remove("show"), 2800);
  }

  async function openFile() {
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

  async function saveFile() {
    if (state.graphMode) return flushGraphSave(true);
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

  function downloadBlob(content, name, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = Object.assign(document.createElement("a"), {
      href: url,
      download: name,
    });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function requestAction(action) {
    if (state.graphMode)
      return flushGraphSave(true).then((saved) => saved && action());
    if (!state.dirty) return action();
    state.pendingAction = action;
    $("#confirmDialog").hidden = false;
  }

  function newDocument() {
    loadMarkdown("", "Untitled");
  }

  function toggleSource(force) {
    const shouldEnable = typeof force === "boolean" ? force : !state.sourceMode;
    if (shouldEnable === state.sourceMode) return;
    if (state.graphMode) {
      if (shouldEnable) {
        commitGraphBlock();
        sourceEditor.value = NotnoteGraph.serializeDocument(state.graphDocument);
        outliner.hidden = true;
        sourceEditor.hidden = false;
      } else {
        state.graphDocument = NotnoteGraph.parseDocument(sourceEditor.value);
        restoreGraphCollapse();
        sourceEditor.hidden = true;
        outliner.hidden = false;
        renderGraphPage();
        graphChanged();
      }
      state.sourceMode = shouldEnable;
      app.classList.toggle("source-mode", shouldEnable);
      updateStats();
      if (state.vimEnabled) requestAnimationFrame(focusVimEditor);
      else (shouldEnable ? sourceEditor : outliner).focus?.();
      return;
    }
    if (shouldEnable) {
      commitActiveBlock();
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
    if (state.vimEnabled) requestAnimationFrame(focusVimEditor);
    else (shouldEnable ? sourceEditor : editor).focus();
  }

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

  function transformInlineMarkdown() {
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

  function markdownShortcut(event) {
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

  function centerCaret() {
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

  let findMatches = [];
  let currentFindMatch = -1;
  let findRefreshFrame = 0;

  function clearFindHighlights() {
    if (globalThis.CSS?.highlights) {
      CSS.highlights.delete("document-search");
      CSS.highlights.delete("document-search-current");
    }
  }

  function closeFind() {
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

  function searchDom(root, query, matches) {
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

  function updateDocumentSearch() {
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

  function showFind() {
    $("#findbar").hidden = false;
    updateDocumentSearch();
    $("#findInput").focus();
    $("#findInput").select();
  }

  function moveFind(direction = 1) {
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

  let documentationLoaded = false;
  let documentationReturnFocus = null;
  let gitSettingsTimer = null;
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
      $("#documentationMenu").innerHTML = sections.length
        ? `<strong>On this page</strong><select aria-label="Jump to documentation section"><option value="">Choose a section…</option>${sections.map((heading) => `<option value="${heading.id}">${escapeHtml(heading.textContent)}</option>`).join("")}</select><div>${sections.map((heading) => `<button type="button" data-documentation-target="${heading.id}">${escapeHtml(heading.textContent)}</button>`).join("")}</div>`
        : "";
      documentationLoaded = true;
    } catch (error) {
      documentationContent.innerHTML = `<p>${escapeHtml(error.message || "Could not load the documentation.")}</p>`;
    }
  }

  function renderShortcutSettings(query = "") {
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

  function saveGitSyncSettings() {
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

  async function loadGitSettingsStatus() {
    clearTimeout(gitSettingsTimer);
    if (
      documentationView.hidden ||
      $("[data-settings-panel=git]").hidden ||
      !graphStore?.isRemote
    )
      return;
    const container = $("#gitSettingsStatus");
    try {
      const status = await graphStore.api("/git/status");
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

  async function showSettings(tab = "general") {
    if (documentationView.hidden)
      documentationReturnFocus =
        activeMarkdownField() || document.activeElement;
    documentationView.hidden = false;
    app.classList.add("documentation-open");
    $("#settingsGitTab").hidden = !graphStore?.isRemote;
    if (tab === "git" && !graphStore?.isRemote) tab = "general";
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
        : $("#settingsClose")
      ).focus(),
    );
  }
  const showDocumentation = () => showSettings("documentation");

  function closeDocumentation() {
    if (documentationView.hidden) return;
    clearTimeout(gitSettingsTimer);
    documentationView.hidden = true;
    app.classList.remove("documentation-open");
    if (
      documentationReturnFocus?.isConnected &&
      !documentationReturnFocus.closest?.("[hidden]")
    )
      documentationReturnFocus.focus();
    else $("#footerMenuButton").focus();
  }

  function exportHtml() {
    const body = markdownToHtml(currentMarkdown());
    const title = escapeHtml(fileName.value || "Document");
    const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{max-width:760px;margin:60px auto;padding:0 24px;color:#333;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}h1{border-bottom:1px solid #ddd}a{color:#4183c4}blockquote{border-left:3px solid #ddd;padding-left:18px;color:#777}code,pre{font-family:monospace;background:#f5f5f5;border-radius:4px}code{padding:2px 4px}pre{padding:16px;overflow:auto}pre code{padding:0}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:7px}img,video,iframe{max-width:100%}audio{width:100%}iframe{border:0}</style><body>${body}</body></html>`;
    downloadBlob(page, `${fileName.value || "document"}.html`, "text/html");
    toast("HTML exported");
  }

  function activeMarkdownField() {
    if (paletteContext?.field?.isConnected) return paletteContext.field;
    if (state.graphMode)
      return activeGraphBlock?.field?.isConnected
        ? activeGraphBlock.field
        : state.sourceMode
          ? sourceEditor
          : null;
    if (activeSourceBlock?.isConnected) return activeSourceBlock;
    return state.sourceMode ? sourceEditor : null;
  }

  function notifyMarkdownField(field) {
    if (field === activeSourceBlock) resizeSourceBlock(field);
    if (field === activeGraphBlock?.field) resizeGraphEditor(field);
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
        () => activeGraphBlock && callback(activeGraphBlock.field),
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
      () => activeSourceBlock && callback(activeSourceBlock),
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

  function prefixMarkdownLines(prefix, ordered = false) {
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

  function headingCommand(level) {
    transformMarkdownBlock(
      (text) => `${"#".repeat(level)} ${text.replace(/^#{1,6}\s+/, "").trim()}`,
    );
  }

  function wrapMarkdownSelection(before, after = before, placeholder = "text") {
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

  function selectedGraphBlock() {
    const id =
      activeGraphBlock?.block?.id || paletteContext?.field?.dataset?.blockId;
    return id ? graphBlockLocation(id)?.block : null;
  }

  async function copyGraphBlockReference() {
    const block = selectedGraphBlock();
    if (!state.graphMode || !block) return toast("Select a block first");
    const properties = NotnoteGraph.propertiesFrom(block.content);
    const uuid = properties.id || NotnoteGraph.newId();
    if (!properties.id) {
      block.content = `${block.content.replace(/\s+$/, "")}\n${block.content ? "" : ""}id:: ${uuid}`;
      block.uuid = uuid;
      graphChanged();
      renderGraphPage();
    }
    await navigator.clipboard.writeText(`((${uuid}))`);
    toast("Block reference copied");
  }

  function zoomGraphBlock() {
    const block = selectedGraphBlock();
    if (!state.graphMode || !block) return toast("Select a block first");
    commitGraphBlock();
    state.graphZoomId = block.id;
    renderGraphPage();
  }

  async function createGraphPage() {
    if (!graphStore) return openGraph();
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
      label: "Task dashboard",
      shortcutId: "tasks",
      keywords: "tasks todo doing done dashboard all",
      run: () => requestAction(openTasksPage),
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
    if (!graphIndex || query.length < 2) return [];
    return graphIndex.search(query, 24).map((result) => ({
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
    const searchQuery = query.toLowerCase();
    const normalizedQuery = query && NotnoteGraph.normalizePage(query);
    const seen = new Set();
    const settings = currentSettings();
    const storedPages = (settings.recentGraphPages || [])
      .filter((item) => item.graph === graphStore?.name)
      .map((item) => graphStore?.pages.find((page) => page.path === item.path))
      .filter(Boolean);
    let graphPages = [...graphHistory]
      .reverse()
      .map((entry) =>
        graphStore?.pages.find((page) => page.path === entry.path),
      )
      .filter(Boolean);
    graphPages.push(...storedPages);
    if (query && graphIndex) graphPages.push(...graphIndex.pageSuggestions());
    const matchedPages = graphPages
      .flatMap((page) => {
        if (seen.has(page.path)) return [];
        seen.add(page.path);
        const aliases = graphIndex?.aliasesForPage(page) || [];
        if (!normalizedQuery)
          return [{ page, aliases, matchedAlias: "", rank: 0 }];
        const results = [];
        const aliasKeys = new Set();
        for (const alias of aliases) {
          const key = NotnoteGraph.normalizePage(alias);
          if (
            !key.includes(normalizedQuery) ||
            key === NotnoteGraph.normalizePage(page.title) ||
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
        if (NotnoteGraph.normalizePage(page.title).includes(normalizedQuery))
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
      .filter((doc) => !query || doc.name.toLowerCase().includes(searchQuery))
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
      Boolean(graphIndex?.resolvePage(query)) ||
      graphIndex
        ?.pageSuggestions()
        .some(
          (page) => NotnoteGraph.normalizePage(page.title) === normalizedQuery,
        );
    const createPage =
      query && graphStore && !exactPage
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

  function renderPaletteGraphStats() {
    const footer = $("#commandPaletteStats");
    const store = graphStore;
    footer.hidden = !store;
    if (!store) return;
    const applyStats = (stats) => {
      if (graphStore !== store || !stats) return;
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
        if (graphStore === store)
          $("#paletteGraphFiles").textContent = "Folder statistics unavailable";
        cache.promise = null;
      });
  }

  function renderCommandList() {
    const rawQuery = $("#commandInput").value.trim();
    const query = rawQuery.toLowerCase();
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
          : `${command.label} ${command.keywords || ""}`
              .toLowerCase()
              .includes(commandQuery),
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

  function showCommandPalette(initialQuery = "") {
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

  function closeCommandPalette(refocus = true) {
    $("#commandPalette").hidden = true;
    if (refocus && paletteContext?.field?.isConnected) {
      paletteContext.field.focus();
      paletteContext.field.setSelectionRange(
        paletteContext.start,
        paletteContext.end,
      );
    }
  }

  function runSelectedCommand(index = selectedCommand) {
    const command = filteredCommands[index];
    if (!command) return;
    closeCommandPalette(false);
    command.run();
    paletteContext = null;
  }

  async function activateJournalBlock(
    pagePath,
    blockId,
    action = "edit",
    position = null,
  ) {
    const page = graphStore?.pages.find((item) => item.path === pagePath);
    if (!page) return;
    if (page.path !== state.graphPage?.path) {
      if (state.dirty && !(await flushGraphSave(true))) return;
      await loadGraphPage(page, { journalMode: true });
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

  async function openSingleJournalPage(pagePath) {
    const page = graphStore?.pages.find((item) => item.path === pagePath);
    if (!page) return;
    await loadGraphPage(page, { journalMode: false });
    notnoteWrap.scrollTop = 0;
  }

  function beginTitleEdit() {
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

  function finishTitleEdit(cancel = false) {
    if (cancel && state.graphMode && state.graphPage)
      fileName.value = titleEditOriginal || state.graphPage.title;
    documentTitleActions.hidden = true;
    app.classList.remove("title-editing");
    titleEditOriginal = "";
  }

  async function renameGraphPage(title) {
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
      const duplicate = graphStore.pages.find(
        (candidate) =>
          candidate !== page &&
          NotnoteGraph.normalizePage(candidate.title) ===
            NotnoteGraph.normalizePage(nextTitle),
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
        for (const linkedPage of [...graphStore.pages]) {
          const content =
            linkedPage === page ? currentContent : linkedPage.content;
          const updated = NotnoteGraph.replacePageReferences(
            content,
            oldTitle,
            nextTitle,
          );
          if (updated !== content) {
            await graphStore.writePage(linkedPage, updated);
            if (linkedPage === page) currentContent = updated;
          }
        }
      }
      const renamed = await graphStore.renamePage(
        page,
        nextTitle,
        currentContent,
      );
      state.graphPage = renamed;
      state.graphDocument = NotnoteGraph.parseDocument(currentContent);
      restoreGraphCollapse();
      state.dirty = false;
      graphIndex = new NotnoteGraph.GraphIndex(graphStore.pages);
      fileName.value = nextTitle;
      document.title = `${nextTitle} — ${graphStore.name} — notnote`;
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
  function deleteCurrentGraphPage() {
    const page = state.graphPage;
    if (!state.graphMode || !page || page.journal || page.virtual) return;
    pagePendingDeletion = page;
    $("#deleteDialogMessage").textContent =
      `Delete “${page.title}”? This cannot be undone.`;
    $("#deleteConfirmDialog").hidden = false;
    requestAnimationFrame(() => $('[data-delete-dialog="cancel"]').focus());
  }

  function closeDeletePageDialog() {
    pagePendingDeletion = null;
    $("#deleteConfirmDialog").hidden = true;
  }

  async function confirmDeleteCurrentGraphPage() {
    const page = pagePendingDeletion;
    closeDeletePageDialog();
    if (!page || page.path !== state.graphPage?.path) return;
    try {
      commitGraphBlock();
      clearTimeout(state.saveTimer);
      clearTimeout(graphDraftTimer);
      await graphStore.deletePage(page);
      graphIndex.removePage(page);
      journalDocuments.delete(page.path);
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

  // UI events
  window.visualViewport?.addEventListener(
    "resize",
    updateMobileToolbarPosition,
  );
  window.visualViewport?.addEventListener(
    "scroll",
    updateMobileToolbarPosition,
  );
  window.addEventListener("orientationchange", () =>
    setTimeout(() => {
      const viewport = window.visualViewport;
      mobileViewportHeight = Math.max(
        window.innerHeight,
        (viewport?.height || 0) + (viewport?.offsetTop || 0),
      );
      updateMobileToolbarPosition();
    }, 250),
  );
  let mobileRecordPointer = null;
  let suppressMobileRecordClickUntil = 0;
  mobileBlockToolbar.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (
      event.pointerType === "touch" &&
      event.target.closest('[data-block-action="record"]') &&
      activeGraphBlock
    )
      mobileRecordPointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        field: activeGraphBlock.field,
        block: activeGraphBlock.block,
        start: activeGraphBlock.field.selectionStart,
        end: activeGraphBlock.field.selectionEnd,
      };
  });
  mobileBlockToolbar.addEventListener("pointerup", (event) => {
    const target = mobileRecordPointer;
    mobileRecordPointer = null;
    if (
      !target ||
      target.id !== event.pointerId ||
      Math.hypot(event.clientX - target.x, event.clientY - target.y) > 12 ||
      !event.target.closest('[data-block-action="record"]')
    )
      return;
    event.preventDefault();
    suppressMobileRecordClickUntil = Date.now() + 750;
    if (voiceRecording) finishVoiceRecording(true);
    else
      startVoiceRecording(
        target.field,
        target.block,
        target.start,
        target.end,
      );
  });
  mobileBlockToolbar.addEventListener("pointercancel", () => {
    mobileRecordPointer = null;
  });
  mobileBlockToolbar.addEventListener("click", (event) => {
    const button = event.target.closest("[data-block-action]");
    const field = activeGraphBlock?.field;
    const block = activeGraphBlock?.block;
    if (!button || !field || !block) return;
    const action = button.dataset.blockAction;
    if (action === "undo" || action === "redo") {
      applyAppHistory(action === "redo");
      return;
    }
    if (action === "task") {
      toggleGraphTask(block, true, true);
      return;
    }
    if (action === "upload") {
      uploadGraphAsset(
        field,
        block,
        field.selectionStart,
        field.selectionEnd,
      );
      return;
    }
    if (action === "collapse-all") {
      toggleAllGraphBlocks();
      return;
    }
    if (action === "record") {
      if (Date.now() < suppressMobileRecordClickUntil) return;
      if (voiceRecording) finishVoiceRecording(true);
      else
        startVoiceRecording(
          field,
          block,
          field.selectionStart,
          field.selectionEnd,
        );
      return;
    }
    const snapshot = captureVimSnapshot(field);
    if (["indent", "outdent", "up", "down"].includes(action)) {
      const changed =
        action === "indent"
          ? indentGraphBlock(block)
          : action === "outdent"
            ? indentGraphBlock(block, true)
            : moveGraphBlock(block, action === "up" ? -1 : 1);
      if (changed) {
        pushVimSnapshot(vimUndoStack, snapshot);
        vimRedoStack.length = 0;
      }
      return;
    }
    const brackets =
      action === "square"
        ? ["[[", "]]"]
        : action === "round"
          ? ["((", "))"]
          : null;
    if (!brackets) return;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const selected = field.value.slice(start, end);
    field.setRangeText(
      `${brackets[0]}${selected}${brackets[1]}`,
      start,
      end,
      "end",
    );
    const cursor = start + brackets[0].length;
    field.setSelectionRange(cursor, cursor);
    pushVimSnapshot(vimUndoStack, snapshot);
    vimRedoStack.length = 0;
    notifyMarkdownField(field);
  });
  voiceRecorderPanel.addEventListener("click", (event) => {
    const action = event.target.closest("[data-voice-recording]")?.dataset
      .voiceRecording;
    if (action) finishVoiceRecording(action === "save");
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (
        activeSourceBlock &&
        !editor.contains(event.target) &&
        !$("#commandPalette").contains(event.target)
      )
        commitActiveBlock();
      if (
        activeGraphBlock &&
        !outliner.contains(event.target) &&
        !$("#commandPalette").contains(event.target) &&
        !graphAutocomplete.contains(event.target) &&
        !journalCalendar.contains(event.target) &&
        !mobileBlockToolbar.contains(event.target) &&
        !voiceRecorderPanel.contains(event.target)
      )
        commitGraphBlock();
    },
    true,
  );
  editor.addEventListener("focusout", () =>
    setTimeout(() => {
      if (
        activeSourceBlock &&
        $("#commandPalette").hidden &&
        !editor.contains(document.activeElement)
      )
        commitActiveBlock();
    }),
  );
  $("#todayJournalButton").addEventListener("click", () => {
    closeJournalCalendar();
    requestAction(() => openToday(true));
  });
  $("#journalCalendarButton").addEventListener("click", (event) => {
    event.stopPropagation();
    toggleJournalCalendar();
  });
  journalCalendar.addEventListener("click", async (event) => {
    const move = event.target.closest("[data-calendar-move]");
    if (move) {
      moveCalendarMonth(Number(move.dataset.calendarMove));
      return;
    }
    if (event.target.closest("[data-calendar-all-tasks]")) {
      closeJournalCalendar();
      await openTasksPage();
      return;
    }
    const pageLink = event.target.closest("[data-page]");
    if (pageLink) {
      event.preventDefault();
      closeJournalCalendar();
      await loadGraphPage(pageLink.dataset.page, { virtual: true });
      return;
    }
    const blockReference = event.target.closest("[data-block-ref]");
    if (blockReference) {
      const resolved = graphIndex?.resolveBlock(
        blockReference.dataset.blockRef,
      );
      closeJournalCalendar();
      if (resolved)
        await loadGraphPage(resolved.page, { blockId: resolved.block.id });
      else toast("Referenced block not found");
      return;
    }
    const task = event.target.closest("[data-calendar-task-page]");
    if (task && !event.target.closest("a, button, audio, video, iframe")) {
      const page = graphStore?.pages.find(
        (item) => item.path === task.dataset.calendarTaskPage,
      );
      closeJournalCalendar();
      if (page)
        await loadGraphPage(page, { blockId: task.dataset.calendarTaskBlock });
      return;
    }
    const day = event.target.closest("[data-calendar-date]");
    if (!day) return;
    const [year, month, date] = day.dataset.calendarDate.split("-").map(Number);
    const selectedDate = new Date(year, month - 1, date, 12);
    const action = calendarSelectAction;
    closeJournalCalendar();
    if (action) action(selectedDate);
    else requestAction(() => openSingleJournalDate(selectedDate));
  });
  journalCalendar.addEventListener("keydown", (event) => {
    if (
      (event.key === "Enter" || event.key === " ") &&
      event.target.matches("[data-calendar-task-page]")
    ) {
      event.preventDefault();
      event.target.click();
      return;
    }
    const day = event.target.closest("[data-calendar-date]");
    if (!day) return;
    const movements = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    if (event.key in movements) {
      event.preventDefault();
      const next = new Date(calendarFocusDate);
      next.setDate(next.getDate() + movements[event.key]);
      focusCalendarDate(next);
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      moveCalendarMonth(event.key === "PageUp" ? -1 : 1);
    } else if (event.key === "Home" && event.ctrlKey) {
      event.preventDefault();
      focusCalendarDate(new Date());
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (
      !journalCalendar.hidden &&
      !journalCalendar.contains(event.target) &&
      event.target !== $("#journalCalendarButton")
    )
      closeJournalCalendar();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !journalCalendar.hidden)
      closeJournalCalendar();
  });
  $("#commandButton").addEventListener("click", () => showCommandPalette());

  const PAGE_DIRECTORY_SIZE = 50;
  let pageDirectoryReturnFocus = null;
  let pageDirectoryVisiblePages = [];
  const pageDirectoryGroupPages = new Map();
  const pageDirectoryExpandedGroups = new Set();
  // Deduplicate physical and referenced pages before alphabetic grouping.
  function allDirectoryPages() {
    if (!graphIndex) return [];
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
    const seen = new Set();
    return graphIndex
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
  function renderPageDirectory() {
    const pages = allDirectoryPages();
    const query = $("#pageDirectoryFilter").value.trim().toLocaleLowerCase();
    const filtered = pages.filter((page) => {
      const aliases = graphIndex?.aliasesForPage(page) || [];
      return [page.title, ...aliases].some((value) =>
        value.toLocaleLowerCase().includes(query),
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
  function closePageDirectory(refocus = true) {
    const view = $("#pageDirectoryView");
    if (view.hidden) return;
    view.hidden = true;
    if (refocus) {
      if (pageDirectoryReturnFocus?.isConnected)
        pageDirectoryReturnFocus.focus();
      else $("#commandButton").focus();
    }
  }
  async function showPageDirectory() {
    if (!graphStore) await openGraph();
    if (!graphStore || !graphIndex) return;
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
  function closePageHistory() {
    const view = $("#pageHistoryView");
    if (view.hidden) return;
    view.hidden = true;
    if (pageHistoryReturnFocus?.isConnected) pageHistoryReturnFocus.focus();
    else $("#footerMenuButton").focus();
  }
  async function showPageHistory() {
    const page = state.graphPage;
    if (!state.graphMode || !page || page.virtual)
      return toast("Open a saved graph page first");
    pageHistoryReturnFocus = $("#footerMenuButton");
    $("#pageHistoryView").hidden = false;
    $("#pageHistoryTitle").textContent = page.title;
    $("#pageHistoryContent").innerHTML =
      '<p class="page-history-message">Loading Git history…</p>';
    if (!graphStore?.isRemote) {
      $("#pageHistoryContent").innerHTML =
        '<p class="page-history-message">Page history is available when the graph is served by notnote server.</p>';
      return;
    }
    commitGraphBlock();
    await flushGraphSave(false);
    try {
      const result = await graphStore.api(
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
  async function restorePageHistoryCommit(button) {
    const details = button.closest("[data-history-commit]");
    const page = state.graphPage;
    if (!details || !page || !graphStore?.isRemote) return;
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
      const result = await graphStore.api(`/history/content?${query}`);
      if (!result.available)
        throw new Error(result.message || "This version cannot be restored");
      status.textContent = "Saving restored version…";
      await graphStore.writePage(page, result.content);
      graphIndex.updatePage(page, result.content);
      await NotnoteGraph.removeDraft(page.path).catch(() => {});
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
  function closeFooterMenu() {
    $("#footerMenu").hidden = true;
    $("#footerMenuButton").setAttribute("aria-expanded", "false");
  }
  function toggleFooterMenu() {
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
  $("#footerMenuButton").addEventListener("click", (event) => {
    event.stopPropagation();
    toggleFooterMenu();
  });
  $("#footerMenu").addEventListener("click", (event) => {
    const action = event.target.closest("[data-footer-action]")?.dataset
      .footerAction;
    if (!action) return;
    closeFooterMenu();
    if (action === "new-page") requestAction(createGraphPage);
    else if (action === "delete-page") deleteCurrentGraphPage();
    else if (action === "page-history") showPageHistory();
    else if (action === "settings") showSettings("general");
    else if (action === "shortcuts") showSettings("shortcuts");
    else if (action === "documentation") showDocumentation();
  });
  document.addEventListener("pointerdown", (event) => {
    if (
      !$("#footerMenu").hidden &&
      !$("#footerMenu").contains(event.target) &&
      !$("#footerMenuButton").contains(event.target)
    )
      closeFooterMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#footerMenu").hidden) {
      event.preventDefault();
      closeFooterMenu();
      $("#footerMenuButton").focus();
    } else if (event.key === "Escape" && !$("#pageDirectoryView").hidden) {
      event.preventDefault();
      closePageDirectory();
    } else if (event.key === "Escape" && !$("#pageHistoryView").hidden) {
      event.preventDefault();
      closePageHistory();
    }
  });
  $("#pageDirectoryClose").addEventListener("click", () =>
    closePageDirectory(),
  );
  $("#pageDirectoryFilter").addEventListener("input", () => {
    pageDirectoryGroupPages.clear();
    renderPageDirectory();
  });
  $("#pageDirectoryContent").addEventListener("click", (event) => {
    const move = event.target.closest("[data-page-directory-move]");
    if (move) {
      const letter = move.dataset.pageDirectoryGroup;
      pageDirectoryGroupPages.set(
        letter,
        Math.max(
          0,
          (pageDirectoryGroupPages.get(letter) || 0) +
            Number(move.dataset.pageDirectoryMove),
        ),
      );
      pageDirectoryExpandedGroups.add(letter);
      renderPageDirectory();
      return;
    }
    const button = event.target.closest("[data-page-directory-index]");
    if (!button) return;
    const page = pageDirectoryVisiblePages[
      Number(button.dataset.pageDirectoryIndex)
    ];
    if (!page) return;
    closePageDirectory(false);
    loadGraphPage(page);
  });
  $("#pageDirectoryContent").addEventListener(
    "toggle",
    (event) => {
      if ($("#pageDirectoryFilter").value.trim()) return;
      const details = event.target.closest?.("[data-page-directory-letter]");
      const letter = details?.dataset.pageDirectoryLetter;
      if (!letter) return;
      if (details.open) pageDirectoryExpandedGroups.add(letter);
      else pageDirectoryExpandedGroups.delete(letter);
    },
    true,
  );
  $("#pageHistoryClose").addEventListener("click", closePageHistory);
  $("#pageHistoryContent").addEventListener("click", (event) => {
    const button = event.target.closest("[data-history-restore]");
    if (button) restorePageHistoryCommit(button);
  });
  $("#pageHistoryContent").addEventListener(
    "toggle",
    async (event) => {
      const details = event.target.closest?.("[data-history-commit]");
      if (!details?.open || details.dataset.historyLoaded) return;
      details.dataset.historyLoaded = "true";
      const output = $(".page-history-diff", details);
      output.textContent = "Loading diff…";
      try {
        const path = state.graphPage?.path;
        if (!path || !graphStore?.isRemote)
          throw new Error("Git diff is unavailable");
        const query = new URLSearchParams({
          path,
          commit: details.dataset.historyCommit,
          gitPath: details.dataset.historyPath,
        });
        const result = await graphStore.api(`/history/diff?${query}`);
        if (result.diff) output.innerHTML = highlightedGitDiff(result.diff);
        else
          output.textContent =
            "No textual changes for this file in this commit.";
      } catch (error) {
        output.textContent = error.message || "Could not load the diff.";
        delete details.dataset.historyLoaded;
      }
    },
    true,
  );
  $("#settingsClose").addEventListener("click", closeDocumentation);
  $(".settings-nav").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-settings-tab]")?.dataset
      .settingsTab;
    if (tab) showSettings(tab);
  });
  $("#documentationMenu").addEventListener("click", (event) => {
    const target = event.target.closest("[data-documentation-target]")?.dataset
      .documentationTarget;
    if (target)
      document
        .getElementById(target)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#documentationMenu").addEventListener("change", (event) => {
    if (event.target.matches("select") && event.target.value)
      document
        .getElementById(event.target.value)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#settingsTheme").addEventListener("change", (event) =>
    setTheme(event.target.value),
  );
  $("#settingsAccent").addEventListener("input", (event) =>
    setAccent(event.target.value),
  );
  $("#settingsVim").addEventListener("change", (event) =>
    setVimEnabled(event.target.checked, false),
  );
  $("#settingsAssetCacheSize").addEventListener("change", (event) =>
    setAssetCacheSize(event.target.value),
  );
  [
    "#settingsGitAutoCommit",
    "#settingsGitAutoPush",
    "#settingsGitDelay",
  ].forEach((selector) =>
    $(selector).addEventListener("change", saveGitSyncSettings),
  );
  $("#gitSyncNow").addEventListener("click", async () => {
    const button = $("#gitSyncNow");
    button.disabled = true;
    try {
      await graphStore.api("/git/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ push: $("#settingsGitAutoPush").checked }),
      });
    } catch (error) {
      toast(error.message || "Git sync failed");
    } finally {
      await loadGitSettingsStatus();
    }
  });
  $("#shortcutSearch").addEventListener("input", (event) =>
    renderShortcutSettings(event.target.value),
  );
  $("#shortcutList").addEventListener("click", (event) => {
    const reset = event.target.closest("[data-shortcut-reset]");
    if (!reset) return;
    const shortcuts = { ...(currentSettings().shortcuts || {}) };
    delete shortcuts[reset.dataset.shortcutReset];
    saveSettings({ shortcuts });
    renderShortcutSettings($("#shortcutSearch").value);
  });
  $("#shortcutList").addEventListener("keydown", (event) => {
    const button = event.target.closest("[data-shortcut-record]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      button.classList.remove("recording");
      button.textContent = shortcutLabel(
        shortcutValue(button.dataset.shortcutRecord),
      );
      return;
    }
    const binding = eventBinding(event);
    if (!binding) return;
    const conflict = shortcutDefinitions.find(
      (item) =>
        item.id !== button.dataset.shortcutRecord &&
        shortcutValue(item.id) === binding,
    );
    if (conflict) return toast(`Shortcut already used by ${conflict.label}`);
    const shortcuts = {
      ...(currentSettings().shortcuts || {}),
      [button.dataset.shortcutRecord]: binding,
    };
    saveSettings({ shortcuts });
    button.classList.remove("recording");
    renderShortcutSettings($("#shortcutSearch").value);
  });
  $("#shortcutList").addEventListener("focusin", (event) => {
    const button = event.target.closest("[data-shortcut-record]");
    if (button) {
      button.classList.add("recording");
      button.textContent = "Press shortcut…";
    }
  });
  $("#shortcutList").addEventListener("focusout", (event) => {
    const button = event.target.closest("[data-shortcut-record]");
    if (button?.isConnected) {
      button.classList.remove("recording");
      button.textContent = shortcutLabel(
        shortcutValue(button.dataset.shortcutRecord),
      );
    }
  });
  document.addEventListener(
    "keydown",
    (event) => {
      const redo =
        shortcutMatches("redo", event) || shortcutMatches("redoAlt", event);
      if (state.vimEnabled || (!redo && !shortcutMatches("undo", event)))
        return;
      event.preventDefault();
      applyAppHistory(redo);
    },
    true,
  );
  document.addEventListener("keydown", handleVimKeydown, true);
  document.addEventListener("pointerup", (event) => {
    if (!state.vimEnabled || state.vimMode !== "normal") return;
    const field =
      event.target === sourceEditor
        ? sourceEditor
        : event.target === activeGraphBlock?.field
          ? activeGraphBlock.field
          : event.target === activeSourceBlock
            ? activeSourceBlock
            : null;
    if (field)
      requestAnimationFrame(() => showVimCursor(field, field.selectionStart));
  });
  $("#commandInput").addEventListener("input", () => {
    selectedCommand = -1;
    expandedCommandSections.clear();
    renderCommandList();
  });
  $("#commandInput").addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (
      event.key === "Tab" &&
      !event.shiftKey &&
      $(".command-palette").classList.contains("searching")
    ) {
      const firstPage = $("#recentPageList .command-item");
      if (firstPage) {
        event.preventDefault();
        firstPage.focus();
      }
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectedCommand = Math.min(
        selectedCommand + 1,
        filteredCommands.length - 1,
      );
      renderCommandList();
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      selectedCommand = Math.max(selectedCommand - 1, 0);
      renderCommandList();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runSelectedCommand();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeCommandPalette();
    }
  });
  $("#commandPalette").addEventListener("focusin", (event) => {
    const item = event.target.closest("[data-command-index]");
    if (!item) return;
    selectedCommand = Number(item.dataset.commandIndex);
    $$(".command-item", $("#commandPalette")).forEach((command) => {
      const selected = command === item;
      command.classList.toggle("selected", selected);
      command.setAttribute("aria-selected", String(selected));
    });
  });
  function handleCommandListClick(event) {
    const item = event.target.closest("[data-command-index]");
    if (item) runSelectedCommand(Number(item.dataset.commandIndex));
  }
  function expandCommandSection(section) {
    const button = $(`[data-command-section-more="${section}"]`);
    if (!button || button.hidden) return;
    const keepInputFocus = document.activeElement === $("#commandInput");
    const focusedIndex = document.activeElement.closest?.(
      "[data-command-index]",
    )?.dataset.commandIndex;
    expandedCommandSections.add(section);
    renderCommandList();
    if (keepInputFocus) $("#commandInput").focus();
    else if (focusedIndex != null)
      $(
        `[data-command-index="${focusedIndex}"]`,
        $("#commandPalette"),
      )?.focus();
  }
  $("#commandPalette").addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "ArrowDown" || (!event.ctrlKey && !event.metaKey))
        return;
      const activeSection = document.activeElement.closest?.(
        "[data-command-section]",
      )?.dataset.commandSection;
      const selectedSection = $(
        ".command-item.selected",
        $("#commandPalette"),
      )?.closest("[data-command-section]")?.dataset.commandSection;
      const section = activeSection || selectedSection;
      const button =
        (section &&
          $(`[data-command-section-more="${section}"]:not([hidden])`)) ||
        $("[data-command-section-more]:not([hidden])");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      expandCommandSection(button.dataset.commandSectionMore);
    },
    true,
  );
  $$("[data-command-section-more]").forEach((button) =>
    button.addEventListener("click", () =>
      expandCommandSection(button.dataset.commandSectionMore),
    ),
  );
  $("#createPageList").addEventListener("click", handleCommandListClick);
  $("#commandList").addEventListener("click", handleCommandListClick);
  $("#blockResultList").addEventListener("click", handleCommandListClick);
  $("#recentPageList").addEventListener("click", handleCommandListClick);
  $("#commandPalette").addEventListener("pointerdown", (event) => {
    if (event.target === $("#commandPalette")) closeCommandPalette();
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (file) loadMarkdown(await file.text(), file.name);
    fileInput.value = "";
  });
  assetInput.addEventListener("change", async () => {
    const file = assetInput.files[0];
    const target = assetUploadTarget;
    assetInput.value = "";
    assetUploadTarget = null;
    if (!file || !target) return;
    try {
      const path = await graphStore.writeAsset(file);
      const label = file.name.replace(/[\[\]]/g, "");
      const markdown = /^(?:image|audio|video)\//.test(file.type)
        ? `![${label}](${path})`
        : `[${label}](${path})`;
      if (target.field.isConnected) {
        target.field.setRangeText(markdown, target.start, target.end, "end");
        target.field.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertText" }),
        );
        target.field.focus();
      } else {
        target.block.content = `${target.block.content.slice(0, target.start)}${markdown}${target.block.content.slice(target.end)}`;
        graphChanged();
        focusGraphBlock(target.block.id, target.start + markdown.length);
      }
      toast(`Uploaded ${file.name}`);
    } catch (error) {
      toast(error.message || "Could not upload the file");
    }
  });
  fileName.addEventListener("focus", beginTitleEdit);
  fileName.addEventListener("input", () => {
    if (!state.graphMode) changed();
  });
  fileName.addEventListener("keydown", (event) => {
    if (!state.graphMode || documentTitleActions.hidden) return;
    if (event.key === "Enter") {
      event.preventDefault();
      $("#saveTitleButton").click();
    } else if (event.key === "Escape") {
      event.preventDefault();
      finishTitleEdit(true);
      fileName.blur();
    }
  });
  documentTitleActions.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) titleActionPointerActive = true;
  });
  const releaseTitleActionPointer = () =>
    setTimeout(() => {
      titleActionPointerActive = false;
    }, 0);
  documentTitleActions.addEventListener("pointerup", releaseTitleActionPointer);
  documentTitleActions.addEventListener(
    "pointercancel",
    releaseTitleActionPointer,
  );
  fileName.addEventListener("blur", (event) => {
    if (!fileName.value.trim())
      fileName.value = state.graphMode ? state.graphPage.title : "Untitled";
    if (!state.graphMode) {
      persistLocal(false);
      return;
    }
    if (
      titleActionPointerActive ||
      documentTitleActions.contains(event.relatedTarget)
    )
      return;
    finishTitleEdit(true);
  });
  documentTitleActions.addEventListener("focusout", () =>
    setTimeout(() => {
      if (
        !documentTitleActions.hidden &&
        !$(".document-title").contains(document.activeElement)
      )
        finishTitleEdit(true);
    }),
  );
  $("#saveTitleButton").addEventListener("click", async () => {
    if (await renameGraphPage(fileName.value)) {
      finishTitleEdit();
      outliner.focus({ preventScroll: true });
    }
  });
  let deletePagePointerHandledAt = 0;
  $("#deletePageButton").addEventListener("pointerup", (event) => {
    if (!usesMobileInput()) return;
    event.preventDefault();
    deletePagePointerHandledAt = Date.now();
    deleteCurrentGraphPage();
  });
  $("#deletePageButton").addEventListener("click", (event) => {
    if (Date.now() - deletePagePointerHandledAt < 600) {
      event.preventDefault();
      return;
    }
    deleteCurrentGraphPage();
  });
  $("#deleteConfirmDialog").addEventListener("click", (event) => {
    const action = event.target.closest("[data-delete-dialog]")?.dataset
      .deleteDialog;
    if (action === "cancel") closeDeletePageDialog();
    else if (action === "confirm") confirmDeleteCurrentGraphPage();
  });
  $("#deleteConfirmDialog").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDeletePageDialog();
    }
  });
  $("#assetCleanupDialog").addEventListener("click", (event) => {
    const action = event.target.closest("[data-asset-cleanup]")?.dataset
      .assetCleanup;
    if (action === "cancel") closeAssetCleanupDialog();
    else if (action === "confirm") closeAssetCleanupDialog(true);
  });
  $("#assetCleanupDialog").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeAssetCleanupDialog();
    }
  });
  editor.addEventListener("input", (event) => {
    if (
      !event.target.matches?.(".md-source-block") &&
      event.inputType?.startsWith("insert")
    )
      transformInlineMarkdown();
    changed();
  });
  sourceEditor.addEventListener("beforeinput", (event) => {
    if (!state.vimEnabled && /^(insert|delete)/.test(event.inputType || ""))
      recordVimChange(sourceEditor);
  });
  sourceEditor.addEventListener("input", changed);
  sourceEditor.addEventListener("keydown", (event) => {
    if (handleSelectionDelimiter(event)) return;
    handleWikiPair(event);
  });
  editor.addEventListener("paste", (event) => {
    if (event.target.matches?.(".md-source-block")) return;
    event.preventDefault();
    document.execCommand(
      "insertText",
      false,
      event.clipboardData.getData("text/plain"),
    );
  });
  editor.addEventListener("pointerdown", (event) => {
    if (
      state.sourceMode ||
      event.target.matches('input[type="checkbox"]') ||
      event.target.closest("button,audio,video,iframe") ||
      activeSourceBlock?.contains(event.target)
    )
      return;
    let block = event.target;
    while (block && block.parentElement !== editor) block = block.parentElement;
    if (!block || block === editor) {
      commitActiveBlock();
      return;
    }
    event.preventDefault();
    activateSourceBlock(block, { x: event.clientX, y: event.clientY });
  });
  editor.addEventListener("keydown", markdownShortcut);
  editor.addEventListener("click", (event) => {
    if (event.target.matches('input[type="checkbox"]')) {
      event.target.toggleAttribute("checked", event.target.checked);
      changed();
    }
  });

  function openImageLightbox(image, trigger = image) {
    const source = image.currentSrc || image.getAttribute("src");
    if (!source) return;
    imageLightboxTrigger = trigger;
    imageLightboxImage.src = source;
    imageLightboxImage.alt = image.alt || "Full-screen image";
    imageLightbox.hidden = false;
    document.body.classList.add("image-lightbox-open");
    requestAnimationFrame(() => $("#imageLightboxClose").focus());
  }

  function closeImageLightbox() {
    if (imageLightbox.hidden) return;
    imageLightbox.hidden = true;
    imageLightboxImage.removeAttribute("src");
    imageLightboxImage.alt = "";
    document.body.classList.remove("image-lightbox-open");
    if (imageLightboxTrigger?.isConnected)
      imageLightboxTrigger.focus({ preventScroll: true });
    imageLightboxTrigger = null;
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.(".image-expand-button");
    const image = button
      ?.closest(".image-embed-wrap")
      ?.querySelector("img.image-embed");
    if (!image) return;
    event.preventDefault();
    openImageLightbox(image, button);
  });
  imageLightbox.addEventListener("click", (event) => {
    if (
      event.target === imageLightbox ||
      event.target.closest("#imageLightboxClose")
    )
      closeImageLightbox();
  });
  document.addEventListener(
    "keydown",
    (event) => {
      if (!imageLightbox.hidden && event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeImageLightbox();
        return;
      }
    },
    true,
  );

  let blockSwipe = null;
  let suppressBlockClickUntil = 0;
  // Horizontal touch gestures mutate indentation while vertical movement remains native scrolling.
  const finishBlockSwipe = (event, canceled = false) => {
    const swipe = blockSwipe;
    if (!swipe || event.pointerId !== swipe.pointerId) return;
    blockSwipe = null;
    if (outliner.hasPointerCapture(event.pointerId))
      outliner.releasePointerCapture(event.pointerId);
    if (canceled) return;
    const deltaX = event.clientX - swipe.x;
    const deltaY = event.clientY - swipe.y;
    if (
      Math.abs(deltaX) < 56 ||
      Math.abs(deltaX) < Math.abs(deltaY) * 1.35 ||
      Date.now() - swipe.time > 1000
    )
      return;
    event.preventDefault();
    suppressBlockClickUntil = Date.now() + 500;
    const block = graphBlockLocation(swipe.blockId)?.block;
    if (!block) return;
    const outdent = deltaX < 0;
    const snapshot = captureVimSnapshot();
    if (!indentGraphBlock(block, outdent, false)) {
      toast(
        outdent
          ? "Block is already at the root"
          : "No previous block to indent under",
      );
      return;
    }
    pushVimSnapshot(vimUndoStack, snapshot);
    vimRedoStack.length = 0;
    navigator.vibrate?.(12);
    toast(outdent ? "Block outdented" : "Block indented");
  };
  outliner.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch" || event.button !== 0) return;
    if (
      event.target.closest(
        "button,a,input,textarea,select,audio,video,iframe",
      )
    )
      return;
    const row = event.target.closest(".block-row");
    const node = row?.closest(".block-node");
    if (!node || node.dataset.pagePath !== state.graphPage?.path) return;
    blockSwipe = {
      pointerId: event.pointerId,
      blockId: node.dataset.blockId,
      x: event.clientX,
      y: event.clientY,
      time: Date.now(),
    };
    outliner.setPointerCapture(event.pointerId);
  });
  outliner.addEventListener("pointermove", (event) => {
    if (!blockSwipe || event.pointerId !== blockSwipe.pointerId) return;
    const deltaX = event.clientX - blockSwipe.x;
    const deltaY = event.clientY - blockSwipe.y;
    if (Math.abs(deltaX) > 12 && Math.abs(deltaX) > Math.abs(deltaY) * 1.2)
      event.preventDefault();
  });
  outliner.addEventListener("pointerup", (event) => finishBlockSwipe(event));
  outliner.addEventListener("pointercancel", (event) =>
    finishBlockSwipe(event, true),
  );

  let taskLongPressTimer = null;
  let taskLongPressStart = null;
  let suppressTaskClickUntil = 0;
  const taskControlInfo = (control) =>
    control?.matches("[data-task-checkbox-page]")
      ? {
          pagePath: control.dataset.taskCheckboxPage,
          blockId: control.dataset.taskCheckboxBlock,
        }
      : control?.matches("[data-task-block]")
        ? {
            pagePath:
              control.closest(".block-node, .on-this-day-item")?.dataset
                .pagePath ||
              control.closest(".reference-result")?.dataset.referencePagePath ||
              state.graphPage?.path,
            blockId: control.dataset.taskBlock,
          }
        : null;
  const cancelTaskLongPress = () => {
    clearTimeout(taskLongPressTimer);
    taskLongPressTimer = null;
    taskLongPressStart = null;
  };
  outliner.addEventListener("pointerdown", (event) => {
    const control = event.target.closest(
      "[data-task-checkbox-page], [data-task-block]",
    );
    if (!control || event.button !== 0) return;
    if (event.shiftKey) {
      control.dataset.taskShiftClick = "true";
      setTimeout(() => {
        if (control.isConnected) delete control.dataset.taskShiftClick;
      }, 1000);
      return;
    }
    taskLongPressStart = { x: event.clientX, y: event.clientY };
    taskLongPressTimer = setTimeout(() => {
      const info = taskControlInfo(control);
      if (!info) return;
      suppressTaskClickUntil = Date.now() + 800;
      navigator.vibrate?.(20);
      updateTaskFromClick(info.pagePath, info.blockId, "doing", {
        feedbackElement: control.matches("[data-task-checkbox-page]")
          ? control
          : null,
      }).catch(taskUpdateFailed);
      taskLongPressTimer = null;
      taskLongPressStart = null;
    }, 550);
  });
  outliner.addEventListener("pointermove", (event) => {
    if (
      taskLongPressStart &&
      Math.hypot(
        event.clientX - taskLongPressStart.x,
        event.clientY - taskLongPressStart.y,
      ) > 10
    )
      cancelTaskLongPress();
  });
  outliner.addEventListener("pointerup", cancelTaskLongPress);
  outliner.addEventListener("pointercancel", cancelTaskLongPress);
  outliner.addEventListener("contextmenu", (event) => {
    if (event.target.closest("[data-task-checkbox-page], [data-task-block]"))
      event.preventDefault();
  });
  outliner.addEventListener("pointerdown", (event) => {
    if (!event.metaKey && !event.ctrlKey && !event.shiftKey) return;
    if (event.target.closest("[data-task-checkbox-page], [data-task-block]"))
      return;
    const node = event.target.closest(".block-node");
    if (
      node?.dataset.pagePath === state.graphPage?.path &&
      event.target.closest(".block-row")
    )
      event.preventDefault();
  });
  outliner.addEventListener("keydown", (event) => {
    if (
      (event.key === "Enter" || event.key === " ") &&
      event.target.matches(".reference-result, [data-task-page]")
    ) {
      event.preventDefault();
      event.target.click();
      return;
    }
    if (shortcutMatches("blockEscape", event) && selectedGraphBlockIds.size) {
      event.preventDefault();
      clearGraphBlockSelection();
      return;
    }
    if (shortcutMatches("blockDelete", event) && selectedGraphBlockIds.size) {
      event.preventDefault();
      deleteSelectedGraphBlocks();
    }
  });
  outliner.addEventListener("click", async (event) => {
    if (
      Date.now() < suppressBlockClickUntil &&
      event.target.closest(".block-node")
    ) {
      event.preventDefault();
      return;
    }
    const taskControl = event.target.closest(
      "[data-task-checkbox-page], [data-task-block]",
    );
    const selectionNode = event.target.closest(".block-node");
    if (
      !taskControl &&
      selectionNode &&
      event.target.closest(".block-row") &&
      (event.metaKey || event.ctrlKey || event.shiftKey) &&
      selectGraphBlocksWithMouse(selectionNode, event)
    ) {
      event.preventDefault();
      return;
    }
    if (
      selectedGraphBlockIds.size &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey
    )
      clearGraphBlockSelection();
    const newBlock = event.target.closest("[data-new-block-page]");
    if (newBlock) {
      await createGraphBlockFromPlaceholder(newBlock.dataset.newBlockPage);
      return;
    }
    const scheduledDate = event.target.closest("[data-scheduled-block]");
    if (scheduledDate) {
      event.preventDefault();
      event.stopPropagation();
      const pagePath =
        scheduledDate.dataset.scheduledPage ||
        scheduledDate.closest(
          ".block-node, .on-this-day-item, .reference-result",
        )?.dataset.pagePath ||
        scheduledDate.closest(".reference-result")?.dataset.referencePagePath;
      const blockId = scheduledDate.dataset.scheduledBlock;
      const initialDate = `${scheduledDate.dataset.scheduledDate}T12:00:00`;
      toggleJournalCalendar(
        (date) =>
          updateScheduledDate(pagePath, blockId, date).catch((error) =>
            toast(error.message || "Could not update the scheduled date"),
          ),
        scheduledDate.getBoundingClientRect(),
        initialDate,
      );
      return;
    }
    if (event.target.closest("[data-open-task-view]")) {
      if (state.taskView === "summary") {
        state.taskView = null;
        state.taskSummaryIds = [];
      } else {
        state.taskView = "summary";
        state.taskSummaryIds = taskOverviewGroups().today.map(
          taskPersistenceId,
        );
      }
      renderGraphPage();
      return;
    }
    if (event.target.closest("[data-close-task-view]")) {
      if (state.graphPage?.name.toLowerCase() === "tasks.md") {
        if (graphHistoryIndex > 0) await navigateGraphHistory(-1);
        else await openToday();
      } else {
        state.taskView = null;
        renderGraphPage();
      }
      return;
    }
    const taskMore = event.target.closest("[data-task-more]");
    if (taskMore) {
      const key = taskMore.dataset.taskMore;
      state.taskLimits[key] = (state.taskLimits[key] || 10) + 10;
      state.taskExpanded[key] = true;
      renderGraphPage();
      return;
    }
    const taskFilter = event.target.closest("[data-task-filter]");
    if (taskFilter) {
      if (taskFilter.dataset.taskFilter === "all") await openTasksPage();
      else {
        state.taskView = taskFilter.dataset.taskFilter;
        renderGraphPage();
      }
      return;
    }
    const taskCheckbox = event.target.closest("[data-task-checkbox-page]");
    if (taskCheckbox) {
      if (Date.now() < suppressTaskClickUntil) return;
      const action =
        event.shiftKey || taskCheckbox.dataset.taskShiftClick === "true"
          ? "doing"
          : "complete";
      delete taskCheckbox.dataset.taskShiftClick;
      await updateTaskFromClick(
        taskCheckbox.dataset.taskCheckboxPage,
        taskCheckbox.dataset.taskCheckboxBlock,
        action,
        { feedbackElement: taskCheckbox },
      ).catch(taskUpdateFailed);
      return;
    }
    const taskSource = event.target.closest("[data-task-page]");
    if (
      taskSource &&
      !event.target.closest("a, button, audio, video, iframe")
    ) {
      const page = graphStore?.pages.find(
        (item) => item.path === taskSource.dataset.taskPage,
      );
      if (page)
        loadGraphPage(page, { blockId: taskSource.dataset.taskBlockId });
      return;
    }
    const onThisDayBlock = event.target.closest("[data-on-this-day-page]");
    if (onThisDayBlock) {
      const page = graphStore?.pages.find(
        (item) => item.path === onThisDayBlock.dataset.onThisDayPage,
      );
      if (page)
        await loadGraphPage(page, {
          blockId: onThisDayBlock.dataset.onThisDayBlock,
        });
      return;
    }
    if (event.target.closest("[data-on-this-day-dismiss]")) {
      state.onThisDayEmptyDismissed = true;
      state.onThisDayExpanded = false;
      renderGraphPage();
      return;
    }
    if (event.target.closest("[data-on-this-day-toggle]")) {
      const expanding = !state.onThisDayExpanded;
      state.onThisDayExpanded = expanding;
      renderGraphPage();
      if (expanding) requestAnimationFrame(scrollOnThisDayIntoView);
      return;
    }
    const journalHeading = event.target.closest("[data-journal-page]");
    if (journalHeading) {
      openSingleJournalPage(journalHeading.dataset.journalPage);
      return;
    }
    if (event.target.closest("[data-journal-more]")) {
      state.journalLimit += 8;
      renderGraphPage();
      return;
    }
    const blockNode = event.target.closest(".block-node, .on-this-day-item");
    const pagePath =
      blockNode?.dataset.pagePath ||
      event.target.closest(".reference-result")?.dataset.referencePagePath;
    const task = event.target.closest("[data-task-block]");
    if (task) {
      if (Date.now() < suppressTaskClickUntil) return;
      const action =
        event.shiftKey || task.dataset.taskShiftClick === "true"
          ? "doing"
          : "complete";
      delete task.dataset.taskShiftClick;
      await updateTaskFromClick(
        pagePath || state.graphPage?.path,
        task.dataset.taskBlock,
        action,
      ).catch(taskUpdateFailed);
      return;
    }
    const assetLink = event.target.closest("a[data-graph-asset]");
    if (assetLink) {
      if (assetLink.dataset.graphAssetReady === "true") return;
      event.preventDefault();
      toast("Attachment is still loading");
      return;
    }
    const pageLink = event.target.closest("[data-page]");
    if (pageLink) {
      event.preventDefault();
      loadGraphPage(pageLink.dataset.page, { virtual: true });
      return;
    }
    const blockReference = event.target.closest("[data-block-ref]");
    if (blockReference) {
      const resolved = graphIndex?.resolveBlock(
        blockReference.dataset.blockRef,
      );
      if (resolved)
        loadGraphPage(resolved.page, { blockId: resolved.block.id });
      else toast("Referenced block not found");
      return;
    }
    const reference = event.target.closest("[data-reference-page]");
    if (reference && !event.target.closest("button,a,audio,video,iframe")) {
      const contextBlock = event.target.closest("[data-context-block-id]");
      loadGraphPage(reference.dataset.referencePage, {
        blockId:
          contextBlock?.dataset.contextBlockId ||
          reference.dataset.referenceBlock,
      });
      return;
    }
    if (event.target.closest("[data-show-unlinked]")) {
      renderReferences(true);
      return;
    }
    if (event.target.closest("[data-show-all-references]")) {
      state.referencesExpanded = true;
      renderReferences(!references.querySelector("[data-show-unlinked]"));
      return;
    }
    if (event.target.closest("[data-clear-zoom]")) {
      state.graphZoomId = null;
      renderGraphPage();
      return;
    }
    const contextToggle = event.target.closest("[data-context-block-toggle]");
    if (contextToggle) {
      const node = contextToggle.closest(".context-block-node");
      const collapsed = node.classList.toggle("collapsed");
      contextToggle.setAttribute("aria-expanded", String(!collapsed));
      contextToggle.setAttribute(
        "aria-label",
        collapsed ? "Expand nested blocks" : "Collapse nested blocks",
      );
      return;
    }
    const toggle = event.target.closest("[data-block-toggle]");
    if (toggle) {
      const page =
        state.journalMode && pagePath && pagePath !== state.graphPage.path
          ? graphStore?.pages.find((item) => item.path === pagePath)
          : state.graphPage;
      const document =
        page && page.path !== state.graphPage.path
          ? cachedJournalDocument(page)
          : state.graphDocument;
      if (!page || !document) return;
      const block = graphBlockLocation(
        toggle.dataset.blockToggle,
        document.blocks,
      )?.block;
      if (block) toggleGraphBlockCollapse(block, toggle, document, page);
      return;
    }
    const bullet = event.target.closest("[data-block-bullet]");
    if (bullet) {
      if (state.journalMode && pagePath && pagePath !== state.graphPage.path)
        activateJournalBlock(pagePath, bullet.dataset.blockBullet, "zoom");
      else {
        const block = graphBlockLocation(bullet.dataset.blockBullet)?.block;
        if (block) {
          commitGraphBlock();
          block.collapsed = false;
          saveGraphCollapse();
          state.graphZoomId = block.id;
          focusGraphBlock(block.id);
        }
      }
      return;
    }
    const content = event.target.closest(".graph-block-content");
    if (content && !event.target.closest("button,a,audio,video,iframe")) {
      if (
        state.journalMode &&
        content.dataset.pagePath !== state.graphPage.path
      )
        activateJournalBlock(content.dataset.pagePath, content.dataset.blockId);
      else
        activateGraphBlock(graphBlockLocation(content.dataset.blockId)?.block);
    }
  });
  $("#addBlock").addEventListener("click", () => {
    const block = {
      id: NotnoteGraph.newId(),
      uuid: null,
      content: "",
      marker: "-",
      children: [],
      collapsed: false,
    };
    state.graphDocument.blocks.push(block);
    graphMutationFocus(block, 0);
  });
  graphAutocomplete.addEventListener("pointerdown", (event) =>
    event.preventDefault(),
  );
  graphAutocomplete.addEventListener("click", (event) => {
    const item = event.target.closest("[data-autocomplete-index]");
    if (item) chooseGraphAutocomplete(Number(item.dataset.autocompleteIndex));
  });

  const systemColorScheme = matchMedia("(prefers-color-scheme: dark)");
  let selectedTheme = "system";
  let selectedAccent = "#3f7fba";
  function applyTheme() {
    const effectiveTheme =
      selectedTheme === "system"
        ? systemColorScheme.matches
          ? "dark"
          : "light"
        : selectedTheme;
    document.documentElement.classList.toggle(
      "theme-dark",
      effectiveTheme === "dark",
    );
    document.documentElement.classList.toggle(
      "theme-system",
      selectedTheme === "system",
    );
    app.classList.toggle("theme-dark", effectiveTheme === "dark");
    app.classList.toggle("theme-system", selectedTheme === "system");
    document.documentElement.style.colorScheme = effectiveTheme;
    $('meta[name="theme-color"]')?.setAttribute(
      "content",
      effectiveTheme === "dark" ? "#282725" : "#fdfcfb",
    );
  }
  function setTheme(theme, persist = true) {
    selectedTheme = ["light", "dark", "system"].includes(theme)
      ? theme
      : "system";
    applyTheme();
    rememberBootAppearance({ theme: selectedTheme });
    if (persist) saveSettings({ theme: selectedTheme });
  }
  function setAccent(color, persist = true) {
    selectedAccent = /^#[0-9a-f]{6}$/i.test(color || "") ? color : "#3f7fba";
    document.documentElement.style.setProperty("--accent", selectedAccent);
    rememberBootAppearance({ accentColor: selectedAccent });
    if (persist) saveSettings({ accentColor: selectedAccent });
  }
  if (systemColorScheme.addEventListener)
    systemColorScheme.addEventListener("change", () => {
      if (selectedTheme === "system") applyTheme();
    });
  else
    systemColorScheme.addListener(() => {
      if (selectedTheme === "system") applyTheme();
    });
  function saveSettings(change) {
    const updated = { ...currentSettings(), ...change };
    if (graphStore && graphSettings !== null) {
      graphSettings = updated;
      clearTimeout(graphSettingsTimer);
      const store = graphStore;
      const value = graphSettings;
      graphSettingsTimer = setTimeout(
        () =>
          store
            .writeSettings(value)
            .catch(() => toast("Could not save graph settings")),
        180,
      );
    } else localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
  }

  const ASSET_CACHE_SIZES = [50, 100, 200, 500, 1000];
  function assetCacheSize() {
    const value = Number(localSettings().assetCacheSizeMB);
    return ASSET_CACHE_SIZES.includes(value) ? value : 200;
  }
  function syncAssetCacheSize() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready
      .then((registration) => {
        const worker =
          navigator.serviceWorker.controller || registration.active;
        worker?.postMessage({
          type: "configure-asset-cache",
          maxBytes: assetCacheSize() * 1024 * 1024,
        });
      })
      .catch(() => {});
  }
  function setAssetCacheSize(value) {
    const size = Number(value);
    if (!ASSET_CACHE_SIZES.includes(size)) return;
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ ...localSettings(), assetCacheSizeMB: size }),
    );
    syncAssetCacheSize();
  }

  async function loadGraphSettings() {
    if (!graphStore.isRemote && graphStore.readConfig)
      await graphStore.readConfig();
    const importedJournal = { ...graphStore.config };
    const stored = await graphStore.readSettings();
    let migrated = false;
    if (stored) {
      graphSettings = stored;
      if (graphSettings.schemaVersion !== 1) {
        graphSettings = { ...graphSettings, schemaVersion: 1 };
        migrated = true;
      }
      if (!graphSettings.journal || typeof graphSettings.journal !== "object") {
        graphSettings = { ...graphSettings, journal: importedJournal };
        migrated = true;
      }
    } else {
      const local = localSettings();
      graphSettings = {
        schemaVersion: 1,
        ...Object.fromEntries(
          [
            "theme",
            "accentColor",
            "vimEnabled",
            "shortcuts",
            "graphCollapsed",
            "lastGraphPage",
            "recentGraphPages",
          ]
            .filter((key) => key in local)
            .map((key) => [key, local[key]]),
        ),
        journal: importedJournal,
      };
      migrated = true;
    }
    graphStore.applySettings(graphSettings);
    if (migrated) await graphStore.writeSettings(graphSettings);
    setTheme(graphSettings.theme || "system", false);
    setAccent(graphSettings.accentColor || "#3f7fba", false);
    setVimEnabled(Boolean(graphSettings.vimEnabled), false, false);
  }

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
      if (event.key === "Escape") {
        event.preventDefault();
        closeDocumentation();
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
  let externalCheckTime = 0;
  function scheduleRemoteRefresh() {
    clearTimeout(remoteRefreshTimer);
    remoteRefreshTimer = setTimeout(() => checkExternalGraphPage(true), 120);
  }

  function watchRemoteGraph() {
    closeRemoteEvents?.();
    closeRemoteEvents = null;
    if (!graphStore?.isRemote || graphStore.offline || !graphStore.subscribe)
      return;
    closeRemoteEvents = graphStore.subscribe((event) => {
      const currentPath = state.graphPage?.path;
      if (
        event.path === currentPath &&
        event.revision &&
        String(event.revision) === String(state.graphPage.lastModified)
      )
        return;
      if (state.dirty) {
        remoteRefreshPending = true;
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
  async function syncOfflineGraph() {
    if (!graphStore?.isRemote || !navigator.onLine) return false;
    if (remoteSyncing) return remoteSyncing;
    const store = graphStore;
    remoteSyncing = (async () => {
      try {
        const pending = store.pendingCount || 0;
        saveState.textContent = pending
          ? `Syncing ${pending} changes…`
          : "Checking connection…";
        await store.reconnect();
        const synced = await store.syncPending();
        if (graphStore !== store) return false;
        await loadGraphSettings();
        const pages = await store.scan();
        if (graphStore !== store) return false;
        graphIndex = new NotnoteGraph.GraphIndex(pages);
        journalDocuments.clear();
        const current =
          state.graphPage &&
          pages.find((page) => page.path === state.graphPage.path);
        if (current && !state.dirty) {
          state.graphPage = current;
          state.graphDocument = NotnoteGraph.parseDocument(current.content);
          restoreGraphCollapse();
          if (state.journalMode)
            journalDocuments.set(current.path, state.graphDocument);
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
        const fresh = await graphStore.freshFile(state.graphPage);
        if (fresh.lastModified !== state.graphPage.lastModified) {
          state.graphConflict = true;
          saveState.textContent = "Conflict";
        }
        return;
      }
      const currentPath = state.graphPage.path;
      const previousModified = state.graphPage.lastModified;
      const pages = await graphStore.scan();
      const current = pages.find((page) => page.path === currentPath);
      graphIndex = new NotnoteGraph.GraphIndex(pages);
      if (!current) {
        remoteRefreshPending = false;
        saveState.textContent = "Page removed";
        return;
      }
      state.graphPage = current;
      journalDocuments.clear();
      remoteRefreshPending = false;
      if (current.lastModified !== previousModified) {
        state.graphDocument = NotnoteGraph.parseDocument(current.content);
        restoreGraphCollapse();
        updateStats();
        saveState.textContent = "Reloaded";
        toast("Page reloaded from disk");
      }
      if (state.journalMode) {
        journalDocuments.set(current.path, state.graphDocument);
        renderGraphPage();
      } else if (current.lastModified !== previousModified) renderGraphPage();
      else renderReferences();
    } catch {
      if (graphStore?.isRemote && graphStore.offline)
        saveState.textContent = graphStatusLabel();
    }
  }
  window.addEventListener("online", () => syncOfflineGraph());
  window.addEventListener("focus", () => {
    if (graphStore?.isRemote && (graphStore.offline || graphStore.pendingCount))
      syncOfflineGraph();
    else checkExternalGraphPage();
  });
  window.addEventListener("popstate", async () => {
    const route = graphRoute();
    if (!route) {
      if (!state.graphMode) return;
      if (state.dirty && !(await flushGraphSave(true))) return;
      loadInitialDocument();
      return;
    }
    if (!graphStore || !graphIndex) return;
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
        graphStore?.isRemote &&
        (graphStore.offline || graphStore.pendingCount)
      )
        syncOfflineGraph();
      else checkExternalGraphPage();
    } else if (state.graphMode) flushGraphSave(false);
  });
  let journalScrollLoading = false;
  notnoteWrap.addEventListener("scroll", () => {
    if (
      !state.journalMode ||
      state.graphZoomId ||
      activeGraphBlock ||
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
  let settings = { ...localSettings(), ...bootAppearance() };
  const savedTheme = ["light", "dark", "system"].includes(settings.theme)
    ? settings.theme
    : "system";
  setTheme(savedTheme, false);
  setAccent(settings.accentColor || "#3f7fba", false);
  setVimEnabled(Boolean(settings.vimEnabled), false, false);
  let docs = getStoredDocs();
  if (settings.welcomeVersion !== WELCOME_VERSION) {
    const welcome = docs.find(
      (doc) => doc.name === "Welcome" || doc.name === "Benvenuto",
    );
    if (welcome) {
      welcome.name = "Welcome";
      welcome.markdown = starter;
      welcome.updated = Date.now();
    } else if (docs.length)
      docs = [
        ...docs.slice(0, 9),
        {
          id: "notnote-welcome",
          name: "Welcome",
          markdown: starter,
          updated: Date.now(),
        },
      ];
    if (docs.length)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(docs.slice(0, 10)));
    saveSettings({ welcomeVersion: WELCOME_VERSION });
  }
  function loadInitialDocument(options = {}) {
    const storedDocs = getStoredDocs();
    if (storedDocs.length)
      loadMarkdown(storedDocs[0].markdown, storedDocs[0].name, {
        id: storedDocs[0].id,
        ...options,
      });
    else loadMarkdown(starter, "Welcome", options);
  }

  app.classList.add("initial-loading");
  saveState.textContent = "Loading…";
  (async () => {
    try {
      const remote = await NotnoteGraph.RemoteGraphStore.connect(
        "/api/graph",
        { preferCache: true },
      );
      graphStore = remote;
      graphSettings = null;
      await loadGraphSettings();
      const pages = await graphStore.scan();
      graphIndex = new NotnoteGraph.GraphIndex(pages);
      watchRemoteGraph();
      if (state.dirty) return;
      journalDocuments.clear();
      graphHistory = [];
      graphHistoryIndex = -1;
      await openGraphLanding({ replaceRoute: true });
      saveState.textContent = graphStatusLabel();
      if (navigator.onLine && (remote.offline || remote.pendingCount))
        setTimeout(syncOfflineGraph, 0);
      return;
    } catch {}
    try {
      const restored = await NotnoteGraph.GraphStore.restore();
      if (restored && (await restored.ensurePermission(false))) {
        graphStore = restored;
        graphSettings = null;
        await loadGraphSettings();
        const pages = await graphStore.scan();
        graphIndex = new NotnoteGraph.GraphIndex(pages);
        if (state.dirty) return;
        journalDocuments.clear();
        graphHistory = [];
        graphHistoryIndex = -1;
        await openGraphLanding({ replaceRoute: true });
        return;
      }
    } catch {}
    if (!state.dirty)
      loadInitialDocument({ preserveGraphRoute: Boolean(graphRoute()) });
  })().finally(() => app.classList.remove("initial-loading"));

  if ("launchQueue" in window) {
    window.launchQueue.setConsumer(async (launchParams) => {
      const handle = launchParams.files?.[0];
      if (!handle) return;
      const file = await handle.getFile();
      requestAction(async () =>
        loadMarkdown(await file.text(), file.name, { handle }),
      );
    });
  }
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker
      .register("sw.js")
      .then((registration) => {
        syncAssetCacheSize();
        setTimeout(() => registration.update().catch(() => {}), 1000);
      })
      .catch(() => {});
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      syncAssetCacheSize,
    );
  }
})();
