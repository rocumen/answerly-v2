import { STUDY_LIMITS } from "./config.js";

/**
 * Splits text into bounded chunks with trailing word-boundary overlap so
 * concepts spanning chunk limits remain searchable.
 */
export function chunkText(text, location, maxLength = 1600, overlap = 180) {
  const normalized = String(text || "").replace(/\u0000/g, "").trim();
  if (!normalized) return [];
  if (normalized.length <= maxLength) {
    return [{ location, text: normalized }];
  }
  const chunks = [];
  const safeOverlap = Math.max(0, Math.min(overlap, Math.floor(maxLength * 0.35)));
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + maxLength, normalized.length);
    if (end < normalized.length) {
      let boundary = normalized.lastIndexOf("\n", end);
      if (boundary <= start + maxLength * 0.55) {
        boundary = normalized.lastIndexOf(". ", end);
        if (boundary > start + maxLength * 0.55) boundary += 1;
      }
      if (boundary <= start + maxLength * 0.55) {
        boundary = normalized.lastIndexOf(" ", end);
      }
      if (boundary > start + maxLength * 0.55) end = boundary;
    }
    const piece = normalized.slice(start, end).trim();
    if (piece) {
      chunks.push({
        location: chunks.length ? `${location} (continued)` : location,
        text: piece
      });
    }
    if (end >= normalized.length) break;
    let nextStart = Math.max(start + 1, end - safeOverlap);
    if (safeOverlap > 0 && nextStart > start + 1) {
      const spaceAfter = normalized.indexOf(" ", nextStart);
      if (spaceAfter !== -1 && spaceAfter < end - 20) {
        nextStart = spaceAfter + 1;
      }
    }
    start = nextStart;
  }
  return chunks;
}

/**
 * Caps extracted sections to the per-module character budget and reports
 * whether any text had to be truncated.
 */
export function capSections(sections, maxChars = STUDY_LIMITS.MAX_EXTRACTED_CHARS) {
  const result = [];
  let remaining = maxChars;
  let charCount = 0;
  let truncated = false;
  for (const section of sections || []) {
    const raw = String(section?.text || "").trim();
    if (!raw) continue;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (raw.length > remaining) truncated = true;
    const text = raw.slice(0, remaining).trim();
    if (text) {
      result.push({
        location: String(section.location || "Document").slice(0, 160),
        text
      });
      remaining -= text.length;
      charCount += text.length;
    }
  }
  return { sections: result, charCount, truncated };
}

/**
 * Computes a deterministic content hash for duplicate detection across imports.
 */
