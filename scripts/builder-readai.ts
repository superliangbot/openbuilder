#!/usr/bin/env npx tsx
/**
 * builder-readai.ts — Read AI CLI commands
 *
 * Usage:
 *   npx openbuilder readai auth                     # Run OAuth flow
 *   npx openbuilder readai meetings                  # List recent meetings
 *   npx openbuilder readai meeting <id>              # Get full meeting data
 *   npx openbuilder readai live <id>                 # Get live meeting data
 *   npx openbuilder readai sync                      # Pull latest meeting, save + report
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { authorize, isAuthenticated } from "../src/readai/auth.js";
import {
  listMeetings,
  getMeeting,
  getLiveMeeting,
  type ReadAIMeetingDetail,
  type ReadAITranscriptEntry,
} from "../src/readai/client.js";
import { ensureDirs, TRANSCRIPTS_DIR, REPORTS_DIR } from "../src/utils/config.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`Read AI Integration — OpenBuilder

Usage:
  npx openbuilder readai auth                Run OAuth authorization flow
  npx openbuilder readai meetings            List recent meetings
  npx openbuilder readai meeting <id>        Get full meeting details
  npx openbuilder readai live <id>           Get live meeting data
  npx openbuilder readai sync                Pull latest meeting, save transcript & report

Options:
  --limit <n>       Number of meetings to list (default: 10)
  --start-date <d>  Start date filter (ISO format)
  --end-date <d>    End date filter (ISO format)
  --json            Output raw JSON instead of formatted text
  --help            Show this help`);
}

function requireAuth(): void {
  if (!isAuthenticated()) {
    console.error("Not authenticated with Read AI.");
    console.error("Run: npx openbuilder readai auth");
    process.exit(1);
  }
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function formatTimestamp(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatDuration(seconds?: number): string {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Convert Read AI transcript entries to OpenBuilder transcript format.
 *
 * Read AI format: { speaker, text, start_time }
 * OpenBuilder format: [HH:MM:SS] Speaker: text
 */
function formatTranscriptToOpenBuilder(entries: ReadAITranscriptEntry[]): string {
  return entries
    .map((entry) => {
      const time = entry.start_time
        ? new Date(entry.start_time).toLocaleTimeString("en-US", { hour12: false })
        : "00:00:00";
      const speaker = entry.speaker || "Unknown";
      return `[${time}] ${speaker}: ${entry.text}`;
    })
    .join("\n");
}

/**
 * Generate a simple markdown report from meeting detail.
 */
