import { findRelevantPassages } from "./study-store.js";
import { buildAnswerMessages } from "./answer-prompt.js";
import {
  DEFAULT_SETTINGS,
  REASONING_EFFORTS,
  LEGACY_MODEL_MIGRATIONS,
  resolveActiveModel,
  getModelMeta
} from "./shared/config.js";

const API_URL = "https://api.deeprelay.ai/v1/chat/completions";
const MODELS_URL = "https://api.deeprelay.ai/v1/models";
const MAX_QUESTION_CHARS = 12000;
const MAX_OPTIONS = 40;
const activeRequests = new Map();
const pendingCaptures = new Map();

function prunePendingCaptures() {
  const cutoff = Date.now() - 30_000;
  for (const [id, entry] of pendingCaptures) {
    if (entry.createdAt < cutoff) pendingCaptures.delete(id);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "answerly-answer-selection",
      title: "Answer selection with Answerly",
      contexts: ["selection"]
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "answerly-answer-selection" || !tab?.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "ANSWERLY_WORDS" });
  } catch (error) {
    console.error("Answerly context-menu action could not inject or message the page.", error);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const commandTypes = {
    "answer-multiple-choice": "ANSWERLY_MULTIPLE_CHOICE",
    "answer-in-words": "ANSWERLY_WORDS",
    "answer-from-image": "ANSWERLY_ARM_IMAGE_CAPTURE",
    "clear-answers": "ANSWERLY_CLEAR_OUTPUT"
  };
  const type = commandTypes[command];
  if (!type) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  try {
    // Inject only after the user invokes a shortcut, then deliver the matching page action.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type });
  } catch (error) {
    // This error is available in the extension service worker's Inspect view on chrome://extensions.
    console.error("Answerly shortcut could not inject or message the active page.", error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if ([
    "ANSWERLY_GET_EDITOR_SELECTION",
    "ANSWERLY_REPLACE_EDITOR_SELECTION",
    "ANSWERLY_SHOW_EDITOR_STATUS",
    "ANSWERLY_FINISH_EDITOR_STATUS"
  ].includes(message?.type)) {
    const tabId = _sender.tab?.id;
    const token = String(message.token ?? "");
    if (!Number.isInteger(tabId) || !token) {
      sendResponse({ ok: false });
      return false;
    }
    const isRead = message.type === "ANSWERLY_GET_EDITOR_SELECTION";
    const isShow = message.type === "ANSWERLY_SHOW_EDITOR_STATUS";
    const isFinish = message.type === "ANSWERLY_FINISH_EDITOR_STATUS";
    const func = isRead ? readSupportedEditorSelection
      : isShow ? showSupportedEditorStatus
        : isFinish ? finishSupportedEditorStatus
          : replaceSupportedEditorSelection;
    const args = isRead || isShow
      ? [token]
      : [token, String(message.text ?? "").slice(0, MAX_QUESTION_CHARS)];
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func,
      args
    }).then((results) => {
      const result = results?.[0]?.result;
      sendResponse(isRead
        ? { ok: true, selection: result || null }
        : isShow ? { ok: true, shown: result === true }
          : { ok: true, replaced: result === true });
    }).catch(() => sendResponse(isRead
      ? { ok: false, selection: null }
      : isShow ? { ok: false, shown: false }
        : { ok: false, replaced: false }));
    return true;
  }

  if (message?.type === "ANSWERLY_CANCEL_REQUEST") {
    activeRequests.get(String(message.requestId))?.abort();
    if (message.captureId) pendingCaptures.delete(String(message.captureId));
    return false;
  }

  if (message?.type === "ANSWERLY_PREPARE_IMAGE_CAPTURE") {
    const captureId = String(message.captureId ?? "");
    const tabId = _sender.tab?.id;
    const windowId = _sender.tab?.windowId;
    if (!captureId || !Number.isInteger(tabId) || !Number.isInteger(windowId)) {
      sendResponse({ ok: false, error: "Could not capture this tab. Try Alt+R again." });
      return false;
    }
    (async () => {
      const settings = await loadActiveSettings();
      const modelMeta = getModelMeta(settings.activeModel);
      if (!modelMeta.vision) {
        throw new Error("Alt+R needs a vision model. Choose DeepSeek V4.1 Flash, Kimi K3.1 Pro, or GLM 5.3 Flash in Answerly settings.");
      }
      const imageDataUrl = await captureImageRegion(
        tabId,
        windowId,
        message.payload?.imageRect,
        message.payload?.viewport,
        Boolean(message.payload?.isExactCrop)
      );
      prunePendingCaptures();
      pendingCaptures.set(captureId, { imageDataUrl, createdAt: Date.now() });
      return { ok: true };
    })()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }

  if (message?.type === "ANSWERLY_TEST_API_KEY") {
    testApiKey(message.apiKey, message.model)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }

  if (message?.type === "ANSWERLY_IMAGE_REQUEST") {
    const requestId = String(message.requestId ?? "");
    const tabId = _sender.tab?.id;
    const windowId = _sender.tab?.windowId;
    if (!requestId || !Number.isInteger(tabId) || !Number.isInteger(windowId)) {
      sendResponse({ ok: false, error: "Could not capture this tab. Try Alt+R again." });
      return false;
    }
    const controller = new AbortController();
    activeRequests.set(requestId, controller);
    const payload = message.captureId
      ? { ...message.payload, captureId: message.captureId }
      : message.payload;
    answerImageQuestion(payload, tabId, windowId, controller.signal)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }))
      .finally(() => {
        if (activeRequests.get(requestId) === controller) activeRequests.delete(requestId);
      });
    return true;
  }

  if (message?.type !== "ANSWERLY_ANSWER_REQUEST") return false;

  const requestId = String(message.requestId ?? "");
  if (!requestId) {
    sendResponse({ ok: false, error: "Missing request identifier." });
    return false;
  }
  const controller = new AbortController();
  activeRequests.set(requestId, controller);
  answerTextQuestion(message.payload, controller.signal)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }))
    .finally(() => {
      if (activeRequests.get(requestId) === controller) activeRequests.delete(requestId);
    });
  return true;
});

