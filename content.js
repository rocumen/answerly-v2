(() => {
  // The worker injects this file on demand for each shortcut; avoid registering duplicate listeners.
  if (globalThis.__answerlyInlineInstalled) return;
  globalThis.__answerlyInlineInstalled = true;

  const OPTION_ATTR = "data-answerly-option-id";
  const OUTPUT_ATTR = "data-answerly-output";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const MAX_OPTIONS = 40;
  let operationNumber = 0;
  let activeOperation = 0;
  let selectionCapturePending = false;
  let activeRequestId = "";
  let activeCaptureId = "";
  let activeEditorStatusToken = "";
  let activeContentEditableStatus = null;
  let activeOptions = [];
  let answerFontScale = 0.6;
  let answerUsePageColor = true;
  let answerCustomColor = "#333333";
  let imageCaptureArmed = false;
  let previousDocumentCursor = "";
  let cropBox = null;
  let pointerDownHandler = null;
  let pointerMoveHandler = null;
  let pointerUpHandler = null;
  let captureClickSuppressHandler = null;
  let imageKeyHandler = null;

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "ANSWERLY_CLEAR_OUTPUT") {
      clearOutput();
      return;
    }
    if (message?.type === "ANSWERLY_ARM_IMAGE_CAPTURE") armImageCapture();
    if (message?.type === "ANSWERLY_MULTIPLE_CHOICE") answerSelection("multiple-choice");
    if (message?.type === "ANSWERLY_WORDS") answerSelection("words");
  });

  chrome.storage.local.get({ answerFontScale: 0.6, answerUsePageColor: true, answerCustomColor: "#333333" }).then((settings) => {
    const scale = Number(settings.answerFontScale);
    if (Number.isFinite(scale)) answerFontScale = Math.max(0.4, Math.min(1, scale));
    answerUsePageColor = settings.answerUsePageColor !== false;
    if (isValidHexColor(settings.answerCustomColor)) answerCustomColor = settings.answerCustomColor;
  }).catch(() => {});

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.answerFontScale) {
      const scale = Number(changes.answerFontScale.newValue);
      if (Number.isFinite(scale)) answerFontScale = Math.max(0.4, Math.min(1, scale));
    }
    if (changes.answerUsePageColor) answerUsePageColor = changes.answerUsePageColor.newValue !== false;
    if (changes.answerCustomColor && isValidHexColor(changes.answerCustomColor.newValue)) {
      answerCustomColor = changes.answerCustomColor.newValue;
    }
  });

  async function answerSelection(mode) {
    if (activeOperation || selectionCapturePending) return;
    selectionCapturePending = true;
    const directEditableSelection = captureEditableSelection();
    let editableSelection;
    try {
      editableSelection = directEditableSelection || await capturePageEditorSelection();
    } finally {
      selectionCapturePending = false;
    }
    const selection = window.getSelection();
    const question = (editableSelection?.text || selection?.toString() || "").trim();
    const focusElement = editableSelection?.element || elementForNode(selection?.focusNode);
    if (!question || !focusElement) {
      showPageMessage("Highlight a question first, then use Alt+Q or Alt+W.", document.activeElement || document.body);
      return;
    }

    const anchor = findQuestionBlock(focusElement);
    const options = mode === "multiple-choice" ? findRadioOptions(anchor) : findNearbyContextOptions(anchor);
    if (mode === "multiple-choice" && options.length < 2) {
      showPageMessage("No multiple-choice options were found near this question.", anchor);
      return;
    }

    const preferInsideContainer = mode === "multiple-choice";
    const insertionPoint = editableSelection || preferInsideContainer ? null : makeInsertionPoint(selection);
    let placementAnchor = anchor;
    if (preferInsideContainer && options.length >= 2) {
      const lastOptionEl = options[options.length - 1]?.element;
      placementAnchor = commonCardAncestor(anchor, lastOptionEl) || resolveCardContainer(anchor);
    }

    const operationId = ++operationNumber;
    const requestId = `answerly-${Date.now()}-${operationId}`;
    activeOperation = operationId;
    activeRequestId = requestId;
    activeOptions = options;
    const pending = insertPendingNode(placementAnchor, "Thinking…", "", insertionPoint, preferInsideContainer);
    try {
      if (mode === "words" && editableSelection?.type === "page-editor") {
        activeEditorStatusToken = editableSelection.token;
        const status = await chrome.runtime.sendMessage({
          type: "ANSWERLY_SHOW_EDITOR_STATUS",
          token: editableSelection.token
        }).catch(() => null);
        if (activeOperation !== operationId) {
          await finishEditorStatus(editableSelection.token, "");
          return;
        }
        if (status?.shown) pending.remove();
      } else if (mode === "words" && editableSelection?.type === "contenteditable") {
        activeContentEditableStatus = showContentEditableStatus(editableSelection);
        if (activeContentEditableStatus) pending.remove();
      }
      const response = await chrome.runtime.sendMessage({
        type: "ANSWERLY_ANSWER_REQUEST",
        requestId,
        payload: {
          mode,
          question,
          options: options.map(({ id, text }) => ({ id, text }))
        }
      });
      if (activeOperation !== operationId) return;
      if (!response?.ok) throw new Error(response?.error || "Could not get an answer.");
      const result = response.result;

      if (mode === "multiple-choice") {
        const choice = options.find((option) => option.id === result.correctOptionId);
        if (result.correctOptionId !== null && !choice) {
          throw new Error("The returned answer did not match an option on the page.");
        }
      }
      await completeAnswer(pending, formatAnswer(result), editableSelection);
    } catch (error) {
      if (editableSelection?.type === "page-editor" && activeEditorStatusToken === editableSelection.token) {
        await finishEditorStatus(editableSelection.token, "");
        activeEditorStatusToken = "";
      }
      if (activeContentEditableStatus) {
        finishContentEditableStatus(activeContentEditableStatus, "");
        activeContentEditableStatus = null;
      }
      if (activeOperation === operationId && error?.name !== "AbortError") {
        setStatusBannerText(pending, `Answerly: ${error.message || "Something went wrong."} (click to dismiss)`);
      } else {
        pending.remove();
      }
    } finally {
      restoreOptionAttributes(options);
      if (activeOperation === operationId) {
        activeOperation = 0;
        activeRequestId = "";
        activeOptions = [];
      }
      if (editableSelection?.type === "page-editor" && activeEditorStatusToken === editableSelection.token) {
        activeEditorStatusToken = "";
      }
      if (activeContentEditableStatus?.selection === editableSelection) activeContentEditableStatus = null;
    }
  }

  function clearOutput() {
    operationNumber += 1;
    const requestId = activeRequestId;
    const captureId = activeCaptureId;
    const statusToken = activeEditorStatusToken;
    const contentEditableStatus = activeContentEditableStatus;
    activeOperation = 0;
    activeRequestId = "";
    activeCaptureId = "";
    activeEditorStatusToken = "";
    activeContentEditableStatus = null;
    if (statusToken) finishEditorStatus(statusToken, "");
    if (contentEditableStatus) finishContentEditableStatus(contentEditableStatus, "");
    if (requestId || captureId) {
      chrome.runtime.sendMessage({ type: "ANSWERLY_CANCEL_REQUEST", requestId, captureId }).catch(() => {});
    }
    restoreOptionAttributes(activeOptions);
    activeOptions = [];
    disarmImageCapture();
    document.querySelectorAll(`[${OUTPUT_ATTR}]`).forEach((node) => node.remove());
  }

  function armImageCapture() {
    if (activeOperation || imageCaptureArmed) return;
    imageCaptureArmed = true;
    previousDocumentCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = "crosshair";

    let dragState = null;

    pointerDownHandler = (event) => {
      if (event.button !== 0 || event.target?.closest?.(`[${OUTPUT_ATTR}]`)) return;
      event.preventDefault();
      event.stopPropagation();
      dragState = {
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        target: event.target
      };
    };

    pointerMoveHandler = (event) => {
      if (!dragState) return;
      dragState.currentX = event.clientX;
      dragState.currentY = event.clientY;
      const dx = Math.abs(dragState.currentX - dragState.startX);
      const dy = Math.abs(dragState.currentY - dragState.startY);
      if (dx < 8 && dy < 8) return;
      if (!cropBox) {
        cropBox = document.createElement("div");
        cropBox.setAttribute(OUTPUT_ATTR, "crop");
        cropBox.style.position = "fixed";
        cropBox.style.pointerEvents = "none";
        cropBox.style.zIndex = "2147483647";
        cropBox.style.border = "1.5px dashed #0066cc";
        cropBox.style.background = "rgba(0, 102, 204, 0.08)";
        cropBox.style.borderRadius = "4px";
        document.documentElement.append(cropBox);
      }
      const left = Math.min(dragState.startX, dragState.currentX);
      const top = Math.min(dragState.startY, dragState.currentY);
      cropBox.style.left = `${left}px`;
      cropBox.style.top = `${top}px`;
      cropBox.style.width = `${dx}px`;
      cropBox.style.height = `${dy}px`;
    };

    pointerUpHandler = async (event) => {
      if (!dragState) return;
      event.preventDefault();
      event.stopPropagation();
      const finished = dragState;
      dragState = null;

      const dx = Math.abs(event.clientX - finished.startX);
      const dy = Math.abs(event.clientY - finished.startY);
      const isDragCrop = dx >= 8 || dy >= 8;

      if (cropBox) {
        cropBox.remove();
        cropBox = null;
      }
      disarmImageCapture();

      // Wait two animation frames so the cursor and crop outline settle before captureVisibleTab.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const clicked = elementForNode(finished.target);
      if (!clicked) return;
      const visual = resolveClickedVisual(clicked, finished.startX, finished.startY);
      const viewport = {
        width: document.documentElement.clientWidth || window.innerWidth,
        height: document.documentElement.clientHeight || window.innerHeight
      };

      let pointRect;
      let contextElement;
      let anchor;
      let standalone = isStandaloneImagePage();

      if (isDragCrop) {
        pointRect = {
          x: Math.min(finished.startX, event.clientX),
          y: Math.min(finished.startY, event.clientY),
          width: Math.max(16, dx),
          height: Math.max(16, dy)
        };
        contextElement = visual;
        anchor = findQuestionBlock(visual);
      } else {
        const targetInfo = findCaptureTarget(clicked, visual, viewport);
        pointRect = targetInfo.rect || {
          x: Math.max(0, event.clientX - 280),
          y: Math.max(0, event.clientY - 180),
          width: 560,
          height: 360
        };
        contextElement = targetInfo.contextElement;
        anchor = targetInfo.anchorElement;
        standalone = targetInfo.standalone;
      }

      const questionText = nearbyQuestionContext(contextElement);
      const operationId = ++operationNumber;
      const requestId = `answerly-image-${Date.now()}-${operationId}`;
      const captureId = `answerly-cap-${Date.now()}-${operationId}`;
      activeOperation = operationId;
      activeRequestId = requestId;
      activeCaptureId = captureId;

      let pending = null;
      try {
        // Phase 1: Capture the untouched page BEFORE inserting any DOM feedback node.
        const prep = await chrome.runtime.sendMessage({
          type: "ANSWERLY_PREPARE_IMAGE_CAPTURE",
          captureId,
          payload: {
            imageRect: pointRect,
            viewport,
            isExactCrop: isDragCrop
          }
        });
        if (activeOperation !== operationId) {
          chrome.runtime.sendMessage({ type: "ANSWERLY_CANCEL_REQUEST", requestId, captureId }).catch(() => {});
          return;
        }
        if (!prep?.ok) {
          throw new Error(prep?.error || "Could not capture the image.");
        }

        // Phase 2: Now insert the pending indicator safely without shifting the captured screenshot.
        pending = insertImagePendingNode(anchor, "Reading image…", "Answerly", standalone);
        const response = await chrome.runtime.sendMessage({
          type: "ANSWERLY_IMAGE_REQUEST",
          requestId,
          captureId,
          payload: {
            captureId,
            question: questionText
          }
        });
        if (activeOperation !== operationId) return;
        if (!response?.ok) throw new Error(response?.error || "Could not answer the image.");
        renderCompletedAnswer(pending, formatAnswer(response.result), "Answer");
        if (!standalone && response.result?.answer) {
          const answerInput = findNearbyImageAnswerInput(clicked, contextElement, pointRect);
          if (answerInput) fillDetectedAnswerInput(answerInput, response.result.answer);
        }
      } catch (error) {
        if (activeOperation === operationId && error?.name !== "AbortError") {
          const message = `Answerly: ${error?.message || "Could not answer the image."} (click to dismiss)`;
          if (pending) setStatusBannerText(pending, message);
          else {
            pending = insertImagePendingNode(anchor, error?.message || "Could not answer the image.", "Answerly", standalone);
            setStatusBannerText(pending, message);
          }
        } else if (pending) {
          pending.remove();
        }
      } finally {
        if (activeOperation === operationId) {
          activeOperation = 0;
          activeRequestId = "";
          activeCaptureId = "";
        }
      }
    };

    captureClickSuppressHandler = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    imageKeyHandler = (event) => {
      if (event.key !== "Escape") return;
      dragState = null;
      disarmImageCapture();
    };

    document.addEventListener("pointerdown", pointerDownHandler, true);
    document.addEventListener("pointermove", pointerMoveHandler, true);
    document.addEventListener("pointerup", pointerUpHandler, true);
    document.addEventListener("click", captureClickSuppressHandler, true);
    document.addEventListener("keydown", imageKeyHandler, true);
  }

  function disarmImageCapture() {
    imageCaptureArmed = false;
    document.documentElement.style.cursor = previousDocumentCursor;
    previousDocumentCursor = "";
    if (cropBox) {
      cropBox.remove();
      cropBox = null;
    }
    if (pointerDownHandler) document.removeEventListener("pointerdown", pointerDownHandler, true);
    if (pointerMoveHandler) document.removeEventListener("pointermove", pointerMoveHandler, true);
    if (pointerUpHandler) document.removeEventListener("pointerup", pointerUpHandler, true);
    if (captureClickSuppressHandler) {
      const handler = captureClickSuppressHandler;
      setTimeout(() => document.removeEventListener("click", handler, true), 50);
    }
    if (imageKeyHandler) document.removeEventListener("keydown", imageKeyHandler, true);
    pointerDownHandler = null;
    pointerMoveHandler = null;
    pointerUpHandler = null;
    captureClickSuppressHandler = null;
    imageKeyHandler = null;
    if (!activeRequestId) activeOperation = 0;
  }

  function resolveClickedVisual(target, clientX, clientY) {
    const visualSelector = "img,canvas,svg,video,[role='img'],picture";
    if (typeof document.elementsFromPoint === "function") {
      for (const el of document.elementsFromPoint(clientX, clientY)) {
        if (el.closest?.(`[${OUTPUT_ATTR}]`)) continue;
        if (el.matches?.(visualSelector)) return el;
      }
    }
    const closestVisual = target.closest?.(visualSelector);
    if (closestVisual) return closestVisual;
    const childVisuals = target.querySelectorAll?.("img,canvas,svg,picture");
    if (childVisuals?.length === 1) return childVisuals[0];
    return target;
  }

  function isStandaloneImagePage() {
    if (!document.body) return false;
    const children = [...document.body.children].filter((el) => !el.hasAttribute(OUTPUT_ATTR));
    return children.length === 1 && ["IMG", "SVG", "CANVAS", "PICTURE"].includes(children[0].tagName);
  }

  function visibleRect(element, vw, vh) {
    if (!element?.getBoundingClientRect) return null;
    const rect = element.getBoundingClientRect();
    const x = Math.max(0, rect.left);
    const y = Math.max(0, rect.top);
    const right = Math.min(vw, rect.right);
    const bottom = Math.min(vh, rect.bottom);
    const width = right - x;
    const height = bottom - y;
    if (width < 4 || height < 4) return null;
    return { x, y, width, height, right, bottom };
  }

  function countChoiceCandidates(root) {
    if (!root?.querySelectorAll) return 0;
    return root.querySelectorAll('input[type="radio"], [role="radio"]').length;
  }

  function findCaptureTarget(clicked, visual, viewport) {
    const vw = viewport.width;
    const vh = viewport.height;
    if (isStandaloneImagePage()) {
      return {
        rect: visibleRect(visual, vw, vh) || visibleRect(clicked, vw, vh),
        contextElement: visual,
        anchorElement: visual,
        standalone: true
      };
    }

    const baseRect = visibleRect(visual, vw, vh) || visibleRect(clicked, vw, vh);
    if (!baseRect) {
      return { rect: null, contextElement: visual, anchorElement: findQuestionBlock(visual), standalone: false };
    }

    let bestContainer = null;
    let bestRect = baseRect;
    let current = visual.parentElement;
    for (let depth = 0; current && current !== document.body && current !== document.documentElement && depth < 6; depth += 1) {
      const candRect = visibleRect(current, vw, vh);
      if (!candRect) {
        current = current.parentElement;
        continue;
      }
      if (candRect.width > vw * 0.94 && candRect.height > vh * 0.88) break;
      if (bestContainer && countChoiceCandidates(bestContainer) >= 2 && countChoiceCandidates(current) > 10) {
        break;
      }
      const isSemanticContainer = current.matches?.('figure,article,section,fieldset,form,li,td,[role="listitem"],[role="group"],[role="region"]') ||
        /question|quiz|problem|card|item|prompt|stem|exercise|task/i.test(`${current.className || ""} ${current.id || ""}`);
      if (candRect.height <= vh * 0.88 && candRect.width <= vw * 0.94 &&
          (isSemanticContainer || candRect.height <= Math.max(vh * 0.85, baseRect.height * 4))) {
        bestContainer = current;
        bestRect = candRect;
      }
      current = current.parentElement;
    }

    if (!bestContainer) {
      let union = { ...baseRect };
      const mergeSibling = (sib) => {
        if (!sib || sib.nodeType !== Node.ELEMENT_NODE) return false;
        if (sib.hasAttribute(OUTPUT_ATTR) || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(sib.tagName)) return false;
        const r = visibleRect(sib, vw, vh);
        if (!r || r.height > vh * 0.55) return false;
        const gap = Math.max(0, r.y - union.bottom, union.y - r.bottom);
        if (gap > 140) return false;
        const nextLeft = Math.min(union.x, r.x);
        const nextTop = Math.min(union.y, r.y);
        const nextRight = Math.max(union.right, r.right);
        const nextBottom = Math.max(union.bottom, r.bottom);
        union = {
          x: nextLeft,
          y: nextTop,
          right: nextRight,
          bottom: nextBottom,
          width: nextRight - nextLeft,
          height: nextBottom - nextTop
        };
        return true;
      };

      let prev = visual.previousElementSibling;
      for (let count = 0; prev && count < 2; prev = prev.previousElementSibling) {
        if (mergeSibling(prev)) count += 1;
      }
      let next = visual.nextElementSibling;
      for (let count = 0; next && count < 2; next = next.nextElementSibling) {
        if (mergeSibling(next)) count += 1;
      }
      bestRect = union;
    }

    return {
      rect: { x: bestRect.x, y: bestRect.y, width: bestRect.width, height: bestRect.height },
      contextElement: bestContainer || visual.parentElement || visual,
      anchorElement: bestContainer || findQuestionBlock(visual),
      standalone: false
    };
  }

  function rectsIntersect(a, b) {
    if (!a || !b) return false;
    const aRight = "right" in a ? a.right : a.x + a.width;
    const aBottom = "bottom" in a ? a.bottom : a.y + a.height;
    const bRight = "right" in b ? b.right : b.x + b.width;
    const bBottom = "bottom" in b ? b.bottom : b.y + b.height;
    const aLeft = "left" in a ? a.left : a.x;
    const aTop = "top" in a ? a.top : a.y;
    const bLeft = "left" in b ? b.left : b.x;
    const bTop = "top" in b ? b.top : b.y;
    return aLeft < bRight && aRight > bLeft && aTop < bBottom && aBottom > bTop;
  }

  function getInputValue(el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value || "";
    return el?.innerText || el?.textContent || "";
  }

  function isEligibleAnswerInput(el) {
    if (!el?.isConnected) return false;
    if (el.closest?.(`[${OUTPUT_ATTR}]`) || el.closest?.("header, nav, [role='navigation'], [role='search']")) {
      return false;
    }
    if (el.getAttribute?.("aria-hidden") === "true") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 16) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const editableOk = isTextControl(el) ||
      (el.isContentEditable && el.getAttribute("aria-disabled") !== "true" && el.getAttribute("aria-readonly") !== "true");
    if (!editableOk) return false;
    return !getInputValue(el).trim() || el.getAttribute("data-answerly-filled") === "true";
  }

  function findNearbyImageAnswerInput(clicked, contextElement, pointRect) {
    const inputSelector = 'textarea, input, [contenteditable="true"], [contenteditable=""], [role="textbox"]';
    const normalizeCandidate = (el) => {
      if (!el) return null;
      return el.isContentEditable ? (editableRootFor(el) || el) : el;
    };

    const directHit = normalizeCandidate(clicked?.closest?.(inputSelector)) || editableRootFor(clicked);
    if (isEligibleAnswerInput(directHit)) return directHit;

    const candidates = new Set();
    if (contextElement && contextElement !== document.body && contextElement !== document.documentElement) {
      for (const el of contextElement.querySelectorAll(inputSelector)) {
        const normalized = normalizeCandidate(el);
        if (normalized) candidates.add(normalized);
      }
    }
    for (const el of document.querySelectorAll(inputSelector)) {
      const normalized = normalizeCandidate(el);
      if (normalized && pointRect && rectsIntersect(normalized.getBoundingClientRect(), pointRect)) {
        candidates.add(normalized);
      }
    }

    const centerX = pointRect ? pointRect.x + pointRect.width / 2 : 0;
    const centerY = pointRect ? pointRect.y + pointRect.height / 2 : 0;
    let best = null;
    let bestIntersects = false;
    let bestDist = Infinity;

    for (const candidate of candidates) {
      if (!isEligibleAnswerInput(candidate)) continue;
      const rect = candidate.getBoundingClientRect();
      const intersects = Boolean(pointRect && rectsIntersect(rect, pointRect));
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = Math.hypot(cx - centerX, cy - centerY);
      if (!best || (intersects && !bestIntersects) || (intersects === bestIntersects && dist < bestDist)) {
        best = candidate;
        bestIntersects = intersects;
        bestDist = dist;
      }
    }
    return best;
  }

  function fillDetectedAnswerInput(el, rawAnswer) {
    const value = String(rawAnswer ?? "").trim();
    if (!value || !el?.isConnected) return false;

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el instanceof HTMLInputElement && el.type === "number" && !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) {
        return false;
      }
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.setAttribute("data-answerly-filled", "true");
      dispatchInput(el, value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if (el.isContentEditable) {
      el.textContent = value;
      el.setAttribute("data-answerly-filled", "true");
      dispatchInput(el, value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    return false;
  }

  function insertImagePendingNode(anchor, text, label, standalone) {
    if (standalone) {
      const node = document.createElement("div");
      node.setAttribute(OUTPUT_ATTR, "answer");
      node.setAttribute("role", "note");
      applyStandaloneOverlayStyle(node);
      node.style.cursor = "pointer";
      node.textContent = `${label ? `${label}: ` : ""}${text}`;
      node.title = "Click to dismiss";
      node._answerlyPendingDismiss = () => node.remove();
      node.addEventListener("click", node._answerlyPendingDismiss, { once: true });
      document.body.append(node);
      return node;
    }

    return insertPendingNode(resolveCardContainer(anchor), text, label, null, true);
  }

  function applyStandaloneOverlayStyle(node) {
    const bgColor = document.body ? getComputedStyle(document.body).backgroundColor : "";
    const isDark = isDarkBackgroundColor(bgColor);
    node.style.position = "fixed";
    node.style.left = "16px";
    node.style.right = "16px";
    node.style.bottom = "16px";
    node.style.width = "auto";
    node.style.maxWidth = "720px";
    node.style.margin = "0 auto";
    node.style.zIndex = "2147483646";
    node.style.padding = "10px 14px";
    node.style.borderRadius = "10px";
    node.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    node.style.fontSize = "14px";
    node.style.lineHeight = "1.45";
    node.style.whiteSpace = "pre-wrap";
    node.style.background = isDark ? "rgba(28, 28, 30, 0.92)" : "rgba(255, 255, 255, 0.94)";
    node.style.color = isDark ? "#f5f5f7" : "#1d1d1f";
    node.style.border = isDark ? "1px solid rgba(255,255,255,0.16)" : "1px solid rgba(0,0,0,0.12)";
    node.style.boxShadow = "0 4px 20px rgba(0,0,0,0.22)";
  }

  function isDarkBackgroundColor(rgbString) {
    const parsed = parseRgba(rgbString);
    if (!parsed || parsed.a <= 0.15) return false;
    return relativeLuminance(parsed.r, parsed.g, parsed.b) < 0.5;
  }

  function nearbyQuestionContext(element) {
    const block = element || document.body;
    const readCleanText = (node) => {
      if (!node) return "";
      const clone = node.cloneNode(true);
      clone.querySelectorAll?.(`[${OUTPUT_ATTR}]`).forEach((el) => el.remove());
      return (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
    };
    let text = readCleanText(block);
    if (text.length < 40 && block?.parentElement && block.parentElement !== document.body) {
      text = readCleanText(block.parentElement) || text;
    }
    return text.slice(0, 5000) || "Read the question shown in the captured image and answer it.";
  }

  function elementForNode(node) {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function captureEditableSelection() {
    const active = document.activeElement;
    if (isTextControl(active) && active.selectionStart !== null && active.selectionEnd > active.selectionStart) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      return {
        type: "text-control",
        element: active,
        start,
        end,
        text: active.value.slice(start, end)
      };
    }

    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const focusElement = elementForNode(selection.focusNode);
    const root = editableRootFor(focusElement);
    if (!root || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
    const range = selection.getRangeAt(0).cloneRange();
    const text = range.toString();
    return text.trim() ? { type: "contenteditable", element: root, range, text } : null;
  }

  function isTextControl(element) {
    if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
    if (!(element instanceof HTMLInputElement) || element.disabled || element.readOnly) return false;
    return ["text", "search", "url", "tel", "email", "number"].includes(element.type);
  }

  function editableRootFor(element) {
    let root = null;
    for (let current = element; current?.isContentEditable; current = current.parentElement) root = current;
    return root;
  }

  async function capturePageEditorSelection() {
    const token = `answerly-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const response = await chrome.runtime.sendMessage({ type: "ANSWERLY_GET_EDITOR_SELECTION", token });
      if (!response?.ok || !response.selection?.text) return null;
      return {
        type: "page-editor",
        element: document.activeElement,
        token,
        text: String(response.selection.text)
      };
    } catch {
      return null;
    }
  }

  async function completeAnswer(pending, answerText, editableSelection) {
    if (activeContentEditableStatus?.selection === editableSelection) {
      const status = activeContentEditableStatus;
      activeContentEditableStatus = null;
      if (finishContentEditableStatus(status, answerText)) {
        pending.remove();
        return;
      }
    }
    if (editableSelection?.type === "page-editor") {
      try {
        if (activeEditorStatusToken === editableSelection.token) {
          const response = await finishEditorStatus(editableSelection.token, answerText);
          activeEditorStatusToken = "";
          if (response?.replaced) {
            pending.remove();
            return;
          }
        }
        const response = await chrome.runtime.sendMessage({
          type: "ANSWERLY_REPLACE_EDITOR_SELECTION",
          token: editableSelection.token,
          text: answerText
        });
        if (response?.ok && response.replaced) {
          pending.remove();
          return;
        }
      } catch {
        // If the editor changed while the answer was generated, preserve the answer inline.
      }
    } else if (editableSelection && insertAfterEditableSelection(editableSelection, answerText)) {
      pending.remove();
      return;
    }
    renderCompletedAnswer(pending, answerText, "Answer");
  }

  function finishEditorStatus(token, text) {
    return chrome.runtime.sendMessage({
      type: "ANSWERLY_FINISH_EDITOR_STATUS",
      token,
      text
    }).catch(() => null);
  }

  function showContentEditableStatus(target) {
    const root = target?.element;
    const editor = root?.closest?.(".cm-editor");
    if (!root?.isConnected || !editor || !root.matches(".cm-content")) return null;
    if (!(document.activeElement === root || root.contains(document.activeElement) || root.matches(":focus-within"))) return null;

    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const currentRange = selection.getRangeAt(0);
    if (currentRange.toString() !== target.text) return null;
    try {
      if (target.range.compareBoundaryPoints(Range.START_TO_START, currentRange) !== 0 ||
          target.range.compareBoundaryPoints(Range.END_TO_END, currentRange) !== 0) return null;
    } catch {
      return null;
    }

    const editorLabel = `${editor.innerText.slice(0, 300)} ${document.title}`;
    const comment = /\.py\b|python/i.test(editorLabel) ? "#" : "//";
    const marker = `${comment} Thinking…`;
    const insertionText = editorInsertionText(target.text, marker);
    const insertionRange = currentRange.cloneRange();
    insertionRange.collapse(false);
    selection.removeAllRanges();
    selection.addRange(insertionRange);
    if (!document.execCommand("insertText", false, insertionText)) return null;

    const markerLine = [...root.querySelectorAll(".cm-line")].find((line) => line.textContent === marker);
    return markerLine ? { selection: target, root, marker, markerLine } : null;
  }

  function finishContentEditableStatus(status, replacementText) {
    const { root, marker } = status || {};
    if (!root?.isConnected) return false;
    const markerLine = [...root.querySelectorAll(".cm-line")].find((line) => line.textContent === marker);
    if (!markerLine) return false;
    const range = document.createRange();
    range.selectNodeContents(markerLine);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const replacement = replacementText ? String(replacementText) : "";
    return document.execCommand("insertText", false, replacement);
  }

  function insertAfterEditableSelection(target, answerText) {
    if (!target?.element?.isConnected || !answerText) return false;
    if (target.type === "text-control") {
      const control = target.element;
      if (document.activeElement !== control || control.disabled || control.readOnly) return false;
      if (control.value.slice(target.start, target.end) !== target.text) return false;
      const suffix = control instanceof HTMLTextAreaElement
        ? editorInsertionText(target.text, answerText)
        : `  ${answerText}`;
      control.setRangeText(suffix, target.end, target.end, "end");
      dispatchInput(control, suffix);
      return true;
    }

    const root = target.element;
    if (!root.isContentEditable || !(document.activeElement === root || root.contains(document.activeElement))) return false;
    const range = target.range;
    if (!range?.startContainer?.isConnected || !range.endContainer?.isConnected || range.toString() !== target.text) return false;
    const currentSelection = window.getSelection();
    if (!currentSelection?.rangeCount) return false;
    const currentRange = currentSelection.getRangeAt(0);
    try {
      if (range.compareBoundaryPoints(Range.START_TO_START, currentRange) !== 0 ||
          range.compareBoundaryPoints(Range.END_TO_END, currentRange) !== 0) return false;
    } catch {
      return false;
    }

    // Collapse to the selection's end so the original highlighted text remains untouched.
    const insertionRange = currentRange.cloneRange();
    insertionRange.collapse(false);
    currentSelection.removeAllRanges();
    currentSelection.addRange(insertionRange);
    const insertionText = editorInsertionText(target.text, answerText);
    if (document.execCommand("insertText", false, insertionText)) return true;
    const inserted = document.createTextNode(insertionText);
    insertionRange.insertNode(inserted);
    insertionRange.setStartAfter(inserted);
    insertionRange.collapse(true);
    currentSelection.removeAllRanges();
    currentSelection.addRange(insertionRange);
    dispatchInput(root, insertionText);
    return true;
  }

  function editorInsertionText(selectedText, answerText) {
    const prefix = /[\r\n]$/.test(selectedText) ? "" : "\n";
    const suffix = /[\r\n]$/.test(answerText) ? "" : "\n";
    return `${prefix}${answerText}${suffix}`;
  }

  function dispatchInput(target, text) {
    let event;
    try {
      event = new InputEvent("input", { bubbles: true, inputType: "insertText", data: text });
    } catch {
      event = new Event("input", { bubbles: true });
    }
    target.dispatchEvent(event);
  }

  function makeInsertionPoint(selection) {
    if (!selection?.focusNode?.isConnected) return null;
    try {
      const range = document.createRange();
      range.setStart(selection.focusNode, selection.focusOffset);
      range.collapse(true);
      return range;
    } catch {
      return null;
    }
  }

  function findQuestionBlock(start) {
    const semanticBlocks = "p,li,td,th,blockquote,h1,h2,h3,h4,h5,h6";
    const blockTags = new Set(["P", "DIV", "LI", "TD", "TH", "BLOCKQUOTE", "SECTION", "ARTICLE", "H1", "H2", "H3", "H4", "H5", "H6"]);
    let current = start;
    let fallback = start;
    while (current && current !== document.body && current !== document.documentElement) {
      if (blockTags.has(current.tagName) || ["block", "list-item", "flex", "grid", "table"].includes(getComputedStyle(current).display)) {
        fallback = current;
        if (current.matches(semanticBlocks)) return current;
      }
      current = current.parentElement;
    }
    return fallback;
  }

  function ancestorRoots(anchor, maxDepth = 5) {
    const roots = [];
    let current = anchor;
    for (let depth = 0; current && current !== document.body && depth < maxDepth; depth += 1, current = current.parentElement) {
      if (current !== anchor) roots.push(current);
    }
    return roots;
  }

  function findRadioOptions(anchor) {
    for (const root of ancestorRoots(anchor)) {
      const native = findNativeInputGroup(root, 'input[type="radio"]', true);
      if (native.length >= 2) return stampOptions(native);

      const ariaRadios = findAriaOptions(root, '[role="radiogroup"]', '[role="radio"]');
      if (ariaRadios.length >= 2) return stampOptions(ariaRadios);

      const checkboxes = findNativeInputGroup(root, 'input[type="checkbox"]', false);
      if (checkboxes.length >= 2) return stampOptions(checkboxes);

      const ariaCheckboxes = findAriaOptions(root, '[role="group"],fieldset', '[role="checkbox"]');
      if (ariaCheckboxes.length >= 2) return stampOptions(ariaCheckboxes);

      const listboxOptions = findAriaOptions(root, '[role="listbox"]', '[role="option"]');
      if (listboxOptions.length >= 2) return stampOptions(listboxOptions);

      const letteredLists = [...root.querySelectorAll('ol[type="A"], ol[type="a"]')]
        .filter((list) => !list.closest(`[${OUTPUT_ATTR}]`));
      for (const list of letteredLists) {
        const items = [...list.children]
          .filter((child) => child.tagName === "LI")
          .slice(0, MAX_OPTIONS)
          .map((item, index) => ({
            id: String(index),
            text: (item.innerText || "").trim().replace(/\s+/g, " ").slice(0, 1000),
            element: item,
            hadId: false,
            previousId: null
          }))
          .filter((option) => option.text);
        if (items.length >= 2) return stampOptions(items);
      }
    }
    return [];
  }

  function findNativeInputGroup(root, selector, preferLargest) {
    const inputs = [...root.querySelectorAll(selector)]
      .filter((input) => !input.disabled && !input.closest(`[${OUTPUT_ATTR}]`));
    if (inputs.length < 2) return [];
    const groups = new Map();
    for (const input of inputs) {
      const form = input.form || root;
      const groupName = input.name || "";
      let byName = groups.get(form);
      if (!byName) groups.set(form, byName = new Map());
      const key = groupName || input.closest('fieldset,[role="radiogroup"],[role="group"]') || input.parentElement;
      let group = byName.get(key);
      if (!group) byName.set(key, group = []);
      group.push(input);
    }
    const candidates = [...groups.values()]
      .flatMap((byName) => [...byName.values()])
      .filter((items) => items.length >= 2);
    if (!candidates.length) return [];
    const chosen = preferLargest
      ? candidates.sort((left, right) => right.length - left.length)[0]
      : candidates[0];
    return chosen.slice(0, MAX_OPTIONS).map((input, index) => {
      const label = input.labels?.[0] || input.closest("label");
      const element = label || input.parentElement || input;
      return {
        id: String(index),
        text: radioText(input, element),
        element,
        input,
        hadId: false,
        previousId: null
      };
    }).filter((option) => option.text);
  }

  function findAriaOptions(root, containerSelector, itemSelector) {
    const containers = [...root.querySelectorAll(containerSelector)]
      .filter((container) => !container.closest(`[${OUTPUT_ATTR}]`));
    const searchPools = containers.length ? containers : [root];
    for (const pool of searchPools) {
      const items = [...pool.querySelectorAll(itemSelector)]
        .filter((el) => el.getAttribute("aria-disabled") !== "true" && !el.closest(`[${OUTPUT_ATTR}]`));
      if (items.length < 2) continue;
      const mapped = items.slice(0, MAX_OPTIONS).map((element, index) => {
        const text = (element.innerText || element.getAttribute("aria-label") || element.getAttribute("data-value") || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 1000);
        return {
          id: String(index),
          text,
          element,
          hadId: false,
          previousId: null
        };
      }).filter((option) => option.text);
      if (mapped.length >= 2) return mapped;
    }
    return [];
  }

  function findNearbyContextOptions(anchor) {
    const options = findRadioOptions(anchor);
    if (options.length >= 2) {
      const clean = options.map(({ id, text }) => ({ id, text }));
      restoreOptionAttributes(options);
      return clean;
    }
    return [];
  }

  function radioText(input, element) {
    const text = (element?.innerText || input.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
    if (text) return text.slice(0, 1000);
    const value = input.value?.trim();
    return value && value.toLowerCase() !== "on" ? value.slice(0, 1000) : "";
  }

  function stampOptions(options) {
    for (const option of options) {
      option.hadId = option.element.hasAttribute(OPTION_ATTR);
      option.previousId = option.element.getAttribute(OPTION_ATTR);
      option.element.setAttribute(OPTION_ATTR, option.id);
    }
    return options;
  }

  function restoreOptionAttributes(options) {
    for (const option of options) {
      if (!option.element?.isConnected) continue;
      if (option.hadId) option.element.setAttribute(OPTION_ATTR, option.previousId);
      else option.element.removeAttribute(OPTION_ATTR);
    }
  }

  const CONTAINER_TAGS = new Set([
    "DIV", "SECTION", "ARTICLE", "MAIN", "FORM", "FIELDSET",
    "FIGURE", "LI", "TD", "TH", "DD", "BLOCKQUOTE", "ASIDE", "DETAILS"
  ]);

  function isContainerElement(el) {
    return Boolean(el && el.nodeType === Node.ELEMENT_NODE && CONTAINER_TAGS.has(el.tagName));
  }

  function resolveCardContainer(anchor) {
    if (!anchor?.isConnected) return document.body;
    if (isContainerElement(anchor) && anchor !== document.body) return anchor;
    let current = anchor.parentElement;
    while (current && current !== document.documentElement) {
      if (isContainerElement(current)) return current;
      current = current.parentElement;
    }
    return document.body;
  }

  function commonCardAncestor(first, second) {
    if (!first?.isConnected || !second?.isConnected) return null;
    const ancestors = new Set();
    for (let cur = first; cur && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) {
      ancestors.add(cur);
    }
    for (let cur = second; cur && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) {
      if (ancestors.has(cur) && isContainerElement(cur)) return cur;
    }
    return null;
  }

  function isHorizontalNowrapFlex(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const style = getComputedStyle(el);
    return style.display.includes("flex") && style.flexDirection.startsWith("row") && style.flexWrap === "nowrap";
  }

  function placeNodeInsideContainer(container, node) {
    node.style.boxSizing = "border-box";
    node.style.display = "block";
    node.style.width = "100%";
    node.style.margin = "8px 0 0 0";
    node.style.padding = "4px 0";

    const target = container?.isConnected ? container : document.body;
    const style = getComputedStyle(target);

    if (style.display.includes("grid")) {
      node.style.gridColumn = "1 / -1";
      target.append(node);
      return;
    }

    if (style.display.includes("flex") && style.flexDirection.startsWith("row")) {
      if (style.flexWrap !== "nowrap") {
        node.style.flex = "0 0 100%";
        target.append(node);
        return;
      }
      // Walk up out of horizontal nowrap flex rows so the answer isn't squeezed sideways.
      let row = target;
      let parent = target.parentElement;
      while (parent && parent !== document.documentElement && isHorizontalNowrapFlex(parent)) {
        row = parent;
        parent = parent.parentElement;
      }
      if (parent && parent !== document.documentElement && row !== document.body) {
        const parentStyle = getComputedStyle(parent);
        if (parentStyle.display.includes("grid")) node.style.gridColumn = "1 / -1";
        else if (parentStyle.display.includes("flex") && parentStyle.flexDirection.startsWith("row")) {
          node.style.flex = "0 0 100%";
        }
        row.insertAdjacentElement("afterend", node);
        return;
      }
      applyStandaloneOverlayStyle(node);
      document.body.append(node);
      return;
    }

    target.append(node);
  }

  function parseRgba(colorStr) {
    const match = String(colorStr || "").match(/rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/i);
    if (!match) return null;
    return {
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3]),
      a: match[4] === undefined ? 1 : Number(match[4])
    };
  }

  function relativeLuminance(r, g, b) {
    const linear = [r, g, b].map((channel) => {
      const s = channel / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  }

  function contrastRatio(lumA, lumB) {
    const lighter = Math.max(lumA, lumB);
    const darker = Math.min(lumA, lumB);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function getEffectiveBackgroundColor(el) {
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE) {
      const parsed = parseRgba(getComputedStyle(cur).backgroundColor);
      if (parsed && parsed.a > 0.15) return parsed;
      cur = cur.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  function ensureReadableContrast(node) {
    if (!answerUsePageColor || !node?.isConnected) return;
    const fg = parseRgba(getComputedStyle(node).color);
    const bg = getEffectiveBackgroundColor(node.parentElement || document.body);
    if (!fg || !bg) return;
    const fgLum = relativeLuminance(fg.r, fg.g, fg.b);
    const bgLum = relativeLuminance(bg.r, bg.g, bg.b);
    if (contrastRatio(fgLum, bgLum) < 4.5) {
      node.style.color = bgLum < 0.4 ? "#f5f5f7" : "#1d1d1f";
    }
  }

  function insertPendingNode(anchor, text, label, insertionPoint = null, preferInsideContainer = false) {
    const node = document.createElement("div");
    node.setAttribute(OUTPUT_ATTR, "answer");
    node.setAttribute("role", "note");
    copyTextStyle(anchor, node, answerFontScale);
    applyAnswerColor(node);
    node.style.whiteSpace = "pre-wrap";
    node.style.display = "block";
    node.style.width = "100%";
    node.style.margin = "6px 0 0 0";
    node.style.cursor = "pointer";
    node.style.opacity = "0.85";
    node.textContent = `${label ? `${label}: ` : ""}${text}`;
    node.title = "Click to dismiss";
    node._answerlyPendingDismiss = () => node.remove();
    node.addEventListener("click", node._answerlyPendingDismiss, { once: true });

    let insertedAtSelection = false;
    if (!preferInsideContainer && insertionPoint?.startContainer?.isConnected) {
      try {
        const point = insertionPoint.cloneRange();
        point.collapse(true);
        point.insertNode(node);
        insertedAtSelection = true;
      } catch {
        // Fall back to the question container if the page changed the range.
      }
    }
    if (!insertedAtSelection) {
      placeNodeInsideContainer(resolveCardContainer(anchor), node);
    }
    ensureReadableContrast(node);
    return node;
  }

  function setStatusBannerText(node, text) {
    node.replaceChildren(document.createTextNode(text));
    node.setAttribute("aria-live", "polite");
    node.style.cursor = "pointer";
    node.style.userSelect = "none";
    if (!node._answerlyPendingDismiss) {
      node._answerlyPendingDismiss = () => node.remove();
      node.addEventListener("click", node._answerlyPendingDismiss, { once: true });
    }
  }

  function renderCompletedAnswer(node, text, label) {
    if (node._answerlyPendingDismiss) {
      node.removeEventListener("click", node._answerlyPendingDismiss);
      node._answerlyPendingDismiss = null;
    }
    node.replaceChildren();
    node.title = "";
    node.style.opacity = "0.92";
    node.style.cursor = "text";
    node.style.userSelect = "text";

    const fullText = `${label ? `${label}: ` : ""}${text}`;
    const textSpan = document.createElement("span");
    textSpan.textContent = fullText;

    const actions = document.createElement("span");
    actions.style.display = "inline-flex";
    actions.style.alignItems = "center";
    actions.style.gap = "4px";
    actions.style.marginLeft = "8px";
    actions.style.verticalAlign = "middle";
    actions.style.opacity = "0";
    actions.style.transition = "opacity 150ms ease";
    actions.style.userSelect = "none";

    const copyBtn = createInlineActionButton("Copy answer", makeCopySvg());
    const dismissBtn = createInlineActionButton("Dismiss answer", makeDismissSvg());

    copyBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const copied = await copyToClipboard(text);
      if (copied) {
        copyBtn.replaceChildren(makeCheckSvg());
        setTimeout(() => {
          if (copyBtn.isConnected) copyBtn.replaceChildren(makeCopySvg());
        }, 1400);
      }
    });
    dismissBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      node.remove();
    });

    const showActions = () => { actions.style.opacity = "0.8"; };
    const hideActions = () => { actions.style.opacity = "0"; };
    node.addEventListener("mouseenter", showActions);
    node.addEventListener("mouseleave", hideActions);
    node.addEventListener("focusin", showActions);
    node.addEventListener("focusout", hideActions);

    actions.append(copyBtn, dismissBtn);
    node.append(textSpan, actions);
  }

  function createInlineActionButton(label, svgEl) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", label);
    btn.title = label;
    btn.style.display = "inline-flex";
    btn.style.alignItems = "center";
    btn.style.justifyContent = "center";
    btn.style.width = "22px";
    btn.style.height = "22px";
    btn.style.padding = "0";
    btn.style.border = "none";
    btn.style.borderRadius = "4px";
    btn.style.background = "transparent";
    btn.style.color = "inherit";
    btn.style.cursor = "pointer";
    btn.style.opacity = "0.75";
    btn.append(svgEl);
    return btn;
  }

  function createSvg(paths) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "13");
    svg.setAttribute("height", "13");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.75");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of paths) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
      svg.append(el);
    }
    return svg;
  }

  function makeCopySvg() {
    return createSvg([
      ["rect", { x: "9", y: "9", width: "13", height: "13", rx: "2", ry: "2" }],
      ["path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }]
    ]);
  }

  function makeCheckSvg() {
    return createSvg([["polyline", { points: "20 6 9 17 4 12" }]]);
  }

  function makeDismissSvg() {
    return createSvg([
      ["line", { x1: "18", y1: "6", x2: "6", y2: "18" }],
      ["line", { x1: "6", y1: "6", x2: "18", y2: "18" }]
    ]);
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fall back to execCommand below.
    }
    try {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.append(helper);
      helper.select();
      const ok = document.execCommand("copy");
      helper.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function formatAnswer(result) {
    const answer = String(result.answer || "").trim();
    const explanationText = String(result.explanation || "").trim();
    const separator = explanationText
      ? (/[.!?:]$/.test(answer) || answer.includes("\n") ? " " : " — ")
      : "";
    const explanation = explanationText ? `${separator}${explanationText}` : "";
    const citations = Array.isArray(result.citations) && result.citations.length
      ? ` Sources: ${result.citations.map((source) => `${source.file} · ${source.location}`).join("; ")}.`
      : "";
    return `${answer}${explanation}${citations}`;
  }

  function copyTextStyle(source, target, fontScale = 1) {
    const style = getComputedStyle(source?.isConnected ? source : document.body);
    target.style.fontFamily = style.fontFamily;
    const computedSize = Number.parseFloat(style.fontSize);
    target.style.fontSize = Number.isFinite(computedSize) ? `${computedSize * fontScale}px` : style.fontSize;
    target.style.color = style.color;
    target.style.lineHeight = style.lineHeight;
    target.style.fontWeight = style.fontWeight;
    target.style.fontStyle = style.fontStyle;
  }

  function applyAnswerColor(node) {
    if (!answerUsePageColor && isValidHexColor(answerCustomColor)) node.style.color = answerCustomColor;
  }

  function isValidHexColor(value) {
    return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
  }

  function showPageMessage(message, anchor) {
    const node = insertPendingNode(findQuestionBlock(elementForNode(anchor) || document.body), message, "Answerly");
    setStatusBannerText(node, `Answerly: ${message} (click to dismiss)`);
  }
})();
