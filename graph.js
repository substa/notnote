/**
 * DOM-free graph model, index, and storage adapters.
 * The classic-script wrapper keeps the same implementation usable by browser bundles and Node VM tests.
 */
(() => {
  "use strict";

  const DB_NAME = "notnote-graph-v1";
  const DB_VERSION = 2;
  const HANDLE_KEY = "last-graph";
  const markdownFile = /\.(md|markdown)$/i;
  const nestedGraphCopy = (path) =>
    /^(pages|journals)\/\1\//i.test(String(path || "").replace(/\\/g, "/"));

  // Normalize every page key once so links, aliases, and filenames resolve consistently.
  const normalizePage = (value) => {
    let normalized = String(value || "")
      .trim()
      .replace(/___/g, "/");
    try {
      normalized = decodeURIComponent(normalized);
    } catch {}
    return normalized
      .normalize("NFC")
      .replace(/\s*\/\s*/g, "/")
      .replace(/\s+/g, " ")
      .toLocaleLowerCase();
  };
  // Search keys ignore diacritics without changing page identity or link resolution.
  const normalizeSearch = (value) =>
    normalizePage(value).normalize("NFD").replace(/\p{M}/gu, "");
  // Resolve relative assets lexically; storage adapters enforce the final graph boundary.
  function resolveAssetPath(reference, fromFolder = "pages") {
    const raw = String(reference || "")
      .trim()
      .replace(/^<|>$/g, "")
      .split(/[?#]/)[0];
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {}
    const parts = `${decoded.startsWith("/") ? "" : fromFolder}/${decoded}`
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean);
    const normalized = [];
    for (const part of parts) {
      if (part === ".") continue;
      if (part === "..") normalized.pop();
      else normalized.push(part);
    }
    return normalized.join("/");
  }
  function assetReferenceCorpus(content) {
    const source = String(content || "");
    try {
      return { source, decoded: decodeURIComponent(source) };
    } catch {
      return { source, decoded: source };
    }
  }

  // Preserve assets when even a non-standard raw or encoded occurrence exists in Markdown.
  function contentMentionsAsset(content, path) {
    const corpus =
      content && typeof content === "object"
        ? content
        : assetReferenceCorpus(content);
    const source = corpus.source;
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const name = path.split("/").at(-1) || path;
    const variants = new Set([
      path,
      encodedPath,
      path.replaceAll("/", "\\"),
      name,
      encodeURIComponent(name),
    ]);
    return (
      [...variants].some((value) => source.includes(value)) ||
      corpus.decoded.includes(path) ||
      corpus.decoded.includes(name)
    );
  }

  // Scan every candidate filename in linear time instead of rescanning all notes per asset.
  function referencedAssetPaths(content, paths) {
    if (!paths.length) return new Set();
    const corpus =
      content && typeof content === "object"
        ? content
        : assetReferenceCorpus(content);
    const nodes = [{ next: new Map(), fail: 0, outputs: [] }];
    paths.forEach((path, index) => {
      const name = path.split("/").at(-1) || path;
      const patterns = new Set([
        path,
        path.split("/").map(encodeURIComponent).join("/"),
        path.replaceAll("/", "\\"),
        name,
        encodeURIComponent(name),
      ]);
      for (const pattern of patterns) {
        let state = 0;
        for (const character of pattern) {
          if (!nodes[state].next.has(character)) {
            nodes[state].next.set(character, nodes.length);
            nodes.push({ next: new Map(), fail: 0, outputs: [] });
          }
          state = nodes[state].next.get(character);
        }
        nodes[state].outputs.push(index);
      }
    });
    const queue = [...nodes[0].next.values()];
    for (let position = 0; position < queue.length; position++) {
      const state = queue[position];
      for (const [character, next] of nodes[state].next) {
        queue.push(next);
        let fallback = nodes[state].fail;
        while (fallback && !nodes[fallback].next.has(character))
          fallback = nodes[fallback].fail;
        nodes[next].fail = nodes[fallback].next.get(character) ?? 0;
        nodes[next].outputs.push(...nodes[nodes[next].fail].outputs);
      }
    }
    const referenced = new Set();
    const scan = (source) => {
      let state = 0;
      for (const character of source) {
        while (state && !nodes[state].next.has(character))
          state = nodes[state].fail;
        state = nodes[state].next.get(character) ?? 0;
        nodes[state].outputs.forEach((index) => referenced.add(paths[index]));
      }
    };
    scan(corpus.source);
    if (corpus.decoded !== corpus.source) scan(corpus.decoded);
    return referenced;
  }

  // Bound parallel filesystem or network mutations to keep large cleanups responsive.
  async function settleInBatches(items, worker, concurrency = 8) {
    const results = [];
    for (let index = 0; index < items.length; index += concurrency) {
      results.push(
        ...(await Promise.allSettled(
          items.slice(index, index + concurrency).map(worker),
        )),
      );
    }
    return results;
  }

  const newId = () =>
    crypto.randomUUID?.() ||
    `notnote-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const hash = (value) => {
    let result = 2166136261;
    for (let i = 0; i < value.length; i++)
      result = Math.imul(result ^ value.charCodeAt(i), 16777619);
    return (result >>> 0).toString(36);
  };

  // IndexedDB stores handles, drafts, and remote replicas without mixing their lifecycles.
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("state"))
          db.createObjectStore("state");
        if (!db.objectStoreNames.contains("drafts"))
          db.createObjectStore("drafts");
        if (!db.objectStoreNames.contains("remoteGraphs"))
          db.createObjectStore("remoteGraphs");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function dbRequest(store, mode, action) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = action(transaction.objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => db.close();
    });
  }

  const setState = (key, value) =>
    dbRequest("state", "readwrite", (store) => store.put(value, key));
  const getState = (key) =>
    dbRequest("state", "readonly", (store) => store.get(key));
  const saveDraft = (path, value) =>
    dbRequest("drafts", "readwrite", (store) =>
      store.put({ ...value, savedAt: Date.now() }, path),
    );
  const getDraft = (path) =>
    dbRequest("drafts", "readonly", (store) => store.get(path));
  const removeDraft = (path) =>
    dbRequest("drafts", "readwrite", (store) => store.delete(path));
  const getRemoteGraph = (key) =>
    dbRequest("remoteGraphs", "readonly", (store) => store.get(key));
  const saveRemoteGraph = (key, value) =>
    dbRequest("remoteGraphs", "readwrite", (store) => store.put(value, key));

  function indentationWidth(value) {
    let width = 0;
    for (const character of value) width += character === "\t" ? 2 : 1;
    return width;
  }

  function normalizePdfEmbeds(markdown = "") {
    return String(markdown).replace(
      /!\[([^\]]*)\]\(([^\s)]+)(\s+["'][^"']*["'])?\)/gi,
      (whole, label, url, title = "") => {
        let path = url.split(/[?#]/)[0];
        try {
          path = decodeURIComponent(path);
        } catch {}
        return /\.pdf$/i.test(path) ? `[${label}](${url}${title})` : whole;
      },
    );
  }

  // Generated placeholder pages contain either no text or one empty list marker.
  function isEmptyPageContent(content) {
    const value = String(content || "").trim();
    return !value || /^[-*+]\s*$/.test(value);
  }

  function propertiesFrom(text) {
    const properties = {};
    for (const match of text.matchAll(/^\s*([\w-]+)::\s*(.*?)\s*$/gm))
      properties[match[1].toLowerCase()] = match[2];
    return properties;
  }

  function pageAliases(document) {
    const properties = propertiesFrom((document?.preamble || []).join("\n"));
    return String(properties.alias || "")
      .split(",")
      .map((item) => item.trim().replace(/^\[\[|\]\]$/g, ""))
      .filter(Boolean);
  }

  // Parse indentation into a tree while retaining preamble metadata and unknown block text.
  function parseDocument(markdown = "") {
    const source = normalizePdfEmbeds(markdown).replace(/\r\n?/g, "\n");
    const lines = source.split("\n");
    const indents = lines
      .map((line) => line.match(/^([ \t]*)[-+*]\s/)?.[1])
      .filter((value) => value && indentationWidth(value));
    const unit = Math.max(1, Math.min(4, ...indents.map(indentationWidth), 2));
    const document = {
      preamble: [],
      blocks: [],
      trailingNewline: source.endsWith("\n"),
    };
    const stack = [];
    let current = null;
    let inFence = false;
    let inOrgQuote = false;

    lines.forEach((line, lineNumber) => {
      if (lineNumber === lines.length - 1 && !line && document.trailingNewline)
        return;
      const bullet =
        !inFence &&
        !inOrgQuote &&
        line.match(/^([ \t]*)([-+*])(?:\s(.*)|\s*)$/);
      if (bullet) {
        let depth = Math.floor(indentationWidth(bullet[1]) / unit);
        depth = Math.min(depth, stack.length);
        const content = bullet[3] || "";
        const properties = propertiesFrom(content);
        const block = {
          id: properties.id || `line-${lineNumber}-${hash(content)}`,
          uuid: properties.id || null,
          content,
          marker: bullet[2],
          children: [],
          collapsed: false,
          line: lineNumber,
        };
        const siblings =
          depth === 0 ? document.blocks : stack[depth - 1].children;
        siblings.push(block);
        stack.length = depth;
        stack[depth] = block;
        current = block;
        if (/^\s*(```|~~~)/.test(content)) inFence = true;
        if (/^\s*#\+BEGIN_QUOTE\b/i.test(content)) inOrgQuote = true;
        return;
      }

      if (!current) {
        document.preamble.push(line);
        return;
      }

      const expected = " ".repeat((stack.length + 1) * unit);
      const continuation = line.startsWith(expected)
        ? line.slice(expected.length)
        : line.replace(/^\s{1,2}/, "");
      current.content += `\n${continuation}`;
      if (/^\s*(```|~~~)/.test(continuation)) inFence = !inFence;
      if (/^\s*#\+BEGIN_QUOTE\b/i.test(continuation)) inOrgQuote = true;
      if (/^\s*#\+END_QUOTE\s*$/i.test(continuation)) inOrgQuote = false;
    });

    while (document.preamble.length && document.preamble.at(-1) === "")
      document.preamble.pop();
    for (const { block } of flattenBlocks(document.blocks)) {
      const uuid = propertiesFrom(block.content).id;
      if (uuid) {
        block.uuid = uuid;
        block.id = uuid;
      }
    }
    if (
      !document.blocks.length &&
      !document.preamble.some((line) => line.trim())
    )
      document.blocks.push({
        id: newId(),
        uuid: null,
        content: "",
        marker: "-",
        children: [],
        collapsed: false,
        line: 0,
      });
    return document;
  }

  function templateName(block) {
    return String(block?.content || "")
      .split("\n", 1)[0]
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .trim();
  }

  function templatesFromDocument(document) {
    const seen = new Set();
    return (document?.blocks || []).flatMap((block) => {
      const name = templateName(block);
      const key = normalizePage(name);
      if (!name || !block.children?.length || seen.has(key)) return [];
      seen.add(key);
      return [{ name, block }];
    });
  }

  function copyBlockTree(blocks, omittedProperties, createId = newId) {
    const propertyPattern = new RegExp(
      `^\\s*(?:${omittedProperties.join("|")})::`,
      "i",
    );
    const clone = (block) => ({
      id: createId(),
      uuid: null,
      content: String(block?.content || "")
        .split("\n")
        .filter((line) => !propertyPattern.test(line))
        .join("\n"),
      marker: block?.marker || "-",
      children: (block?.children || []).map(clone),
      collapsed: false,
    });
    return (blocks || []).map(clone);
  }

  function copyBlocksForTemplate(blocks, createId = newId) {
    return copyBlockTree(blocks, ["id", "completed-at"], createId);
  }

  function copyBlocksForPaste(blocks, createId = newId) {
    return copyBlockTree(blocks, ["id"], createId);
  }

  function instantiateTemplate(blocks, variables = {}, createId = newId) {
    let cursorBlockId = null;
    let cursorPosition = null;
    const firstBlock = { id: null, position: 0 };
    const expandContent = (content, blockId) => {
      let value = String(content || "")
        .split("\n")
        .filter((line) => !/^\s*(?:id|completed-at)::/i.test(line))
        .join("\n")
        .replace(/\{\{\s*(date|time|today|page)\s*\}\}/gi, (whole, key) =>
          Object.hasOwn(variables, key.toLowerCase())
            ? String(variables[key.toLowerCase()])
            : whole,
        );
      const marker = "{{cursor}}";
      const markerIndex = value.indexOf(marker);
      if (markerIndex >= 0 && cursorBlockId === null) {
        cursorBlockId = blockId;
        cursorPosition = markerIndex;
      }
      return value.replace(/\{\{cursor\}\}/gi, "");
    };
    const clone = (block) => {
      const id = createId();
      const content = expandContent(block.content, id);
      if (firstBlock.id === null) {
        firstBlock.id = id;
        firstBlock.position = content.length;
      }
      return {
        id,
        uuid: null,
        content,
        marker: block.marker || "-",
        children: (block.children || []).map(clone),
        collapsed: false,
      };
    };
    const result = (blocks || []).map(clone);
    return {
      blocks: result,
      cursorBlockId: cursorBlockId || firstBlock.id,
      cursorPosition:
        cursorPosition === null ? firstBlock.position : cursorPosition,
    };
  }

  // Serialize the tree deterministically so structural edits produce small Markdown diffs.
  function serializeDocument(document) {
    const output = [...(document.preamble || [])];
    const hasPersistentBlocks = document.blocks?.some(
      (block) => !block.transient,
    );
    if (output.length && hasPersistentBlocks) output.push("");
    const visit = (blocks, depth) => {
      for (const block of blocks) {
        // The outliner keeps its final “new block” editor in memory until the
        // user types. It is UI state and must never leak into Markdown.
        if (block.transient) continue;
        const lines = String(block.content ?? "").split("\n");
        output.push(
          `${"  ".repeat(depth)}${block.marker || "-"} ${lines.shift() || ""}`,
        );
        for (const line of lines)
          output.push(`${"  ".repeat(depth + 1)}${line}`);
        visit(block.children || [], depth + 1);
      }
    };
    visit(document.blocks || [], 0);
    const result = output.join("\n").replace(/^\n+/, "");
    return result + (document.trailingNewline && result ? "\n" : "");
  }

  function flattenBlocks(blocks, result = [], parent = null) {
    for (const block of blocks || []) {
      result.push({ block, parent });
      flattenBlocks(block.children, result, block);
    }
    return result;
  }

  // Strip fenced source before indexing so code examples never become graph entities.
  function indexableText(text) {
    const output = [];
    let fence = null;
    for (const line of String(text || "").split("\n")) {
      if (fence) {
        const closing = line.match(/^\s*(`+|~+)\s*$/)?.[1];
        if (
          closing &&
          closing[0] === fence.character &&
          closing.length >= fence.length
        )
          fence = null;
        continue;
      }
      const opening = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
      if (opening) {
        fence = { character: opening[0], length: opening.length };
        continue;
      }
      output.push(line);
    }
    return output.join("\n");
  }

  function pageReferences(text) {
    return [...indexableText(text).matchAll(/\[\[([^\]]+?)\]\]/g)].map(
      (match) => match[1].split("|")[0].trim(),
    );
  }

  function blockReferences(text) {
    return [
      ...indexableText(text).matchAll(/\(\(([0-9a-z-]{8,})\)\)/gi),
    ].map((match) => match[1]);
  }

  function tags(text) {
    return [
      ...indexableText(text).matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu),
    ].map((match) => match[2]);
  }

  function trailingTagQuery(text) {
    const match = String(text || "").match(
      /(?:^|\s)#([\p{L}\p{N}_/-]*)$/u,
    );
    if (!match) return null;
    return {
      query: match[1],
      start: match.index + match[0].lastIndexOf("#"),
    };
  }

  function pageTitle(content, filename) {
    const rawBase = filename.replace(/\.(md|markdown)$/i, "");
    const namespacedFile = /___|%2f/i.test(rawBase);
    const base = rawBase.replace(/___/g, "/");
    let decodedBase = base;
    try {
      decodedBase = decodeURIComponent(base);
    } catch {}
    const property = content.match(/^\s*title::\s*(.+?)\s*$/im)?.[1];
    if (property && (!namespacedFile || property.includes("/")))
      return property;
    if (namespacedFile) return decodedBase;
    const heading = content.match(/^#\s+(.+?)\s*$/m)?.[1];
    if (heading && !/^\s*[-+*]\s/.test(content)) return heading;
    return decodedBase;
  }

  // Produce portable filenames while keeping the readable title in Markdown metadata.
  function safeFilename(title) {
    return (
      String(title || "Untitled")
        .trim()
        .replace(/\//g, "___")
        .replace(/[<>:"\\|?*\u0000-\u001f]/g, "_") || "Untitled"
    );
  }

  const defaultJournalConfig = {
    fileNameFormat: "yyyy_MM_dd",
    pageTitleFormat: "MMM do, yyyy",
  };
  const monthLong = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const monthShort = monthLong.map((month) => month.slice(0, 3));
  const weekdayLong = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const ordinal = (day) =>
    `${day}${day % 10 === 1 && day % 100 !== 11 ? "st" : day % 10 === 2 && day % 100 !== 12 ? "nd" : day % 10 === 3 && day % 100 !== 13 ? "rd" : "th"}`;

  // Support the intentionally small journal token set used by graph configuration.
  function formatJournalDate(
    date,
    format = defaultJournalConfig.pageTitleFormat,
  ) {
    const values = {
      yyyy: String(date.getFullYear()),
      yy: String(date.getFullYear()).slice(-2),
      MMMM: monthLong[date.getMonth()],
      MMM: monthShort[date.getMonth()],
      MM: String(date.getMonth() + 1).padStart(2, "0"),
      M: String(date.getMonth() + 1),
      do: ordinal(date.getDate()),
      dd: String(date.getDate()).padStart(2, "0"),
      d: String(date.getDate()),
      EEEE: weekdayLong[date.getDay()],
      EEE: weekdayLong[date.getDay()].slice(0, 3),
    };
    return format.replace(
      /yyyy|MMMM|EEEE|MMM|EEE|yy|MM|do|dd|M|d/g,
      (token) => values[token],
    );
  }

  // Parse journal filenames without relying on locale-dependent date parsing.
  function parseJournalDate(
    filename,
    format = defaultJournalConfig.fileNameFormat,
  ) {
    const base = filename.replace(/\.(md|markdown)$/i, "");
    const tokens = [];
    let pattern = "^";
    for (let index = 0; index < format.length;) {
      const token = ["yyyy", "MM", "dd", "M", "d"].find((candidate) =>
        format.startsWith(candidate, index),
      );
      if (token) {
        tokens.push(token);
        pattern += token === "yyyy" ? "(\\d{4})" : "(\\d{1,2})";
        index += token.length;
      } else {
        pattern += format[index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        index++;
      }
    }
    let match = base.match(new RegExp(`${pattern}$`));
    let year, month, day;
    if (match) {
      tokens.forEach((token, index) => {
        if (token === "yyyy") year = Number(match[index + 1]);
        else if (token === "MM" || token === "M")
          month = Number(match[index + 1]);
        else day = Number(match[index + 1]);
      });
    } else {
      match =
        base.match(/^(\d{4})[_-](\d{1,2})[_-](\d{1,2})$/) ||
        base.match(/^(\d{4})(\d{2})(\d{2})$/);
      if (match) [, year, month, day] = match.map(Number);
    }
    if (!year || !month || !day) return null;
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
      ? date
      : null;
  }

  class ConflictError extends Error {
    constructor(message = "The file changed outside notnote") {
      super(message);
      this.name = "ConflictError";
    }
  }

  // Keep direct filesystem access behind the same interface as remote graph storage.
  class GraphStore {
    constructor(handle) {
      this.handle = handle;
      this.name = handle.name;
      this.pages = [];
      this.assetUrls = new Map();
      this.config = { ...defaultJournalConfig };
    }

    static async open() {
      if (!window.showDirectoryPicker)
        throw new Error("Directory access is not supported by this browser");
      const handle = await window.showDirectoryPicker({
        mode: "readwrite",
        id: "notnote-graph",
      });
      const store = new GraphStore(handle);
      if (!(await store.ensurePermission(true)))
        throw new Error("Graph permission was not granted");
      await setState(HANDLE_KEY, handle).catch(() => {});
      return store;
    }

    static async restore() {
      try {
        const handle = await getState(HANDLE_KEY);
        return handle ? new GraphStore(handle) : null;
      } catch {
        return null;
      }
    }

    async ensurePermission(request = false) {
      const options = { mode: "readwrite" };
      if ((await this.handle.queryPermission(options)) === "granted")
        return true;
      return (
        request && (await this.handle.requestPermission(options)) === "granted"
      );
    }

    async directory(path, create = false) {
      let directory = this.handle;
      for (const part of path.split("/").filter(Boolean))
        directory = await directory.getDirectoryHandle(part, { create });
      return directory;
    }

    async readSettings() {
      try {
        const directory = await this.handle.getDirectoryHandle(".notnote");
        const file = await (
          await directory.getFileHandle("settings.json")
        ).getFile();
        const settings = JSON.parse(await file.text());
        if (
          !settings ||
          typeof settings !== "object" ||
          Array.isArray(settings)
        )
          throw new Error("Graph settings must be a JSON object");
        return settings;
      } catch (error) {
        if (error.name === "NotFoundError") return null;
        throw error;
      }
    }

    async writeSettings(settings) {
      if (!(await this.ensurePermission(true)))
        throw new Error("Graph is read only");
      const directory = await this.handle.getDirectoryHandle(".notnote", {
        create: true,
      });
      const handle = await directory.getFileHandle("settings.json", {
        create: true,
      });
      const writable = await handle.createWritable();
      await writable.write(`${JSON.stringify(settings, null, 2)}\n`);
      await writable.close();
    }

    applySettings(settings = {}) {
      if (!settings.journal || typeof settings.journal !== "object") return;
      this.config = {
        pageTitleFormat:
          typeof settings.journal.pageTitleFormat === "string"
            ? settings.journal.pageTitleFormat
            : defaultJournalConfig.pageTitleFormat,
        fileNameFormat:
          typeof settings.journal.fileNameFormat === "string"
            ? settings.journal.fileNameFormat
            : defaultJournalConfig.fileNameFormat,
      };
      this.settingsConfig = true;
    }

    async readConfig() {
      try {
        const directory = await this.handle.getDirectoryHandle("logseq");
        const file = await (
          await directory.getFileHandle("config.edn")
        ).getFile();
        const content = await file.text();
        const pageTitleFormat = content.match(
          /:journal\/page-title-format\s+"([^"]+)"/,
        )?.[1];
        const fileNameFormat = content.match(
          /:journal\/file-name-format\s+"([^"]+)"/,
        )?.[1];
        this.config = {
          pageTitleFormat:
            pageTitleFormat || defaultJournalConfig.pageTitleFormat,
          fileNameFormat: fileNameFormat || defaultJournalConfig.fileNameFormat,
        };
      } catch {
        this.config = { ...defaultJournalConfig };
      }
      return this.config;
    }

    async scan() {
      if (!(await this.ensurePermission(false)))
        throw new Error("Graph permission is required");
      if (!this.settingsConfig) await this.readConfig();
      const pages = [];
      const walk = async (directory, folder = "") => {
        for await (const [name, handle] of directory.entries()) {
          const path = folder ? `${folder}/${name}` : name;
          if (handle.kind === "directory") {
            if (
              !nestedGraphCopy(`${path}/`) &&
              (folder || ["pages", "journals"].includes(name))
            )
              await walk(handle, path);
            continue;
          }
          if (
            !markdownFile.test(name) ||
            (folder && !/^(pages|journals)(\/|$)/.test(folder))
          )
            continue;
          const file = await handle.getFile();
          const content = await file.text();
          const journalDateValue =
            folder === "journals"
              ? parseJournalDate(name, this.config.fileNameFormat)
              : null;
          const explicitTitle = content.match(/^\s*title::\s*(.+?)\s*$/im)?.[1];
          const journalTitle = journalDateValue
            ? explicitTitle ||
              formatJournalDate(journalDateValue, this.config.pageTitleFormat)
            : null;
          pages.push({
            title: journalTitle || pageTitle(content, name),
            name,
            path,
            folder,
            handle,
            content,
            lastModified: file.lastModified,
            journal: folder === "journals",
            journalDate: journalDateValue
              ? formatJournalDate(journalDateValue, "yyyy-MM-dd")
              : null,
          });
        }
      };
      await walk(this.handle);
      this.pages = pages.sort((a, b) => a.title.localeCompare(b.title));
      return this.pages;
    }

    findPage(title) {
      const key = normalizePage(title);
      return this.pages.find((page) => normalizePage(page.title) === key);
    }

    async createPage(title, options = {}) {
      const existing = this.findPage(title);
      if (existing) return existing;
      const folder = options.folder || (options.journal ? "journals" : "pages");
      const directory = await this.directory(folder, true);
      const journalDateValue =
        options.journalDate || (options.journal ? new Date() : null);
      const journalFilename = journalDateValue
        ? formatJournalDate(journalDateValue, this.config.fileNameFormat)
        : null;
      const name = `${options.filename || journalFilename || safeFilename(title)}.md`;
      const handle = await directory.getFileHandle(name, { create: true });
      const page = {
        title,
        name,
        path: `${folder}/${name}`,
        folder,
        handle,
        content: "",
        lastModified: 0,
        journal: folder === "journals",
        journalDate: journalDateValue
          ? formatJournalDate(journalDateValue, "yyyy-MM-dd")
          : null,
      };
      await this.writePage(page, options.content || "- ", { force: true });
      this.pages.push(page);
      this.pages.sort((a, b) => a.title.localeCompare(b.title));
      return page;
    }

    async writePage(page, content, options = {}) {
      if (!(await this.ensurePermission(options.requestPermission !== false)))
        throw new Error("Graph is read only");
      const file = await page.handle.getFile();
      if (
        !options.force &&
        page.lastModified &&
        file.lastModified !== page.lastModified
      ) {
        const external = await file.text();
        if (external !== page.content) throw new ConflictError();
      }
      const writable = await page.handle.createWritable();
      await writable.write(content);
      await writable.close();
      const updated = await page.handle.getFile();
      page.content = content;
      page.lastModified = updated.lastModified;
      return page;
    }

    async renamePage(page, title, content) {
      const duplicate = this.pages.find(
        (candidate) =>
          candidate !== page &&
          normalizePage(candidate.title) === normalizePage(title),
      );
      if (duplicate) throw new Error("A page with this name already exists");
      const folder = page.folder || "pages";
      const directory = await this.directory(folder, true);
      const name = `${safeFilename(title)}.md`;
      if (name === page.name) {
        await this.writePage(page, content);
        page.title = title;
        return page;
      }
      let handle = await directory.getFileHandle(name, { create: true });
      const sameEntry =
        typeof handle.isSameEntry === "function" &&
        (await handle.isSameEntry(page.handle));
      if (sameEntry) {
        // Case-insensitive filesystems return the original handle for a case-only
        // filename change. Move through a temporary file so removing the old name
        // does not also remove the newly written page.
        const temporaryName = `.notnote-case-rename-${newId()}.tmp`;
        const temporaryHandle = await directory.getFileHandle(temporaryName, {
          create: true,
        });
        const temporaryPage = {
          ...page,
          name: temporaryName,
          path: `${folder}/${temporaryName}`,
          handle: temporaryHandle,
          lastModified: 0,
        };
        await this.writePage(temporaryPage, content, { force: true });
        await directory.removeEntry(page.name);
        try {
          handle = await directory.getFileHandle(name, { create: true });
          const replacement = {
            ...page,
            title,
            name,
            path: `${folder}/${name}`,
            handle,
            lastModified: 0,
          };
          await this.writePage(replacement, content, { force: true });
        } catch (error) {
          try {
            const recovery = await directory.getFileHandle(page.name, {
              create: true,
            });
            await this.writePage(
              { ...page, handle: recovery, lastModified: 0 },
              content,
              { force: true },
            );
          } catch {
            throw new Error(
              `Could not rename the page; recovery copy kept as ${temporaryName}`,
            );
          }
          await directory.removeEntry(temporaryName).catch(() => {});
          throw error;
        }
        await directory.removeEntry(temporaryName);
      }
      const renamed = {
        ...page,
        title,
        name,
        path: `${folder}/${name}`,
        handle,
        lastModified: 0,
      };
      if (!sameEntry) await this.writePage(renamed, content, { force: true });
      if (!sameEntry) await directory.removeEntry(page.name);
      else {
        const updated = await handle.getFile();
        renamed.content = content;
        renamed.lastModified = updated.lastModified;
      }
      this.pages = this.pages.filter((item) => item !== page);
      this.pages.push(renamed);
      this.pages.sort((a, b) => a.title.localeCompare(b.title));
      await removeDraft(page.path).catch(() => {});
      return renamed;
    }

    async deletePage(page) {
      if (!(await this.ensurePermission()))
        throw new Error("Graph is read only");
      try {
        const file = await page.handle.getFile();
        if (
          page.lastModified &&
          file.lastModified !== page.lastModified &&
          (await file.text()) !== page.content
        )
          throw new ConflictError();
        const directory = await this.directory(page.folder || "");
        await directory.removeEntry(page.name);
      } catch (error) {
        // Missing files are already in the desired state; still clear stale index entries.
        if (error.name !== "NotFoundError") throw error;
      }
      this.pages = this.pages.filter((item) => item !== page);
      await removeDraft(page.path).catch(() => {});
    }

    async freshFile(page) {
      const file = await page.handle.getFile();
      return { content: await file.text(), lastModified: file.lastModified };
    }

    async writeAsset(file, preferredName = safeFilename(file.name)) {
      if (!(await this.ensurePermission()))
        throw new Error("Graph is read only");
      const directory = await this.directory("assets", true);
      const original = safeFilename(preferredName);
      const extension = original.match(/(\.[^.]+)$/)?.[1] || "";
      const stem = extension ? original.slice(0, -extension.length) : original;
      let name = original;
      let suffix = 1;
      while (true) {
        try {
          await directory.getFileHandle(name);
          name = `${stem}-${suffix++}${extension}`;
        } catch (error) {
          if (error.name === "NotFoundError") break;
          throw error;
        }
      }
      const handle = await directory.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(file);
      await writable.close();
      return `/assets/${encodeURIComponent(name)}`;
    }

    async listAssets() {
      const assets = [];
      const walk = async (directory, prefix = "assets") => {
        for await (const [name, handle] of directory.entries()) {
          const path = `${prefix}/${name}`;
          if (handle.kind === "directory") await walk(handle, path);
          else assets.push(path);
        }
      };
      try {
        await walk(await this.directory("assets"));
      } catch (error) {
        if (error.name !== "NotFoundError") throw error;
      }
      return assets;
    }

    async removeAsset(reference) {
      if (!(await this.ensurePermission()))
        throw new Error("Graph is read only");
      const path = resolveAssetPath(reference);
      if (!path.startsWith("assets/")) throw new Error("Invalid asset path");
      const parts = path.split("/");
      const directory = await this.directory(parts.slice(0, -1).join("/"));
      await directory.removeEntry(parts.at(-1));
      const url = this.assetUrls.get(path);
      if (url) URL.revokeObjectURL(url);
      this.assetUrls.delete(path);
    }

    async removeAssets(references) {
      const results = await settleInBatches(references, (reference) =>
        this.removeAsset(reference),
      );
      const missing = results.filter(
        (result) =>
          result.status === "rejected" && result.reason?.name === "NotFoundError",
      ).length;
      return {
        deleted: results.filter((result) => result.status === "fulfilled").length,
        skipped: missing,
        failed: results.filter(
          (result) =>
            result.status === "rejected" &&
            result.reason?.name !== "NotFoundError",
        ).length,
      };
    }

    disposeAssets() {
      this.assetUrls.forEach((url) => URL.revokeObjectURL(url));
      this.assetUrls.clear();
    }

    async stats() {
      let files = 0;
      let size = 0;
      let lastModified = 0;
      let skipped = 0;
      const walk = async (directory) => {
        try {
          for await (const [, handle] of directory.entries()) {
            try {
              if (handle.kind === "directory") await walk(handle);
              else {
                const file = await handle.getFile();
                files++;
                size += file.size;
                lastModified = Math.max(lastModified, file.lastModified || 0);
              }
            } catch {
              skipped++;
            }
          }
        } catch {
          skipped++;
        }
      };
      await walk(this.handle);
      return { files, size, lastModified, partial: skipped > 0 };
    }

    async assetUrl(reference, fromFolder = "pages") {
      if (/^[a-z]+:/i.test(reference) || reference.startsWith("#"))
        return reference;
      const key = resolveAssetPath(reference, fromFolder);
      if (this.assetUrls.has(key)) return this.assetUrls.get(key);
      let directory = this.handle;
      const parts = key.split("/");
      for (const part of parts.slice(0, -1))
        directory = await directory.getDirectoryHandle(part);
      const handle = await directory.getFileHandle(parts.at(-1));
      const url = URL.createObjectURL(await handle.getFile());
      this.assetUrls.set(key, url);
      return url;
    }
  }

  // Mirror remote notes locally and queue writes while the server is unavailable.
  class RemoteGraphStore {
    constructor(status, baseUrl = "/api/graph") {
      this.baseUrl = baseUrl;
      this.name = status.name || "Server graph";
      this.config = { ...defaultJournalConfig, ...(status.config || {}) };
      this.pages = [];
      this.isRemote = true;
      this.clientId = newId();
      this.offline = false;
      this.pendingCount = 0;
      this.cache = null;
    }

    static fromCache(cached, baseUrl = "/api/graph") {
      if (!cached?.status || !cached?.files) return null;
      const store = new RemoteGraphStore(cached.status, baseUrl);
      store.cache = cached;
      store.offline = true;
      store.pendingCount = (cached.operations || []).length;
      return store;
    }

    static async connect(
      baseUrl = "/api/graph",
      { preferCache = false } = {},
    ) {
      const cached = await getRemoteGraph(baseUrl).catch(() => null);
      if (preferCache) {
        const store = RemoteGraphStore.fromCache(cached, baseUrl);
        if (store) return store;
      }
      try {
        const response = await fetch(`${baseUrl}/status`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("No server graph is available");
        const status = await response.json();
        if (!status.enabled) throw new Error("The server graph is disabled");
        const store = new RemoteGraphStore(status, baseUrl);
        store.cache = {
          ...(cached || {}),
          status,
          operations: cached?.operations || [],
        };
        store.pendingCount = store.cache.operations.length;
        store.offline = store.pendingCount > 0;
        await saveRemoteGraph(baseUrl, store.cache).catch(() => {});
        return store;
      } catch (error) {
        const store = RemoteGraphStore.fromCache(cached, baseUrl);
        if (!store) throw error;
        return store;
      }
    }

    async api(path, options = {}) {
      const response = await fetch(`${this.baseUrl}${path}`, {
        cache: "no-store",
        ...options,
      });
      if (response.ok) return response.json();
      let message = `Graph server error (${response.status})`;
      try {
        message = (await response.json()).error || message;
      } catch {}
      if (response.status === 409) throw new ConflictError(message);
      throw new Error(message);
    }

    async reconnect() {
      try {
        const status = await this.api("/status");
        if (!status.enabled) throw new Error("The server graph is disabled");
        this.name = status.name || this.name;
        if (!this.settingsConfig)
          this.config = { ...defaultJournalConfig, ...(status.config || {}) };
        this.cache = {
          ...(this.cache || {}),
          status,
          operations: this.cache?.operations || [],
        };
        this.offline = false;
        await this.persistCache();
        return status;
      } catch (error) {
        this.offline = this.networkFailure(error);
        throw error;
      }
    }

    async ensurePermission() {
      return true;
    }

    networkFailure(error) {
      return (
        error instanceof TypeError ||
        /fetch|network|offline|load failed/i.test(
          String(error?.message || error),
        )
      );
    }

    async persistCache() {
      this.cache = this.cache || {
        status: { enabled: true, name: this.name, config: this.config },
        files: { files: [], config: this.config },
        operations: [],
      };
      this.pendingCount = (this.cache.operations || []).length;
      await saveRemoteGraph(this.baseUrl, this.cache);
    }

    cacheFile(path, content, revision = null, remove = false) {
      this.cache = this.cache || {
        status: { enabled: true, name: this.name, config: this.config },
        files: { files: [], config: this.config },
        operations: [],
      };
      const files = this.cache.files?.files || [];
      this.cache.files = {
        ...(this.cache.files || {}),
        config: this.config,
        files: remove
          ? files.filter((file) => file.path !== path)
          : [
              ...files.filter((file) => file.path !== path),
              {
                ...(files.find((file) => file.path === path) || {}),
                path,
                name: path.split("/").at(-1),
                folder: path.includes("/")
                  ? path.split("/").slice(0, -1).join("/")
                  : "",
                content,
                revision,
              },
            ],
      };
    }

    async queueOperation(operation) {
      this.cache = this.cache || {
        status: { enabled: true, name: this.name, config: this.config },
        files: { files: [], config: this.config },
        operations: [],
      };
      const operations = [...(this.cache.operations || [])];
      if (operation.type === "write") {
        const index = operations.findIndex(
          (item) => item.type === "write" && item.path === operation.path,
        );
        if (index >= 0)
          operation = {
            ...operation,
            expectedRevision: operations[index].expectedRevision,
            create: operations[index].create || operation.create,
          };
        if (index >= 0) operations.splice(index, 1);
      } else if (operation.type === "settings") {
        for (let index = operations.length - 1; index >= 0; index--)
          if (operations[index].type === "settings")
            operations.splice(index, 1);
      }
      operations.push({ ...operation, queuedAt: Date.now() });
      this.cache.operations = operations;
      this.offline = true;
      await this.persistCache();
    }

    applySettings(settings = {}) {
      if (!settings.journal || typeof settings.journal !== "object") return;
      this.config = {
        pageTitleFormat:
          typeof settings.journal.pageTitleFormat === "string"
            ? settings.journal.pageTitleFormat
            : defaultJournalConfig.pageTitleFormat,
        fileNameFormat:
          typeof settings.journal.fileNameFormat === "string"
            ? settings.journal.fileNameFormat
            : defaultJournalConfig.fileNameFormat,
      };
      this.settingsConfig = true;
    }

    async readSettings() {
      if (this.offline) return this.cache?.settings || null;
      try {
        const settings = await this.api("/settings");
        this.cache.settings = settings;
        await this.persistCache();
        return settings;
      } catch (error) {
        if (/\(404\)|not found/i.test(error.message))
          return this.cache?.settings || null;
        if (this.networkFailure(error) && this.cache) {
          this.offline = true;
          return this.cache.settings || null;
        }
        throw error;
      }
    }

    async writeSettings(settings) {
      this.cache = this.cache || {};
      if (
        Object.hasOwn(this.cache, "settings") &&
        JSON.stringify(this.cache.settings) === JSON.stringify(settings)
      )
        return;
      this.cache.settings = settings;
      if (this.offline)
        return this.queueOperation({ type: "settings", settings });
      try {
        await this.api("/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings, clientId: this.clientId }),
        });
        await this.persistCache();
      } catch (error) {
        if (this.networkFailure(error))
          return this.queueOperation({ type: "settings", settings });
        throw error;
      }
    }

    subscribe(listener) {
      const events = new EventSource(`${this.baseUrl}/events`);
      events.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data);
          if (event.clientId !== this.clientId) listener(event);
        } catch {}
      };
      return () => events.close();
    }

    pageFromFile(file) {
      const folder = file.folder || "";
      const journal = /^journals(?:\/|$)/.test(folder);
      const journalDateValue = journal
        ? parseJournalDate(file.name, this.config.fileNameFormat)
        : null;
      const explicitTitle = file.content.match(
        /^\s*title::\s*(.+?)\s*$/im,
      )?.[1];
      const journalTitle = journalDateValue
        ? explicitTitle ||
          formatJournalDate(journalDateValue, this.config.pageTitleFormat)
        : null;
      return {
        title: journalTitle || pageTitle(file.content, file.name),
        name: file.name,
        path: file.path,
        folder,
        content: file.content,
        lastModified: file.revision,
        journal,
        journalDate: journalDateValue
          ? formatJournalDate(journalDateValue, "yyyy-MM-dd")
          : null,
      };
    }

    async scan() {
      let payload;
      if (this.offline) payload = this.cache?.files;
      else {
        try {
          payload = await this.api("/files");
          this.cache.files = payload;
          await this.persistCache();
        } catch (error) {
          if (!this.networkFailure(error) || !this.cache?.files) throw error;
          this.offline = true;
          payload = this.cache.files;
        }
      }
      if (!payload) throw new Error("No offline graph copy is available");
      if (!this.settingsConfig)
        this.config = { ...defaultJournalConfig, ...(payload.config || {}) };
      this.pages = payload.files
        .filter((file) => !nestedGraphCopy(file.path))
        .map((file) => this.pageFromFile(file))
        .sort((a, b) => a.title.localeCompare(b.title));
      return this.pages;
    }

    findPage(title) {
      const key = normalizePage(title);
      return this.pages.find((page) => normalizePage(page.title) === key);
    }

    async createPage(title, options = {}) {
      const existing = this.findPage(title);
      if (existing) return existing;
      const folder = options.folder || (options.journal ? "journals" : "pages");
      const journalDateValue =
        options.journalDate || (options.journal ? new Date() : null);
      const journalFilename = journalDateValue
        ? formatJournalDate(journalDateValue, this.config.fileNameFormat)
        : null;
      const name = `${options.filename || journalFilename || safeFilename(title)}.md`;
      const page = {
        title,
        name,
        path: `${folder}/${name}`,
        folder,
        content: "",
        lastModified: null,
        journal: folder === "journals",
        journalDate: journalDateValue
          ? formatJournalDate(journalDateValue, "yyyy-MM-dd")
          : null,
      };
      // Creation must be exclusive on the server. A page with the same path may
      // have been created by another device since this replica was cached.
      await this.writePage(page, options.content || "- ", {
        create: true,
      });
      this.pages.push(page);
      this.pages.sort((a, b) => a.title.localeCompare(b.title));
      return page;
    }

    async writePage(page, content, options = {}) {
      const operation = {
        type: "write",
        path: page.path,
        content,
        expectedRevision: page.lastModified,
        // A force confirmation is valid only for the immediate request. If the
        // request is queued, re-check its base revision when reconnecting so a
        // later edit from another device cannot be overwritten silently.
        force: false,
        create: Boolean(options.create),
      };
      if (this.offline) {
        page.content = content;
        this.cacheFile(page.path, content, page.lastModified);
        await this.queueOperation(operation);
        return page;
      }
      try {
        const payload = await this.api("/file", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: page.path,
            content,
            expectedRevision: page.lastModified,
            force: Boolean(options.force),
            create: Boolean(options.create),
            clientId: this.clientId,
          }),
        });
        page.content = content;
        page.lastModified = payload.revision;
        this.cacheFile(page.path, content, payload.revision);
        await this.persistCache();
        return page;
      } catch (error) {
        if (!this.networkFailure(error)) throw error;
        page.content = content;
        this.cacheFile(page.path, content, page.lastModified);
        await this.queueOperation(operation);
        return page;
      }
    }

    async syncPending() {
      const operations = [...(this.cache?.operations || [])];
      if (!operations.length) {
        this.offline = false;
        return 0;
      }
      let completed = 0;
      for (const operation of operations) {
        try {
          if (operation.type === "settings") {
            await this.api("/settings", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                settings: operation.settings,
                clientId: this.clientId,
              }),
            });
          } else if (operation.type === "write") {
            const payload = await this.api("/file", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                path: operation.path,
                content: operation.content,
                expectedRevision: operation.expectedRevision,
                // Never replay a persisted operation as a blind overwrite,
                // including operations cached by older application versions.
                force: false,
                create: operation.create,
                clientId: this.clientId,
              }),
            });
            this.cacheFile(operation.path, operation.content, payload.revision);
            const page = this.pages.find(
              (item) => item.path === operation.path,
            );
            if (page) page.lastModified = payload.revision;
          }
          this.cache.operations.shift();
          completed++;
          await this.persistCache();
        } catch (error) {
          this.offline = this.networkFailure(error);
          throw error;
        }
      }
      this.offline = false;
      await this.persistCache();
      return completed;
    }

    async renamePage(page, title, content) {
      if (this.offline) throw new Error("Renaming pages requires a connection");
      const duplicate = this.pages.find(
        (candidate) =>
          candidate !== page &&
          normalizePage(candidate.title) === normalizePage(title),
      );
      if (duplicate) throw new Error("A page with this name already exists");
      const folder = page.folder || "pages";
      const name = `${safeFilename(title)}.md`;
      const target = `${folder}/${name}`;
      if (target === page.path) {
        await this.writePage(page, content);
        page.title = title;
        return page;
      }
      const payload = await this.api("/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: page.path,
          target,
          content,
          expectedRevision: page.lastModified,
          clientId: this.clientId,
        }),
      });
      const renamed = {
        ...page,
        title,
        name,
        path: payload.path,
        content,
        lastModified: payload.revision,
      };
      this.pages = this.pages.filter((item) => item !== page);
      this.pages.push(renamed);
      this.pages.sort((a, b) => a.title.localeCompare(b.title));
      this.cacheFile(page.path, "", null, true);
      this.cacheFile(renamed.path, content, payload.revision);
      await this.persistCache();
      await removeDraft(page.path).catch(() => {});
      return renamed;
    }

    async deletePage(page) {
      if (this.offline) throw new Error("Deleting pages requires a connection");
      try {
        await this.api("/file", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: page.path,
            expectedRevision: page.lastModified,
            clientId: this.clientId,
          }),
        });
      } catch (error) {
        // Treat a server-side missing file as an idempotent delete.
        if (!/graph file not found/i.test(error.message || "")) throw error;
      }
      this.pages = this.pages.filter((item) => item !== page);
      this.cacheFile(page.path, "", null, true);
      await this.persistCache();
      await removeDraft(page.path).catch(() => {});
    }

    async freshFile(page) {
      if (this.offline)
        return { content: page.content, lastModified: page.lastModified };
      const payload = await this.api(
        `/file?path=${encodeURIComponent(page.path)}`,
      );
      return { content: payload.content, lastModified: payload.revision };
    }

    async writeAsset(file, preferredName = safeFilename(file.name)) {
      const name = safeFilename(preferredName);
      const response = await fetch(
        `${this.baseUrl}/asset?path=${encodeURIComponent(`assets/${name}`)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-Notnote-Client": this.clientId,
          },
          body: file,
        },
      );
      if (!response.ok) {
        let message = `Graph server error (${response.status})`;
        try {
          message = (await response.json()).error || message;
        } catch {}
        if (response.status === 404 && message === "Unknown graph endpoint")
          message = "File uploads require a server.py restart";
        throw new Error(message);
      }
      const payload = await response.json();
      return `/${payload.path.split("/").map(encodeURIComponent).join("/")}`;
    }

    async listAssets() {
      const payload = await this.api("/assets");
      return payload.files || [];
    }

    async removeAsset(reference) {
      const path = resolveAssetPath(reference);
      if (!path.startsWith("assets/")) throw new Error("Invalid asset path");
      const response = await fetch(
        `${this.baseUrl}/asset?path=${encodeURIComponent(path)}`,
        { method: "DELETE", headers: { "X-Notnote-Client": this.clientId } },
      );
      if (!response.ok) {
        let message = `Graph server error (${response.status})`;
        try {
          message = (await response.json()).error || message;
        } catch {}
        throw new Error(message);
      }
    }

    async removeAssets(references) {
      const paths = references.map((reference) => resolveAssetPath(reference));
      try {
        return await this.api("/assets/cleanup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths, clientId: this.clientId }),
        });
      } catch (error) {
        // Older graph servers can still clean safely without an unbounded request burst.
        if (!/unknown graph endpoint/i.test(error.message || "")) throw error;
        const results = await settleInBatches(references, (reference) =>
          this.removeAsset(reference),
        );
        return {
          deleted: results.filter((result) => result.status === "fulfilled").length,
          skipped: 0,
          failed: results.filter((result) => result.status === "rejected").length,
        };
      }
    }

    disposeAssets() {}

    async stats() {
      try {
        const payload = await this.api("/stats");
        return {
          files: Number(payload.files) || 0,
          size: Number(payload.size) || 0,
          lastModified: Number(payload.lastModified) || 0,
          partial: Boolean(payload.partial),
        };
      } catch {
        const content = this.pages.map((page) => page.content || "").join("");
        const timestamps = this.pages
          .map((page) => Number(page.lastModified))
          .filter((value) => Number.isFinite(value) && value > 0)
          .map((value) => (value > 1e15 ? value / 1e6 : value));
        return {
          files: this.pages.length,
          size: new Blob([content]).size,
          lastModified: timestamps.length ? Math.max(...timestamps) : 0,
          partial: true,
        };
      }
    }

    async assetUrl(reference, fromFolder = "pages") {
      if (/^[a-z]+:/i.test(reference) || reference.startsWith("#"))
        return reference;
      return `${this.baseUrl}/asset?path=${encodeURIComponent(resolveAssetPath(reference, fromFolder))}`;
    }
  }

  // Own canonical pages, aliases, references, and UUID lookup tables.
  class GraphIndex {
    constructor(pages = []) {
      this.contentOverrides = new Map();
      this.sourcePages = [];
      this.rebuild(pages);
    }

    rebuild(pages = this.sourcePages) {
      this.sourcePages = [
        ...new Map(
          pages
            .filter((page) => !nestedGraphCopy(page.path))
            .map((page) => [page.path, page]),
        ).values(),
      ];
      this.pages = new Map();
      this.documents = new Map();
      this.uuids = new Map();
      this.pageLinks = new Map();
      this.blockLinks = new Map();
      this.tagLinks = new Map();
      this.referencedPages = new Map();
      this.sourcePages.forEach((page) =>
        this.addPage(
          page,
          this.contentOverrides.get(page.path) ?? page.content,
        ),
      );
      return this;
    }

    addTo(map, key, value) {
      const normalized = normalizePage(key);
      if (!map.has(normalized)) map.set(normalized, []);
      map.get(normalized).push(value);
    }

    registerPageNames(page, document) {
      this.pages.set(normalizePage(page.title), page);
      const filename = page.name || page.path?.split("/").at(-1) || "";
      const filenameTitle = pageTitle("", filename);
      if (filenameTitle) this.pages.set(normalizePage(filenameTitle), page);
      if (page.journalDate) {
        const [year, month, day] = page.journalDate.split("-").map(Number);
        const date = new Date(year, month - 1, day);
        [
          page.journalDate,
          formatJournalDate(date, "yyyy_MM_dd"),
          formatJournalDate(date, "MMM do, yyyy"),
          formatJournalDate(date, "MMMM do, yyyy"),
        ].forEach((alias) => this.pages.set(normalizePage(alias), page));
      }
      for (const alias of pageAliases(document))
        this.pages.set(normalizePage(alias), page);
    }

    addPage(page, content) {
      const document = parseDocument(content);
      this.registerPageNames(page, document);
      this.documents.set(page.path, document);
      for (const { block } of flattenBlocks(document.blocks)) {
        const properties = propertiesFrom(block.content);
        const reference = { page, block, content: block.content };
        if (properties.id) {
          block.uuid = properties.id;
          this.uuids.set(normalizePage(properties.id), reference);
        }
        pageReferences(block.content).forEach((target) => {
          this.addTo(this.pageLinks, target, reference);
          const key = normalizePage(target);
          if (!this.referencedPages.has(key))
            this.referencedPages.set(key, target);
        });
        blockReferences(block.content).forEach((target) =>
          this.addTo(this.blockLinks, target, reference),
        );
        tags(block.content).forEach((tag) => {
          this.addTo(this.tagLinks, tag, reference);
          const key = normalizePage(tag);
          if (!this.referencedPages.has(key))
            this.referencedPages.set(key, tag);
        });
      }
      return document;
    }

    removePage(page) {
      this.contentOverrides.delete(page.path);
      this.rebuild(this.sourcePages.filter((item) => item.path !== page.path));
    }

    updatePage(page, content) {
      this.contentOverrides.set(page.path, content);
      const path = page.path;
      this.sourcePages = this.sourcePages.filter((item) => item.path !== path);
      this.sourcePages.push(page);
      for (const map of [this.pageLinks, this.blockLinks, this.tagLinks]) {
        for (const [key, references] of map) {
          const remaining = references.filter(
            (reference) => reference.page.path !== path,
          );
          if (remaining.length) map.set(key, remaining);
          else map.delete(key);
        }
      }
      for (const [key, reference] of this.uuids)
        if (reference.page.path === path) this.uuids.delete(key);
      this.documents.delete(path);
      this.addPage(page, content);
      for (const key of this.referencedPages.keys()) {
        if (!this.pageLinks.has(key) && !this.tagLinks.has(key))
          this.referencedPages.delete(key);
      }
      // Re-register aliases without reparsing every document. This preserves overlap
      // semantics while making a keystroke update proportional to index size, not file size.
      this.pages.clear();
      for (const candidate of this.sourcePages)
        this.registerPageNames(candidate, this.documents.get(candidate.path));
    }

    resolvePage(title) {
      return this.pages.get(normalizePage(title));
    }
    resolveBlock(uuid) {
      return this.uuids.get(normalizePage(uuid));
    }
    aliasesForPage(page) {
      return pageAliases(this.documents.get(page?.path));
    }
    referencesToPage(title) {
      const page = this.resolvePage(title);
      const aliases = page
        ? [...this.pages]
            .filter(([, candidate]) => candidate === page)
            .map(([key]) => key)
        : [normalizePage(title)];
      const references = aliases.flatMap((key) => [
        ...(this.pageLinks.get(key) || []),
        ...(this.tagLinks.get(key) || []),
      ]);
      return [
        ...new Map(
          references.map((item) => [
            `${item.page.path}:${item.block.id}`,
            item,
          ]),
        ).values(),
      ];
    }
    referencesToBlock(uuid) {
      return this.blockLinks.get(normalizePage(uuid)) || [];
    }
    allPages() {
      return [...this.sourcePages].sort((a, b) =>
        a.title.localeCompare(b.title),
      );
    }
    pageSuggestions() {
      const pages = [...this.allPages()];
      for (const [key, title] of this.referencedPages) {
        if (!this.pages.has(key))
          pages.push({
            title,
            name: "",
            path: `virtual:${key}`,
            folder: "pages",
            content: "- ",
            lastModified: null,
            virtual: true,
          });
      }
      return pages.sort((a, b) => a.title.localeCompare(b.title));
    }

    search(query, limit = 30) {
      const needle = normalizeSearch(query);
      if (!needle) return [];
      const results = [];
      for (const page of this.allPages()) {
        const document = this.documents.get(page.path);
        for (const { block } of flattenBlocks(document?.blocks)) {
          if (normalizeSearch(block.content).includes(needle))
            results.push({ page, block, content: block.content });
          if (results.length >= limit) return results;
        }
      }
      return results;
    }

    unlinkedReferences(title, limit = 50) {
      const needle = normalizePage(title);
      const linked = new Set(
        this.referencesToPage(title).map(
          (item) => `${item.page.path}:${item.block.id}`,
        ),
      );
      return this.search(title, limit * 2)
        .filter(
          (item) =>
            !linked.has(`${item.page.path}:${item.block.id}`) &&
            normalizePage(item.page.title) !== needle,
        )
        .slice(0, limit);
    }
  }

  function replacePageReferences(content, oldTitle, newTitle) {
    return content.replace(/\[\[([^\]]+?)\]\]/g, (whole, target) => {
      const [page, alias] = target.split("|");
      return normalizePage(page) === normalizePage(oldTitle)
        ? `[[${newTitle}${alias ? `|${alias}` : ""}]]`
        : whole;
    });
  }

  function journalInfo(date = new Date(), config = defaultJournalConfig) {
    return {
      title: formatJournalDate(
        date,
        config.pageTitleFormat || defaultJournalConfig.pageTitleFormat,
      ),
      filename: formatJournalDate(
        date,
        config.fileNameFormat || defaultJournalConfig.fileNameFormat,
      ),
      date: formatJournalDate(date, "yyyy-MM-dd"),
      value: date,
    };
  }

  window.NotnoteGraph = {
    GraphStore,
    RemoteGraphStore,
    GraphIndex,
    ConflictError,
    parseDocument,
    serializeDocument,
    flattenBlocks,
    propertiesFrom,
    templatesFromDocument,
    copyBlocksForTemplate,
    copyBlocksForPaste,
    instantiateTemplate,
    isEmptyPageContent,
    pageReferences,
    blockReferences,
    trailingTagQuery,
    pageTitle,
    normalizePage,
    normalizeSearch,
    resolveAssetPath,
    assetReferenceCorpus,
    contentMentionsAsset,
    referencedAssetPaths,
    replacePageReferences,
    normalizePdfEmbeds,
    saveDraft,
    getDraft,
    removeDraft,
    journalInfo,
    formatJournalDate,
    parseJournalDate,
    newId,
  };
})();
