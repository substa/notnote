/**
 * Shared graph API and application state.
 * The graph engine remains DOM-free and exposes its browser API before the app bundle starts.
 */
export const Graph = window.NotnoteGraph;
if (!Graph) throw new Error("The graph engine must load before the application");

/**
 * Shared application state.
 * `state` contains serializable document and view data. `session` contains transient browser,
 * storage, selection, and navigation handles that must be shared across features.
 */

export const state = {
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

export const session = {
  graphSettings: null,
  journalDocuments: new Map(),
  graphHistory: [],
  graphHistoryIndex: -1,
  graphStore: null,
  graphIndex: null,
  closeRemoteEvents: null,
  remoteRefreshPending: false,
  activeGraphBlock: null,
  blockContextTarget: null,
  selectedGraphBlockIds: new Set(),
  graphSelectionPagePath: null,
  graphDraftTimer: null,
  activeSourceBlock: null,
  vimPending: "",
  vimDesiredColumn: null,
  vimInsertSnapshot: null,
};
