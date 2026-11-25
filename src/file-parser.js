import { unzipSync, strFromU8 } from "fflate";
import { XMLParser } from "fast-xml-parser";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { STUDY_LIMITS } from "../shared/config.js";
import {
  chunkText,
  capSections,
  computeContentHash,
  extractMarkdownSections,
  extractHtmlSections,
  extractDelimitedSections,
  extractJsonSections
} from "../shared/text-module.js";

export const MAX_FILE_BYTES = STUDY_LIMITS.MAX_FILE_BYTES;
export const MAX_FILE_COUNT = STUDY_LIMITS.MAX_STUDY_FILES;
export const MAX_EXTRACTED_CHARS = STUDY_LIMITS.MAX_EXTRACTED_CHARS;
export const SUPPORTED_EXTENSIONS = STUDY_LIMITS.SUPPORTED_EXTENSIONS;
const MAX_ARCHIVE_BYTES = STUDY_LIMITS.MAX_ARCHIVE_BYTES;
const MAX_ARCHIVE_ENTRIES = STUDY_LIMITS.MAX_ARCHIVE_ENTRIES;
const MAX_PDF_PAGES = STUDY_LIMITS.MAX_PDF_PAGES;

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  trimValues: true
});

const orderedXmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  trimValues: true
});

export async function extractStudyFile(file, options = {}) {
  const { onProgress, setId = "" } = options;
  const name = String(file?.name || "");
  const extension = name.split(".").pop()?.toLowerCase();
  if (!name || !SUPPORTED_EXTENSIONS.includes(extension)) {
    throw new Error(`${name || "This file"} has an unsupported type.`);
  }
  if (!file.size || file.size > MAX_FILE_BYTES) {
    throw new Error(`${name} must be between 1 byte and 50 MB.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const warnings = [];
  let rawSections = [];

  if (extension === "pdf") {
    const pdfResult = await extractPdf(bytes, name, onProgress);
    rawSections = pdfResult.sections;
    warnings.push(...pdfResult.warnings);
  } else if (extension === "docx") {
    rawSections = extractDocx(bytes);
  } else if (extension === "pptx") {
    rawSections = extractPptx(bytes, onProgress);
  } else if (extension === "html" || extension === "htm") {
    rawSections = extractHtmlSections(decodeText(bytes), name);
  } else if (extension === "csv" || extension === "tsv") {
    rawSections = extractDelimitedSections(decodeText(bytes), extension === "tsv" ? "\t" : ",");
  } else if (extension === "json") {
    rawSections = extractJsonSections(decodeText(bytes));
  } else if (extension === "md" || extension === "markdown") {
    rawSections = extractMarkdownSections(decodeText(bytes));
  } else {
    rawSections = chunkText(decodeText(bytes), "Text");
  }

  const { sections, charCount, truncated } = capSections(rawSections);
  if (!sections.length) throw new Error(`No readable text was found in ${name}.`);
  if (truncated) {
    warnings.push(`Truncated to ${MAX_EXTRACTED_CHARS.toLocaleString()} extracted characters.`);
  }

  const combinedText = sections.map((section) => `${section.location}\n${section.text}`).join("\n\n");
  const contentHash = await computeContentHash(combinedText);

  return {
    id: crypto.randomUUID(),
    name,
    extension,
    size: file.size,
    addedAt: Date.now(),
    enabled: true,
    setId: String(setId || ""),
    sourceType: "file",
    sourceUrl: "",
    contentHash,
    charCount,
    truncated,
    warnings,
    sections
  };
}

/**
 * Extracts all supported study files contained inside a .zip archive while
 * skipping macOS metadata, hidden files, and unsupported entries.
 */
export async function extractStudyArchive(file, options = {}) {
  const name = String(file?.name || "archive.zip");
  if (!file.size || file.size > MAX_FILE_BYTES) {
    throw new Error(`${name} must be between 1 byte and 50 MB.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = unzipChecked(bytes);
  const extracted = [];
  const skipped = [];
  const errors = [];

  const paths = Object.keys(entries).sort((left, right) => left.localeCompare(right));
  for (let index = 0; index < paths.length; index += 1) {
    const entryPath = paths[index];
    const entryBytes = entries[entryPath];
    if (!entryBytes || entryPath.endsWith("/")) continue;
    const segments = entryPath.split("/").filter(Boolean);
    const baseName = segments[segments.length - 1] || "";
    if (!baseName || baseName.startsWith(".") || segments.includes("__MACOSX")) continue;
    const ext = baseName.split(".").pop()?.toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      skipped.push({ name: entryPath, reason: `Unsupported type (.${ext || "unknown"})` });
      continue;
    }
    if (!entryBytes.byteLength) {
      skipped.push({ name: entryPath, reason: "Empty file" });
      continue;
    }
    options.onProgress?.({
      phase: "zip",
      current: index + 1,
      total: paths.length,
      detail: `Extracting ${baseName} from ${name}`
    });
    const virtualFile = {
      name: entryPath,
      size: entryBytes.byteLength,
      arrayBuffer: async () => entryBytes.buffer.slice(entryBytes.byteOffset, entryBytes.byteOffset + entryBytes.byteLength)
    };
    try {
      const module = await extractStudyFile(virtualFile, options);
      extracted.push(module);
    } catch (error) {
      errors.push({ name: entryPath, error: error instanceof Error ? error.message : "Could not read archive entry." });
    }
  }
  return { extracted, skipped, errors };
}

async function extractPdf(bytes, name, onProgress) {
  let document;
  try {
    document = await pdfjs.getDocument({
      data: bytes,
      cMapUrl: chrome.runtime.getURL("vendor/cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: chrome.runtime.getURL("vendor/standard_fonts/"),
      iccUrl: chrome.runtime.getURL("vendor/iccs/"),
      disableAutoFetch: true,
      isEvalSupported: false,
      useSystemFonts: true
    }).promise;
    if (document.numPages > MAX_PDF_PAGES) {
      throw new Error(`PDF has more than ${MAX_PDF_PAGES} pages.`);
    }
    const sections = [];
    let totalChars = 0;
    let emptyPageCount = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      onProgress?.({
        phase: "pdf",
        current: pageNumber,
        total: document.numPages,
        detail: `Reading page ${pageNumber} of ${document.numPages}`
      });
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = reconstructPdfPageText(content.items || []);
      const nonSpaceLength = text.replace(/\s+/g, "").length;
      if (nonSpaceLength < 15) emptyPageCount += 1;
      if (text) {
        const chunks = chunkText(text, `Page ${pageNumber}`);
        sections.push(...chunks);
        totalChars += chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
      }
      if (totalChars >= MAX_EXTRACTED_CHARS) break;
    }
    if (!sections.length) {
      throw new Error(`${name} appears to be a scanned or image-only PDF with no selectable text.`);
    }
    const warnings = [];
    if (emptyPageCount > 0 && document.numPages > 1) {
      warnings.push(`${emptyPageCount} of ${document.numPages} pages had no selectable text (may be scanned images).`);
    }
    return { sections, warnings };
  } finally {
    if (typeof document?.destroy === "function") {
      try { await document.destroy(); } catch { /* A parsed document remains usable until the popup closes. */ }
    }
  }
}

function reconstructPdfPageText(items) {
  const lines = [];
  let currentLine = "";
  let prevY = null;
  for (const item of items) {
    const str = typeof item?.str === "string" ? item.str : "";
    const y = Array.isArray(item?.transform) ? item.transform[5] : null;
    if (prevY !== null && y !== null && Math.abs(y - prevY) > 4 && currentLine.trim()) {
      lines.push(currentLine.trim());
      currentLine = "";
    }
    if (str) {
      if (currentLine && !currentLine.endsWith(" ") && !str.startsWith(" ") && !/^[,.;:!?)]/.test(str)) {
        currentLine += " ";
      }
      currentLine += str;
    }
    if (item?.hasEOL) {
      if (currentLine.trim()) lines.push(currentLine.trim());
      currentLine = "";
      prevY = null;
    } else if (y !== null) {
      prevY = y;
    }
  }
  if (currentLine.trim()) lines.push(currentLine.trim());
  return lines.join("\n").replace(/[ \t]{2,}/g, " ").trim();
}

