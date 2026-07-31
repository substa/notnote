/**
 * Event bindings for navigation overlays, settings, shortcuts, and the command palette.
 */

import {
  saveSettings,
  setAccent,
  setAssetCacheSize,
  setTheme,
} from "../appearance.js";
import {
  closeCommandPalette,
  closeFooterMenu,
  closePageDirectory,
  closePageHistory,
  createGraphPage,
  deleteCurrentGraphPage,
  expandCommandSectionState,
  moveCommandSelection,
  pageDirectoryExpandedGroups,
  pageDirectoryGroupPages,
  pageDirectoryVisiblePages,
  renderPageDirectory,
  resetCommandSelection,
  restorePageHistoryCommit,
  runSelectedCommand,
  selectCommand,
  showPageHistory,
  toggleFooterMenu,
} from "../commands.js";
import {
  currentSettings,
  eventBinding,
  shortcutDefinitions,
  shortcutLabel,
  shortcutMatches,
  shortcutValue,
} from "../core.js";
import { requestAction, toast } from "../document.js";
import { $, $$, sourceEditor } from "../dom.js";
import { loadGraphPage } from "../graph-session.js";
import { highlightedGitDiff } from "../markdown.js";
import {
  closeDocumentation,
  loadGitSettingsStatus,
  moveDocumentationSearch,
  renderShortcutSettings,
  resetDocumentationSearch,
  saveGitSyncSettings,
  showDocumentation,
  showSettings,
  updateDocumentationSearch,
} from "../settings.js";
import { session, state } from "../state.js";
import {
  applyAppHistory,
  handleVimKeydown,
  setVimEnabled,
  showVimCursor,
} from "../vim.js";



export function initOverlayEvents() {
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
        if (!path || !session.graphStore?.isRemote)
          throw new Error("Git diff is unavailable");
        const query = new URLSearchParams({
          path,
          commit: details.dataset.historyCommit,
          gitPath: details.dataset.historyPath,
        });
        const result = await session.graphStore.api(`/history/diff?${query}`);
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
    const move = event.target.closest("[data-documentation-search-move]")
      ?.dataset.documentationSearchMove;
    if (move) {
      moveDocumentationSearch(Number(move));
      return;
    }
    const target = event.target.closest("[data-documentation-target]")?.dataset
      .documentationTarget;
    if (target)
      document
        .getElementById(target)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#documentationMenu").addEventListener("input", (event) => {
    if (event.target.matches("#documentationSearch"))
      updateDocumentationSearch();
  });
  $("#documentationMenu").addEventListener("keydown", (event) => {
    if (!event.target.matches("#documentationSearch")) return;
    if (event.key === "Enter") {
      event.preventDefault();
      moveDocumentationSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape" && event.target.value) {
      event.preventDefault();
      event.stopPropagation();
      resetDocumentationSearch();
    }
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
      await session.graphStore.api("/git/sync", {
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
        : event.target === session.activeGraphBlock?.field
          ? session.activeGraphBlock.field
          : event.target === session.activeSourceBlock
            ? session.activeSourceBlock
            : null;
    if (field)
      requestAnimationFrame(() => showVimCursor(field, field.selectionStart));
  });
  $("#commandInput").addEventListener("input", resetCommandSelection);
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
      moveCommandSelection(1);
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveCommandSelection(-1);
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
    selectCommand(item.dataset.commandIndex);
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
    expandCommandSectionState(section);
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
}
