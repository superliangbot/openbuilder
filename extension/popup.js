/**
 * popup.js — Extension popup logic
 *
 * Shows meeting status, caption count, and controls for recording,
 * transcript copying, and AI report generation. Updates in real-time.
 */

"use strict";

// ── DOM refs ─────────────────────────────────────────────────────────────

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const meetingInfo = document.getElementById("meetingInfo");
const meetingCodeEl = document.getElementById("meetingCode");
const durationEl = document.getElementById("duration");
const captionCountEl = document.getElementById("captionCount");

const audioBtn = document.getElementById("audioBtn");
const audioBtnText = document.getElementById("audioBtnText");
const copyBtn = document.getElementById("copyBtn");
const reportBtn = document.getElementById("reportBtn");

const reportSection = document.getElementById("reportSection");
const reportPreview = document.getElementById("reportPreview");
const openReportBtn = document.getElementById("openReportBtn");

const loading = document.getElementById("loading");
const loadingText = document.getElementById("loadingText");
const toast = document.getElementById("toast");

const settingsBtn = document.getElementById("settingsBtn");

// ── State ────────────────────────────────────────────────────────────────

let state = {
  meeting: null,
  captionCount: 0,
  isRecordingAudio: false,
};

let durationTimer = null;

// ── Helpers ──────────────────────────────────────────────────────────────

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function showToast(message, type = "success") {
  toast.textContent = message;
  toast.className = `toast ${type}`;
  setTimeout(() => {
    toast.classList.add("hidden");
  }, 3000);
}

function showLoading(text) {
  loadingText.textContent = text;
  loading.classList.remove("hidden");
}

function hideLoading() {
  loading.classList.add("hidden");
}

// ── UI update ────────────────────────────────────────────────────────────

function updateUI() {
  const inMeeting = !!state.meeting;

  if (inMeeting) {
    meetingInfo.classList.remove("hidden");
    meetingCodeEl.textContent = state.meeting.code || "—";
    captionCountEl.textContent = state.captionCount.toLocaleString();

    if (state.isRecordingAudio) {
      statusDot.className = "status-dot recording";
      statusText.textContent = "Recording";
      audioBtnText.textContent = "Stop Audio Recording";
      audioBtn.className = "btn btn-danger";
    } else {
      statusDot.className = "status-dot active";
      statusText.textContent = "In meeting — capturing captions";
      audioBtnText.textContent = "Start Audio Recording";
      audioBtn.className = "btn btn-primary";
    }

    audioBtn.disabled = false;
    copyBtn.disabled = state.captionCount === 0;
    reportBtn.disabled = state.captionCount === 0;
  } else {
    statusDot.className = "status-dot idle";
    statusText.textContent = "Not in a meeting";
    meetingInfo.classList.add("hidden");

    audioBtn.disabled = true;
    audioBtnText.textContent = "Start Audio Recording";
    audioBtn.className = "btn btn-primary";

    // Still allow copy/report if there's a previous meeting
    copyBtn.disabled = true;
    reportBtn.disabled = true;
  }
}

function updateDuration() {
  if (state.meeting && state.meeting.startTime) {
    const elapsed = Date.now() - state.meeting.startTime;
    durationEl.textContent = formatDuration(elapsed);
  }
}

// ── Data fetching ────────────────────────────────────────────────────────

async function refreshState() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "getMeetingState" });
    state.meeting = result.meeting;
    state.captionCount = result.captionCount;
    state.isRecordingAudio = result.isRecordingAudio;
    updateUI();
  } catch (e) {
    // Extension context may be invalidated
    console.warn("[OpenBuilder] Failed to get state:", e);
  }
}

// ── Event handlers ───────────────────────────────────────────────────────

audioBtn.addEventListener("click", async () => {
  const msgType = state.isRecordingAudio ? "stopAudio" : "startAudio";
  const result = await chrome.runtime.sendMessage({ type: msgType });
  if (result && !result.ok) {
    showToast(result.error || "Failed", "error");
  }
  await refreshState();
});

