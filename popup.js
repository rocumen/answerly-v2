import {
  CURATED_MODELS,
  DEFAULT_ANSWER_INSTRUCTIONS,
  DEFAULT_SETTINGS,
  REASONING_EFFORTS,
  STUDY_LIMITS,
  clampFontScale,
  isValidHexColor,
  migrateAnswerInstructions,
  migrateModelId
} from "./shared/config.js";
import {
  clearStudyFiles,
  createStudySet,
  deleteStudySet,
  listStudyFiles,
  listStudySets,
  removeStudyFile,
  removeStudyFilesBySet,
  renameStudySet,
  saveStudyFile,
  updateStudyFile
} from "./study-store.js";
import { createStudyModuleFromText } from "./shared/text-module.js";

const CUSTOM_MODEL_OPTION = "__custom__";

const tabModulesBtn = document.getElementById("tab-modules");
const tabSettingsBtn = document.getElementById("tab-settings");
const panelModules = document.getElementById("panel-modules");
const panelSettings = document.getElementById("panel-settings");
const saveStatusPill = document.getElementById("save-status");
const modulesCountBadge = document.getElementById("modules-count-badge");

const dragOverlay = document.getElementById("drag-overlay");
const importFilesLabel = document.getElementById("import-files-label");
const fileInput = document.getElementById("file-input");
const togglePasteBtn = document.getElementById("toggle-paste");
const pasteDrawer = document.getElementById("paste-drawer");
const pasteTitleInput = document.getElementById("paste-title");
const pasteBodyInput = document.getElementById("paste-body");
const pasteSaveBtn = document.getElementById("paste-save");
const pasteCancelBtn = document.getElementById("paste-cancel");
const importPageBtn = document.getElementById("import-page");
const importProgress = document.getElementById("import-progress");
const importProgressFill = document.getElementById("import-progress-fill");
const importProgressText = document.getElementById("import-progress-text");
const fileStatus = document.getElementById("file-status");

const setsBar = document.getElementById("sets-bar");
const renameSetBtn = document.getElementById("rename-set-btn");
const deleteSetBtn = document.getElementById("delete-set-btn");
const newSetForm = document.getElementById("new-set-form");
const newSetNameInput = document.getElementById("new-set-name");
const newSetSaveBtn = document.getElementById("new-set-save");
const newSetCancelBtn = document.getElementById("new-set-cancel");
const deleteSetConfirm = document.getElementById("delete-set-confirm");
const deleteSetYesBtn = document.getElementById("delete-set-yes");
const deleteSetNoBtn = document.getElementById("delete-set-no");

const groundingStrictBtn = document.getElementById("grounding-strict");
const groundingHybridBtn = document.getElementById("grounding-hybrid");
const groundingHint = document.getElementById("grounding-hint");

const moduleSearchWrap = document.getElementById("module-search-wrap");
const moduleSearchInput = document.getElementById("module-search");
const emptyModules = document.getElementById("empty-modules");
const fileList = document.getElementById("study-files");
const modulesFooter = document.getElementById("modules-footer");
const librarySummary = document.getElementById("library-summary");
const clearFilesBtn = document.getElementById("clear-files");
const clearFilesConfirm = document.getElementById("clear-files-confirm");
const clearFilesYesBtn = document.getElementById("clear-files-yes");
const clearFilesNoBtn = document.getElementById("clear-files-no");

const keyInput = document.getElementById("api-key");
const toggleApiKeyBtn = document.getElementById("toggle-api-key");
const eyeIcon = document.getElementById("eye-icon");
const testApiKeyBtn = document.getElementById("test-api-key");
const keyTestStatus = document.getElementById("key-test-status");
const modelSelect = document.getElementById("model");
const customModelWrap = document.getElementById("custom-model-wrap");
const customModelInput = document.getElementById("custom-model-id");
const reasoningEffortSelect = document.getElementById("reasoning-effort");
const answerInstructionsInput = document.getElementById("answer-instructions");
const resetPromptBtn = document.getElementById("reset-prompt-btn");
const resetPromptConfirm = document.getElementById("reset-prompt-confirm");
const resetPromptYesBtn = document.getElementById("reset-prompt-yes");
const resetPromptNoBtn = document.getElementById("reset-prompt-no");
const answerSizeInput = document.getElementById("answer-size");
const answerSizeValue = document.getElementById("answer-size-value");
const answerSizePreview = document.getElementById("answer-size-preview");
const matchQuestionColorInput = document.getElementById("match-question-color");
const customColorRow = document.getElementById("custom-color-row");
const answerColorInput = document.getElementById("answer-color");
const openShortcutsBtn = document.getElementById("open-shortcuts");

