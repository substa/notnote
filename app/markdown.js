/**
 * Safe Markdown rendering, syntax highlighting, and DOM-to-Markdown serialization.
 */

import { $, editor, sourceEditor } from "./dom.js";
import { Graph, state } from "./state.js";



// All renderer paths start from escaped text and selectively add known-safe markup.
export function escapeHtml(value = "") {
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

export function decodeHtmlEntities(value = "") {
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

// Embedded media is restricted to explicit schemes and a small provider allowlist.
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

// Lightweight highlighting covers common note-taking languages without a runtime dependency.
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

export function highlightedCodeBlock(code, language = "") {
  const label = language.trim();
  const safeLanguage = syntaxLanguage(label);
  return `<pre${label ? ` data-lang="${escapeHtml(label)}"` : ""} class="graph-code-block"><code class="language-${safeLanguage}">${highlightCode(code, label)}</code></pre>`;
}

export function highlightedGitDiff(diff = "") {
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

export function fenceOpening(line = "") {
  const opening = line.match(/^\s*(`{3,}|~{3,})[^\S\n]*([^\s`]*)[^\n]*$/);
  if (!opening) return null;
  return { marker: opening[1], language: opening[2] || "" };
}

export function fenceClosing(line, marker) {
  return new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(line);
}

export function caretInsideFence(value, position) {
  let marker = null;
  for (const line of value.slice(0, position).split("\n")) {
    if (!marker) marker = fenceOpening(line)?.marker || null;
    else if (fenceClosing(line, marker)) marker = null;
  }
  return Boolean(marker);
}

export function orgQuoteOpening(line = "") {
  return /^\s*#\+BEGIN_QUOTE\b.*$/i.test(line);
}
export function orgQuoteClosing(line = "") {
  return /^\s*#\+END_QUOTE\s*$/i.test(line);
}

// Inline rendering runs after block boundaries are identified.
export function inlineMarkdown(text) {
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

export function markdownToHtml(markdown) {
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

// DOM serialization handles only markup emitted or edited by the application.
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

export function sourceBlockText(node) {
  const text =
    "value" in node ? node.value : (node.innerText ?? node.textContent);
  return text.replace(/\u00a0/g, " ").replace(/\n$/, "");
}

export function editorToMarkdown(root = editor) {
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

export function currentMarkdown() {
  if (state.graphMode)
    return state.sourceMode
      ? sourceEditor.value
      : Graph.serializeDocument(state.graphDocument);
  return state.sourceMode ? sourceEditor.value : editorToMarkdown();
}

