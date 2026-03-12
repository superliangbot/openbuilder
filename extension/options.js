/**
 * options.js — Settings page for the OpenBuilder extension
 *
 * Handles AI provider selection, API key storage, and behavior toggles.
 * Settings are stored in chrome.storage.sync (synced across devices).
 */

"use strict";

// ── DOM refs ─────────────────────────────────────────────────────────────

const aiProviderSelect = document.getElementById("aiProvider");
const claudeSection = document.getElementById("claudeSection");
const openaiSection = document.getElementById("openaiSection");
const claudeApiKeyInput = document.getElementById("claudeApiKey");
const openaiApiKeyInput = document.getElementById("openaiApiKey");
const toggleClaudeBtn = document.getElementById("toggleClaude");
const toggleOpenaiBtn = document.getElementById("toggleOpenai");
const autoCaptionCheckbox = document.getElementById("autoCaption");
const autoRecordCheckbox = document.getElementById("autoRecord");
const clearDataBtn = document.getElementById("clearDataBtn");
const saveBtn = document.getElementById("saveBtn");
const saveStatus = document.getElementById("saveStatus");

// ── Provider toggle ──────────────────────────────────────────────────────

aiProviderSelect.addEventListener("change", () => {
  const provider = aiProviderSelect.value;
  claudeSection.classList.toggle("hidden", provider !== "claude");
  openaiSection.classList.toggle("hidden", provider !== "openai");
});

// ── API key visibility toggles ───────────────────────────────────────────

function makeToggle(btn, input) {
  btn.addEventListener("click", () => {
    input.type = input.type === "password" ? "text" : "password";
  });
}

makeToggle(toggleClaudeBtn, claudeApiKeyInput);
makeToggle(toggleOpenaiBtn, openaiApiKeyInput);

// ── Load saved settings ──────────────────────────────────────────────────

async function loadSettings() {
  const settings = await chrome.storage.sync.get([
    "aiProvider",
    "claudeApiKey",
    "openaiApiKey",
    "autoCaption",
    "autoRecord",
  ]);

  aiProviderSelect.value = settings.aiProvider || "claude";
  claudeApiKeyInput.value = settings.claudeApiKey || "";
  openaiApiKeyInput.value = settings.openaiApiKey || "";
  autoCaptionCheckbox.checked = settings.autoCaption !== false; // default true
  autoRecordCheckbox.checked = settings.autoRecord || false;

  // Show correct API key section
  aiProviderSelect.dispatchEvent(new Event("change"));
}

// ── Save settings ────────────────────────────────────────────────────────

saveBtn.addEventListener("click", async () => {
  await chrome.storage.sync.set({
    aiProvider: aiProviderSelect.value,
    claudeApiKey: claudeApiKeyInput.value.trim(),
    openaiApiKey: openaiApiKeyInput.value.trim(),
    autoCaption: autoCaptionCheckbox.checked,
    autoRecord: autoRecordCheckbox.checked,
  });

  saveStatus.textContent = "Settings saved!";
  setTimeout(() => {
    saveStatus.textContent = "";
  }, 3000);
});

// ── Clear data ───────────────────────────────────────────────────────────

clearDataBtn.addEventListener("click", async () => {
  if (!confirm("This will delete all stored transcripts, reports, and meeting history. Continue?")) {
    return;
  }

  await chrome.storage.local.clear();
  saveStatus.textContent = "All meeting data cleared.";
  setTimeout(() => {
    saveStatus.textContent = "";
  }, 3000);
});

// ── Initialize ───────────────────────────────────────────────────────────

loadSettings();
