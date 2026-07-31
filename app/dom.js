/**
 * Stable references to application DOM elements.
 * Keep selectors here when an element is shared by multiple features; feature-only elements can
 * still be queried next to the code that owns them.
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [
  ...root.querySelectorAll(selector),
];

export const app = $("#app");
export const editor = $("#editor");
export const sourceEditor = $("#sourceEditor");
export const notnoteWrap = $("#notnoteWrap");
export const outliner = $("#outliner");
export const blockTree = $("#blockTree");
export const pageHierarchy = $("#pageHierarchy");
export const references = $("#references");
export const graphAutocomplete = $("#graphAutocomplete");
export const blockContextMenu = $("#blockContextMenu");
export const mobileBlockToolbar = $("#mobileBlockToolbar");
export const voiceRecorderPanel = $("#voiceRecorder");
export const toastElement = $("#toast");
export const imageLightbox = $("#imageLightbox");
export const imageLightboxImage = $("#imageLightboxImage");
export const documentationView = $("#settingsView");
export const documentationContent = $("#documentationContent");
export const journalCalendar = $("#journalCalendar");
export const fileName = $("#fileName");
export const documentTitleActions = $("#documentTitleActions");
export const fileInput = $("#fileInput");
export const assetInput = $("#assetInput");
export const saveState = $("#saveState");
