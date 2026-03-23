/**
 * digest.ts — Weekly meeting digest generator.
 */

import type Database from "better-sqlite3";

export interface DigestOpts {
  since?: string;
  until?: string;
}

interface MeetingRow {
  id: string;
  title: string;
  date: string;
  duration_ms: number | null;
  read_score: number | null;
  sentiment: number | null;
  engagement: number | null;
  participant_count: number;
}

interface ActionRow {
  text: string;
  assignee: string | null;
  meeting_title: string;
  meeting_date: string;
}

interface QuestionRow {
  text: string;
  meeting_title: string;
  meeting_date: string;
}

interface TopicRow {
  text: string;
  meeting_title: string;
  meeting_date: string;
}

function formatDuration(ms: number): string {
  const totalMins = Math.round(ms / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  return `${hours}h ${mins}m`;
}

export function generateWeeklyDigest(db: Database.Database, opts?: DigestOpts): string | null {
  const now = new Date();
  const until = opts?.until ?? now.toISOString().slice(0, 10);
  const sinceDate = opts?.since
    ? opts.since
    : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Query meetings in range
  const meetings = db.prepare(`
    SELECT m.id, m.title, m.date, m.duration_ms, m.read_score, m.sentiment, m.engagement,
           (SELECT COUNT(*) FROM participants p WHERE p.meeting_id = m.id AND p.attended = 1) AS participant_count
    FROM meetings m
    WHERE m.date >= @since AND m.date <= @until
    ORDER BY m.date
  `).all({ since: sinceDate, until }) as MeetingRow[];

  if (meetings.length === 0) return null;

  // Total duration
  const totalMs = meetings.reduce((sum, m) => sum + (m.duration_ms ?? 0), 0);
  const totalDuration = formatDuration(totalMs);

  // Unique participants
  const participants = db.prepare(`
    SELECT DISTINCT p.name FROM participants p
    JOIN meetings m ON m.id = p.meeting_id
    WHERE m.date >= @since AND m.date <= @until AND p.attended = 1 AND p.name IS NOT NULL
  `).all({ since: sinceDate, until }) as Array<{ name: string }>;

  // Average metrics
  const metricsWithScore = meetings.filter((m) => m.read_score != null);
  const avgScore = metricsWithScore.length > 0
    ? (metricsWithScore.reduce((s, m) => s + m.read_score!, 0) / metricsWithScore.length).toFixed(0)
    : "N/A";
  const metricsWithEng = meetings.filter((m) => m.engagement != null);
  const avgEng = metricsWithEng.length > 0
    ? (metricsWithEng.reduce((s, m) => s + m.engagement!, 0) / metricsWithEng.length).toFixed(0)
    : "N/A";
  const metricsWithSent = meetings.filter((m) => m.sentiment != null);
  const avgSent = metricsWithSent.length > 0
    ? (metricsWithSent.reduce((s, m) => s + m.sentiment!, 0) / metricsWithSent.length).toFixed(0)
    : "N/A";

  // Action items
  const actions = db.prepare(`
    SELECT ai.text, ai.assignee, m.title AS meeting_title, m.date AS meeting_date
    FROM action_items ai
    JOIN meetings m ON m.id = ai.meeting_id
    WHERE m.date >= @since AND m.date <= @until
    ORDER BY ai.assignee, m.date, ai.position
  `).all({ since: sinceDate, until }) as ActionRow[];

  // Key questions
  const questions = db.prepare(`
    SELECT kq.text, m.title AS meeting_title, m.date AS meeting_date
    FROM key_questions kq
    JOIN meetings m ON m.id = kq.meeting_id
    WHERE m.date >= @since AND m.date <= @until
    ORDER BY m.date, kq.position
  `).all({ since: sinceDate, until }) as QuestionRow[];

  // Topics
  const topics = db.prepare(`
    SELECT t.text, m.title AS meeting_title, m.date AS meeting_date
    FROM topics t
    JOIN meetings m ON m.id = t.meeting_id
    WHERE m.date >= @since AND m.date <= @until
    ORDER BY m.date, t.position
  `).all({ since: sinceDate, until }) as TopicRow[];

  // Build markdown
  const lines: string[] = [];

  lines.push("# Weekly Meeting Digest");
  lines.push(`**${sinceDate} — ${until}**`);
  lines.push("");

  // Overview
  lines.push("## Overview");
  lines.push(`- **${meetings.length} meetings** totaling ${totalDuration}`);
  lines.push(`- **${participants.length} unique participants**`);
  lines.push(`- **Avg Read Score:** ${avgScore} | **Engagement:** ${avgEng} | **Sentiment:** ${avgSent}`);
  lines.push("");

  // Meetings table
  lines.push("## Meetings");
  lines.push("| Date | Title | Duration | Participants | Score |");
  lines.push("|------|-------|----------|-------------|-------|");
  for (const m of meetings) {
    const dur = m.duration_ms != null ? formatDuration(m.duration_ms) : "—";
    const score = m.read_score != null ? m.read_score.toFixed(0) : "—";
    lines.push(`| ${m.date} | ${m.title ?? "—"} | ${dur} | ${m.participant_count} | ${score} |`);
  }
  lines.push("");

  // Action items by assignee
  if (actions.length > 0) {
    lines.push("## Action Items by Assignee");
    lines.push("");

    const grouped = new Map<string, ActionRow[]>();
    for (const a of actions) {
      const key = a.assignee ?? "Unassigned";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(a);
    }

    // Named assignees first, then Unassigned
    const keys = [...grouped.keys()].sort((a, b) => {
      if (a === "Unassigned") return 1;
      if (b === "Unassigned") return -1;
      return a.localeCompare(b);
    });

    for (const assignee of keys) {
      lines.push(`### ${assignee}`);
      for (const a of grouped.get(assignee)!) {
        lines.push(`- [ ] ${a.text} (${a.meeting_title}, ${a.meeting_date})`);
      }
      lines.push("");
    }
  }

  // Key questions
  if (questions.length > 0) {
    lines.push("## Key Questions");
    for (const q of questions) {
      lines.push(`- ${q.text} (${q.meeting_title}, ${q.meeting_date})`);
    }
    lines.push("");
  }

  // Topics
  if (topics.length > 0) {
    lines.push("## Top Topics");
    for (const t of topics) {
      lines.push(`- ${t.text} (${t.meeting_title}, ${t.meeting_date})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