let state = {
  activeTab: "modules",
  activeSetId: "",
  groundingMode: "strict",
  searchQuery: "",
  expandedIds: new Set(),
  renamingSetId: "",
  processingFiles: false,
  dragDepth: 0
};
let autoSaveTimer = 0;

populateModelSelect();
initializePopup();

function populateModelSelect() {
  modelSelect.replaceChildren();
  for (const model of CURATED_MODELS) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.vision ? `${model.label} (vision)` : model.label;
    modelSelect.append(option);
  }
  const customOption = document.createElement("option");
  customOption.value = CUSTOM_MODEL_OPTION;
  customOption.textContent = "Custom model ID…";
  modelSelect.append(customOption);
}

async function initializePopup() {
  try {
    const raw = await chrome.storage.local.get(DEFAULT_SETTINGS);
    const migratedModel = migrateModelId(raw.model);
    const { value: instructions, migrated: instructionsMigrated } = migrateAnswerInstructions(raw.answerInstructions);
    if (migratedModel !== raw.model || instructionsMigrated) {
      chrome.storage.local.set({ model: migratedModel, answerInstructions: instructions }).catch(() => {});
    }

    keyInput.value = String(raw.apiKey || "");
    const useCustom = Boolean(raw.useCustomModel);
    modelSelect.value = useCustom ? CUSTOM_MODEL_OPTION : migratedModel;
    customModelInput.value = String(raw.customModelId || "");
    customModelWrap.hidden = !useCustom;

    reasoningEffortSelect.value = REASONING_EFFORTS.includes(raw.reasoningEffort) ? raw.reasoningEffort : "medium";
    answerInstructionsInput.value = instructions;

    const clampedScale = clampFontScale(raw.answerFontScale);
    answerSizeInput.value = String(Math.round(clampedScale * 100));
    updateAnswerSizeUI();

    matchQuestionColorInput.checked = raw.answerUsePageColor !== false;
    answerColorInput.value = isValidHexColor(raw.answerCustomColor) ? raw.answerCustomColor : "#333333";
    customColorRow.hidden = matchQuestionColorInput.checked;

    state.groundingMode = raw.groundingMode === "hybrid" ? "hybrid" : "strict";
    state.activeSetId = String(raw.activeSetId || "");
    updateGroundingUI();

    const preferredTab = raw.apiKey
      ? (raw.activePopupTab === "settings" ? "settings" : "modules")
      : "settings";
    switchTab(preferredTab, false);
    updateSavePill(keyInput.value.trim() ? "saved" : "warning", keyInput.value.trim() ? "Saved" : "Add API key");
  } catch {
    updateSavePill("error", "Load failed");
  }

  await refreshLibrary().catch(() => {
    showFileStatus("Could not load attached modules.", "error");
  });
}

function switchTab(tab, persist = true) {
  state.activeTab = tab === "settings" ? "settings" : "modules";
  const isModules = state.activeTab === "modules";
  tabModulesBtn.setAttribute("aria-selected", String(isModules));
  tabSettingsBtn.setAttribute("aria-selected", String(!isModules));
  panelModules.hidden = !isModules;
  panelSettings.hidden = isModules;
  if (persist) {
    chrome.storage.local.set({ activePopupTab: state.activeTab }).catch(() => {});
  }
}

tabModulesBtn.addEventListener("click", () => switchTab("modules"));
tabSettingsBtn.addEventListener("click", () => switchTab("settings"));

function updateSavePill(pillState, text) {
  saveStatusPill.dataset.state = pillState;
  saveStatusPill.textContent = text;
}

