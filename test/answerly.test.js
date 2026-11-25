import test, { before } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { indexedDB } from "fake-indexeddb";

globalThis.indexedDB = indexedDB;
globalThis.chrome = { runtime: { getURL: (path) => new URL(`../${path}`, import.meta.url).href } };

let extractStudyFile;
let extractStudyArchive;
let createStudyModuleFromText;
let chunkText;
let clearStudyFiles;
let saveStudyFile;
let updateStudyFile;
let findRelevantPassages;
let createStudySet;
let listStudySets;
let deleteStudySet;
let listStudyFiles;
let buildAnswerMessages;
let migrateModelId;
let resolveActiveModel;
let getModelMeta;

before(async () => {
  ({ extractStudyFile, extractStudyArchive } = await import("../vendor/file-parser.js"));
  ({ createStudyModuleFromText, chunkText } = await import("../shared/text-module.js"));
  ({
    clearStudyFiles,
    saveStudyFile,
    updateStudyFile,
    findRelevantPassages,
    createStudySet,
    listStudySets,
    deleteStudySet,
    listStudyFiles
  } = await import("../study-store.js"));
  ({ buildAnswerMessages } = await import("../answer-prompt.js"));
  ({ migrateModelId, resolveActiveModel, getModelMeta } = await import("../shared/config.js"));
});

test("extracts TXT and Markdown text with heading locations", async () => {
  const txt = await extractStudyFile(new File(["Cell membranes regulate transport."], "notes.txt"));
  assert.match(txt.sections.map((section) => section.text).join(" "), /regulate transport/);

  const markdown = await extractStudyFile(new File(["# Membranes\n\nThey regulate transport."], "notes.md"));
  assert.equal(markdown.sections[0].location, "Membranes");
  assert.match(markdown.sections[0].text, /regulate transport/);
});

test("extracts DOCX paragraphs and heading context", async () => {
  const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Cell Structure</w:t></w:r></w:p><w:p><w:r><w:t>Mitochondria produce ATP for the cell.</w:t></w:r></w:p></w:body></w:document>`;
  const archive = zipSync({ "word/document.xml": strToU8(xml) });
  const docx = await extractStudyFile(new File([archive], "module.docx"));
  assert.equal(docx.sections[0].location, "Cell Structure · paragraph 2");
  assert.match(docx.sections[0].text, /produce ATP/);
});

test("extracts DOCX tables, grouped paragraphs, and footnotes", async () => {
  const docXml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Enzymes</w:t></w:r></w:p>
    <w:p><w:r><w:t>Catalysts lower activation energy.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Substrates bind at the active site.</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Enzyme</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Target</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>Amylase</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Starch</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body></w:document>`;
  const footnoteXml = `<?xml version="1.0"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote><w:p><w:r><w:t>Cofactors assist enzyme activity.</w:t></w:r></w:p></w:footnote></w:footnotes>`;
  const archive = zipSync({
    "word/document.xml": strToU8(docXml),
    "word/footnotes.xml": strToU8(footnoteXml)
  });
  const docx = await extractStudyFile(new File([archive], "enzymes.docx"));
  assert.equal(docx.sections[0].location, "Enzymes · paragraphs 2–3");
  assert.match(docx.sections[0].text, /Enzymes/);
  assert.match(docx.sections[0].text, /activation energy/);
  assert.equal(docx.sections[1].location, "Enzymes · table");
  assert.match(docx.sections[1].text, /Amylase \| Starch/);
  assert.equal(docx.sections[2].location, "Footnotes");
  assert.match(docx.sections[2].text, /Cofactors assist/);
});

test("extracts PPTX slide text with slide numbers", async () => {
  const slide1 = `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Photosynthesis</a:t></a:r></a:p></p:sld>`;
  const slide2 = `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Chlorophyll absorbs light.</a:t></a:r></a:p></p:sld>`;
  const archive = zipSync({
    "ppt/slides/slide1.xml": strToU8(slide1),
    "ppt/slides/slide2.xml": strToU8(slide2)
  });
  const pptx = await extractStudyFile(new File([archive], "module.pptx"));
  assert.equal(pptx.sections[1].location, "Slide 2");
  assert.match(pptx.sections[1].text, /absorbs light/);
});

