/**
 * background.js — Service worker for the OpenBuilder Chrome extension
 *
 * Responsibilities:
 * - Receives caption data from content script
 * - Stores transcript in chrome.storage.local
 * - Manages tab audio capture via offscreen document
 * - Provides data to the popup
 * - Handles AI report generation
 */

"use strict";

// ── State ────────────────────────────────────────────────────────────────

let currentMeeting = null;  // { code, startTime, tabId }
let isRecordingAudio = false;

// ── Transcript storage helpers ───────────────────────────────────────────

async function getTranscript(meetingCode) {
  const key = `transcript_${meetingCode}`;
  const result = await chrome.storage.local.get(key);
  return result[key] || [];
}

async function addCaption(meetingCode, caption) {
  const key = `transcript_${meetingCode}`;
  const transcript = await getTranscript(meetingCode);
  transcript.push(caption);
  await chrome.storage.local.set({ [key]: transcript });

  // Update caption count for popup
  await chrome.storage.local.set({
    currentCaptionCount: transcript.length,
  });
}

async function getMeetingState() {
  const result = await chrome.storage.local.get([
    "currentMeeting",
    "currentCaptionCount",
    "isRecordingAudio",
  ]);
  return {
    meeting: result.currentMeeting || null,
    captionCount: result.currentCaptionCount || 0,
    isRecordingAudio: result.isRecordingAudio || false,
  };
}

// ── Meeting lifecycle ────────────────────────────────────────────────────

async function handleMeetingStarted(meetingCode, startTime, tabId) {
  currentMeeting = { code: meetingCode, startTime, tabId };

  await chrome.storage.local.set({
    currentMeeting: { code: meetingCode, startTime },
    currentCaptionCount: 0,
    isRecordingAudio: false,
  });

  // Add to meeting history
  const history = (await chrome.storage.local.get("meetingHistory")).meetingHistory || [];
  history.unshift({
    code: meetingCode,
    startTime,
    endTime: null,
    captionCount: 0,
  });
  // Keep last 50 meetings
  if (history.length > 50) history.length = 50;
  await chrome.storage.local.set({ meetingHistory: history });

  console.log(`[OpenBuilder] Meeting started: ${meetingCode}`);
}

async function handleMeetingEnded(meetingCode, endTime) {
  // Update meeting history
  const history = (await chrome.storage.local.get("meetingHistory")).meetingHistory || [];
  const entry = history.find((h) => h.code === meetingCode && !h.endTime);
  if (entry) {
    entry.endTime = endTime;
    entry.captionCount = (await chrome.storage.local.get("currentCaptionCount")).currentCaptionCount || 0;
    await chrome.storage.local.set({ meetingHistory: history });
  }

  // Stop audio recording if active
  if (isRecordingAudio) {
    await stopAudioCapture();
  }

  await chrome.storage.local.set({
    currentMeeting: null,
    isRecordingAudio: false,
  });

  currentMeeting = null;
  console.log(`[OpenBuilder] Meeting ended: ${meetingCode}`);
}

// ── Audio capture via offscreen document ─────────────────────────────────

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Recording tab audio for meeting transcript",
  });
}

async function startAudioCapture(tabId) {
  if (isRecordingAudio) return;

  try {
    // Get a media stream ID for the tab
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    });

    await ensureOffscreenDocument();

    // Tell offscreen document to start recording
    chrome.runtime.sendMessage({
      type: "startRecording",
      target: "offscreen",
      streamId,
    });

    isRecordingAudio = true;
    await chrome.storage.local.set({ isRecordingAudio: true });
    console.log("[OpenBuilder] Audio capture started");
  } catch (err) {
    console.error("[OpenBuilder] Failed to start audio capture:", err);
  }
}

async function stopAudioCapture() {
  if (!isRecordingAudio) return;

  try {
    chrome.runtime.sendMessage({
      type: "stopRecording",
      target: "offscreen",
    });
  } catch (e) {
    // Offscreen document may already be closed
  }

  isRecordingAudio = false;
  await chrome.storage.local.set({ isRecordingAudio: false });
  console.log("[OpenBuilder] Audio capture stopped");
}