function scheduleSettingsSave(immediate = false) {
  clearTimeout(autoSaveTimer);
  updateSavePill("saving", "Saving…");
  const commit = async () => {
    try {
      const apiKey = keyInput.value.trim();
      const useCustomModel = modelSelect.value === CUSTOM_MODEL_OPTION;
      const customModelId = customModelInput.value.trim();
      const model = useCustomModel ? migrateModelId(DEFAULT_SETTINGS.model) : migrateModelId(modelSelect.value);
      const answerInstructions = answerInstructionsInput.value.trim().slice(0, 2000) || DEFAULT_ANSWER_INSTRUCTIONS;
      await chrome.storage.local.set({
        apiKey,
        model,
        useCustomModel,
        customModelId,
        reasoningEffort: reasoningEffortSelect.value,
        answerInstructions,
        answerFontScale: Number(answerSizeInput.value) / 100,
        answerUsePageColor: matchQuestionColorInput.checked,
        answerCustomColor: isValidHexColor(answerColorInput.value) ? answerColorInput.value : "#333333",
        groundingMode: state.groundingMode,
        activeSetId: state.activeSetId
      });
      updateSavePill(apiKey ? "saved" : "warning", apiKey ? "Saved" : "Add API key");
    } catch {
      updateSavePill("error", "Save failed");
    }
  };
  if (immediate) commit();
  else autoSaveTimer = setTimeout(commit, 250);
}

function updateAnswerSizeUI() {
  const pct = Number(answerSizeInput.value);
  answerSizeValue.value = `${pct}%`;
  answerSizeValue.textContent = `${pct}%`;
  answerSizePreview.style.fontSize = `${Math.max(10, Math.round(16 * (pct / 100)))}px`;
}

function updateGroundingUI() {
  const isStrict = state.groundingMode !== "hybrid";
  groundingStrictBtn.setAttribute("aria-pressed", String(isStrict));
  groundingHybridBtn.setAttribute("aria-pressed", String(!isStrict));
  groundingHint.textContent = isStrict
    ? "Strict: uses only active study modules when attached."
    : "Hybrid: prefers modules and falls back to AI knowledge.";
}

keyInput.addEventListener("input", () => scheduleSettingsSave(false));
customModelInput.addEventListener("input", () => scheduleSettingsSave(false));
answerInstructionsInput.addEventListener("input", () => scheduleSettingsSave(false));

modelSelect.addEventListener("change", () => {
  customModelWrap.hidden = modelSelect.value !== CUSTOM_MODEL_OPTION;
  scheduleSettingsSave(true);
});
reasoningEffortSelect.addEventListener("change", () => scheduleSettingsSave(true));
answerSizeInput.addEventListener("input", () => {
  updateAnswerSizeUI();
  scheduleSettingsSave(false);
});
matchQuestionColorInput.addEventListener("change", () => {
  customColorRow.hidden = matchQuestionColorInput.checked;
  scheduleSettingsSave(true);
});
answerColorInput.addEventListener("input", () => scheduleSettingsSave(false));

toggleApiKeyBtn.addEventListener("click", () => {
  const showing = keyInput.type === "text";
  keyInput.type = showing ? "password" : "text";
  toggleApiKeyBtn.setAttribute("aria-pressed", String(!showing));
  toggleApiKeyBtn.setAttribute("aria-label", showing ? "Show API key" : "Hide API key");
  eyeIcon.innerHTML = showing
    ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" /><circle cx="12" cy="12" r="3" />'
    : '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" />';
});

testApiKeyBtn.addEventListener("click", async () => {
  const apiKey = keyInput.value.trim();
  if (!apiKey) {
    keyTestStatus.dataset.state = "error";
    keyTestStatus.textContent = "Enter your API key first.";
    keyInput.focus();
    return;
  }
  testApiKeyBtn.disabled = true;
  keyTestStatus.dataset.state = "";
  keyTestStatus.textContent = "Testing connection…";
  const model = modelSelect.value === CUSTOM_MODEL_OPTION ? customModelInput.value.trim() : modelSelect.value;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "ANSWERLY_TEST_API_KEY",
      apiKey,
      model
    });
    if (response?.ok) {
      keyTestStatus.dataset.state = "success";
      keyTestStatus.textContent = response.message || "Connected";
    } else {
      keyTestStatus.dataset.state = "error";
      keyTestStatus.textContent = response?.error || "Connection test failed.";
    }
  } catch {
    keyTestStatus.dataset.state = "error";
    keyTestStatus.textContent = "Could not reach Deep Relay.";
  } finally {
    testApiKeyBtn.disabled = false;
  }
});