function readSupportedEditorSelection(token) {
  const storeKey = Symbol.for("answerly.editorSelections");
  const store = globalThis[storeKey] || (globalThis[storeKey] = new Map());
  for (const [key, value] of store) if (Date.now() - value.createdAt > 120000) store.delete(key);
  const active = document.activeElement;
  const save = (entry) => {
    if (!entry?.text || !entry.snapshot) return null;
    store.set(token, { ...entry, createdAt: Date.now() });
    return { text: entry.text };
  };

  const cmWrappers = [...document.querySelectorAll(".CodeMirror")];
  for (const wrapper of cmWrappers) {
    const editor = wrapper.CodeMirror;
    if (!editor || !(editor.hasFocus?.() || wrapper.contains(active))) continue;
    const selections = editor.listSelections?.() || [];
    if (selections.length !== 1) continue;
    const text = editor.getSelection?.() || "";
    if (!text.trim()) continue;
    const point = (value) => ({ line: value.line, ch: value.ch });
    return save({
      type: "codemirror",
      editor,
      text,
      end: point(editor.getCursor("to")),
      snapshot: selections.map(({ anchor, head }) => ({ anchor: point(anchor), head: point(head) }))
    });
  }

  const aceRoots = [...document.querySelectorAll(".ace_editor")];
  for (const root of aceRoots) {
    if (!(root.contains(active) || root.matches(":focus-within"))) continue;
    let editor = root.env?.editor;
    if (!editor && globalThis.ace?.edit) {
      try { editor = globalThis.ace.edit(root); } catch { /* Not an initialized Ace editor. */ }
    }
    if (!editor?.getSelectedText || !editor?.getSelectionRange) continue;
    const text = editor.getSelectedText();
    if (!text.trim()) continue;
    const range = editor.getSelectionRange();
    const snapshot = {
      start: { row: range.start.row, column: range.start.column },
      end: { row: range.end.row, column: range.end.column }
    };
    return save({ type: "ace", editor, text, snapshot });
  }

  const monacoEditors = globalThis.monaco?.editor?.getEditors?.() || [];
  for (const editor of monacoEditors) {
    const root = editor.getDomNode?.();
    if (!(editor.hasTextFocus?.() || root?.contains(active))) continue;
    const model = editor.getModel?.();
    const selection = editor.getSelection?.();
    if (!model || !selection || selection.isEmpty?.()) continue;
    const text = model.getValueInRange(selection);
    if (!text.trim()) continue;
    return save({ type: "monaco", editor, model, text, snapshot: selection });
  }
  return null;
}