function extractDocx(bytes) {
  const files = unzipChecked(bytes);
  const documentBytes = files["word/document.xml"];
  if (!documentBytes) throw new Error("DOCX archive is missing its document body.");

  const orderedDoc = parseOrderedXml(documentBytes, "DOCX document");
  const bodyNode = findOrderedElement(orderedDoc, "body");
  const bodyChildren = bodyNode ? orderedChildren(bodyNode) : orderedDoc;

  const sections = [];
  let heading = "Document";
  let pendingHeadingHeader = "";
  let paragraphNumber = 0;
  let totalChars = 0;
  let groupedParagraphs = [];
  let groupStart = 0;
  let groupEnd = 0;
  let groupChars = 0;

  const flushParagraphGroup = () => {
    if (!groupedParagraphs.length) {
      if (pendingHeadingHeader) {
        sections.push(...chunkText(pendingHeadingHeader, heading));
        pendingHeadingHeader = "";
      }
      return;
    }
    const location = groupStart === groupEnd
      ? `${heading} · paragraph ${groupStart}`
      : `${heading} · paragraphs ${groupStart}–${groupEnd}`;
    const bodyText = groupedParagraphs.join("\n");
    const fullText = pendingHeadingHeader ? `${pendingHeadingHeader}\n${bodyText}` : bodyText;
    const chunks = chunkText(fullText, location);
    sections.push(...chunks);
    totalChars += chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
    groupedParagraphs = [];
    pendingHeadingHeader = "";
    groupStart = 0;
    groupEnd = 0;
    groupChars = 0;
  };

  for (const child of bodyChildren) {
    const tag = orderedTagName(child);
    if (tag === "p") {
      const text = collectOrderedText(child).replace(/[ \t]+/g, " ").trim();
      if (!text) continue;
      paragraphNumber += 1;
      const style = findOrderedAttribute(child, "pStyle", "val");
      if (/^heading\d+$/i.test(style)) {
        flushParagraphGroup();
        heading = text.slice(0, 120);
        pendingHeadingHeader = heading;
      } else {
        if (groupedParagraphs.length && groupChars + text.length + 1 > 1400) {
          flushParagraphGroup();
        }
        if (!groupedParagraphs.length) groupStart = paragraphNumber;
        groupEnd = paragraphNumber;
        groupedParagraphs.push(text);
        groupChars += text.length + 1;
      }
    } else if (tag === "tbl") {
      flushParagraphGroup();
      const tableText = extractOrderedDocxTable(child);
      if (tableText) {
        const chunks = chunkText(tableText, `${heading} · table`);
        sections.push(...chunks);
        totalChars += chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
      }
    }
    if (totalChars >= MAX_EXTRACTED_CHARS) break;
  }
  flushParagraphGroup();

  for (const [notePath, label] of [["word/footnotes.xml", "Footnotes"], ["word/endnotes.xml", "Endnotes"]]) {
    if (!files[notePath] || totalChars >= MAX_EXTRACTED_CHARS) continue;
    try {
      const noteXml = parseXml(files[notePath], label);
      const notes = findElements(noteXml, "p")
        .map((paragraph) => collectText(paragraph).replace(/[ \t]+/g, " ").trim())
        .filter(Boolean);
      if (notes.length) {
        const chunks = chunkText(notes.join("\n"), label);
        sections.push(...chunks);
        totalChars += chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
      }
    } catch {
      // Ignore optional malformed footnote files without discarding the main document.
    }
  }
  return sections;
}