resetPromptBtn.addEventListener("click", () => {
  if (answerInstructionsInput.value.trim() === DEFAULT_ANSWER_INSTRUCTIONS) return;
  resetPromptConfirm.hidden = false;
});
resetPromptNoBtn.addEventListener("click", () => {
  resetPromptConfirm.hidden = true;
});
resetPromptYesBtn.addEventListener("click", () => {
  answerInstructionsInput.value = DEFAULT_ANSWER_INSTRUCTIONS;
  resetPromptConfirm.hidden = true;
  scheduleSettingsSave(true);
});

openShortcutsBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" }).catch(() => {});
});

groundingStrictBtn.addEventListener("click", () => {
  state.groundingMode = "strict";
  updateGroundingUI();
  scheduleSettingsSave(true);
});
groundingHybridBtn.addEventListener("click", () => {
  state.groundingMode = "hybrid";
  updateGroundingUI();
  scheduleSettingsSave(true);
});

// File importing & full-window drag-and-drop
importFilesLabel.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => processFiles(fileInput.files));

document.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  state.dragDepth += 1;
  dragOverlay.hidden = false;
});
document.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
});
document.addEventListener("dragleave", () => {
  if (state.dragDepth > 0) state.dragDepth -= 1;
  if (state.dragDepth === 0) dragOverlay.hidden = true;
});
document.addEventListener("drop", (event) => {
  event.preventDefault();
  state.dragDepth = 0;
  dragOverlay.hidden = true;
  if (event.dataTransfer?.files?.length) {
    switchTab("modules");
    processFiles(event.dataTransfer.files);
  }
});

togglePasteBtn.addEventListener("click", () => {
  const opening = pasteDrawer.hidden;
  pasteDrawer.hidden = !opening;
  togglePasteBtn.setAttribute("aria-expanded", String(opening));
  if (opening) pasteTitleInput.focus();
});
pasteCancelBtn.addEventListener("click", () => {
  pasteDrawer.hidden = true;
  togglePasteBtn.setAttribute("aria-expanded", "false");
});
pasteSaveBtn.addEventListener("click", async () => {
  const text = pasteBodyInput.value.trim();
  if (!text) {
    showFileStatus("Paste some study notes before saving.", "warning");
    pasteBodyInput.focus();
    return;
  }
  const title = pasteTitleInput.value.trim() || `Notes ${new Date().toLocaleDateString()}`;
  pasteSaveBtn.disabled = true;
  try {
    const module = await createStudyModuleFromText({
      name: title,
      text,
      extension: "md",
      sourceType: "paste",
      setId: state.activeSetId
    });
    const outcome = await saveStudyFile(module);
    pasteTitleInput.value = "";
    pasteBodyInput.value = "";
    pasteDrawer.hidden = true;
    togglePasteBtn.setAttribute("aria-expanded", "false");
    await refreshLibrary();
    showFileStatus(
      outcome.status === "duplicate" ? `"${title}" is already in this set.` : `Saved "${title}".`,
      outcome.status === "duplicate" ? "warning" : "success"
    );
  } catch (error) {
    showFileStatus(error instanceof Error ? error.message : "Could not save pasted notes.", "error");
  } finally {
    pasteSaveBtn.disabled = false;
  }
});

importPageBtn.addEventListener("click", importActiveTab);

