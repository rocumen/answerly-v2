export const CURATED_MODELS = [
  {
    id: "deeprelay/deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash 1017",
    vision: true,
    useJsonObjectFirst: false,
    supportsTemperature: true
  },
  {
    id: "deeprelay/kimi-k3.1-pro",
    label: "Kimi K3.1 Pro",
    vision: true,
    useJsonObjectFirst: true,
    supportsTemperature: false
  },
  {
    id: "deeprelay/glm-5.3",
    label: "GLM 5.3",
    vision: false,
    useJsonObjectFirst: false,
    supportsTemperature: true
  },
  {
    id: "deeprelay/glm-5.3-flash",
    label: "GLM 5.3 Flash",
    vision: true,
    useJsonObjectFirst: false,
    supportsTemperature: true
  }
];

export const MODEL_IDS = CURATED_MODELS.map((model) => model.id);

export const LEGACY_MODEL_MIGRATIONS = {
  "deeprelay/kimi-k3": "deeprelay/kimi-k3.1-pro"
};

export const REASONING_EFFORTS = ["", "none", "minimal", "low", "medium", "high", "xhigh"];

export const LEGACY_DEFAULT_ANSWER_INSTRUCTIONS =
  "Answer exactly what the question asks. Be direct and concise. For multiple choice, choose only from the provided options. If the evidence is insufficient, say so briefly instead of guessing. Avoid unrelated details.";

export const PREVIOUS_DEFAULT_ANSWER_INSTRUCTIONS =
  `${LEGACY_DEFAULT_ANSWER_INSTRUCTIONS} When asked to write, fix, or complete code, provide the complete usable code solution rather than a partial snippet.`;

export const PREVIOUS_CODE_ONLY_ANSWER_INSTRUCTIONS =
  `${PREVIOUS_DEFAULT_ANSWER_INSTRUCTIONS} For code responses, provide the complete code only, without prose or Markdown fences. If an explanation is needed, write it as a comment using that language's syntax (for example, # comment in Python).`;

export const DEFAULT_ANSWER_INSTRUCTIONS =
  `${PREVIOUS_CODE_ONLY_ANSWER_INSTRUCTIONS} Add brief, useful comments for important or non-obvious logic so I can understand the code. Use the language's comment syntax, and do not comment every obvious line.`;

export const STUDY_LIMITS = {
  MAX_STUDY_FILES: 25,
  MAX_FILE_BYTES: 50 * 1024 * 1024,
  MAX_EXTRACTED_CHARS: 500_000,
  MAX_ARCHIVE_BYTES: 100 * 1024 * 1024,
  MAX_ARCHIVE_ENTRIES: 2_500,
  MAX_PDF_PAGES: 1_000,
  SUPPORTED_EXTENSIONS: ["pdf", "docx", "pptx", "txt", "md", "markdown", "html", "htm", "csv", "tsv", "json"]
};

export const DEFAULT_SETTINGS = {
  apiKey: "",
  model: CURATED_MODELS[0].id,
  customModelId: "",
  useCustomModel: false,
  reasoningEffort: "medium",
  answerInstructions: DEFAULT_ANSWER_INSTRUCTIONS,
  answerFontScale: 0.6,
  answerUsePageColor: true,
  answerCustomColor: "#333333",
  groundingMode: "strict",
  activeSetId: "",
  activePopupTab: ""
};

export function migrateModelId(modelId) {
  const normalized = String(modelId || "").trim();
  if (Object.hasOwn(LEGACY_MODEL_MIGRATIONS, normalized)) {
    return LEGACY_MODEL_MIGRATIONS[normalized];
  }
  return MODEL_IDS.includes(normalized) ? normalized : CURATED_MODELS[0].id;
}

export function migrateAnswerInstructions(saved) {
  const text = typeof saved === "string" ? saved : "";
  const trimmed = text.trim();
  const hasLegacyDefault = [
    LEGACY_DEFAULT_ANSWER_INSTRUCTIONS,
    PREVIOUS_DEFAULT_ANSWER_INSTRUCTIONS,
    PREVIOUS_CODE_ONLY_ANSWER_INSTRUCTIONS
  ].includes(trimmed);
  if (hasLegacyDefault) {
    return { value: DEFAULT_ANSWER_INSTRUCTIONS, migrated: true };
  }
  return {
    value: (text || DEFAULT_ANSWER_INSTRUCTIONS).slice(0, 2000),
    migrated: false
  };
}

export function resolveActiveModel(settings = {}) {
  const custom = String(settings.customModelId || "").trim();
  if (settings.useCustomModel && custom) {
    return custom;
  }
  return migrateModelId(settings.model);
}

export function getModelMeta(modelId) {
  const normalized = LEGACY_MODEL_MIGRATIONS[String(modelId || "").trim()] || String(modelId || "").trim();
  const curated = CURATED_MODELS.find((model) => model.id === normalized);
  if (curated) return curated;
  return {
    id: normalized,
    label: normalized,
    vision: true,
    useJsonObjectFirst: false,
    supportsTemperature: true,
    isCustom: true
  };
}

export function isValidHexColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function clampFontScale(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_SETTINGS.answerFontScale;
  return Math.max(0.4, Math.min(1, Math.round(numeric * 100 / 5) * 5 / 100));
}
