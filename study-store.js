import { STUDY_LIMITS } from "./shared/config.js";

const DATABASE_NAME = "answerly-study-library";
const DATABASE_VERSION = 2;
export const MAX_STUDY_FILES = STUDY_LIMITS.MAX_STUDY_FILES;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("modules")) {
        database.createObjectStore("modules", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("sets")) {
        database.createObjectStore("sets", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the local study-file library."));
  });
}

function sumSectionChars(sections) {
  if (!Array.isArray(sections)) return 0;
  return sections.reduce((sum, section) => sum + String(section?.text || "").length, 0);
}

function normalizeStudyFile(file) {
  const sections = Array.isArray(file?.sections) ? file.sections : [];
  return {
    ...file,
    id: String(file?.id || crypto.randomUUID()),
    name: String(file?.name || "Untitled module"),
    extension: String(file?.extension || "txt"),
    size: Number(file?.size) || 0,
    addedAt: Number(file?.addedAt) || Date.now(),
    enabled: file?.enabled !== false,
    setId: String(file?.setId || ""),
    sourceType: String(file?.sourceType || "file"),
    sourceUrl: String(file?.sourceUrl || ""),
    contentHash: String(file?.contentHash || ""),
    charCount: Number.isFinite(Number(file?.charCount)) ? Number(file.charCount) : sumSectionChars(sections),
    truncated: Boolean(file?.truncated),
    warnings: Array.isArray(file?.warnings) ? file.warnings.map(String) : [],
    sections
  };
}

export async function listStudyFiles() {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("modules", "readonly");
    const request = transaction.objectStore("modules").getAll();
    const files = await requestResult(request);
    return files.map(normalizeStudyFile).sort((left, right) => left.addedAt - right.addedAt);
  } finally {
    database.close();
  }
}

export async function saveStudyFile(file) {
  const normalized = normalizeStudyFile(file);
  const database = await openDatabase();
  try {
    const transaction = database.transaction("modules", "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore("modules");
    const existing = (await requestResult(store.getAll())).map(normalizeStudyFile);

    const sameSet = existing.filter((item) => item.setId === normalized.setId);
    if (normalized.contentHash) {
      const duplicate = sameSet.find((item) => item.contentHash && item.contentHash === normalized.contentHash);
      if (duplicate) {
        transaction.abort();
        await done.catch(() => {});
        return { status: "duplicate", file: duplicate };
      }
    }

    const sameName = sameSet.find((item) => item.name.toLocaleLowerCase() === normalized.name.toLocaleLowerCase());
    if (sameName) {
      const updated = normalizeStudyFile({
        ...normalized,
        id: sameName.id,
        enabled: sameName.enabled,
        addedAt: sameName.addedAt,
        updatedAt: Date.now()
      });
      await requestResult(store.put(updated));
      await done;
      return { status: "updated", file: updated };
    }

    if (existing.length >= MAX_STUDY_FILES) {
      transaction.abort();
      await done.catch(() => {});
      throw new Error(`You can attach up to ${MAX_STUDY_FILES} study files.`);
    }
    await requestResult(store.add(normalized));
    await done;
    return { status: "added", file: normalized };
  } finally {
    database.close();
  }
}

export async function updateStudyFile(id, patch) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("modules", "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore("modules");
    const current = await requestResult(store.get(id));
    if (!current) {
      transaction.abort();
      await done.catch(() => {});
      return null;
    }
    const next = normalizeStudyFile({
      ...current,
      ...(typeof patch?.enabled === "boolean" ? { enabled: patch.enabled } : {}),
      ...(typeof patch?.setId === "string" ? { setId: patch.setId } : {}),
      ...(typeof patch?.name === "string" && patch.name.trim() ? { name: patch.name.trim().slice(0, 160) } : {})
    });
    await requestResult(store.put(next));
    await done;
    return next;
  } finally {
    database.close();
  }
}

