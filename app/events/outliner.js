/**
 * Outliner gestures, task controls, context menus, links, and block actions.
 */

import {
  activateJournalBlock,
  openSingleJournalPage,
  runBlockContextAction,
} from "../commands.js";
import {
  closeBlockContextMenu,
  openBlockContextMenu,
  shortcutMatches,
  vimRedoStack,
  vimUndoStack,
} from "../core.js";
import { toast } from "../document.js";
import {
  $,
  $$,
  blockContextMenu,
  graphAutocomplete,
  notnoteWrap,
  outliner,
  references,
} from "../dom.js";
import {
  loadGraphPage,
  navigateGraphHistory,
  openToday,
  renderReferences,
  taskUpdateFailed,
  toggleJournalCalendar,
  updateScheduledDate,
  updateTaskFromClick,
} from "../graph-session.js";
import {
  activateGraphBlock,
  cachedJournalDocument,
  clearGraphBlockSelection,
  commitGraphBlock,
  deleteSelectedGraphBlocks,
  focusGraphBlock,
  graphBlockLocation,
  openTasksPage,
  renderGraphPage,
  saveGraphCollapse,
  scrollOnThisDayIntoView,
  selectGraphBlocksWithMouse,
  taskOverviewGroups,
  taskPersistenceId,
  toggleGraphBlockCollapse,
} from "../graph-view.js";
import {
  chooseGraphAutocomplete,
  createGraphBlockFromPlaceholder,
  graphMutationFocus,
  indentGraphBlock,
  pasteGraphBlockTree,
} from "../outliner.js";
import { Graph, session, state } from "../state.js";
import { captureVimSnapshot, pushVimSnapshot } from "../vim.js";