// ── AI report generation ─────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are an expert meeting analyst. You analyze meeting transcripts and produce structured, actionable meeting intelligence. Be concise but thorough. Focus on what matters most.";

function getMeetingAnalysisPrompt(transcript, chunkInfo) {
  const chunkNote = chunkInfo
    ? `\n\nNOTE: This is ${chunkInfo} of a longer meeting. Analyze this portion thoroughly.`
    : "";

  return `Analyze this meeting transcript and return a JSON object with the following structure. Be thorough but concise.${chunkNote}

Return ONLY valid JSON — no markdown fences, no explanation before or after.

{
  "summary": "2-3 paragraph summary covering the main topics discussed, key outcomes, and overall meeting flow",
  "chapters": [
    { "timestamp": "HH:MM", "title": "Topic name", "description": "Brief description of what was discussed" }
  ],
  "actionItems": [
    { "description": "What needs to be done", "assignee": "Person name or null if unspecified" }
  ],
  "keyDecisions": [
    "Decision that was made"
  ],
  "keyQuestions": [
    { "question": "Question that was asked", "status": "answered or unanswered" }
  ]
}

Guidelines:
- For chapters: Group discussion into logical topic segments with approximate timestamps
- For action items: Look for commitments, tasks, follow-ups. Detect assignees from context (e.g. "Alice will..." → assignee: "Alice")
- For key decisions: Only include explicit decisions, not suggestions or ideas
- For key questions: Include important questions raised. Mark as "answered" if the transcript shows a response
- Use the speaker names exactly as they appear in the transcript
- Timestamps should use HH:MM format from the transcript

TRANSCRIPT:
${transcript}`;
}

function getQuickSummaryPrompt(transcript) {
  return `Summarize this meeting transcript in 3-5 paragraphs. Focus on:
1. What was discussed (main topics)
2. Key outcomes or decisions
3. Action items or next steps mentioned

Write in clear, professional prose. Use the speaker names from the transcript.

TRANSCRIPT:
${transcript}`;
}

async function callClaudeAPI(apiKey, systemPrompt, userPrompt) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