function replaceSupportedEditorSelection(token, text) {
  const store = globalThis[Symbol.for("answerly.editorSelections")];
  const entry = store?.get(token);
  store?.delete(token);
  if (!entry || !text || entry.text.length > 20000) return false;
  const prefix = /[\r\n]$/.test(entry.text) ? "" : "\n";
  const suffix = /[\r\n]$/.test(text) ? "" : "\n";
  const insertionText = `${prefix}${text}${suffix}`;

  if (entry.type === "codemirror") {
    const selections = entry.editor.listSelections?.() || [];
    const same = JSON.stringify(selections.map(({ anchor, head }) => ({
      anchor: { line: anchor.line, ch: anchor.ch },
      head: { line: head.line, ch: head.ch }
    }))) === JSON.stringify(entry.snapshot);
    if (!same || entry.editor.getSelection?.() !== entry.text) return false;
    entry.editor.replaceRange(insertionText, entry.end, entry.end, "+answerly");
    return true;
  }

  if (entry.type === "ace") {
    const range = entry.editor.getSelectionRange?.();
    if (!range || range.start.row !== entry.snapshot.start.row || range.start.column !== entry.snapshot.start.column ||
        range.end.row !== entry.snapshot.end.row || range.end.column !== entry.snapshot.end.column ||
        entry.editor.getSelectedText?.() !== entry.text) return false;
    entry.editor.clearSelection();
    entry.editor.moveCursorToPosition(entry.snapshot.end);
    entry.editor.insert(insertionText);
    return true;
  }

  if (entry.type === "monaco") {
    const model = entry.editor.getModel?.();
    const selection = entry.editor.getSelection?.();
    if (model !== entry.model || !selection || model.getValueInRange(selection) !== entry.text ||
        selection.startLineNumber !== entry.snapshot.startLineNumber ||
        selection.startColumn !== entry.snapshot.startColumn ||
        selection.endLineNumber !== entry.snapshot.endLineNumber ||
        selection.endColumn !== entry.snapshot.endColumn) return false;
    const end = { lineNumber: selection.endLineNumber, column: selection.endColumn };
    const collapsedRange = {
      startLineNumber: end.lineNumber,
      startColumn: end.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column
    };
    return entry.editor.executeEdits("answerly", [{ range: collapsedRange, text: insertionText, forceMoveMarkers: true }]) === true;
  }
  return false;
}