export async function removeStudyFile(id) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("modules", "readwrite");
    transaction.objectStore("modules").delete(id);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function removeStudyFilesBySet(setId = "") {
  const targetSetId = String(setId || "");
  const database = await openDatabase();
  try {
    const transaction = database.transaction("modules", "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore("modules");
    const files = (await requestResult(store.getAll())).map(normalizeStudyFile);
    for (const file of files) {
      if (!targetSetId || file.setId === targetSetId) {
        store.delete(file.id);
      }
    }
    await done;
  } finally {
    database.close();
  }
}

export async function clearStudyFiles() {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("modules", "readwrite");
    transaction.objectStore("modules").clear();
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function listStudySets() {
  const database = await openDatabase();
  try {
    const transaction = database.transaction("sets", "readonly");
    const sets = await requestResult(transaction.objectStore("sets").getAll());
    return sets.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
  } finally {
    database.close();
  }
}

export async function createStudySet(name) {
  const cleanName = String(name || "").trim().slice(0, 60);
  if (!cleanName) throw new Error("Enter a set name.");
  const database = await openDatabase();
  try {
    const transaction = database.transaction("sets", "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore("sets");
    const existing = await requestResult(store.getAll());
    if (existing.some((set) => String(set.name).toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
      transaction.abort();
      await done.catch(() => {});
      throw new Error(`A set named "${cleanName}" already exists.`);
    }
    const created = { id: crypto.randomUUID(), name: cleanName, createdAt: Date.now() };
    await requestResult(store.add(created));
    await done;
    return created;
  } finally {
    database.close();
  }
}

export async function renameStudySet(id, name) {
  const cleanName = String(name || "").trim().slice(0, 60);
  if (!cleanName) throw new Error("Enter a set name.");
  const database = await openDatabase();
  try {
    const transaction = database.transaction("sets", "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore("sets");
    const current = await requestResult(store.get(id));
    if (!current) {
      transaction.abort();
      await done.catch(() => {});
      return null;
    }
    const updated = { ...current, name: cleanName };
    await requestResult(store.put(updated));
    await done;
    return updated;
  } finally {
    database.close();
  }
}

export async function deleteStudySet(id) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(["sets", "modules"], "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("sets").delete(id);
    const modulesStore = transaction.objectStore("modules");
    const files = (await requestResult(modulesStore.getAll())).map(normalizeStudyFile);
    for (const file of files) {
      if (file.setId === id) {
        await requestResult(modulesStore.put({ ...file, setId: "" }));
      }
    }
    await done;
  } finally {
    database.close();
  }
}

export async function findRelevantPassages(question, maxPassages = 6, maxCharacters = 10_000, options = {}) {
  const { choices = [], activeSetId = "", onlyEnabled = true } = options;
  const allFiles = await listStudyFiles();
  const activeFiles = allFiles.filter((file) => {
    if (onlyEnabled && file.enabled === false) return false;
    if (activeSetId && file.setId !== activeSetId) return false;
    return true;
  });
  if (!activeFiles.length) {
    return { hasFiles: false, activeFileCount: 0, totalFileCount: allFiles.length, passages: [] };
  }

  const queryWeights = new Map();
  for (const term of tokenize(question).keys()) {
    if (!isStopWord(term)) queryWeights.set(term, 1.0);
  }
  for (const choiceText of Array.isArray(choices) ? choices : []) {
    for (const term of tokenize(choiceText).keys()) {
      if (!isStopWord(term) && !queryWeights.has(term)) {
        queryWeights.set(term, 0.45);
      }
    }
  }
  if (!queryWeights.size) {
    return { hasFiles: true, activeFileCount: activeFiles.length, totalFileCount: allFiles.length, passages: [] };
  }

  const queryPhrases = extractPhrases(question);
  const docs = [];
  const docFreq = new Map();
  let totalDocLength = 0;

  for (const file of activeFiles) {
    const fileTokens = tokenize(file.name);
    for (const section of file.sections || []) {
      const text = String(section.text || "");
      const location = String(section.location || "");
      const textTokens = tokenize(text);
      const headerTokens = tokenize(`${location} ${file.name}`);
      const docLength = Math.max(1, sumMapValues(textTokens));
      totalDocLength += docLength;

      const combinedTerms = new Set([...textTokens.keys(), ...headerTokens.keys(), ...fileTokens.keys()]);
      for (const term of combinedTerms) {
        docFreq.set(term, (docFreq.get(term) || 0) + 1);
      }
      docs.push({
        file: file.name,
        location,
        text,
        normalizedText: text.toLocaleLowerCase().replace(/\s+/g, " "),
        textTokens,
        headerTokens,
        docLength
      });
    }
  }

  if (!docs.length) {
    return { hasFiles: true, activeFileCount: activeFiles.length, totalFileCount: allFiles.length, passages: [] };
  }

  const numDocs = docs.length;
  const avgDocLength = Math.max(1, totalDocLength / numDocs);
  const k1 = 1.2;
  const b = 0.75;
  const scored = [];

  for (const doc of docs) {
    let score = 0;
    for (const [term, weight] of queryWeights.entries()) {
      const tf = doc.textTokens.get(term) || 0;
      const headerTf = doc.headerTokens.get(term) || 0;
      if (!tf && !headerTf) continue;
      const df = docFreq.get(term) || 1;
      const idf = Math.log(1 + (numDocs - df + 0.5) / (df + 0.5));
      if (tf > 0) {
        const bm25 = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.docLength / avgDocLength)));
        score += weight * idf * bm25;
      }
      if (headerTf > 0) {
        score += weight * idf * 1.5;
      }
    }
    for (const phrase of queryPhrases) {
      if (doc.normalizedText.includes(phrase)) {
        score += 2.0;
      }
    }
    if (score > 0) {
      scored.push({ file: doc.file, location: doc.location, text: doc.text, score });
    }
  }

  scored.sort((left, right) => right.score - left.score || left.file.localeCompare(right.file));
  const passages = [];
  let used = 0;
  for (const item of scored) {
    if (passages.length >= maxPassages || used >= maxCharacters) break;
    const text = item.text.slice(0, Math.min(1800, maxCharacters - used));
    if (!text) continue;
    passages.push({ file: item.file, location: item.location, text });
    used += text.length;
  }
  return { hasFiles: true, activeFileCount: activeFiles.length, totalFileCount: allFiles.length, passages };
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Local file storage failed."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Local file storage failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Local file storage was cancelled."));
  });
}

