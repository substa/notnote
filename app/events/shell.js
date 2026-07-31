/**
 * Global shell, mobile toolbar, journal calendar, and focus interactions.
 */

import { notifyMarkdownField, showCommandPalette } from "../commands.js";
import {
  openBlockContextMenu,
  resetMobileViewportHeight,
  updateMobileToolbarPosition,
  vimRedoStack,
  vimUndoStack,
} from "../core.js";
import { changed, requestAction, toast } from "../document.js";
import {
  $,
  editor,
  graphAutocomplete,
  journalCalendar,
  mobileBlockToolbar,
  outliner,
  voiceRecorderPanel,
} from "../dom.js";
import {
  closeJournalCalendar,
  focusCalendarDate,
  loadGraphPage,
  moveCalendarFocus,
  moveCalendarMonth,
  openToday,
  selectCalendarDate,
  toggleJournalCalendar,
} from "../graph-session.js";
import { commitGraphBlock, openTasksPage, toggleAllGraphBlocks } from "../graph-view.js";
import {
  finishVoiceRecording,
  startVoiceRecording,
  uploadGraphAsset,
  voiceRecording,
} from "../media.js";
import { indentGraphBlock, moveGraphBlock, toggleGraphTask } from "../outliner.js";
import { session, state } from "../state.js";
import {
  applyAppHistory,
  captureVimSnapshot,
  commitActiveBlock,
  pushVimSnapshot,
} from "../vim.js";



export function initShellEvents() {
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
    setTimeout(resetMobileViewportHeight, 250),
  );
  let mobileRecordPointer = null;
  let mobileMorePointer = null;
  let suppressMobileRecordClickUntil = 0;
  let suppressMobileMoreClickUntil = 0;
  const openMobileBlockMenu = (event, trigger) => {
    const block = session.activeGraphBlock?.block;
    const page = session.activeGraphBlock?.page || state.graphPage;
    const document =
      page?.path === state.graphPage?.path
        ? state.graphDocument
        : session.journalDocuments.get(page?.path) ||
          session.graphIndex?.documents.get(page?.path);
    if (block && page && document)
      openBlockContextMenu(
        { block, page, document },
        event,
        trigger,
        false,
      );
  };
  mobileBlockToolbar.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (event.pointerType !== "touch" || !session.activeGraphBlock) return;
    const action = event.target.closest("[data-block-action]")?.dataset
      .blockAction;
    if (action === "more")
      mobileMorePointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
    else if (action === "record")
      mobileRecordPointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        field: session.activeGraphBlock.field,
        block: session.activeGraphBlock.block,
        start: session.activeGraphBlock.field.selectionStart,
        end: session.activeGraphBlock.field.selectionEnd,
      };
  });
  mobileBlockToolbar.addEventListener("pointerup", (event) => {
    const moreTarget = mobileMorePointer;
    mobileMorePointer = null;
    if (
      moreTarget?.id === event.pointerId &&
      Math.hypot(
        event.clientX - moreTarget.x,
        event.clientY - moreTarget.y,
      ) <= 12 &&
      event.target.closest('[data-block-action="more"]')
    ) {
      event.preventDefault();
      suppressMobileMoreClickUntil = Date.now() + 750;
      openMobileBlockMenu(
        event,
        event.target.closest('[data-block-action="more"]'),
      );
      return;
    }
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
    mobileMorePointer = null;
  });
  mobileBlockToolbar.addEventListener("click", (event) => {
    const button = event.target.closest("[data-block-action]");
    const field = session.activeGraphBlock?.field;
    const block = session.activeGraphBlock?.block;
    if (!button || !field || !block) return;
    const action = button.dataset.blockAction;
    if (action === "more") {
      if (Date.now() >= suppressMobileMoreClickUntil)
        openMobileBlockMenu(event, button);
      return;
    }
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
        session.activeSourceBlock &&
        !editor.contains(event.target) &&
        !$("#commandPalette").contains(event.target)
      )
        commitActiveBlock();
      if (
        session.activeGraphBlock &&
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
        session.activeSourceBlock &&
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
      const resolved = session.graphIndex?.resolveBlock(
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
      const page = session.graphStore?.pages.find(
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
    selectCalendarDate(selectedDate);
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
      moveCalendarFocus(movements[event.key]);
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
}