function extractOrderedDocxTable(tableNode) {
  const rows = [];
  for (const rowNode of findAllOrderedElements(tableNode, "tr")) {
    const cells = [];
    for (const cellNode of orderedChildren(rowNode)) {
      if (orderedTagName(cellNode) !== "tc") continue;
      const cellText = collectOrderedText(cellNode).replace(/\s+/g, " ").trim();
      if (cellText) cells.push(cellText);
    }
    if (cells.length) rows.push(cells.join(" | "));
  }
  return rows.join("\n");
}

function extractPptx(bytes, onProgress) {
  const files = unzipChecked(bytes);
  const paths = Object.keys(files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)[1]) - Number(b.match(/slide(\d+)/i)[1]));
  if (!paths.length) throw new Error("PPTX archive has no slide text.");
  const sections = [];
  let totalChars = 0;

  for (let index = 0; index < paths.length; index += 1) {
    const path = paths[index];
    const slideNumber = Number(path.match(/slide(\d+)/i)[1]);
    onProgress?.({
      phase: "pptx",
      current: index + 1,
      total: paths.length,
      detail: `Reading slide ${index + 1} of ${paths.length}`
    });
    const xml = parseXml(files[path], `slide ${slideNumber}`);
    const paragraphs = findElements(xml, "p")
      .map((paragraph) => collectText(paragraph).replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const tables = findElements(xml, "tbl")
      .map((tbl) => extractPptxTable(tbl))
      .filter(Boolean);
    const slideParts = [];
    if (paragraphs.length) slideParts.push(paragraphs.join("\n"));
    if (tables.length) slideParts.push(tables.join("\n"));
    const slideText = slideParts.join("\n").trim();
    if (slideText) {
      const chunks = chunkText(slideText, `Slide ${slideNumber}`);
      sections.push(...chunks);
      totalChars += chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
    }

    const notesPath = resolveSlideNotesPath(files, slideNumber);
    if (notesPath && files[notesPath] && totalChars < MAX_EXTRACTED_CHARS) {
      try {
        const notesXml = parseXml(files[notesPath], `slide ${slideNumber} notes`);
        const noteLines = findElements(notesXml, "p")
          .map((paragraph) => collectText(paragraph).replace(/\s+/g, " ").trim())
          .filter((line) => line && line !== String(slideNumber));
        if (noteLines.length) {
          const chunks = chunkText(noteLines.join("\n"), `Slide ${slideNumber} · Notes`);
          sections.push(...chunks);
          totalChars += chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
        }
      } catch {
        // Ignore optional malformed speaker-note XML.
      }
    }
    if (totalChars >= MAX_EXTRACTED_CHARS) break;
  }
  return sections;
}

