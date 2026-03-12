/**
 * content.js — Content script injected into meet.google.com
 *
 * Detects active meetings, auto-enables captions, scrapes caption text
 * from the DOM via MutationObserver, deduplicates the accumulating
 * Google Meet CC buffer, and forwards clean caption data to the
 * background service worker.
 */

(function () {
  "use strict";

  // ── Constants ──────────────────────────────────────────────────────────

  // Google Meet class selectors for speaker badges inside caption elements
  const BADGE_SEL = ".NWpY1d, .xoMHSc";

  // How long a caption must be idle before we "settle" (finalize) it
  const SETTLE_MS = 5000;

  // Poll interval (ms) for checking meeting state & enabling captions
  const POLL_MS = 3000;

  // ── State ──────────────────────────────────────────────────────────────

  let isInMeeting = false;
  let observerActive = false;
  let captionObserver = null;
  let captionContainer = null;
  let meetingStartTime = null;
  let meetingCode = null;
  let pollTimer = null;
  let settleTimer = null;

  // Caption deduplication tracking (mirrors the bot's approach)
  const tracking = new Map();   // speaker → { text, ts, startTs }
  const lastWritten = new Map(); // speaker → last finalized text

  // ── Utilities ──────────────────────────────────────────────────────────

  function normalizeForCompare(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function formatTimestamp(date) {
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  /** Extract the meeting code from the URL (e.g. abc-defg-hij). */
  function getMeetingCode() {
    const match = location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
    return match ? match[1] : null;
  }

  // ── Caption extraction helpers (same as the bot) ───────────────────────

  function getSpeaker(node) {
    if (!node || !node.querySelector) return "";
    const badge = node.querySelector(BADGE_SEL);
    return badge ? badge.textContent.trim() : "";
  }

  function getText(node) {
    if (!node || !node.cloneNode) return "";
    const clone = node.cloneNode(true);
    const badges = clone.querySelectorAll ? clone.querySelectorAll(BADGE_SEL) : [];
    for (const b of badges) b.remove();
    const imgs = clone.querySelectorAll ? clone.querySelectorAll("img") : [];
    for (const img of imgs) img.remove();
    return clone.textContent.trim();
  }

  // ── Caption deduplication ──────────────────────────────────────────────

  function finalizeCaption(speaker, text, startTs) {
    const prevWritten = lastWritten.get(speaker) || "";
    const normNew = normalizeForCompare(text);
    const normPrev = normalizeForCompare(prevWritten);

    // Skip if identical or trivially different
    if (
      normPrev &&
      (normNew === normPrev ||
        normPrev.startsWith(normNew) ||
        (normNew.startsWith(normPrev) && normNew.length - normPrev.length < 3))
    ) {
      return;
    }

    // Extract only NEW text from the accumulating buffer
    let textToWrite = text;
    if (prevWritten && text.startsWith(prevWritten)) {
      textToWrite = text.slice(prevWritten.length).replace(/^[\s,.!?;:]+/, "").trim();
      if (!textToWrite) return;
    } else if (prevWritten) {
      const prevWords = normPrev.split(/\s+/);
      const newWords = normNew.split(/\s+/);
      let commonLen = 0;
      for (let i = 0; i < Math.min(prevWords.length, newWords.length); i++) {
        if (prevWords[i] === newWords[i]) commonLen = i + 1;
        else break;
      }
      if (commonLen > 0 && commonLen >= prevWords.length * 0.8) {
        const newPart = newWords.slice(commonLen).join(" ").trim();
        if (newPart) textToWrite = newPart;
      }
    }

    lastWritten.set(speaker, text);

    const timestamp = formatTimestamp(new Date(startTs));

    // Send to background service worker
    chrome.runtime.sendMessage({
      type: "caption",
      speaker,
      text: textToWrite,
      timestamp,
      meetingCode,
    });
  }

  function handleCaption(speaker, text) {
    const prevWritten = lastWritten.get(speaker) || "";
    const normNew = normalizeForCompare(text);
    const normWritten = normalizeForCompare(prevWritten);

    // Already written — skip
    if (normWritten && (normNew === normWritten || normWritten.startsWith(normNew))) {
      return;
    }

    const existing = tracking.get(speaker);

    if (existing) {
      const normOld = normalizeForCompare(existing.text);

      // Check if the caption buffer is growing (Google Meet accumulates text)
      const isGrowing =
        normNew.startsWith(normOld) ||
        normOld.startsWith(normNew) ||
        (normNew.length > normOld.length &&
          normNew.includes(normOld.slice(0, Math.min(20, normOld.length))));

      if (isGrowing) {
        if (text.length >= existing.text.length) {
          existing.text = text;
          existing.ts = Date.now();
        }
        return;
      }

      // New sentence from the same speaker — finalize previous
      finalizeCaption(speaker, existing.text, existing.startTs);
    }

    tracking.set(speaker, { text, ts: Date.now(), startTs: Date.now() });
  }

  /** Called periodically to finalize captions that stopped growing. */
  function settleStale() {
    const now = Date.now();
    for (const [speaker, data] of tracking.entries()) {
      if (now - data.ts >= SETTLE_MS) {
        finalizeCaption(speaker, data.text, data.startTs);
        tracking.delete(speaker);
      }
    }
  }

  // ── MutationObserver for caption DOM changes ───────────────────────────

  function processCaptionNode(node) {
    if (!(node instanceof HTMLElement)) return;

    let el = node;
    let speaker = "";
    for (let depth = 0; depth < 6 && el && el !== document.body; depth++) {
      speaker = getSpeaker(el);
      if (speaker) break;
      el = el.parentElement;
    }

    if (!speaker || !el) return;

    const text = getText(el);
    if (!text || text.length > 500) return;

    // Filter out UI icon text
    if (/^(mic_off|videocam|call_end|more_vert|keyboard|arrow_)/i.test(text)) return;
    if (text.indexOf("extension") !== -1 && text.indexOf("developers.google") !== -1) return;

    handleCaption(speaker, text);
  }

  function startCaptionObserver() {
    if (observerActive) return;

    captionObserver = new MutationObserver((mutations) => {
      // Re-acquire container if it disappeared
      if (!captionContainer || !document.contains(captionContainer)) {
        captionContainer =
          document.querySelector('[aria-label="Captions"]') ||
          document.querySelector('[role="region"][aria-label*="Captions"]') ||
          document.querySelector("[aria-live]");
      }

      for (const m of mutations) {
        if (captionContainer && !captionContainer.contains(m.target)) continue;

        for (const added of m.addedNodes) {
          if (added instanceof HTMLElement) processCaptionNode(added);
        }

        if (m.type === "characterData" && m.target && m.target.parentElement) {
          processCaptionNode(m.target.parentElement);
        }
      }
    });

    captionObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    // Periodically settle stale captions
    settleTimer = setInterval(settleStale, 1000);

    observerActive = true;
    console.log("[OpenBuilder] Caption observer active");
  }

  function stopCaptionObserver() {
    if (captionObserver) {
      captionObserver.disconnect();
      captionObserver = null;
    }
    if (settleTimer) {
      clearInterval(settleTimer);
      settleTimer = null;
    }

    // Finalize any remaining tracked captions
    for (const [speaker, data] of tracking.entries()) {
      finalizeCaption(speaker, data.text, data.startTs);
    }
    tracking.clear();

    observerActive = false;
    captionContainer = null;
  }

  // ── Meeting detection ──────────────────────────────────────────────────

  /** Check whether the user is currently in a meeting. */
  function detectMeeting() {
    // The leave/end-call button is a reliable indicator
    const leaveBtn =
      document.querySelector('[aria-label="Leave call"]') ||
      document.querySelector('button[data-tooltip="Leave call"]') ||
      document.querySelector('[aria-label="Leave the call"]');

    return !!leaveBtn;
  }

  /** Try to auto-enable captions by clicking the CC button. */
  function enableCaptions() {
    // Check if captions are already on
    const alreadyOn =
      document.querySelector('[role="region"][aria-label*="Captions"]') ||
      document.querySelector('[aria-label="Captions are on"]') ||
      document.querySelector('button[aria-label*="Turn off captions" i]') ||
      document.querySelector("[data-is-persistent-caption]") ||
      document.querySelector("[jscontroller][data-caption-id]");
    if (alreadyOn) return true;

    // Method 1: Click the CC button by aria-label
    const ccBtn =
      document.querySelector('button[aria-label*="Turn on captions" i]') ||
      document.querySelector('button[aria-label*="captions" i][aria-pressed="false"]') ||
      document.querySelector('[data-tooltip*="captions" i]') ||
      document.querySelector('[data-icon="closed_caption"]');

    if (ccBtn) {
      ccBtn.click();
      console.log("[OpenBuilder] Clicked CC button to enable captions");
      return true;
    }

    // Method 2: Keyboard shortcut — 'c' toggles captions in Google Meet
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "c", code: "KeyC", bubbles: true }));
      console.log("[OpenBuilder] Sent 'c' key to toggle captions");
    } catch (e) {
      // Ignored
    }

    return false;
  }

  // ── Main poll loop ─────────────────────────────────────────────────────

  function poll() {
    const inMeeting = detectMeeting();

    if (inMeeting && !isInMeeting) {
      // Just entered a meeting
      isInMeeting = true;
      meetingStartTime = Date.now();
      meetingCode = getMeetingCode();

      console.log(`[OpenBuilder] Meeting detected: ${meetingCode}`);

      chrome.runtime.sendMessage({
        type: "meetingStarted",
        meetingCode,
        startTime: meetingStartTime,
      });

      // Auto-enable captions after a short delay (UI needs to settle)
      setTimeout(() => {
        enableCaptions();
        startCaptionObserver();
      }, 2000);

      // Retry caption enabling a few more times
      setTimeout(() => enableCaptions(), 5000);
      setTimeout(() => enableCaptions(), 10000);
    }

    if (!inMeeting && isInMeeting) {
      // Meeting ended
      console.log("[OpenBuilder] Meeting ended");
      stopCaptionObserver();

      chrome.runtime.sendMessage({
        type: "meetingEnded",
        meetingCode,
        endTime: Date.now(),
        startTime: meetingStartTime,
      });

      isInMeeting = false;
      meetingStartTime = null;
      meetingCode = null;
      lastWritten.clear();
    }
  }

  // ── Listen for messages from popup / background ────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "getStatus") {
      sendResponse({
        isInMeeting,
        meetingCode,
        meetingStartTime,
        observerActive,
      });
      return true;
    }

    if (msg.type === "enableCaptions") {
      enableCaptions();
      startCaptionObserver();
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });

  // ── Initialize ─────────────────────────────────────────────────────────

  console.log("[OpenBuilder] Content script loaded on", location.href);
  pollTimer = setInterval(poll, POLL_MS);

  // Run an immediate check
  setTimeout(poll, 1000);
})();