async function callOpenAIAPI(apiKey, systemPrompt, userPrompt) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function generateReport(meetingCode) {
  const transcript = await getTranscript(meetingCode);
  if (!transcript.length) throw new Error("No transcript data available");

  // Build transcript text
  const transcriptText = transcript
    .map((c) => `[${c.timestamp}] ${c.speaker}: ${c.text}`)
    .join("\n");

  // Get settings
  const settings = await chrome.storage.sync.get([
    "aiProvider",
    "claudeApiKey",
    "openaiApiKey",
  ]);

  const provider = settings.aiProvider || "claude";
  const prompt = getMeetingAnalysisPrompt(transcriptText);

  let rawResponse;
  if (provider === "claude") {
    if (!settings.claudeApiKey) throw new Error("Claude API key not configured. Go to extension settings.");
    rawResponse = await callClaudeAPI(settings.claudeApiKey, SYSTEM_PROMPT, prompt);
  } else {
    if (!settings.openaiApiKey) throw new Error("OpenAI API key not configured. Go to extension settings.");
    rawResponse = await callOpenAIAPI(settings.openaiApiKey, SYSTEM_PROMPT, prompt);
  }

  // Parse JSON response
  let analysis;
  try {
    let cleaned = rawResponse.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    analysis = JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Failed to parse AI response as JSON. Raw: " + rawResponse.slice(0, 200));
  }

  // Calculate speaker analytics
  const speakerMap = {};
  for (const c of transcript) {
    if (!speakerMap[c.speaker]) {
      speakerMap[c.speaker] = { words: 0, lines: 0 };
    }
    speakerMap[c.speaker].words += c.text.split(/\s+/).length;
    speakerMap[c.speaker].lines += 1;
  }
  const totalWords = Object.values(speakerMap).reduce((sum, s) => sum + s.words, 0);

  // Format markdown report (mirrors src/report/generator.ts)
  const date = new Date().toISOString().split("T")[0];
  const lines = [];

  lines.push(`# Meeting Report: ${meetingCode} — ${date}`);
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push(analysis.summary || "(No summary generated)");
  lines.push("");

  // Chapters
  if (analysis.chapters && analysis.chapters.length > 0) {
    lines.push("## Chapters");
    lines.push("");
    analysis.chapters.forEach((ch, i) => {
      lines.push(`${i + 1}. [${ch.timestamp}] ${ch.title} — ${ch.description}`);
    });
    lines.push("");
  }

  // Action Items
  if (analysis.actionItems && analysis.actionItems.length > 0) {
    lines.push("## Action Items");
    lines.push("");
    for (const item of analysis.actionItems) {
      const assignee = item.assignee ? ` (@${item.assignee})` : "";
      lines.push(`- [ ] ${item.description}${assignee}`);
    }
    lines.push("");
  }

  // Key Decisions
  if (analysis.keyDecisions && analysis.keyDecisions.length > 0) {
    lines.push("## Key Decisions");
    lines.push("");
    for (const d of analysis.keyDecisions) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }

  // Key Questions
  if (analysis.keyQuestions && analysis.keyQuestions.length > 0) {
    lines.push("## Key Questions");
    lines.push("");
    for (const q of analysis.keyQuestions) {
      lines.push(`- ${q.question} (${q.status})`);
    }
    lines.push("");
  }

  // Speaker Analytics
  const speakers = Object.entries(speakerMap);
  if (speakers.length > 0) {
    lines.push("## Speaker Analytics");
    lines.push("");
    lines.push("| Speaker | Words | % of Meeting |");
    lines.push("|---------|-------|--------------|");
    for (const [name, stats] of speakers) {
      const pct = totalWords > 0 ? Math.round((stats.words / totalWords) * 100) : 0;
      lines.push(`| ${name} | ${stats.words.toLocaleString()} | ${pct}% |`);
    }
    lines.push("");
  }

  // Metadata
  lines.push("## Metadata");
  lines.push("");
  lines.push(`- Participants: ${speakers.length}`);
  lines.push(`- Captions captured: ${transcript.length}`);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Powered by: OpenBuilder`);
  lines.push("");

  const report = lines.join("\n");

  // Save report
  const reportKey = `report_${meetingCode}`;
  await chrome.storage.local.set({
    [reportKey]: { report, analysis, date, meetingCode },
    lastReport: { report, meetingCode, date },
  });

  return report;
}

// ── Message handling ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Route messages meant for offscreen document
  if (msg.target === "offscreen") return false;

  if (msg.type === "caption") {
    addCaption(msg.meetingCode, {
      speaker: msg.speaker,
      text: msg.text,
      timestamp: msg.timestamp,
      capturedAt: Date.now(),
    });
    return false;
  }

  if (msg.type === "meetingStarted") {
    const tabId = sender.tab ? sender.tab.id : null;
    handleMeetingStarted(msg.meetingCode, msg.startTime, tabId);
    return false;
  }

  if (msg.type === "meetingEnded") {
    handleMeetingEnded(msg.meetingCode, msg.endTime);
    return false;
  }

  if (msg.type === "getMeetingState") {
    getMeetingState().then(sendResponse);
    return true; // async
  }

  if (msg.type === "getTranscript") {
    getTranscript(msg.meetingCode).then(sendResponse);
    return true;
  }

  if (msg.type === "generateReport") {
    generateReport(msg.meetingCode)
      .then((report) => sendResponse({ ok: true, report }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "startAudio") {
    if (currentMeeting && currentMeeting.tabId) {
      startAudioCapture(currentMeeting.tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
    } else {
      sendResponse({ ok: false, error: "No active meeting tab" });
    }
    return true;
  }

  if (msg.type === "stopAudio") {
    stopAudioCapture()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "getMeetingHistory") {
    chrome.storage.local.get("meetingHistory").then((result) => {
      sendResponse(result.meetingHistory || []);
    });
    return true;
  }

  if (msg.type === "audioChunk") {
    // Audio chunk from offscreen document — store it
    const key = `audio_${currentMeeting ? currentMeeting.code : "unknown"}`;
    chrome.storage.local.get(key).then((result) => {
      const chunks = result[key] || [];
      chunks.push(msg.data);
      chrome.storage.local.set({ [key]: chunks });
    });
    return false;
  }

  return false;
});

// ── Initialization ───────────────────────────────────────────────────────

console.log("[OpenBuilder] Background service worker loaded");