function extractPptxTable(tableNode) {
  const rows = [];
  for (const row of findElements(tableNode, "tr")) {
    const cells = findElements(row, "tc")
      .map((cell) => collectText(cell).replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (cells.length) rows.push(cells.join(" | "));
  }
  return rows.join("\n");
}

function resolveSlideNotesPath(files, slideNumber) {
  const relsPath = `ppt/slides/_rels/slide${slideNumber}.xml.rels`;
  if (files[relsPath]) {
    try {
      const relsXml = parseXml(files[relsPath], `slide ${slideNumber} relationships`);
      for (const rel of findElements(relsXml, "Relationship")) {
        const type = String(rel?.["@_Type"] || "");
        const target = String(rel?.["@_Target"] || "");
        if (/notesSlide/i.test(type) && target) {
          const resolved = target.replace(/^\.\.\//, "ppt/").replace(/^\/+/, "");
          if (files[resolved]) return resolved;
        }
      }
    } catch {
      // Fall back to standard notes path.
    }
  }
  const fallback = `ppt/notesSlides/notesSlide${slideNumber}.xml`;
  return files[fallback] ? fallback : "";
}

function decodeText(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^\uFEFF/, "");
}

function parseXml(bytes, label) {
  try {
    const xml = xmlParser.parse(strFromU8(bytes));
    if (!xml || typeof xml !== "object") throw new Error("empty XML");
    return xml;
  } catch (error) {
    throw new Error(`Could not read ${label}: ${error.message}`);
  }
}

function parseOrderedXml(bytes, label) {
  try {
    const xml = orderedXmlParser.parse(strFromU8(bytes));
    if (!Array.isArray(xml)) throw new Error("empty XML");
    return xml;
  } catch (error) {
    throw new Error(`Could not read ${label}: ${error.message}`);
  }
}

function orderedTagName(node) {
  if (!node || typeof node !== "object") return "";
  for (const key of Object.keys(node)) {
    if (key !== ":@" && key !== "#text") return key.split(":").at(-1);
  }
  return "";
}

function orderedChildren(node) {
  if (!node || typeof node !== "object") return [];
  for (const [key, value] of Object.entries(node)) {
    if (key !== ":@" && key !== "#text" && Array.isArray(value)) return value;
  }
  return [];
}

function findOrderedElement(nodes, localName) {
  for (const node of nodes || []) {
    if (orderedTagName(node) === localName) return node;
    const nested = findOrderedElement(orderedChildren(node), localName);
    if (nested) return nested;
  }
  return null;
}

function findAllOrderedElements(root, localName) {
  const results = [];
  const visit = (nodes) => {
    for (const node of nodes || []) {
      if (orderedTagName(node) === localName) results.push(node);
      visit(orderedChildren(node));
    }
  };
  visit(Array.isArray(root) ? root : orderedChildren(root));
  return results;
}

function collectOrderedText(node) {
  const tag = orderedTagName(node);
  if (tag === "tab") return "\t";
  if (tag === "br" || tag === "cr") return "\n";
  if (typeof node?.["#text"] === "string" || typeof node?.["#text"] === "number") {
    return String(node["#text"]);
  }
  return orderedChildren(node).map(collectOrderedText).join("");
}

function findOrderedAttribute(root, elementName, attributeName) {
  for (const element of findAllOrderedElements(root, elementName)) {
    const attrs = element?.[":@"] || {};
    for (const [key, value] of Object.entries(attrs)) {
      if (key === `@_w:${attributeName}` || key === `@_${attributeName}`) return String(value);
    }
  }
  return "";
}

function findElements(root, localName) {
  const found = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("@_") || key === "#text") continue;
      if (key.split(":").at(-1) === localName) {
        if (Array.isArray(value)) found.push(...value);
        else found.push(value);
      }
      visit(value);
    }
  };
  visit(root);
  return found;
}