async function importActiveTab() {
  importPageBtn.disabled = true;
  showProgress(35, "Reading active page…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || /^(chrome|chrome-extension|edge|about):/i.test(tab.url)) {
      throw new Error("This page cannot be imported. Open a standard webpage and try again.");
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractActiveWebpageContent
    });
    const extracted = results?.[0]?.result;
    if (!extracted?.text?.trim()) {
      throw new Error("No readable study content was found on this page.");
    }
    showProgress(80, `Saving ${extracted.title || "webpage"}…`);
    const module = await createStudyModuleFromText({
      name: extracted.title || new URL(tab.url).hostname,
      text: extracted.text,
      extension: "md",
      sourceType: "webpage",
      sourceUrl: extracted.url || tab.url,
      setId: state.activeSetId
    });
    const outcome = await saveStudyFile(module);
    await refreshLibrary();
    showFileStatus(
      outcome.status === "duplicate"
        ? `"${module.name}" is already saved with identical content.`
        : outcome.status === "updated"
          ? `Updated "${module.name}" from the current page.`
          : `Imported "${module.name}" (${module.sections.length} sections).`,
      outcome.status === "duplicate" ? "warning" : "success"
    );
  } catch (error) {
    showFileStatus(error instanceof Error ? error.message : "Could not import this page.", "error");
  } finally {
    hideProgress();
    importPageBtn.disabled = false;
  }
}

function extractActiveWebpageContent() {
  const root = document.querySelector("main, article, [role='main']") || document.body;
  if (!root) return { title: document.title, url: location.href, text: "" };
  const skipSelector = "script, style, noscript, nav, footer, aside, [data-answerly-output]";
  const lines = [];
  const blocks = root.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, pre, blockquote, tr");
  const seen = new Set();
  for (const el of blocks) {
    if (el.closest(skipSelector)) continue;
    if (el.tagName === "TR") {
      const rowText = [...el.querySelectorAll("th, td")].map((cell) => cell.innerText.trim()).filter(Boolean).join(" | ");
      if (rowText && !seen.has(rowText)) {
        seen.add(rowText);
        lines.push(rowText);
      }
      continue;
    }
    if (el.closest("tr")) continue;
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const headingMatch = el.tagName.match(/^H([1-6])$/);
    lines.push(headingMatch ? `${"#".repeat(Number(headingMatch[1]))} ${text}` : text);
  }
  const combined = lines.length ? lines.join("\n\n") : (root.innerText || "").trim();
  return {
    title: (document.title || location.hostname || "Webpage").trim(),
    url: location.href,
    text: combined
  };
}

async function processFiles(fileCollection) {
  const files = [...(fileCollection || [])];
  fileInput.value = "";
  if (!files.length || state.processingFiles) return;
  state.processingFiles = true;
  const counts = { added: 0, updated: 0, duplicate: 0, skipped: 0, errors: [] };
  let warningCount = 0;

  try {
    showProgress(5, "Loading local parser…");
    const { extractStudyFile, extractStudyArchive, MAX_FILE_BYTES } = await import("./vendor/file-parser.js");

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const basePct = Math.round((index / files.length) * 100);
      showProgress(Math.max(8, basePct), `Reading ${file.name} (${index + 1}/${files.length})…`);
      try {
        if (file.size > MAX_FILE_BYTES) {
          throw new Error(`${file.name} is larger than 50 MB.`);
        }
        const ext = String(file.name || "").split(".").pop()?.toLowerCase();
        const onProgress = ({ current, total, detail }) => {
          if (!total) return;
          const fileShare = (current / total) * (100 / files.length);
          showProgress(Math.min(98, Math.round(basePct + fileShare)), detail || `Reading ${file.name}…`);
        };

        if (ext === "zip") {
          const archive = await extractStudyArchive(file, { setId: state.activeSetId, onProgress });
          counts.skipped += archive.skipped.length;
          for (const entryError of archive.errors) {
            counts.errors.push(`${entryError.name}: ${entryError.error}`);
          }
          for (const mod of archive.extracted) {
            try {
              const res = await saveStudyFile(mod);
              counts[res.status] += 1;
              if (mod.warnings?.length) warningCount += 1;
            } catch (saveErr) {
              counts.errors.push(`${mod.name}: ${saveErr instanceof Error ? saveErr.message : "Could not save."}`);
            }
          }
          if (!archive.extracted.length && !archive.errors.length) {
            counts.errors.push(`${file.name}: No supported study files inside ZIP.`);
          }
        } else {
          const mod = await extractStudyFile(file, { setId: state.activeSetId, onProgress });
          const res = await saveStudyFile(mod);
          counts[res.status] += 1;
          if (mod.warnings?.length) warningCount += 1;
        }
        await refreshLibrary();
      } catch (fileError) {
        counts.errors.push(fileError instanceof Error ? fileError.message : `Could not read ${file.name}.`);
      }
    }

    const parts = [];
    if (counts.added) parts.push(`Added ${counts.added}`);
    if (counts.updated) parts.push(`Updated ${counts.updated}`);
    if (counts.duplicate) parts.push(`Skipped ${counts.duplicate} duplicate`);
    if (counts.skipped) parts.push(`Ignored ${counts.skipped} unsupported`);
    if (warningCount) parts.push(`${warningCount} with warnings`);
    if (counts.errors.length) parts.push(`${counts.errors.length} failed (${counts.errors[0]})`);

    const summary = parts.length ? parts.join(" · ") : "No files added.";
    const stateType = counts.errors.length && !counts.added && !counts.updated
      ? "error"
      : counts.errors.length || warningCount || counts.duplicate
        ? "warning"
        : "success";
    showFileStatus(summary, stateType);
  } catch (error) {
    showFileStatus(error instanceof Error ? error.message : "Could not load the local file parser.", "error");
  } finally {
    hideProgress();
    state.processingFiles = false;
  }
}