function sumMapValues(map) {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}

function tokenize(text) {
  const counts = new Map();
  const normalized = String(text || "").toLocaleLowerCase();
  const matches = normalized.match(/(?:[cf]#|c\+\+|\.net|[\p{L}\p{N}]{2,})/gu) || [];
  for (const rawToken of matches) {
    const token = stemToken(rawToken);
    if (!token) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return counts;
}

function stemToken(token) {
  if (/^(?:c#|c\+\+|f#|\.net)$/i.test(token)) return token;
  if (/^\d+$/.test(token)) return token;
  if (token.length >= 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length >= 6 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length >= 5 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length >= 5 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length >= 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function isStopWord(token) {
  return STOP_WORDS.has(token) || SHORT_STOP_WORDS.has(token);
}

function extractPhrases(question) {
  const words = (String(question || "").toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])
    .filter((word) => !isStopWord(word));
  const phrases = new Set();
  for (let i = 0; i < words.length - 1; i += 1) {
    phrases.add(`${words[i]} ${words[i + 1]}`);
    if (i < words.length - 2) {
      phrases.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
  }
  return [...phrases].slice(0, 12);
}

const SHORT_STOP_WORDS = new Set("to of in is at by on or an as it if no we he be do so up my me us".split(" "));
const STOP_WORDS = new Set("the and for are was were what which when where with from into about that this these those have has had does did can could would should will their there then than them they you your our out use using used how why who whom its it's each both per via file page section answer question choices option correct determine choose select best explain".split(" "));
