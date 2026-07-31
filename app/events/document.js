/**
 * Standalone editor, title, upload, dialog, and media-lightbox interactions.
 */

import {
  beginTitleEdit,
  closeDeletePageDialog,
  confirmDeleteCurrentGraphPage,
  deleteCurrentGraphPage,
  finishTitleEdit,
  renameGraphPage,
} from "../commands.js";
import { usesMobileInput } from "../core.js";
import {
  changed,
  loadMarkdown,
  markdownShortcut,
  persistLocal,
  toast,
  transformInlineMarkdown,
} from "../document.js";
import {
  $,
  assetInput,
  documentTitleActions,
  editor,
  fileInput,
  fileName,
  imageLightbox,
  imageLightboxImage,
  outliner,
  sourceEditor,
} from "../dom.js";
import { closeAssetCleanupDialog, graphChanged } from "../graph-session.js";
import { focusGraphBlock } from "../graph-view.js";
import { takeAssetUploadTarget } from "../media.js";
import { handleSelectionDelimiter, handleWikiPair } from "../outliner.js";
import { session, state } from "../state.js";
import { activateSourceBlock, commitActiveBlock, recordVimChange } from "../vim.js";



export function initDocumentEvents() {
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (file) loadMarkdown(await file.text(), file.name);
    fileInput.value = "";
  });
  assetInput.addEventListener("change", async () => {
    const file = assetInput.files[0];
    const target = takeAssetUploadTarget();
    assetInput.value = "";
    if (!file || !target) return;
    try {
      const path = await session.graphStore.writeAsset(file);
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
  let titleActionPointerActive = false;

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
      session.activeSourceBlock?.contains(event.target)
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

  let imageLightboxTrigger = null;

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
}