function showProgress(percent, text) {
  importProgress.hidden = false;
  importProgressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  importProgressText.textContent = text;
}

function hideProgress() {
  importProgress.hidden = true;
  importProgressFill.style.width = "0%";
  importProgressText.textContent = "";
}

function showFileStatus(message, stateType = "") {
  fileStatus.textContent = message;
  fileStatus.dataset.state = stateType;
  fileStatus.hidden = !message;
}

// Course sets management
newSetSaveBtn.addEventListener("click", submitSetForm);
newSetNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    submitSetForm();
  } else if (event.key === "Escape") {
    closeSetForm();
  }
});
newSetCancelBtn.addEventListener("click", closeSetForm);

renameSetBtn.addEventListener("click", async () => {
  if (!state.activeSetId) return;
  const sets = await listStudySets().catch(() => []);
  const current = sets.find((set) => set.id === state.activeSetId);
  if (!current) return;
  state.renamingSetId = current.id;
  newSetForm.hidden = false;
  newSetSaveBtn.textContent = "Save";
  newSetNameInput.value = current.name;
  newSetNameInput.focus();
  newSetNameInput.select();
});

deleteSetBtn.addEventListener("click", () => {
  if (!state.activeSetId) return;
  deleteSetConfirm.hidden = false;
});
deleteSetNoBtn.addEventListener("click", () => {
  deleteSetConfirm.hidden = true;
});
deleteSetYesBtn.addEventListener("click", async () => {
  if (!state.activeSetId) return;
  try {
    await deleteStudySet(state.activeSetId);
    state.activeSetId = "";
    deleteSetConfirm.hidden = true;
    scheduleSettingsSave(true);
    await refreshLibrary();
    showFileStatus("Set removed. Modules kept in All modules.", "success");
  } catch {
    showFileStatus("Could not delete that set.", "error");
  }
});

async function submitSetForm() {
  const name = newSetNameInput.value.trim();
  if (!name) {
    newSetNameInput.focus();
    return;
  }
  try {
    if (state.renamingSetId) {
      await renameStudySet(state.renamingSetId, name);
    } else {
      const created = await createStudySet(name);
      state.activeSetId = created.id;
      scheduleSettingsSave(true);
    }
    closeSetForm();
    await refreshLibrary();
  } catch (error) {
    showFileStatus(error instanceof Error ? error.message : "Could not save set.", "error");
  }
}

function closeSetForm() {
  state.renamingSetId = "";
  newSetNameInput.value = "";
  newSetSaveBtn.textContent = "Add";
  newSetForm.hidden = true;
}

moduleSearchInput.addEventListener("input", () => {
  state.searchQuery = moduleSearchInput.value.trim().toLocaleLowerCase();
  refreshLibrary().catch(() => {});
});

