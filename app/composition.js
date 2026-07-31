/**
 * Connect cycle-breaking feature callbacks and install event adapters.
 * Direct imports remain the default; this composition root contains only relationships that would
 * otherwise form a module cycle and registers browser events after every callback is available.
 */

import { configureAppearanceDependencies } from "./appearance.js";
import {
  activateJournalBlock,
  activeMarkdownField,
  finishTitleEdit,
  notifyMarkdownField,
  showCommandPalette,
} from "./commands.js";
import { configureDocumentDependencies } from "./document.js";
import { initDocumentEvents } from "./events/document.js";
import { initOutlinerEvents } from "./events/outliner.js";
import { initOverlayEvents } from "./events/overlays.js";
import { initShellEvents } from "./events/shell.js";
import {
  configureGraphSessionDependencies,
  flushGraphSave,
  graphChanged,
  graphRoute,
  loadGraphPage,
  openGraph,
  relativeJournalDate,
  renderPageHierarchy,
  renderReferences,
  toggleJournalCalendar,
} from "./graph-session.js";
import {
  activateGraphBlock,
  cachedJournalDocument,
  clearGraphBlockSelection,
  commitGraphBlock,
  configureGraphViewDependencies,
  deleteSelectedGraphBlocks,
  focusGraphBlock,
  graphBlockLocation,
  orderedJournalPages,
  renderGraphPage,
  resizeGraphEditor,
  restoreGraphCollapse,
  saveGraphCollapse,
  syncGraphNewBlockElement,
  updateTaskCompletionMetadata,
  visibleGraphBlocks,
} from "./graph-view.js";
import { scheduleRemoteRefresh } from "./lifecycle.js";
import { configureMediaDependencies } from "./media.js";
import { configureOutlinerDependencies } from "./outliner.js";
import { configureSettingsDependencies, showDocumentation } from "./settings.js";
import {
  captureVimSnapshot,
  commitActiveBlock,
  configureVimDependencies,
  focusVimEditor,
  pushVimSnapshot,
  recordTaskHistory,
  setVimEnabled,
  updateVimUi,
} from "./vim.js";


export function composeApplication() {
  configureAppearanceDependencies({ setVimEnabled });
  configureSettingsDependencies({ activeMarkdownField });
  configureDocumentDependencies({
    commitActiveBlock,
    commitGraphBlock,
    finishTitleEdit,
    flushGraphSave,
    focusVimEditor,
    graphChanged,
    graphRoute,
    renderGraphPage,
    restoreGraphCollapse,
    updateVimUi,
  });
  configureGraphSessionDependencies({
    finishTitleEdit,
    scheduleRemoteRefresh,
  });
  configureGraphViewDependencies({
    graphChanged,
    loadGraphPage,
    openGraph,
    renderPageHierarchy,
    renderReferences,
  });
  configureMediaDependencies({
    focusGraphBlock,
    graphBlockLocation,
    graphChanged,
  });
  configureVimDependencies({
    activateGraphBlock,
    activateJournalBlock,
    cachedJournalDocument,
    clearGraphBlockSelection,
    deleteSelectedGraphBlocks,
    focusGraphBlock,
    graphBlockLocation,
    graphChanged,
    notifyMarkdownField,
    orderedJournalPages,
    renderGraphPage,
    restoreGraphCollapse,
    showCommandPalette,
    showDocumentation,
    updateTaskCompletionMetadata,
    visibleGraphBlocks,
  });
  configureOutlinerDependencies({
    captureVimSnapshot,
    commitGraphBlock,
    flushGraphSave,
    focusGraphBlock,
    graphBlockLocation,
    graphChanged,
    loadGraphPage,
    notifyMarkdownField,
    pushVimSnapshot,
    recordTaskHistory,
    relativeJournalDate,
    renderGraphPage,
    resizeGraphEditor,
    saveGraphCollapse,
    syncGraphNewBlockElement,
    toggleJournalCalendar,
    updateTaskCompletionMetadata,
    visibleGraphBlocks,
  });

  initShellEvents();
  initOverlayEvents();
  initDocumentEvents();
  initOutlinerEvents();
}