export async function computeContentHash(text) {
  const input = String(text || "");
  if (globalThis.crypto?.subtle?.digest) {
    try {
      const encoded = new TextEncoder().encode(input);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch {
      // Fall back to deterministic FNV-1a below.
    }
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + (index & 0xff);
    h2 = Math.imul(h2, 0x01000193);
  }
  return `fnv-${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

export function extractMarkdownSections(text, defaultHeading = "Markdown") {
  const sections = [];
  let heading = defaultHeading;
  let body = [];
  const flush = () => {
    const value = body.join("\n").trim();
    if (value) sections.push(...chunkText(value, heading));
    body = [];
  };
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (match) {
      flush();
      heading = match[1].slice(0, 120);
    } else {
      body.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Pure-JS semantic HTML text extractor safe for both Chrome and Node tests.
 */
export function extractHtmlSections(htmlText, defaultHeading = "Webpage") {
  let cleaned = String(htmlText || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  const titleMatch = cleaned.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const docHeading = titleMatch ? decodeHtmlEntities(stripHtmlTags(titleMatch[1])).trim().slice(0, 120) : "";

  cleaned = cleaned
    .replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, " | ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|section|article|li|blockquote|pre|figcaption|header|footer|aside|dd|dt)>/gi, "\n");

  const headingRegex = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const sections = [];
  let currentHeading = docHeading || defaultHeading;
  let lastIndex = 0;

  const pushSlice = (rawSlice, location) => {
    const plain = decodeHtmlEntities(stripHtmlTags(rawSlice))
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    if (plain) sections.push(...chunkText(plain, location));
  };

  for (const match of cleaned.matchAll(headingRegex)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      pushSlice(cleaned.slice(lastIndex, matchIndex), currentHeading);
    }
    const nextHeading = decodeHtmlEntities(stripHtmlTags(match[2])).replace(/\s+/g, " ").trim().slice(0, 120);
    if (nextHeading) currentHeading = nextHeading;
    lastIndex = matchIndex + match[0].length;
  }
  if (lastIndex < cleaned.length) {
    pushSlice(cleaned.slice(lastIndex), currentHeading);
  }
  return sections;
}

export function extractDelimitedSections(text, delimiter = ",") {
  const rows = parseDelimitedRows(String(text || ""), delimiter);
  if (!rows.length) return [];
  const headers = rows[0].map((cell, index) => cell.trim() || `Column ${index + 1}`);
  const dataRows = rows.length > 1 ? rows.slice(1) : rows;
  const useHeaders = rows.length > 1;
  const formattedLines = [];
  let rowNumbers = [];

  for (let index = 0; index < dataRows.length; index += 1) {
    const row = dataRows[index];
    if (!row.some((cell) => cell.trim())) continue;
    const rowNumber = useHeaders ? index + 2 : index + 1;
    const line = useHeaders
      ? row.map((cell, col) => `${headers[col] || `Column ${col + 1}`}: ${cell.trim()}`).filter((entry) => !entry.endsWith(": ")).join(" | ")
      : row.map((cell) => cell.trim()).filter(Boolean).join(" | ");
    if (line) {
      formattedLines.push(line);
      rowNumbers.push(rowNumber);
    }
  }
  if (!formattedLines.length) return [];

  const sections = [];
  let batch = [];
  let batchNums = [];
  let batchChars = 0;
  const flush = () => {
    if (!batch.length) return;
    const first = batchNums[0];
    const last = batchNums[batchNums.length - 1];
    const location = first === last ? `Row ${first}` : `Rows ${first}–${last}`;
    sections.push(...chunkText(batch.join("\n"), location));
    batch = [];
    batchNums = [];
    batchChars = 0;
  };
  for (let i = 0; i < formattedLines.length; i += 1) {
    const line = formattedLines[i];
    if (batch.length && batchChars + line.length + 1 > 1400) flush();
    batch.push(line);
    batchNums.push(rowNumbers[i]);
    batchChars += line.length + 1;
  }
  flush();
  return sections;
}

export function extractJsonSections(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch (error) {
    throw new Error(`Could not read JSON file: ${error.message}`);
  }
  const sections = [];
  if (Array.isArray(parsed)) {
    for (let i = 0; i < parsed.length; i += 10) {
      const slice = parsed.slice(i, i + 10);
      const location = slice.length === 1 ? `Item ${i + 1}` : `Items ${i + 1}–${i + slice.length}`;
      const body = slice.map((item, offset) => `[${i + offset + 1}] ${formatJsonValue(item)}`).join("\n");
      sections.push(...chunkText(body, location));
    }
  } else if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed)) {
      const formatted = formatJsonValue(value);
      if (formatted) sections.push(...chunkText(`${key}: ${formatted}`, key.slice(0, 120)));
    }
  } else if (parsed !== null && parsed !== undefined) {
    sections.push(...chunkText(String(parsed), "JSON"));
  }
  return sections;
}

export async function createStudyModuleFromText({
  name,
  text,
  extension = "txt",
  sourceType = "paste",
  sourceUrl = "",
  setId = "",
  warnings = []
}) {
  const cleanName = String(name || "Study notes").trim().slice(0, 160) || "Study notes";
  const rawText = String(text || "").replace(/^\uFEFF/, "");
  const ext = String(extension || "txt").toLowerCase();
  const rawSections = ext === "md" || ext === "markdown"
    ? extractMarkdownSections(rawText, cleanName)
    : ext === "html" || ext === "htm"
      ? extractHtmlSections(rawText, cleanName)
      : chunkText(rawText, sourceType === "webpage" ? cleanName : "Notes");

  const { sections, charCount, truncated } = capSections(rawSections);
  if (!sections.length) {
    throw new Error(`No readable text was found in ${cleanName}.`);
  }
  const allWarnings = [...(Array.isArray(warnings) ? warnings : [])];
  if (truncated) {
    allWarnings.push(`Truncated to ${STUDY_LIMITS.MAX_EXTRACTED_CHARS.toLocaleString()} extracted characters.`);
  }
  const combinedText = sections.map((section) => `${section.location}\n${section.text}`).join("\n\n");
  const contentHash = await computeContentHash(combinedText);
  return {
    id: crypto.randomUUID(),
    name: cleanName,
    extension: ext,
    size: new TextEncoder().encode(rawText).byteLength,
    addedAt: Date.now(),
    enabled: true,
    setId: String(setId || ""),
    sourceType,
    sourceUrl: String(sourceUrl || ""),
    contentHash,
    charCount,
    truncated,
    warnings: allWarnings,
    sections
  };
}

function stripHtmlTags(html) {
  return String(html || "").replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(text) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—"
  };
  return String(text || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, entity) => {
    const lower = entity.toLowerCase();
    if (Object.hasOwn(named, lower)) return named[lower];
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    return full;
  });
}

function parseDelimitedRows(input, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function formatJsonValue(value, depth = 0) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (depth >= 4) return JSON.stringify(value);
  if (Array.isArray(value)) {
    return value.map((item) => formatJsonValue(item, depth + 1)).filter(Boolean).join("; ");
  }
  return Object.entries(value)
    .map(([key, val]) => {
      const inner = formatJsonValue(val, depth + 1);
      return inner ? `${key}: ${inner}` : "";
    })
    .filter(Boolean)
    .join(", ");
}
