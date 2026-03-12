#!/usr/bin/env npx tsx
/**
 * builder-readai-poll.ts — Auto-poll Read AI for new meetings
 *
 * Runs as a cron job or background daemon. Checks Read AI every interval
 * for new completed meetings, pulls transcripts, generates reports,
 * and sends notifications.
 *
 * Usage:
 *   npx openbuilder readai poll                    # Run once (for cron)
 *   npx openbuilder readai poll --daemon           # Run continuously
 *   npx openbuilder readai poll --interval 15      # Check every 15 min
 *   npx openbuilder readai poll --channel telegram --target 8493823957
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

import { isAuthenticated, getAccessToken } from "../src/readai/auth.js";
import {
  listMeetings,
  getMeeting,
  type ReadAIMeetingDetail,
  type ReadAITranscriptEntry,
  type ReadAIActionItem,
} from "../src/readai/client.js";

// ── Config ───────────────────────────────────────────────────────────────

const OPENBUILDER_DIR = join(homedir(), ".openbuilder");
const WORKSPACE_DIR = join(homedir(), ".openclaw", "workspace", "openbuilder");
const TRANSCRIPTS_DIR = join(WORKSPACE_DIR, "transcripts");
const REPORTS_DIR = join(WORKSPACE_DIR, "reports");
const POLL_STATE_FILE = join(OPENBUILDER_DIR, "readai-poll-state.json");

interface PollState {
  lastPollAt: string;
  processedMeetingIds: string[];
  totalProcessed: number;
}

function loadPollState(): PollState {
  if (existsSync(POLL_STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(POLL_STATE_FILE, "utf-8"));
    } catch {
      // Corrupted state — reset
    }
  }
  return {
    lastPollAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 24h ago
    processedMeetingIds: [],
    totalProcessed: 0,
  };
}

function savePollState(state: PollState): void {
  mkdirSync(OPENBUILDER_DIR, { recursive: true });
  writeFileSync(POLL_STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Helpers ──────────────────────────────────────────────────────────────

function sendMessage(opts: { channel?: string; target?: string; message: string }): void {
  if (opts.channel && opts.target) {
    try {
      const { exec: execAsync } = require("node:child_process");
      execAsync(
        `openclaw message send --channel ${opts.channel} --target ${JSON.stringify(opts.target)} --message ${JSON.stringify(opts.message)}`,
        { timeout: 30_000 },
        () => {},
      );
    } catch {
      // Best-effort
    }
  }
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTranscript(meeting: ReadAIMeetingDetail): string {
  if (!meeting.transcript?.length) return "";

  return meeting.transcript
    .map((entry: ReadAITranscriptEntry) => {
      const speaker = entry.speaker || "Unknown";
      const time = entry.start_time || "";
      const timeStr = time ? `[${time}] ` : "";
      return `${timeStr}${speaker}: ${entry.text}`;
    })
    .join("\n");
}

function generateMeetingDigest(meeting: ReadAIMeetingDetail): string {
  const lines: string[] = [];

  // Header
  const title = meeting.title || "Untitled Meeting";
  const date = meeting.start_time
    ? new Date(meeting.start_time).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Unknown date";
  const duration = meeting.duration_seconds
    ? formatDuration(meeting.duration_seconds)
    : "Unknown";
  const participantCount = meeting.participants?.length || 0;

  lines.push(`📋 **${title}**`);
  lines.push(`${date} • ${duration} • ${participantCount} participants`);
  lines.push("");

  // Summary
  if (meeting.summary) {
    lines.push(`**Summary:** ${meeting.summary}`);
    lines.push("");
  }

  // Action items
  if (meeting.action_items?.length) {
    lines.push("**Action Items:**");
    for (const item of meeting.action_items) {
      const assignee = item.assignee ? ` (${item.assignee})` : "";
      lines.push(`• ${item.text}${assignee}`);
    }
    lines.push("");
  }

  // Key topics
  if (meeting.topics?.length) {
    lines.push(`**Topics:** ${meeting.topics.map((t) => t.name).join(", ")}`);
    lines.push("");
  }

  // Speaker breakdown
  if (meeting.participants?.length) {
    const speakers = meeting.participants
      .filter((p) => p.talk_time_seconds && p.talk_time_seconds > 0)
      .sort((a, b) => (b.talk_time_seconds || 0) - (a.talk_time_seconds || 0));

    if (speakers.length) {
      lines.push("**Speakers:**");
      const totalTalk = speakers.reduce((sum, s) => sum + (s.talk_time_seconds || 0), 0);
      for (const s of speakers) {
        const pct = totalTalk > 0 ? Math.round(((s.talk_time_seconds || 0) / totalTalk) * 100) : 0;
        lines.push(`• ${s.name}: ${formatDuration(s.talk_time_seconds || 0)} (${pct}%)`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ── Main poll logic ──────────────────────────────────────────────────────

async function pollOnce(opts: {
  channel?: string;
  target?: string;
  verbose?: boolean;
}): Promise<number> {
  const state = loadPollState();
  const now = new Date();

  if (opts.verbose) {
    console.log(`Polling Read AI... (last poll: ${state.lastPollAt})`);
  }

  // Fetch meetings since last poll
  const response = await listMeetings({
    start_date: state.lastPollAt,
    end_date: now.toISOString(),
    limit: 50,
  });

  const meetings = response.meetings || [];
  if (opts.verbose) {
    console.log(`  Found ${meetings.length} meetings since last poll`);
  }

  // Filter out already-processed meetings
  const newMeetings = meetings.filter(
    (m) => !state.processedMeetingIds.includes(m.id),
  );

  if (newMeetings.length === 0) {
    if (opts.verbose) console.log("  No new meetings to process");
    state.lastPollAt = now.toISOString();
    savePollState(state);
    return 0;
  }

  console.log(`Processing ${newMeetings.length} new meeting(s)...`);

  let processed = 0;
  const digests: string[] = [];

  for (const meeting of newMeetings) {
    try {
      console.log(`  Fetching: ${meeting.title || meeting.id}`);
      const detail = await getMeeting(meeting.id);

      // Save transcript
      mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
      const transcriptText = formatTranscript(detail);
      if (transcriptText) {
        const transcriptFile = join(TRANSCRIPTS_DIR, `readai-${meeting.id}.txt`);
        writeFileSync(transcriptFile, transcriptText);
        console.log(`    Transcript → ${transcriptFile}`);
      }

      // Save full meeting data as JSON
      const dataFile = join(REPORTS_DIR, `readai-${meeting.id}-data.json`);
      mkdirSync(REPORTS_DIR, { recursive: true });
      writeFileSync(dataFile, JSON.stringify(detail, null, 2));

      // Generate digest
      const digest = generateMeetingDigest(detail);
      digests.push(digest);

      // Save report
      const reportFile = join(REPORTS_DIR, `readai-${meeting.id}-report.md`);
      writeFileSync(reportFile, `# Meeting Report: ${detail.title || meeting.id}\n\n${digest}`);
      console.log(`    Report → ${reportFile}`);

      // Mark as processed
      state.processedMeetingIds.push(meeting.id);
      state.totalProcessed++;
      processed++;
    } catch (err) {
      console.error(`  ❌ Failed to process ${meeting.id}:`, err instanceof Error ? err.message : String(err));
    }
  }

  // Keep only last 500 meeting IDs to prevent state file from growing forever
  if (state.processedMeetingIds.length > 500) {
    state.processedMeetingIds = state.processedMeetingIds.slice(-500);
  }

  state.lastPollAt = now.toISOString();
  savePollState(state);

  // Send notification with all digests
  if (digests.length > 0 && opts.channel && opts.target) {
    const header = digests.length === 1
      ? "🎤 **New meeting processed from Read AI:**\n\n"
      : `🎤 **${digests.length} new meetings processed from Read AI:**\n\n`;

    const fullMessage = header + digests.join("\n---\n\n");

    // Truncate if too long for Telegram (4096 char limit)
    const message = fullMessage.length > 4000
      ? fullMessage.slice(0, 3950) + "\n\n...(truncated, see full reports in workspace)"
      : fullMessage;

    sendMessage({ channel: opts.channel, target: opts.target, message });
  }

  return processed;
}

// ── CLI ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const daemon = args.includes("--daemon");
  const verbose = args.includes("--verbose") || args.includes("-v");
  const intervalIdx = args.indexOf("--interval");
  const intervalMin = intervalIdx !== -1 && args[intervalIdx + 1]
    ? parseInt(args[intervalIdx + 1], 10)
    : 15;
  const channelIdx = args.indexOf("--channel");
  const channel = channelIdx !== -1 ? args[channelIdx + 1] : undefined;
  const targetIdx = args.indexOf("--target");
  const target = targetIdx !== -1 ? args[targetIdx + 1] : undefined;

  // Check auth
  if (!await isAuthenticated()) {
    console.error("Not authenticated with Read AI. Run: npx openbuilder readai auth");
    process.exit(1);
  }

  const opts = { channel, target, verbose };

  if (daemon) {
    console.log(`Read AI auto-poll daemon started (every ${intervalMin} min)`);
    if (channel && target) {
      console.log(`  Notifications: ${channel} → ${target}`);
    }

    // Run immediately
    await pollOnce(opts);

    // Then on interval
    setInterval(async () => {
      try {
        await pollOnce(opts);
      } catch (err) {
        console.error("Poll error:", err instanceof Error ? err.message : String(err));
      }
    }, intervalMin * 60 * 1000);
  } else {
    // Single run (for cron)
    const count = await pollOnce(opts);
    console.log(`Done. Processed ${count} new meeting(s).`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