function showSupportedEditorStatus(token) {
  const insertionFor = (selectedText, text) => {
    const prefix = /[\r\n]$/.test(selectedText) ? "" : "\n";
    const suffix = /[\r\n]$/.test(text) ? "" : "\n";
    return `${prefix}${text}${suffix}`;
  };
  const sameAceRange = (range, snapshot) => Boolean(range) &&
    range.start.row === snapshot.start.row && range.start.column === snapshot.start.column &&
    range.end.row === snapshot.end.row && range.end.column === snapshot.end.column;
  const sameMonacoSelection = (selection, snapshot) => Boolean(selection) &&
    selection.startLineNumber === snapshot.startLineNumber && selection.startColumn === snapshot.startColumn &&
    selection.endLineNumber === snapshot.endLineNumber && selection.endColumn === snapshot.endColumn;
  const commentPrefix = (entry) => {
    const mode = entry.type === "ace" ? entry.editor.session.getMode?.().$id
      : entry.type === "monaco" ? entry.model.getLanguageId?.()
        : entry.editor.getMode?.().name;
    return /python|ruby|shell|bash|yaml|toml|perl|powershell/i.test(String(mode || "")) ? "#" : "//";
  };
  const store = globalThis[Symbol.for("answerly.editorSelections")];
  const entry = store?.get(token);
  if (!entry || entry.status) return false;
  const statusText = `${commentPrefix(entry)} Thinking…`;
  const insertionText = insertionFor(entry.text, statusText);

  if (entry.type === "codemirror") {
    const selections = entry.editor.listSelections?.() || [];
    if (JSON.stringify(selections.map(({ anchor, head }) => ({
      anchor: { line: anchor.line, ch: anchor.ch },
      head: { line: head.line, ch: head.ch }
    }))) !== JSON.stringify(entry.snapshot) || entry.editor.getSelection?.() !== entry.text) return false;
    const start = entry.end;
    const startIndex = entry.editor.indexFromPos(start);
    entry.editor.replaceRange(insertionText, start, start, "+answerly-status");
    entry.status = {
      start,
      end: entry.editor.posFromIndex(startIndex + insertionText.length),
      text: insertionText
    };
    return true;
  }

  if (entry.type === "ace") {
    const range = entry.editor.getSelectionRange?.();
    if (!sameAceRange(range, entry.snapshot) || entry.editor.getSelectedText?.() !== entry.text) return false;
    const doc = entry.editor.session.getDocument();
    const startIndex = doc.positionToIndex(entry.snapshot.end);
    entry.editor.clearSelection();
    entry.editor.moveCursorToPosition(entry.snapshot.end);
    entry.editor.insert(insertionText);
    entry.status = {
      start: doc.indexToPosition(startIndex),
      end: doc.indexToPosition(startIndex + insertionText.length),
      text: insertionText
    };
    return true;
  }

  if (entry.type === "monaco") {
    const model = entry.editor.getModel?.();
    const selection = entry.editor.getSelection?.();
    if (model !== entry.model || !sameMonacoSelection(selection, entry.snapshot) ||
        model.getValueInRange(selection) !== entry.text) return false;
    const start = { lineNumber: selection.endLineNumber, column: selection.endColumn };
    const startOffset = model.getOffsetAt(start);
    const editRange = {
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: start.lineNumber,
      endColumn: start.column
    };
    if (entry.editor.executeEdits("answerly-status", [{ range: editRange, text: insertionText, forceMoveMarkers: true }]) !== true) return false;
    entry.status = {
      start: model.getPositionAt(startOffset),
      end: model.getPositionAt(startOffset + insertionText.length),
      text: insertionText
    };
    return true;
  }
  return false;
}

function finishSupportedEditorStatus(token, replacementText) {
  const insertionFor = (selectedText, text) => {
    const prefix = /[\r\n]$/.test(selectedText) ? "" : "\n";
    const suffix = /[\r\n]$/.test(text) ? "" : "\n";
    return `${prefix}${text}${suffix}`;
  };
  const store = globalThis[Symbol.for("answerly.editorSelections")];
  const entry = store?.get(token);
  if (!entry?.status) {
    store?.delete(token);
    return false;
  }
  const { start, end, text: currentStatus } = entry.status;
  const replacement = replacementText ? insertionFor(entry.text, replacementText) : "";
  let replaced = false;

  if (entry.type === "codemirror" && entry.editor.getRange(start, end) === currentStatus) {
    entry.editor.replaceRange(replacement, start, end, "+answerly-finish");
    replaced = true;
  } else if (entry.type === "ace") {
    const session = entry.editor.session;
    const current = session.getTextRange({ start, end });
    if (current === currentStatus) {
      session.replace({ start, end }, replacement);
      replaced = true;
    }
  } else if (entry.type === "monaco") {
    const model = entry.editor.getModel?.();
    const range = {
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column
    };
    if (model === entry.model && model.getValueInRange(range) === currentStatus) {
      replaced = entry.editor.executeEdits("answerly-finish", [{ range, text: replacement, forceMoveMarkers: true }]) === true;
    }
  }

  store?.delete(token);
  return replaced;
}