copyBtn.addEventListener("click", async () => {
  if (!state.meeting) return;

  const transcript = await chrome.runtime.sendMessage({
    type: "getTranscript",
    meetingCode: state.meeting.code,
  });

  if (!transcript || transcript.length === 0) {
    showToast("No transcript data", "error");
    return;
  }

  const text = transcript
    .map((c) => `[${c.timestamp}] ${c.speaker}: ${c.text}`)
    .join("\n");

  try {
    await navigator.clipboard.writeText(text);
    showToast("Transcript copied to clipboard");
  } catch (e) {
    showToast("Failed to copy: " + e.message, "error");
  }
});

reportBtn.addEventListener("click", async () => {
  if (!state.meeting) return;

  showLoading("Generating report...");

  try {
    const result = await chrome.runtime.sendMessage({
      type: "generateReport",
      meetingCode: state.meeting.code,
    });

    hideLoading();

    if (result.ok) {
      showToast("Report generated!");
      loadLastReport();
    } else {
      showToast(result.error || "Report generation failed", "error");
    }
  } catch (e) {
    hideLoading();
    showToast("Error: " + e.message, "error");
  }
});

openReportBtn.addEventListener("click", async () => {
  const result = await chrome.storage.local.get("lastReport");
  if (result.lastReport) {
    // Open report in a new tab using a data URL
    const html = markdownToHtml(result.lastReport.report);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    chrome.tabs.create({ url });
  }
});

settingsBtn.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ── Load last report ─────────────────────────────────────────────────────

async function loadLastReport() {
  const result = await chrome.storage.local.get("lastReport");
  if (result.lastReport) {
    reportSection.classList.remove("hidden");
    // Show first ~200 chars of the summary
    const lines = result.lastReport.report.split("\n");
    const summaryStart = lines.findIndex((l) => l.startsWith("## Summary"));
    if (summaryStart >= 0) {
      const preview = lines
        .slice(summaryStart + 2, summaryStart + 6)
        .join("\n")
        .slice(0, 200);
      reportPreview.textContent = preview + (preview.length >= 200 ? "..." : "");
    } else {
      reportPreview.textContent = result.lastReport.report.slice(0, 200) + "...";
    }
  }
}

// ── Simple markdown → HTML for report viewing ────────────────────────────

function markdownToHtml(md) {
  let html = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Headers
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Tables
  html = html.replace(/^\|(.+)\|$/gm, (match) => {
    const cells = match
      .split("|")
      .filter((c) => c.trim())
      .map((c) => c.trim());
    if (cells.every((c) => /^[-:]+$/.test(c))) return "";
    const tag = "td";
    return "<tr>" + cells.map((c) => `<${tag}>${c}</${tag}>`).join("") + "</tr>";
  });

  // Checkboxes
  html = html.replace(/^- \[ \] (.+)$/gm, '<label><input type="checkbox"> $1</label><br>');
  html = html.replace(/^- \[x\] (.+)$/gm, '<label><input type="checkbox" checked> $1</label><br>');

  // List items
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

  // Paragraphs (double newlines)
  html = html.replace(/\n\n/g, "</p><p>");

  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<title>Meeting Report — OpenBuilder</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #1e293b; line-height: 1.6; }
  h1 { border-bottom: 2px solid #0891b2; padding-bottom: 8px; }
  h2 { color: #0891b2; margin-top: 24px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  td, th { border: 1px solid #e2e8f0; padding: 8px 12px; text-align: left; }
  tr:nth-child(even) { background: #f8fafc; }
  li { margin: 4px 0; }
  label { display: block; margin: 4px 0; }
  code { background: #f1f5f9; padding: 2px 4px; border-radius: 4px; }
</style>
</head><body><p>${html}</p></body></html>`;
}

// ── Initialize ───────────────────────────────────────────────────────────

refreshState();
loadLastReport();

// Poll for updates every 2 seconds
setInterval(() => {
  refreshState();
  updateDuration();
}, 2000);
