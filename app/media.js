/**
 * Graph asset uploads and voice recording with browser-compatible audio fallbacks.
 */

import { requireFunctions } from "./core.js";
import { toast } from "./document.js";
import {
  $,
  $$,
  assetInput,
  mobileBlockToolbar,
  voiceRecorderPanel,
} from "./dom.js";
import { session, state } from "./state.js";



// Graph mutations are injected because graph rendering also consumes media helpers.
let mediaDependencies;

export function configureMediaDependencies(dependencies) {
  mediaDependencies = requireFunctions("media", dependencies, [
    "focusGraphBlock",
    "graphBlockLocation",
    "graphChanged",
  ]);
}

let assetUploadTarget = null;
// Asset writes are delegated to the active graph store and inserted as relative references.
export function uploadGraphAsset(field, block, start, end) {
  if (!session.graphStore || !state.graphMode) return toast("Open a graph first");
  assetUploadTarget = { field, block, start, end };
  assetInput.click();
}

// Return and clear the pending upload atomically so UI events cannot reuse a stale target.
export function takeAssetUploadTarget() {
  const target = assetUploadTarget;
  assetUploadTarget = null;
  return target;
}

export let voiceRecording = null;
let voiceRecordingStarting = false;
export let voiceRecordingStartingTarget = null;

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
  const location = mediaDependencies.graphBlockLocation(target.block.id);
  if (target.pagePath !== state.graphPage?.path || !location?.block)
    throw new Error("The source block changed while recording");
  const block = location.block;
  block.content =
    `${block.content.slice(0, target.start)}${markdown}${block.content.slice(target.end)}`;
  if (block.transient) delete block.transient;
  mediaDependencies.graphChanged();
  mediaDependencies.focusGraphBlock(block.id, target.start + markdown.length);
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
    if (session.graphStore !== session.store)
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

// Prefer MediaRecorder, then fall back to a small WAV encoder when necessary.
export async function startVoiceRecording(field, block, start, end) {
  if (!session.graphStore || !state.graphMode) return toast("Open a graph first");
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
  const store = session.graphStore;
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
    if (session.graphStore !== store || state.graphPage?.path !== pagePath)
      throw new Error("The source page changed before recording started");
    const recorder = createVoiceRecorder(stream, preparedContext);
    const recordingSession = {
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
    voiceRecording = recordingSession;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) recordingSession.chunks.push(event.data);
    });
    recorder.addEventListener(
      "stop",
      () => completeVoiceRecording(recordingSession),
      { once: true },
    );
    stream.getTracks().forEach((track) => {
      track.addEventListener(
        "ended",
        () => {
          if (
            voiceRecording === recordingSession &&
            recorder.state !== "inactive"
          )
            finishVoiceRecording(true);
        },
        { once: true },
      );
    });
    recorder.start(1000);
    recordingSession.timer = setInterval(
      () => updateVoiceRecordingTime(recordingSession),
      500,
    );
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

export function finishVoiceRecording(save = true) {
  const session = voiceRecording;
  if (!session || session.finishing) return;
  session.finishing = true;
  session.save = save;
  if (session.recorder.state === "inactive") completeVoiceRecording(session);
  else session.recorder.stop();
}

