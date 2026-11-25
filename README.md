# Answerly Inline

An MV3 extension that answers highlighted questions with Deep Relay AI and can ground answers in locally stored study modules.

## Install

You do not need Node.js, `npm install`, or `npm run build` to install the extension from this repository. The built files are already included.

1. Download the repository ZIP from GitHub and extract it, or clone the repository.
2. Open `chrome://extensions` in Chrome and enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted `answerly` folder (the one containing `manifest.json`).
4. Open Answerly Inline’s toolbar popup, add a Deep Relay API key in **Settings**, test your key, and optionally attach study modules in **Modules**.
5. Settings auto-save immediately. Edit the **Answer focus prompt** if you want to change what the AI prioritizes or how it phrases responses, then highlight a question and use one of the shortcuts below. Edit shortcut conflicts at `chrome://extensions/shortcuts`.

To rebuild the bundled parser after changing its source or dependencies, developers can run `npm install` and `npm run build`.

## Shortcuts

- **Alt+Q:** Detect nearby native radio buttons, ARIA `role="radio"` quiz options, grouped checkboxes, or lettered lists (`ol[type="A"]`) to determine the best answer and show it inline. Answerly does not click or select an option and does not submit the form. If evidence does not support a choice, the model may return no selection.
- **Alt+W:** Insert a concise written answer at the highlighted text’s endpoint. In supported CodeMirror, Ace, and Monaco code editors, a temporary language-appropriate `Thinking…` comment appears while the AI is responding, then is replaced with the answer. If the highlight is still selected inside a text field, contenteditable region, or supported editor, add the answer after that passage while keeping the original text. If the editor cannot safely accept the edit, show the answer inline instead. Inline answers can be highlighted and copied directly, with subtle hover-only Copy and Dismiss icons.
- **Right-click selected text:** Choose **Answer selection with Answerly** from Chrome’s context menu to run the same written-answer action as Alt+W. The normal browser context menu remains available.
- **Alt+R:** Arm image-question capture (crosshair cursor). Clicking an image or question captures its enclosing question container (parent, children, and nearby siblings); dragging draws a custom crop rectangle. Answerly captures the visible area before inserting feedback, reads it with a vision model, and inserts the answer cleanly. Press **Escape** before releasing to cancel.
- **Alt+1:** Remove Answerly-inserted answers, status/error messages, crop boxes, and legacy choice markers, and cancel any active request.

## Study modules

Import modules in the **Modules** tab by dropping files anywhere on the popup, picking files, pasting notes directly, or clicking **Import page** to capture the active browser tab.

- **Supported formats:** PDF (line-aware extraction + scanned-page warnings), DOCX (headings, grouped paragraphs, tables, footnotes), PPTX (slide text, tables, and speaker notes), TXT, Markdown, HTML/HTM, CSV/TSV, JSON, and ZIP archives containing supported study files.
- **Limits:** Up to 25 modules, 50 MB per file, and 500,000 extracted characters per module. Scanned image-only PDFs require OCR and will trigger a warning or error if no selectable text is found.
- **Organization & grounding:** Organize modules into course sets, toggle individual modules on or off, preview extracted sections, and switch between **Strict** (use only active attached modules) and **Hybrid** (prefer modules and fall back to general knowledge) grounding.
- **Local storage & retrieval:** Extracted text is stored locally in extension IndexedDB; original file bytes are not retained. Answerly ranks passages locally using BM25 + heading + phrase + choice-aware retrieval (up to 6 excerpts / 10,000 characters) and sends only relevant excerpts when a shortcut is invoked.

## Deep Relay configuration

The extension uses Deep Relay’s OpenAI-compatible chat completions API at `https://api.deeprelay.ai/v1/chat/completions` with `Authorization: Bearer` authentication. You can choose a curated model or enter a custom Deep Relay model ID in **Settings**.

| Display name | Model ID |
| --- | --- |
| DeepSeek V4.1 Flash 1017 | `deeprelay/deepseek-v4.1-flash` (vision) |
| Kimi K3.1 Pro | `deeprelay/kimi-k3.1-pro` (vision) |
| GLM 5.3 | `deeprelay/glm-5.3` |
| GLM 5.3 Flash | `deeprelay/glm-5.3-flash` (vision) |

## Data and page behavior

- Settings (API key, model, thinking level, custom focus prompt, grounding mode, active set, and inline answer style) are stored in `chrome.storage.local` and auto-save on change.
- Attached extracted text stays local until a shortcut requests an answer. Relevant excerpts, question text, and nearby option labels are then sent to Deep Relay over HTTPS.
- The extension injects a content script into the active tab only after a shortcut or explicit **Import page** action. It never submits forms.
- Alt+R captures only the visible tab crop after you click or drag-select an area and does not save screenshots.
- Browser-internal pages, the Chrome Web Store, and some protected pages block extension script injection.

## Development checks

- `npm run build` builds `vendor/file-parser.js` from `src/file-parser.js` and `shared/`.
- `npm test` checks extraction for PDF, DOCX, PPTX, TXT, Markdown, HTML, CSV, JSON, ZIP, local BM25 passage retrieval, set/duplicate management, prompt grounding modes, and model configuration.
