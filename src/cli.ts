#!/usr/bin/env node
/**
 * cli.ts — OpenBuilder CLI for meeting intelligence database.
 *
 * Usage: npx tsx src/cli.ts <command> [options]
 */

import { openDb, initSchema, getDbPath } from "./db/schema.js";
import { ingestAllFromDirectory } from "./db/ingest.js";
import {
  searchAll,
  getActionItems,
  getMeetings,
  getMeetingDetail,
  getMetricsTrend,
  getSpeakerStats,
} from "./db/query.js";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Arg parsing ──────────────────────────────────────────────────────

const SUBCOMMAND_PARENTS = new Set(["db"]);

function parseArgs(argv: string[]): { command: string; subcommand: string; positional: string[]; flags: Record<string, string> } {
  const args = argv.slice(2);
  const command = args[0] ?? "";
  const hasSubcommand = SUBCOMMAND_PARENTS.has(command) && args[1] && !args[1].startsWith("--");
  const subcommand = hasSubcommand ? args[1] : "";
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  const startIdx = hasSubcommand ? 2 : 1;
  for (let i = startIdx; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx > -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        flags[arg.slice(2)] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, subcommand, positional, flags };
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function truncate(s: string | null, len: number): string {
  if (!s) return "—";
  return s.length > len ? s.slice(0, len - 1) + "…" : s;
}

// ── Commands ─────────────────────────────────────────────────────────

const DEFAULT_DIR = join(homedir(), ".openclaw", "workspace", "openbuilder", "reports");

function cmdDbInit() {
  const db = openDb();
  initSchema(db);
  db.close();
  console.log("Database initialized at:", getDbPath());
}

async function cmdDbIngest(flags: Record<string, string>) {
  const dir = flags.dir ?? DEFAULT_DIR;
  const db = openDb();
  initSchema(db);
  console.log(`Ingesting from: ${dir}`);
  const stats = ingestAllFromDirectory(db, dir);
  db.close();
  console.log(`\nDone: ${stats.ingested} meetings ingested, ${stats.errors} errors, ${stats.total} files found.`);
}

function cmdDbStatus() {
  const db = openDb();
  initSchema(db);
  const counts = {
    meetings: (db.prepare("SELECT COUNT(*) AS c FROM meetings").get() as { c: number }).c,
    participants: (db.prepare("SELECT COUNT(*) AS c FROM participants").get() as { c: number }).c,
    chapters: (db.prepare("SELECT COUNT(*) AS c FROM chapters").get() as { c: number }).c,
    transcript_turns: (db.prepare("SELECT COUNT(*) AS c FROM transcript_turns").get() as { c: number }).c,
    action_items: (db.prepare("SELECT COUNT(*) AS c FROM action_items").get() as { c: number }).c,
    key_questions: (db.prepare("SELECT COUNT(*) AS c FROM key_questions").get() as { c: number }).c,
    topics: (db.prepare("SELECT COUNT(*) AS c FROM topics").get() as { c: number }).c,
  };
  const dateRange = db.prepare("SELECT MIN(date) AS earliest, MAX(date) AS latest FROM meetings").get() as { earliest: string; latest: string };
  db.close();

  console.log("OpenBuilder Database Status");
  console.log("──────────────────────────────");
  for (const [table, count] of Object.entries(counts)) {
    console.log(`  ${table.padEnd(20)} ${String(count).padStart(6)}`);
  }
  console.log("──────────────────────────────");
  if (dateRange.earliest) {
    console.log(`  Date range: ${dateRange.earliest} → ${dateRange.latest}`);
  }
}

function cmdSearch(positional: string[], flags: Record<string, string>) {
  const query = positional.join(" ");
  if (!query) {
    console.error("Usage: openbuilder search <query>");
    process.exit(1);
  }

  const db = openDb();
  initSchema(db);
  const results = searchAll(db, query);
  db.close();

  if (flags.json === "true") {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.meetings.length > 0) {
    console.log(`\n── Meetings (${results.meetings.length}) ──`);
    for (const m of results.meetings) {
      console.log(`  ${m.date}  ${m.id}`);
      console.log(`    ${m.title}`);
      if (m.summary) console.log(`    ${truncate(m.summary, 120)}`);
    }
  }

  if (results.chapters.length > 0) {
    console.log(`\n── Chapters (${results.chapters.length}) ──`);
    for (const c of results.chapters) {
      console.log(`  ${c.meeting_date}  ${truncate(c.meeting_title, 40)}`);
      console.log(`    ${c.title}: ${truncate(c.description, 100)}`);
    }
  }

  if (results.transcripts.length > 0) {
    console.log(`\n── Transcripts (${results.transcripts.length}) ──`);
    for (const t of results.transcripts) {
      console.log(`  ${t.meeting_date}  ${truncate(t.meeting_title, 40)}`);
      console.log(`    [${t.speaker_name}] ${truncate(t.text, 120)}`);
    }
  }

  if (results.action_items.length > 0) {
    console.log(`\n── Action Items (${results.action_items.length}) ──`);
    for (const a of results.action_items) {
      console.log(`  ${a.meeting_date}  ${truncate(a.meeting_title, 40)}`);
      console.log(`    ${truncate(a.text, 120)}`);
    }
  }

  const total = results.meetings.length + results.chapters.length + results.transcripts.length + results.action_items.length;
  if (total === 0) {
    console.log("No results found.");
  }
}

function cmdMeetings(flags: Record<string, string>) {
  const db = openDb();
  initSchema(db);
  const rows = getMeetings(db, {
    since: flags.since,
    until: flags.until,
    title: flags.title,
    participant: flags.participant,
    limit: flags.limit ? parseInt(flags.limit) : undefined,
  });
  db.close();

  if (flags.json === "true") {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("No meetings found.");
    return;
  }

  console.log(`\n${"Date".padEnd(12)} ${"Duration".padEnd(10)} ${"Ppl".padEnd(5)} ${"Score".padEnd(7)} Title`);
  console.log("─".repeat(80));
  for (const m of rows) {
    const score = m.read_score != null ? m.read_score.toFixed(0) : "—";
    console.log(`${(m.date ?? "—").padEnd(12)} ${formatDuration(m.duration_ms).padEnd(10)} ${String(m.participant_count).padEnd(5)} ${score.padEnd(7)} ${truncate(m.title, 50)}`);
  }
  console.log(`\n${rows.length} meeting(s)`);
}

function cmdMeeting(positional: string[], flags: Record<string, string>) {
  const id = positional[0];
  if (!id) {
    console.error("Usage: openbuilder meeting <id>");
    process.exit(1);
  }

  const db = openDb();
  initSchema(db);
  const detail = getMeetingDetail(db, id);
  db.close();

  if (!detail) {
    console.error(`Meeting not found: ${id}`);
    process.exit(1);
  }

  if (flags.json === "true") {
    console.log(JSON.stringify(detail, null, 2));
    return;
  }

  console.log(`\n# ${detail.title}`);
  console.log(`Date: ${detail.date}  |  Duration: ${formatDuration(detail.duration_ms)}  |  Platform: ${detail.platform}`);
  console.log(`Owner: ${detail.owner_name} <${detail.owner_email}>`);
  if (detail.report_url) console.log(`Report: ${detail.report_url}`);
  if (detail.recording_url) console.log(`Recording: ${detail.recording_url}`);

  if (detail.read_score != null || detail.sentiment != null || detail.engagement != null) {
    console.log(`\n## Metrics`);
    if (detail.read_score != null) console.log(`  Read Score: ${detail.read_score.toFixed(1)}`);
    if (detail.sentiment != null) console.log(`  Sentiment:  ${detail.sentiment.toFixed(1)}`);
    if (detail.engagement != null) console.log(`  Engagement: ${detail.engagement.toFixed(1)}`);
  }

  if (detail.participants.length > 0) {
    console.log(`\n## Participants (${detail.participants.length})`);
    for (const p of detail.participants) {
      const status = p.attended ? "attended" : "invited";
      console.log(`  ${p.name ?? "—"}${p.email ? ` <${p.email}>` : ""} (${status})`);
    }
  }

  if (detail.summary) {
    console.log(`\n## Summary`);
    console.log(detail.summary);
  }

  if (detail.chapters.length > 0) {
    console.log(`\n## Chapters (${detail.chapters.length})`);
    for (const c of detail.chapters) {
      console.log(`  ${c.position + 1}. ${c.title}`);
      if (c.description) console.log(`     ${truncate(c.description, 120)}`);
    }
  }

  if (detail.action_items.length > 0) {
    console.log(`\n## Action Items (${detail.action_items.length})`);
    for (const a of detail.action_items) {
      const assigneeTag = a.assignee ? ` [@${a.assignee}]` : "";
      console.log(`  - ${a.text}${assigneeTag}`);
    }
  }

  if (detail.key_questions.length > 0) {
    console.log(`\n## Key Questions (${detail.key_questions.length})`);
    for (const q of detail.key_questions) {
      console.log(`  - ${q.text}`);
    }
  }

  if (detail.topics.length > 0) {
    console.log(`\n## Topics (${detail.topics.length})`);
    for (const t of detail.topics) {
      console.log(`  - ${t.text}`);
    }
  }

  if (detail.transcript_turns.length > 0) {
    console.log(`\n## Transcript (${detail.transcript_turns.length} turns)`);
    // Show first 20 turns
    const shown = detail.transcript_turns.slice(0, 20);
    for (const t of shown) {
      console.log(`  [${t.speaker_name}] ${truncate(t.text, 120)}`);
    }
    if (detail.transcript_turns.length > 20) {
      console.log(`  ... and ${detail.transcript_turns.length - 20} more turns`);
    }
  }
}

function cmdActions(flags: Record<string, string>) {
  const db = openDb();
  initSchema(db);
  const items = getActionItems(db, {
    assignee: flags.assignee,
    meetingId: flags.meeting,
    since: flags.since,
    limit: flags.limit ? parseInt(flags.limit) : undefined,
  });
  db.close();

  if (flags.json === "true") {
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  if (items.length === 0) {
    console.log("No action items found.");
    return;
  }

  let currentDate = "";
  for (const a of items) {
    if (a.meeting_date !== currentDate) {
      currentDate = a.meeting_date;
      console.log(`\n${currentDate}  ${a.meeting_title}`);
    }
    const assigneeTag = a.assignee ? ` [@${a.assignee}]` : "";
    console.log(`  - ${a.text}${assigneeTag}`);
  }
  console.log(`\n${items.length} action item(s)`);
}

function cmdSpeakers(flags: Record<string, string>) {
  const db = openDb();
  initSchema(db);
  const rows = getSpeakerStats(db, { since: flags.since });
  db.close();

  if (flags.json === "true") {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("No speaker data found.");
    return;
  }

  console.log(`\n${"Speaker".padEnd(30)} ${"Turns".padStart(8)} ${"Meetings".padStart(10)}`);
  console.log("─".repeat(50));
  for (const r of rows.slice(0, 30)) {
    console.log(`${truncate(r.speaker_name, 30).padEnd(30)} ${String(r.turn_count).padStart(8)} ${String(r.meeting_count).padStart(10)}`);
  }
  if (rows.length > 30) console.log(`  ... and ${rows.length - 30} more speakers`);
}

function cmdMetrics(flags: Record<string, string>) {
  const db = openDb();
  initSchema(db);
  const rows = getMetricsTrend(db, { title: flags.title, since: flags.since });
  db.close();

  if (flags.json === "true") {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("No metrics data found.");
    return;
  }

  console.log(`\n${"Date".padEnd(12)} ${"Score".padEnd(8)} ${"Sent.".padEnd(8)} ${"Engage".padEnd(8)} Title`);
  console.log("─".repeat(80));
  for (const r of rows) {
    console.log(
      `${r.date.padEnd(12)} ${(r.read_score?.toFixed(0) ?? "—").padEnd(8)} ${(r.sentiment?.toFixed(0) ?? "—").padEnd(8)} ${(r.engagement?.toFixed(0) ?? "—").padEnd(8)} ${truncate(r.title, 40)}`,
    );
  }
}

function showHelp() {
  console.log(`
OpenBuilder — Meeting Intelligence CLI

Usage: openbuilder <command> [options]

Commands:
  db init                 Create/migrate the SQLite database
  db ingest [--dir]       Ingest all raw JSON files into SQLite
  db status               Show database stats

  search <query>          Search across everything (transcripts, summaries, chapters, action items)
  meetings [options]      List meetings
    --since <date>          Filter by start date (YYYY-MM-DD)
    --until <date>          Filter by end date
    --title <text>          Filter by title (LIKE match)
    --participant <name>    Filter by participant name
    --limit <n>             Max results
  meeting <id>            Show full meeting detail
  actions [options]       List action items
    --assignee <name>       Filter by assignee
    --since <date>          Filter by date
    --meeting <id>          Filter by meeting
    --limit <n>             Max results
  speakers [--since]      Speaker stats (who talks most)
  metrics [--title]       Metrics trends for a meeting series

Global flags:
  --json                  Output as JSON
  --help                  Show this help
`);
}

// ── Main ─────────────────────────────────────────────────────────────

const { command, subcommand, positional, flags } = parseArgs(process.argv);

if (flags.help === "true" || command === "help" || command === "") {
  showHelp();
  process.exit(0);
}

switch (command) {
  case "db":
    switch (subcommand) {
      case "init":
        cmdDbInit();
        break;
      case "ingest":
        cmdDbIngest(flags);
        break;
      case "status":
        cmdDbStatus();
        break;
      default:
        console.error(`Unknown db command: ${subcommand}`);
        process.exit(1);
    }
    break;
  case "search":
    cmdSearch(positional, flags);
    break;
  case "meetings":
    cmdMeetings(flags);
    break;
  case "meeting":
    cmdMeeting(positional, flags);
    break;
  case "actions":
    cmdActions(flags);
    break;
  case "speakers":
    cmdSpeakers(flags);
    break;
  case "metrics":
    cmdMetrics(flags);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    showHelp();
    process.exit(1);
}