test("extracts PPTX speaker notes and slide tables", async () => {
  const slide1 = `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Glycolysis</a:t></a:r></a:p><a:tbl><a:tr><a:tc><a:p><a:r><a:t>Input</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>Glucose</a:t></a:r></a:p></a:tc></a:tr></a:tbl></p:sld>`;
  const notes1 = `<p:notes xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Occurs in the cytoplasm without oxygen.</a:t></a:r></a:p></p:notes>`;
  const rels1 = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`;
  const archive = zipSync({
    "ppt/slides/slide1.xml": strToU8(slide1),
    "ppt/notesSlides/notesSlide1.xml": strToU8(notes1),
    "ppt/slides/_rels/slide1.xml.rels": strToU8(rels1)
  });
  const pptx = await extractStudyFile(new File([archive], "slides.pptx"));
  assert.equal(pptx.sections[0].location, "Slide 1");
  assert.match(pptx.sections[0].text, /Input \| Glucose/);
  assert.equal(pptx.sections[1].location, "Slide 1 · Notes");
  assert.match(pptx.sections[1].text, /cytoplasm without oxygen/);
});

test("extracts PDF page text and rejects empty scanned PDFs", async () => {
  const pdf = makePdf("PDF text extraction works.");
  const document = await extractStudyFile(new File([pdf], "module.pdf"));
  assert.equal(document.sections[0].location, "Page 1");
  assert.match(document.sections[0].text, /text extraction works/);

  const emptyPdf = makePdf("");
  await assert.rejects(
    () => extractStudyFile(new File([emptyPdf], "scan.pdf")),
    /scanned or image-only PDF/i
  );
});

test("extracts HTML, CSV, JSON, and ZIP archives cleanly", async () => {
  const html = await extractStudyFile(new File(
    ["<html><body><h1>Osmosis</h1><p>Water moves across semipermeable membranes &amp; equalizes solute concentration.</p></body></html>"],
    "lesson.html"
  ));
  assert.equal(html.sections[0].location, "Osmosis");
  assert.match(html.sections[0].text, /& equalizes/);

  const csv = await extractStudyFile(new File(["Term,Definition\npH,Measure of hydrogen ion concentration"], "terms.csv"));
  assert.match(csv.sections[0].text, /Term: pH \| Definition: Measure/);

  const json = await extractStudyFile(new File([JSON.stringify({ Mitosis: "Division of somatic cells." })], "bio.json"));
  assert.equal(json.sections[0].location, "Mitosis");
  assert.match(json.sections[0].text, /somatic cells/);

  const zip = zipSync({
    "__MACOSX/._notes.txt": strToU8("ignored"),
    "lecture/notes.md": strToU8("# Mitosis\n\nSister chromatids separate during anaphase."),
    "lecture/image.png": new Uint8Array([137, 80, 78, 71])
  });
  const archiveResult = await extractStudyArchive(new File([zip], "course.zip"));
  assert.equal(archiveResult.extracted.length, 1);
  assert.equal(archiveResult.extracted[0].name, "lecture/notes.md");
  assert.equal(archiveResult.skipped.length, 1);
});

test("chunks long text with overlap and creates paste/webpage modules", async () => {
  const words = Array.from({ length: 380 }, (_, index) => `word${index}`).join(" ");
  const chunks = chunkText(words, "Lecture", 500, 80);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[1].location, "Lecture (continued)");
  const tailToken = chunks[0].text.split(" ").at(-2);
  assert.ok(chunks[1].text.includes(tailToken));

  const pasted = await createStudyModuleFromText({
    name: "Lecture 1",
    text: "# Overview\n\nHomeostasis maintains internal stability.",
    extension: "md",
    sourceType: "paste"
  });
  assert.equal(pasted.sourceType, "paste");
  assert.ok(pasted.contentHash.length > 8);
});

test("stores files locally and selects question-relevant excerpts", async () => {
  await clearStudyFiles();
  await saveStudyFile({
    id: "local-test-module",
    name: "Biology module.pdf",
    addedAt: Date.now(),
    sections: [
      { location: "Page 7", text: "Mitochondria produce ATP through cellular respiration." },
      { location: "Page 19", text: "The cell membrane controls movement of substances into and out of the cell." }
    ]
  });
  const result = await findRelevantPassages("What do mitochondria produce?");
  assert.equal(result.hasFiles, true);
  assert.equal(result.passages[0].file, "Biology module.pdf");
  assert.equal(result.passages[0].location, "Page 7");
  assert.match(result.passages[0].text, /ATP/);
  await clearStudyFiles();
  assert.deepEqual(await findRelevantPassages("What is ATP?"), {
    hasFiles: false,
    activeFileCount: 0,
    totalFileCount: 0,
    passages: []
  });
});

test("handles duplicate/update detection, sets, toggles, short tokens, and choice-aware retrieval", async () => {
  await clearStudyFiles();
  const bioSet = await createStudySet("Biology");
  assert.equal((await listStudySets()).some((s) => s.id === bioSet.id), true);

  const first = await saveStudyFile({
    id: "f1",
    name: "chem.txt",
    setId: bioSet.id,
    contentHash: "hash-v1",
    addedAt: 100,
    sections: [
      { location: "Notes", text: "Normal blood pH is 7.4 and O2 binds to hemoglobin." },
      { location: "Other", text: "Ribosomes translate mRNA into proteins." }
    ]
  });
  assert.equal(first.status, "added");

  const dup = await saveStudyFile({
    id: "f1-dup",
    name: "chem-copy.txt",
    setId: bioSet.id,
    contentHash: "hash-v1",
    addedAt: 101,
    sections: [{ location: "Notes", text: "Duplicate" }]
  });
  assert.equal(dup.status, "duplicate");

  const upd = await saveStudyFile({
    id: "f1-upd",
    name: "chem.txt",
    setId: bioSet.id,
    contentHash: "hash-v2",
    addedAt: 102,
    sections: [
      { location: "Notes", text: "Normal blood pH is 7.4 and O2 binds to hemoglobin." },
      { location: "Other", text: "Ribosomes translate mRNA into proteins." }
    ]
  });
  assert.equal(upd.status, "updated");

  // Short token + choice-aware retrieval
  const mcq = await findRelevantPassages("Which statement is accurate?", 6, 10_000, {
    choices: ["Blood pH is 7.4", "DNA is a lipid"],
    activeSetId: bioSet.id
  });
  assert.equal(mcq.passages[0].location, "Notes");

  // Disabling module turns off hasFiles
  await updateStudyFile(first.file.id, { enabled: false });
  const disabledRes = await findRelevantPassages("What is blood pH?", 6, 10_000, { activeSetId: bioSet.id });
  assert.equal(disabledRes.hasFiles, false);

  // Deleting a set unassigns its files without deleting them
  await deleteStudySet(bioSet.id);
  const remaining = await listStudyFiles();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].setId, "");
  await clearStudyFiles();
});

test("answer prompt supports strict and hybrid grounding and discloses lack of live search", () => {
  const withFile = buildAnswerMessages({
    mode: "words",
    question: "What is ATP?",
    hasFiles: true,
    groundingMode: "strict",
    passages: [{ file: "notes.pdf", location: "Page 2", text: "ATP stores usable cellular energy." }]
  });
  assert.match(withFile[0].content, /untrusted reference data/);
  assert.match(withFile[1].content, /notes\.pdf/);
  assert.match(withFile[0].content, /only factual source/);

  const hybrid = buildAnswerMessages({
    mode: "words",
    question: "What is ATP?",
    hasFiles: true,
    groundingMode: "hybrid",
    passages: [{ file: "notes.pdf", location: "Page 2", text: "ATP stores usable cellular energy." }]
  });
  assert.match(hybrid[0].content, /Prefer and cite the supplied excerpts/);
  assert.match(hybrid[0].content, /general knowledge/);

  const withoutFile = buildAnswerMessages({ mode: "words", question: "Who is the current president?", hasFiles: false });
  assert.match(withoutFile[0].content, /does not provide hosted web search/);
  assert.match(withoutFile[0].content, /Do not claim to have browsed/);
});

test("migrates kimi-k3 to kimi-k3.1-pro and resolves custom models", () => {
  assert.equal(migrateModelId("deeprelay/kimi-k3"), "deeprelay/kimi-k3.1-pro");
  assert.equal(
    resolveActiveModel({ useCustomModel: true, customModelId: "deeprelay/custom-test", model: "deeprelay/glm-5.3" }),
    "deeprelay/custom-test"
  );
  assert.equal(getModelMeta("deeprelay/kimi-k3.1-pro").vision, true);
  assert.equal(getModelMeta("deeprelay/kimi-k3.1-pro").supportsTemperature, false);
  assert.equal(getModelMeta("deeprelay/custom-test").isCustom, true);
});

function makePdf(text) {
  const escaped = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const stream = text ? `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET` : "";
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < bodies.length; index += 1) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${bodies[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  source += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(source, "ascii");
}