function collectText(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (!node || typeof node !== "object") return "";
  return Object.entries(node).map(([key, value]) => {
    if (key === "#text") return String(value);
    if (key.startsWith("@_")) return "";
    const local = key.split(":").at(-1);
    if (local === "tab") return "\t";
    if (local === "br" || local === "cr") return "\n";
    return collectText(value);
  }).join("");
}

function unzipChecked(bytes) {
  checkZipDirectory(bytes);
  try {
    return unzipSync(bytes);
  } catch {
    throw new Error("The office or ZIP archive is damaged or uses an unsupported compression format.");
  }
}

function checkZipDirectory(bytes) {
  const minimum = Math.max(0, bytes.length - 65_557);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (read32(bytes, offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("The archive is not a valid ZIP document.");
  const entries = read16(bytes, endOffset + 10);
  const directoryOffset = read32(bytes, endOffset + 16);
  if (entries > MAX_ARCHIVE_ENTRIES || directoryOffset >= bytes.length) {
    throw new Error("Archive exceeds safe extraction limits.");
  }
  let offset = directoryOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entries; index += 1) {
    if (read32(bytes, offset) !== 0x02014b50 || offset + 46 > bytes.length) {
      throw new Error("The archive has a malformed ZIP directory.");
    }
    const compressed = read32(bytes, offset + 20);
    const uncompressed = read32(bytes, offset + 24);
    const nameLength = read16(bytes, offset + 28);
    const extraLength = read16(bytes, offset + 30);
    const commentLength = read16(bytes, offset + 32);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new Error("ZIP64 archives are not supported.");
    }
    if (uncompressed > MAX_ARCHIVE_BYTES) {
      throw new Error("An archive entry exceeds the safe extraction limit.");
    }
    totalUncompressed += uncompressed;
    if (totalUncompressed > MAX_ARCHIVE_BYTES) {
      throw new Error("Archive expands beyond the 100 MB extraction limit.");
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

function read16(bytes, offset) {
  return offset + 2 <= bytes.length ? bytes[offset] | (bytes[offset + 1] << 8) : -1;
}

function read32(bytes, offset) {
  if (offset + 4 > bytes.length) return -1;
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}