async function loadActiveSettings() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const rawModel = String(settings.model || "");
  if (Object.hasOwn(LEGACY_MODEL_MIGRATIONS, rawModel)) {
    const migrated = LEGACY_MODEL_MIGRATIONS[rawModel];
    settings.model = migrated;
    chrome.storage.local.set({ model: migrated }).catch(() => {});
  }
  return {
    ...settings,
    activeModel: resolveActiveModel(settings)
  };
}

async function answerTextQuestion(payload, signal) {
  const mode = payload?.mode === "multiple-choice" ? "multiple-choice" : "words";
  const question = String(payload?.question ?? "").trim().slice(0, MAX_QUESTION_CHARS);
  if (!question) throw new Error("Highlight a question before using the shortcut.");
  const options = Array.isArray(payload?.options)
    ? payload.options.slice(0, MAX_OPTIONS).map((option) => ({
        id: String(option.id),
        text: String(option.text ?? "").trim().slice(0, 1000)
      })).filter((option) => option.text)
    : [];
  if (mode === "multiple-choice" && options.length < 2) {
    throw new Error("No multiple-choice options were found near the highlighted question.");
  }
  return requestAnswer({ mode, question, options, signal });
}

async function answerImageQuestion(payload, tabId, windowId, signal) {
  const settings = await loadActiveSettings();
  const modelMeta = getModelMeta(settings.activeModel);
  if (!modelMeta.vision) {
    throw new Error("Alt+R needs a vision model. Choose DeepSeek V4.1 Flash, Kimi K3.1 Pro, or GLM 5.3 Flash in Answerly settings.");
  }
  const captureId = String(payload?.captureId ?? "");
  let imageDataUrl = "";
  if (captureId && pendingCaptures.has(captureId)) {
    imageDataUrl = pendingCaptures.get(captureId).imageDataUrl;
    pendingCaptures.delete(captureId);
  } else {
    imageDataUrl = await captureImageRegion(
      tabId,
      windowId,
      payload?.imageRect,
      payload?.viewport,
      Boolean(payload?.isExactCrop)
    );
  }
  const question = String(payload?.question ?? "Read and answer the question shown in the attached image.")
    .trim().slice(0, MAX_QUESTION_CHARS);
  return requestAnswer({
    mode: "image",
    question,
    options: [],
    imageDataUrl,
    settings,
    signal
  });
}