export function initOutlinerEvents() {
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
  outliner.addEventListener("paste", pasteGraphBlockTree);

  const blockContextForBullet = (bullet) => {
    const node = bullet?.closest(".block-node");
    const page = session.graphStore?.pages.find(
      (item) => item.path === node?.dataset.pagePath,
    );
    const document =
      page?.path === state.graphPage?.path
        ? state.graphDocument
        : session.journalDocuments.get(page?.path) ||
          session.graphIndex?.documents.get(page?.path);
    const block = graphBlockLocation(
      bullet?.dataset.blockBullet,
      document?.blocks,
    )?.block;
    return bullet && page && document && block
      ? { block, page, document }
      : null;
  };

  let blockMenuLongPressTimer = null;
  let blockMenuLongPress = null;
  const cancelBlockMenuLongPress = () => {
    clearTimeout(blockMenuLongPressTimer);
    blockMenuLongPressTimer = null;
    blockMenuLongPress = null;
  };
  const finishBlockMenuLongPress = (event) => {
    if (
      blockMenuLongPress?.triggered &&
      blockMenuLongPress.pointerId === event.pointerId
    ) {
      event.preventDefault();
      suppressBlockClickUntil = Date.now() + 800;
    }
    cancelBlockMenuLongPress();
  };
  outliner.addEventListener("pointerdown", (event) => {
    const bullet = event.target.closest("[data-block-bullet]");
    if (!bullet || event.pointerType !== "touch" || event.button !== 0) return;
    cancelBlockMenuLongPress();
    blockMenuLongPress = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    blockMenuLongPressTimer = setTimeout(() => {
      const press = blockMenuLongPress;
      const context = blockContextForBullet(bullet);
      clearTimeout(blockMenuLongPressTimer);
      blockMenuLongPressTimer = null;
      if (!press || !context || !bullet.isConnected) {
        cancelBlockMenuLongPress();
        return;
      }
      press.triggered = true;
      suppressBlockClickUntil = Number.POSITIVE_INFINITY;
      getSelection()?.removeAllRanges();
      navigator.vibrate?.(20);
      openBlockContextMenu(
        context,
        { clientX: press.x, clientY: press.y },
        bullet,
        false,
      );
    }, 550);
  });
  outliner.addEventListener("pointermove", (event) => {
    if (
      blockMenuLongPress?.pointerId === event.pointerId &&
      !blockMenuLongPress.triggered &&
      Math.hypot(
        event.clientX - blockMenuLongPress.x,
        event.clientY - blockMenuLongPress.y,
      ) > 10
    )
      cancelBlockMenuLongPress();
  });
  outliner.addEventListener("pointerup", finishBlockMenuLongPress);
  outliner.addEventListener("pointercancel", finishBlockMenuLongPress);

  outliner.addEventListener("contextmenu", (event) => {
    const bullet = event.target.closest("[data-block-bullet]");
    const context = blockContextForBullet(bullet);
    if (context) {
      event.preventDefault();
      if (!blockMenuLongPress?.triggered) cancelBlockMenuLongPress();
      openBlockContextMenu(
        context,
        event,
        bullet,
        !blockMenuLongPress?.triggered &&
          !event.sourceCapabilities?.firesTouchEvents,
      );
      return;
    }
    closeBlockContextMenu();
    if (event.target.closest("[data-task-checkbox-page], [data-task-block]"))
      event.preventDefault();
  });
  const activateBlockContextMenuAction = async (action, context) => {
    if (!action || !context?.block) return;
    closeBlockContextMenu();
    try {
      await runBlockContextAction(action, context);
    } catch (error) {
      toast(error.message || "Could not complete the block action");
    }
  };
  let blockContextActionPointer = null;
  let suppressBlockContextActionClickUntil = 0;
  blockContextMenu.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("[data-block-context-action]");
    if (!button || event.pointerType !== "touch") return;
    event.preventDefault();
    blockContextActionPointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      action: button.dataset.blockContextAction,
      context: session.blockContextTarget,
    };
  });
  blockContextMenu.addEventListener("pointerup", (event) => {
    const target = blockContextActionPointer;
    blockContextActionPointer = null;
    if (
      !target ||
      target.id !== event.pointerId ||
      Math.hypot(event.clientX - target.x, event.clientY - target.y) > 12 ||
      event.target.closest("[data-block-context-action]")?.dataset
        .blockContextAction !== target.action
    )
      return;
    event.preventDefault();
    suppressBlockContextActionClickUntil = Date.now() + 750;
    activateBlockContextMenuAction(target.action, target.context);
  });
  blockContextMenu.addEventListener("pointercancel", () => {
    blockContextActionPointer = null;
  });
  blockContextMenu.addEventListener("click", (event) => {
    if (Date.now() < suppressBlockContextActionClickUntil) return;
    const action = event.target.closest("[data-block-context-action]")?.dataset
      .blockContextAction;
    activateBlockContextMenuAction(action, session.blockContextTarget);
  });
  blockContextMenu.addEventListener("keydown", (event) => {
    const items = $$('[role="menuitem"]', blockContextMenu);
    const index = items.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      closeBlockContextMenu();
      outliner.focus({ preventScroll: true });
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const target =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length;
      items[target]?.focus();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!blockContextMenu.hidden && !blockContextMenu.contains(event.target))
      closeBlockContextMenu();
  });
  notnoteWrap.addEventListener("scroll", closeBlockContextMenu, {
    passive: true,
  });
  window.addEventListener("resize", closeBlockContextMenu);

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
    if (shortcutMatches("blockEscape", event) && session.selectedGraphBlockIds.size) {
      event.preventDefault();
      clearGraphBlockSelection();
      return;
    }
    if (shortcutMatches("blockDelete", event) && session.selectedGraphBlockIds.size) {
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
      session.selectedGraphBlockIds.size &&
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
        if (session.graphHistoryIndex > 0) await navigateGraphHistory(-1);
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
      const page = session.graphStore?.pages.find(
        (item) => item.path === taskSource.dataset.taskPage,
      );
      if (page)
        loadGraphPage(page, { blockId: taskSource.dataset.taskBlockId });
      return;
    }
    const onThisDayBlock = event.target.closest("[data-on-this-day-page]");
    if (onThisDayBlock) {
      const page = session.graphStore?.pages.find(
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
      const resolved = session.graphIndex?.resolveBlock(
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
          ? session.graphStore?.pages.find((item) => item.path === pagePath)
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
      id: Graph.newId(),
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
}