clearFilesBtn.addEventListener("click", () => {
  clearFilesBtn.hidden = true;
  clearFilesConfirm.hidden = false;
});
clearFilesNoBtn.addEventListener("click", () => {
  clearFilesConfirm.hidden = true;
  clearFilesBtn.hidden = false;
});
clearFilesYesBtn.addEventListener("click", async () => {
  try {
    if (state.activeSetId) await removeStudyFilesBySet(state.activeSetId);
    else await clearStudyFiles();
    clearFilesConfirm.hidden = true;
    clearFilesBtn.hidden = false;
    await refreshLibrary();
    showFileStatus(state.activeSetId ? "Cleared modules in this set." : "All modules removed from this device.", "success");
  } catch {
    showFileStatus("Could not clear study modules.", "error");
  }
});

async function refreshLibrary() {
  const [files, sets] = await Promise.all([listStudyFiles(), listStudySets()]);
  if (state.activeSetId && !sets.some((set) => set.id === state.activeSetId)) {
    state.activeSetId = "";
    scheduleSettingsSave(true);
  }

  renderSetsBar(sets, files);

  const visibleBySet = state.activeSetId
    ? files.filter((file) => file.setId === state.activeSetId)
    : files;
  const activeCount = visibleBySet.filter((file) => file.enabled !== false).length;
  modulesCountBadge.textContent = String(activeCount);
  modulesCountBadge.hidden = activeCount === 0;

  moduleSearchWrap.hidden = files.length < 4 && !state.searchQuery;
  const filtered = state.searchQuery
    ? visibleBySet.filter((file) => {
        const hay = `${file.name} ${file.sections.slice(0, 5).map((s) => s.text).join(" ")}`.toLocaleLowerCase();
        return hay.includes(state.searchQuery);
      })
    : visibleBySet;

  renderModuleList(filtered, sets);

  emptyModules.hidden = visibleBySet.length > 0;
  modulesFooter.hidden = visibleBySet.length === 0;
  const totalChars = visibleBySet.reduce((sum, file) => sum + (file.charCount || 0), 0);
  librarySummary.textContent = `${files.length} of ${STUDY_LIMITS.MAX_STUDY_FILES} modules · ${formatCompactChars(totalChars)}`;
  clearFilesBtn.textContent = state.activeSetId ? "Clear set" : "Clear all";
}

function renderSetsBar(sets, files) {
  setsBar.replaceChildren();
  const makePill = (id, label, count) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "set-pill";
    btn.setAttribute("aria-pressed", String(state.activeSetId === id));
    btn.textContent = typeof count === "number" ? `${label} (${count})` : label;
    btn.addEventListener("click", () => {
      state.activeSetId = id;
      deleteSetConfirm.hidden = true;
      closeSetForm();
      scheduleSettingsSave(true);
      refreshLibrary().catch(() => {});
    });
    return btn;
  };

  setsBar.append(makePill("", "All", files.length));
  for (const set of sets) {
    const count = files.filter((file) => file.setId === set.id).length;
    setsBar.append(makePill(set.id, set.name, count));
  }

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "set-pill set-pill-add";
  addBtn.textContent = "+ New set";
  addBtn.addEventListener("click", () => {
    state.renamingSetId = "";
    newSetSaveBtn.textContent = "Add";
    newSetNameInput.value = "";
    newSetForm.hidden = false;
    deleteSetConfirm.hidden = true;
    newSetNameInput.focus();
  });
  setsBar.append(addBtn);

  const hasActiveSet = Boolean(state.activeSetId);
  renameSetBtn.hidden = !hasActiveSet;
  deleteSetBtn.hidden = !hasActiveSet;
}