async function captureImageRegion(tabId, windowId, rect, viewport, isExactCrop = false) {
  if (![rect?.x, rect?.y, rect?.width, rect?.height, viewport?.width, viewport?.height]
    .every((value) => Number.isFinite(Number(value)))) {
    throw new Error("Could not identify the captured image area. Press Alt+R and try again.");
  }
  const vw = Number(viewport.width);
  const vh = Number(viewport.height);
  if (vw <= 0 || vh <= 0) {
    throw new Error("Could not identify the visible page size. Try Alt+R again.");
  }
  const rawLeft = Math.max(0, Number(rect.x));
  const rawTop = Math.max(0, Number(rect.y));
  const rawRight = Math.min(vw, Number(rect.x) + Number(rect.width));
  const rawBottom = Math.min(vh, Number(rect.y) + Number(rect.height));
  if (rawRight <= rawLeft || rawBottom <= rawTop) {
    throw new Error("The selected image is outside the visible page. Scroll it into view and try Alt+R again.");
  }
  let screenshot;
  try {
    // Capture the visible tab only after Alt+R is invoked and the user selects the target area.
    screenshot = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch {
    throw new Error("Could not capture this page. Check that the tab is active, then try Alt+R again.");
  }
  const source = await createImageBitmap(await (await fetch(screenshot)).blob());
  const scaleX = source.width / vw;
  const scaleY = source.height / vh;
  const padX = isExactCrop ? 0 : Math.max(16, (rawRight - rawLeft) * 0.03);
  const padY = isExactCrop ? 0 : Math.max(16, (rawBottom - rawTop) * 0.03);
  const x = Math.max(0, Math.floor((rawLeft - padX) * scaleX));
  const y = Math.max(0, Math.floor((rawTop - padY) * scaleY));
  const right = Math.min(source.width, Math.ceil((rawRight + padX) * scaleX));
  const bottom = Math.min(source.height, Math.ceil((rawBottom + padY) * scaleY));
  if (right <= x || bottom <= y) {
    source.close();
    throw new Error("The selected image is outside the visible page. Scroll it into view and try Alt+R again.");
  }
  const maxDimension = 2200;
  const shrink = Math.min(1, maxDimension / Math.max(right - x, bottom - y));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round((right - x) * shrink)), Math.max(1, Math.round((bottom - y) * shrink)));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    source.close();
    throw new Error("Could not process the captured image region.");
  }
  context.drawImage(source, x, y, right - x, bottom - y, 0, 0, canvas.width, canvas.height);
  source.close();
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
  if (blob.size > 5 * 1024 * 1024) {
    throw new Error("The captured image is too large to send safely. Try capturing a smaller area.");
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

async function requestAnswer({ mode, question, options = [], imageDataUrl = "", settings: preloadedSettings = null, signal }) {
  const settings = preloadedSettings || await loadActiveSettings();
  const apiKey = String(settings.apiKey || "").trim();
  if (!apiKey) throw new Error("Add your Deep Relay API key in the extension settings first.");
  const activeModel = settings.activeModel;
  if (!activeModel) throw new Error("Choose a model in the extension settings.");

  const groundingMode = settings.groundingMode === "hybrid" ? "hybrid" : "strict";
  const reference = await findRelevantPassages(question, 6, 10_000, {
    choices: options.map((option) => option.text),
    activeSetId: String(settings.activeSetId || ""),
    onlyEnabled: true
  });
  const passages = reference.passages;

  const { response, body } = await postAnswerRequest({
    apiKey,
    model: activeModel,
    reasoningEffort: settings.reasoningEffort,
    messages: buildAnswerMessages({
      mode,
      question,
      options,
      hasFiles: reference.hasFiles,
      passages,
      imageDataUrl,
      customInstructions: settings.answerInstructions,
      groundingMode
    }),
    schema: answerSchema(),
    signal
  });
  if (!response.ok) throw new Error(formatDeepRelayError(response, body));

  const choice = body?.choices?.[0];
  const finishReason = choice?.finish_reason || "";
  const content = choice?.message?.content;
  const text = typeof content === "string"
    ? content.trim()
    : Array.isArray(content)
      ? content.map((part) => typeof part?.text === "string" ? part.text : "").join("").trim()
      : "";
  if (!text) throw new Error("The AI returned an empty answer. Try again.");

  const result = parseModelJson(text, finishReason);
  if (typeof result.answer !== "string" || typeof result.explanation !== "string" ||
    (mode === "multiple-choice" && typeof result.correctOptionId !== "string")) {
    throw new Error("The AI response did not contain a valid answer.");
  }
  const correctOptionId = typeof result.correctOptionId === "string" ? result.correctOptionId : "";
  const validIds = new Set(options.map((option) => option.id));
  if (mode === "multiple-choice" && correctOptionId !== "" && !validIds.has(correctOptionId)) {
    throw new Error("The AI answer did not match any detected choice. Try again.");
  }
  const validCitations = new Set(passages.map((passage) => `${passage.file}\u0000${passage.location}`));
  const citations = Array.isArray(result.citations)
    ? result.citations.filter((citation) => validCitations.has(`${citation.file}\u0000${citation.location}`)).slice(0, 3)
    : [];
  return {
    answer: result.answer.slice(0, 4000),
    explanation: result.explanation.slice(0, 6000),
    correctOptionId: mode === "multiple-choice" && correctOptionId ? correctOptionId : null,
    citations
  };
}

function parseModelJson(text, finishReason) {
  const stripped = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const firstBrace = stripped.indexOf("{");
    const lastBrace = stripped.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(stripped.slice(firstBrace, lastBrace + 1));
      } catch {
        // Fall through to structured error message.
      }
    }
    if (finishReason === "length") {
      throw new Error("The AI response was cut off because it exceeded the length limit. Try a lower thinking level or shorter prompt.");
    }
    throw new Error("The AI response was not valid JSON. Try again.");
  }
}

function answerSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      answer: { type: "string" },
      explanation: { type: "string" },
      correctOptionId: { type: "string" },
      citations: citationSchema()
    },
    required: ["answer", "explanation", "correctOptionId", "citations"]
  };
}

async function postAnswerRequest({ apiKey, model, reasoningEffort = "medium", messages, schema, signal }) {
  const modelMeta = getModelMeta(model);
  const maxTokens = ["high", "xhigh"].includes(reasoningEffort) ? 4096 : 2048;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey.trim()}`
  };
  const send = (responseFormat) => {
    const requestBody = { model, messages, max_tokens: maxTokens, response_format: responseFormat };
    if (REASONING_EFFORTS.includes(reasoningEffort) && reasoningEffort !== "") {
      requestBody.reasoning_effort = reasoningEffort;
    }
    if (modelMeta.supportsTemperature) requestBody.temperature = 0.2;
    return fetch(API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal
    });
  };

  let response = await send(modelMeta.useJsonObjectFirst
    ? { type: "json_object" }
    : { type: "json_schema", json_schema: { name: "answer_result", strict: true, schema } });
  let body = await response.json().catch(() => ({}));
  const relayErrorCode = response.headers.get("X-Deeprelay-Error-Code") || body?.error?.code || "";
  const errorMessage = String(body?.error?.message || "").toLowerCase();
  const rejectedSchema = relayErrorCode === "upstream_rejected_request" ||
    errorMessage.includes("upstream model rejected this request as invalid");
  if (!response.ok && rejectedSchema && !modelMeta.useJsonObjectFirst) {
    response = await send({ type: "json_object" });
    body = await response.json().catch(() => ({}));
  }
  return { response, body };
}

async function testApiKey(rawKey, requestedModel) {
  const apiKey = String(rawKey || "").trim();
  if (!apiKey) {
    return { ok: false, error: "Enter your Deep Relay API key first." };
  }
  const startedAt = Date.now();
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
  let response = await fetch(MODELS_URL, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(8000)
  });
  if (response.status === 404 || response.status === 405) {
    const settings = await loadActiveSettings();
    const model = String(requestedModel || settings.activeModel).trim() || DEFAULT_SETTINGS.model;
    response = await fetch(API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with ok" }],
        max_tokens: 1
      }),
      signal: AbortSignal.timeout(8000)
    });
  }
  const latencyMs = Date.now() - startedAt;
  const body = await response.json().catch(() => ({}));
  if (response.ok) {
    return { ok: true, latencyMs, message: `Connected (${latencyMs} ms)` };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: "API key rejected. Check that you copied the full Deep Relay key." };
  }
  return { ok: false, error: formatDeepRelayError(response, body) };
}

function formatDeepRelayError(response, body) {
  const code = response.headers.get("X-Deeprelay-Error-Code") || body?.error?.code || "";
  const detail = body?.error?.message || "Unknown provider error.";
  return `Deep Relay request failed (${response.status}${code ? `, ${code}` : ""}): ${detail}`;
}

function citationSchema() {
  return {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: { file: { type: "string" }, location: { type: "string" } },
      required: ["file", "location"]
    }
  };
}

function safeErrorMessage(error) {
  if (error?.name === "AbortError") return "Request cancelled.";
  if (error?.name === "TimeoutError") return "Deep Relay timed out. Check your connection and try again.";
  return error instanceof Error ? error.message : "Answerly could not answer this question.";
}