function generateReadAIReport(meeting: ReadAIMeetingDetail): string {
  const lines: string[] = [];
  const title = meeting.title || meeting.id;

  lines.push(`# Meeting Report: ${title}`);
  lines.push("");
  lines.push(`**Date:** ${formatTimestamp(meeting.start_time)}`);
  lines.push(`**Duration:** ${formatDuration(meeting.duration_seconds)}`);

  if (meeting.participants?.length) {
    lines.push(`**Participants:** ${meeting.participants.map((p) => p.name).join(", ")}`);
  }

  lines.push("");

  // Summary
  if (meeting.summary) {
    lines.push("## Summary");
    lines.push("");
    lines.push(meeting.summary);
    lines.push("");
  }

  // Chapters
  if (meeting.chapters?.length) {
    lines.push("## Chapters");
    lines.push("");
    for (const ch of meeting.chapters) {
      lines.push(`### ${ch.title}`);
      if (ch.summary) lines.push(ch.summary);
      lines.push("");
    }
  }

  // Action Items
  if (meeting.action_items?.length) {
    lines.push("## Action Items");
    lines.push("");
    for (const item of meeting.action_items) {
      const assignee = item.assignee ? ` (@${item.assignee})` : "";
      const status = item.status ? ` [${item.status}]` : "";
      lines.push(`- ${item.text}${assignee}${status}`);
    }
    lines.push("");
  }

  // Questions
  if (meeting.questions?.length) {
    lines.push("## Key Questions");
    lines.push("");
    for (const q of meeting.questions) {
      const status = q.answered ? "Answered" : "Open";
      lines.push(`- **[${status}]** ${q.text}`);
      if (q.answer) lines.push(`  > ${q.answer}`);
    }
    lines.push("");
  }

  // Topics
  if (meeting.topics?.length) {
    lines.push("## Topics");
    lines.push("");
    for (const t of meeting.topics) {
      const duration = t.duration_seconds ? ` (${formatDuration(t.duration_seconds)})` : "";
      lines.push(`- ${t.name}${duration}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("*Generated by OpenBuilder via Read AI*");

  return lines.join("\n");
}

// ── Subcommands ──────────────────────────────────────────────────────────

async function cmdAuth(): Promise<void> {
  await authorize();
}

async function cmdMeetings(args: string[]): Promise<void> {
  requireAuth();

  const limit = parseInt(getArg(args, "--limit") || "10", 10);
  const startDate = getArg(args, "--start-date");
  const endDate = getArg(args, "--end-date");
  const json = hasFlag(args, "--json");

  const result = await listMeetings({ limit, start_date: startDate, end_date: endDate });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.meetings?.length) {
    console.log("No meetings found.");
    return;
  }

  console.log(`Found ${result.meetings.length} meeting(s):\n`);
  for (const m of result.meetings) {
    const date = formatTimestamp(m.start_time);
    const title = m.title || "(untitled)";
    console.log(`  ${m.id}  ${date}  ${title}`);
  }
}

async function cmdMeeting(args: string[]): Promise<void> {
  requireAuth();

  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("Usage: npx openbuilder readai meeting <meeting-id>");
    process.exit(1);
  }

  const json = hasFlag(args, "--json");
  const meeting = await getMeeting(id);

  if (json) {
    console.log(JSON.stringify(meeting, null, 2));
    return;
  }

  // Formatted output
  console.log(`Meeting: ${meeting.title || meeting.id}`);
  console.log(`Date: ${formatTimestamp(meeting.start_time)}`);
  console.log(`Duration: ${formatDuration(meeting.duration_seconds)}`);

  if (meeting.participants?.length) {
    console.log(`Participants: ${meeting.participants.map((p) => p.name).join(", ")}`);
  }

  if (meeting.summary) {
    console.log(`\n--- Summary ---\n${meeting.summary}`);
  }

  if (meeting.action_items?.length) {
    console.log("\n--- Action Items ---");
    for (const item of meeting.action_items) {
      const assignee = item.assignee ? ` (${item.assignee})` : "";
      console.log(`  - ${item.text}${assignee}`);
    }
  }

  if (meeting.questions?.length) {
    console.log("\n--- Questions ---");
    for (const q of meeting.questions) {
      const status = q.answered ? "Answered" : "Open";
      console.log(`  [${status}] ${q.text}`);
    }
  }

  if (meeting.transcript?.length) {
    console.log(`\n--- Transcript (${meeting.transcript.length} entries) ---`);
    for (const entry of meeting.transcript.slice(0, 20)) {
      const speaker = entry.speaker || "Unknown";
      console.log(`  ${speaker}: ${entry.text}`);
    }
    if (meeting.transcript.length > 20) {
      console.log(`  ... and ${meeting.transcript.length - 20} more entries`);
    }
  }
}

async function cmdLive(args: string[]): Promise<void> {
  requireAuth();

  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("Usage: npx openbuilder readai live <meeting-id>");
    process.exit(1);
  }

  const json = hasFlag(args, "--json");
  const live = await getLiveMeeting(id);

  if (json) {
    console.log(JSON.stringify(live, null, 2));
    return;
  }

  console.log(`Live Meeting: ${live.id}`);
  console.log(`Status: ${live.status || "unknown"}`);

  if (live.chapters?.length) {
    console.log("\n--- Live Chapters ---");
    for (const ch of live.chapters) {
      console.log(`  ${ch.title}`);
      if (ch.summary) console.log(`    ${ch.summary}`);
    }
  }

  if (live.transcript?.length) {
    console.log(`\n--- Live Transcript (${live.transcript.length} entries) ---`);
    for (const entry of live.transcript) {
      const speaker = entry.speaker || "Unknown";
      console.log(`  ${speaker}: ${entry.text}`);
    }
  }
}

async function cmdSync(args: string[]): Promise<void> {
  requireAuth();
  ensureDirs();

  const json = hasFlag(args, "--json");

  console.log("Fetching latest meeting from Read AI...");
  const result = await listMeetings({ limit: 1 });

  if (!result.meetings?.length) {
    console.log("No meetings found in Read AI.");
    return;
  }

  const meetingMeta = result.meetings[0]!;
  console.log(`Latest meeting: ${meetingMeta.title || meetingMeta.id} (${formatTimestamp(meetingMeta.start_time)})`);

  console.log("Fetching full meeting data...");
  const meeting = await getMeeting(meetingMeta.id);

  if (json) {
    console.log(JSON.stringify(meeting, null, 2));
    return;
  }

  // Save transcript in OpenBuilder format
  if (meeting.transcript?.length) {
    const transcriptContent = formatTranscriptToOpenBuilder(meeting.transcript);
    const safeId = meeting.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
    const transcriptPath = `${TRANSCRIPTS_DIR}/readai-${safeId}.txt`;
    writeFileSync(transcriptPath, transcriptContent + "\n");
    console.log(`Transcript saved: ${transcriptPath}`);
  } else {
    console.log("No transcript data available for this meeting.");
  }

  // Generate and save report
  const report = generateReadAIReport(meeting);
  const safeId = meeting.id.replace(/[^a-zA-Z0-9_-]/g, "_");
  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = `${REPORTS_DIR}/readai-${safeId}-report.md`;
  writeFileSync(reportPath, report + "\n");
  console.log(`Report saved: ${reportPath}`);

  console.log("\n" + report);

  console.log(`\n[OPENBUILDER_REPORT] ${reportPath}`);
}

// ── Main routing ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];
  const subArgs = args.slice(1);

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return;
  }

  switch (subcommand) {
    case "auth":
      await cmdAuth();
      break;
    case "meetings":
      await cmdMeetings(subArgs);
      break;
    case "meeting":
      await cmdMeeting(subArgs);
      break;
    case "live":
      await cmdLive(subArgs);
      break;
    case "sync":
      await cmdSync(subArgs);
      break;
    case "poll": {
      // Delegate to the poll script
      const { execSync: execSyncPoll } = await import("node:child_process");
      const pollArgs = subArgs.join(" ");
      execSyncPoll(`npx tsx ${new URL("./builder-readai-poll.ts", import.meta.url).pathname} ${pollArgs}`, {
        stdio: "inherit",
        cwd: process.cwd(),
      });
      break;
    }
    default:
      console.error(`Unknown readai command: ${subcommand}\n`);
      printHelp();
      process.exit(1);
  }
}

const isMain = process.argv[1]?.endsWith("builder-readai.ts");
if (isMain) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