function renderModuleList(files, sets) {
  fileList.replaceChildren();
  for (const file of files) {
    const isExpanded = state.expandedIds.has(file.id);
    const li = document.createElement("li");
    li.className = `module-row${file.enabled === false ? " is-disabled" : ""}`;

    const mainRow = document.createElement("div");
    mainRow.className = "module-main";

    const switchLabel = document.createElement("label");
    switchLabel.className = "switch";
    switchLabel.setAttribute("aria-label", `Use ${file.name} for answers`);
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = file.enabled !== false;
    toggle.addEventListener("change", async () => {
      await updateStudyFile(file.id, { enabled: toggle.checked });
      await refreshLibrary();
    });
    const track = document.createElement("span");
    track.className = "switch-track";
    switchLabel.append(toggle, track);

    const info = document.createElement("div");
    info.className = "module-info";
    const nameEl = document.createElement("span");
    nameEl.className = "module-name";
    nameEl.textContent = file.name;
    nameEl.title = file.name;

    const meta = document.createElement("div");
    meta.className = "module-meta";
    const typeLabel = file.sourceType === "webpage" ? "Webpage" : file.sourceType === "paste" ? "Notes" : String(file.extension || "file").toUpperCase();
    const metaText = document.createElement("span");
    metaText.textContent = `${typeLabel} · ${file.sections.length} sections · ${formatCompactChars(file.charCount || 0)}`;
    meta.append(metaText);
    if (file.warnings?.length) {
      const warnTag = document.createElement("span");
      warnTag.className = "warn-tag";
      warnTag.textContent = file.truncated ? "Truncated" : "Notice";
      meta.append(warnTag);
    }
    info.append(nameEl, meta);

    const actions = document.createElement("div");
    actions.className = "module-actions";

    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "icon-btn";
    expandBtn.setAttribute("aria-expanded", String(isExpanded));
    expandBtn.setAttribute("aria-label", `${isExpanded ? "Hide" : "Preview"} ${file.name}`);
    expandBtn.innerHTML = isExpanded
      ? '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="18 15 12 9 6 15" /></svg>'
      : '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>';
    expandBtn.addEventListener("click", () => {
      if (state.expandedIds.has(file.id)) state.expandedIds.delete(file.id);
      else state.expandedIds.add(file.id);
      refreshLibrary().catch(() => {});
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "icon-btn";
    removeBtn.setAttribute("aria-label", `Remove ${file.name}`);
    removeBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>';
    removeBtn.addEventListener("click", async () => {
      try {
        await removeStudyFile(file.id);
        state.expandedIds.delete(file.id);
        await refreshLibrary();
        showFileStatus(`${file.name} removed.`, "success");
      } catch {
        showFileStatus("Could not remove that module.", "error");
      }
    });

    actions.append(expandBtn, removeBtn);
    mainRow.append(switchLabel, info, actions);
    li.append(mainRow);

    if (isExpanded) {
      const detail = document.createElement("div");
      detail.className = "module-detail";

      if (file.warnings?.length) {
        const warningsBox = document.createElement("div");
        warningsBox.className = "module-warnings";
        for (const msg of file.warnings) {
          const p = document.createElement("span");
          p.textContent = msg;
          warningsBox.append(p);
        }
        detail.append(warningsBox);
      }

      if (file.sourceUrl) {
        const urlLine = document.createElement("p");
        urlLine.className = "hint";
        urlLine.textContent = `Source: ${file.sourceUrl}`;
        detail.append(urlLine);
      }

      const setGroup = document.createElement("div");
      setGroup.className = "field-group";
      const setLabel = document.createElement("label");
      setLabel.className = "field-label";
      setLabel.textContent = "Course set";
      const setSelect = document.createElement("select");
      setSelect.setAttribute("aria-label", `Course set for ${file.name}`);
      const noneOpt = document.createElement("option");
      noneOpt.value = "";
      noneOpt.textContent = "Unassigned";
      setSelect.append(noneOpt);
      for (const set of sets) {
        const opt = document.createElement("option");
        opt.value = set.id;
        opt.textContent = set.name;
        setSelect.append(opt);
      }
      setSelect.value = file.setId || "";
      setSelect.addEventListener("change", async () => {
        await updateStudyFile(file.id, { setId: setSelect.value });
        await refreshLibrary();
      });
      setGroup.append(setLabel, setSelect);
      detail.append(setGroup);

      const previewList = document.createElement("div");
      previewList.className = "preview-list";
      for (const section of file.sections.slice(0, 3)) {
        const item = document.createElement("div");
        item.className = "preview-item";
        const loc = document.createElement("span");
        loc.className = "preview-loc";
        loc.textContent = section.location;
        const body = document.createElement("p");
        body.className = "preview-text";
        body.textContent = section.text;
        item.append(loc, body);
        previewList.append(item);
      }
      detail.append(previewList);
      li.append(detail);
    }

    fileList.append(li);
  }
}

function formatCompactChars(count) {
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}k chars`;
  return `${count} chars`;
}
