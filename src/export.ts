/**
 * export.ts — Export meeting data as Markdown, JSON, or CSV.
 */

import type Database from "better-sqlite3";

// ── Action Items Export ─────────────────────────────────────────────

export interface ExportActionOpts {
  assignee?: string;
  since?: string;
  until?: string;
  format?: "md" | "json" | "csv";
}

interface ActionRow {
  text: string;
  assignee: string | null;
  meeting_id: string;
  meeting_title: string;
  meeting_date: string;
}

function queryActions(db: Database.Database, opts?: ExportActionOpts): ActionRow[] {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (opts?.assignee) {
    conditions.push("ai.assignee LIKE @assignee");
    params.assignee = `%${opts.assignee}%`;
  }
  if (opts?.since) {
    conditions.push("m.date >= @since");
    params.since = opts.since;
  }
  if (opts?.until) {
    conditions.push("m.date <= @until");
    params.until = opts.until;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.prepare(`
    SELECT ai.text, ai.assignee, ai.meeting_id, m.title AS meeting_title, m.date AS meeting_date
    FROM action_items ai
    JOIN meetings m ON m.id = ai.meeting_id
    ${where}
    ORDER BY m.date DESC, ai.position
  `).all(params) as ActionRow[];
}

export function exportActionItems(db: Database.Database, opts?: ExportActionOpts): string {
  const items = queryActions(db, opts);
  const format = opts?.format ?? "md";

  if (items.length === 0) return "No action items found.";

  if (format === "json") {
    return JSON.stringify(items.map((a) => ({
      meeting_id: a.meeting_id,
      meeting_title: a.meeting_title,
      date: a.meeting_date,
      text: a.text,
      assignee: a.assignee,
    })), null, 2);
  }

  if (format === "csv") {
    const escape = (s: string | null) => {
      if (s == null) return "";
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const lines = ["meeting_id,meeting_title,date,text,assignee"];
    for (const a of items) {
      lines.push([
        escape(a.meeting_id),
        escape(a.meeting_title),
        escape(a.meeting_date),
        escape(a.text),
        escape(a.assignee),
      ].join(","));
    }
    return lines.join("\n");
  }

  // Markdown
  const lines: string[] = ["# Action Items", ""];
  let currentMeeting = "";
  for (const a of items) {
    const meetingKey = `${a.meeting_title} (${a.meeting_date})`;
    if (meetingKey !== currentMeeting) {
      currentMeeting = meetingKey;
      lines.push(`## ${a.meeting_title}`);
      lines.push(`*${a.meeting_date}*`, "");
    }
    const assigneeTag = a.assignee ? ` — @${a.assignee}` : "";
    lines.push(`- [ ] ${a.text}${assigneeTag}`);
  }
  return lines.join("\n");
}

// ── Meeting Summaries Export ────────────────────────────────────────

export interface ExportMeetingsOpts {
  since?: string;
  until?: string;
  title?: string;
  format?: "md" | "json";
}

interface MeetingSummaryRow {
  id: string;
  title: string;
  date: string;
  duration_ms: number | null;
  summary: string | null;
}

interface ChapterRow {
  title: string;
  description: string | null;
}

interface ActionItemRow {
  text: string;
  assignee: string | null;
}

export function exportMeetingSummaries(db: Database.Database, opts?: ExportMeetingsOpts): string {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (opts?.since) {
    conditions.push("m.date >= @since");
    params.since = opts.since;
  }
  if (opts?.until) {
    conditions.push("m.date <= @until");
    params.until = opts.until;
  }
  if (opts?.title) {
    conditions.push("m.title LIKE @title");
    params.title = `%${opts.title}%`;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const meetings = db.prepare(`
    SELECT m.id, m.title, m.date, m.duration_ms, m.summary
    FROM meetings m
    ${where}
    ORDER BY m.date DESC
  `).all(params) as MeetingSummaryRow[];

  if (meetings.length === 0) return "No meetings found.";

  const format = opts?.format ?? "md";

  if (format === "json") {
    const result = meetings.map((m) => {
      const chapters = db.prepare(
        "SELECT title, description FROM chapters WHERE meeting_id = ? ORDER BY position",
      ).all(m.id) as ChapterRow[];
      const actions = db.prepare(
        "SELECT text, assignee FROM action_items WHERE meeting_id = ? ORDER BY position",
      ).all(m.id) as ActionItemRow[];

      return {
        id: m.id,
        title: m.title,
        date: m.date,
        duration_ms: m.duration_ms,
        summary: m.summary,
        chapters: chapters.map((c) => ({ title: c.title, description: c.description })),
        action_items: actions.map((a) => ({ text: a.text, assignee: a.assignee })),
      };
    });
    return JSON.stringify(result, null, 2);
  }

  // Markdown
  const lines: string[] = [];
  for (const m of meetings) {
    lines.push(`# ${m.title ?? "Untitled"}`);
    lines.push(`**Date:** ${m.date}`);
    if (m.duration_ms != null) {
      const mins = Math.round(m.duration_ms / 60000);
      lines.push(`**Duration:** ${Math.floor(mins / 60)}h ${mins % 60}m`);
    }
    lines.push("");

    if (m.summary) {
      lines.push("## Summary");
      lines.push(m.summary);
      lines.push("");
    }

    const chapters = db.prepare(
      "SELECT title, description FROM chapters WHERE meeting_id = ? ORDER BY position",
    ).all(m.id) as ChapterRow[];
    if (chapters.length > 0) {
      lines.push("## Chapters");
      for (const c of chapters) {
        lines.push(`### ${c.title}`);
        if (c.description) lines.push(c.description);
        lines.push("");
      }
    }

    const actions = db.prepare(
      "SELECT text, assignee FROM action_items WHERE meeting_id = ? ORDER BY position",
    ).all(m.id) as ActionItemRow[];
    if (actions.length > 0) {
      lines.push("## Action Items");
      for (const a of actions) {
        const tag = a.assignee ? ` — @${a.assignee}` : "";
        lines.push(`- [ ] ${a.text}${tag}`);
      }
      lines.push("");
    }

    lines.push("---", "");
  }
  return lines.join("\n");
}

// ── Transcript Export ───────────────────────────────────────────────

export interface ExportTranscriptOpts {
  format?: "md" | "json" | "txt";
}

interface TranscriptTurn {
  speaker_name: string;
  text: string;
  start_time_ms: number | null;
}

function msToTimestamp(ms: number | null): string {
  if (ms == null) return "00:00:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function exportTranscript(db: Database.Database, meetingId: string, format?: "md" | "json" | "txt"): string {
  const meeting = db.prepare("SELECT title, date FROM meetings WHERE id = ?").get(meetingId) as
    | { title: string; date: string }
    | undefined;

  if (!meeting) return `Meeting not found: ${meetingId}`;

  const turns = db.prepare(
    "SELECT speaker_name, text, start_time_ms FROM transcript_turns WHERE meeting_id = ? ORDER BY position",
  ).all(meetingId) as TranscriptTurn[];

  if (turns.length === 0) return "No transcript available for this meeting.";

  const fmt = format ?? "md";

  if (fmt === "json") {
    return JSON.stringify(turns.map((t) => ({
      speaker: t.speaker_name,
      text: t.text,
      timestamp_ms: t.start_time_ms,
      timestamp: msToTimestamp(t.start_time_ms),
    })), null, 2);
  }

  if (fmt === "txt") {
    return turns.map((t) => `${t.speaker_name}: ${t.text}`).join("\n");
  }

  // Markdown
  const lines: string[] = [];
  lines.push(`## ${meeting.title}`);
  lines.push(meeting.date, "");
  for (const t of turns) {
    lines.push(`[${msToTimestamp(t.start_time_ms)}] ${t.speaker_name}: ${t.text}`);
  }
  return lines.join("\n");
}
