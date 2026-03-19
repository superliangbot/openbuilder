/**
 * query.ts — Query layer for the meeting intelligence database.
 */

import type Database from "better-sqlite3";

// ── Search transcripts (FTS5) ────────────────────────────────────────

export interface SearchTranscriptsOpts {
  meetingId?: string;
  speaker?: string;
  limit?: number;
  since?: string;
}

export interface TranscriptResult {
  meeting_id: string;
  meeting_title: string;
  meeting_date: string;
  speaker_name: string;
  text: string;
  rank: number;
}

export function searchTranscripts(db: Database.Database, query: string, opts?: SearchTranscriptsOpts): TranscriptResult[] {
  const conditions: string[] = ["tf.transcript_fts MATCH @query"];
  const params: Record<string, unknown> = { query, limit: opts?.limit ?? 20 };

  if (opts?.meetingId) {
    conditions.push("tf.meeting_id = @meetingId");
    params.meetingId = opts.meetingId;
  }
  if (opts?.speaker) {
    conditions.push("tf.speaker_name = @speaker");
    params.speaker = opts.speaker;
  }
  if (opts?.since) {
    conditions.push("m.date >= @since");
    params.since = opts.since;
  }

  const sql = `
    SELECT tf.meeting_id, m.title AS meeting_title, m.date AS meeting_date,
           tf.speaker_name, tf.text, rank
    FROM transcript_fts tf
    JOIN meetings m ON m.id = tf.meeting_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY rank
    LIMIT @limit
  `;
  return db.prepare(sql).all(params) as TranscriptResult[];
}

// ── Search meetings (FTS5) ───────────────────────────────────────────

export interface SearchMeetingsOpts {
  since?: string;
  limit?: number;
}

export interface MeetingSearchResult {
  id: string;
  title: string;
  date: string;
  summary: string;
  rank: number;
}

export function searchMeetings(db: Database.Database, query: string, opts?: SearchMeetingsOpts): MeetingSearchResult[] {
  const conditions: string[] = ["mf.meetings_fts MATCH @query"];
  const params: Record<string, unknown> = { query, limit: opts?.limit ?? 20 };

  if (opts?.since) {
    conditions.push("m.date >= @since");
    params.since = opts.since;
  }

  const sql = `
    SELECT mf.meeting_id AS id, m.title, m.date, m.summary, rank
    FROM meetings_fts mf
    JOIN meetings m ON m.id = mf.meeting_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY rank
    LIMIT @limit
  `;
  return db.prepare(sql).all(params) as MeetingSearchResult[];
}

// ── Action items ─────────────────────────────────────────────────────

export interface ActionItemsOpts {
  assignee?: string;
  meetingId?: string;
  since?: string;
  limit?: number;
}

export interface ActionItemResult {
  text: string;
  assignee: string | null;
  meeting_id: string;
  meeting_title: string;
  meeting_date: string;
}

export function getActionItems(db: Database.Database, opts?: ActionItemsOpts): ActionItemResult[] {
  const conditions: string[] = [];
  const params: Record<string, unknown> = { limit: opts?.limit ?? 50 };

  if (opts?.assignee) {
    conditions.push("ai.assignee LIKE @assignee");
    params.assignee = `%${opts.assignee}%`;
  }
  if (opts?.meetingId) {
    conditions.push("ai.meeting_id = @meetingId");
    params.meetingId = opts.meetingId;
  }
  if (opts?.since) {
    conditions.push("m.date >= @since");
    params.since = opts.since;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT ai.text, ai.assignee, ai.meeting_id, m.title AS meeting_title, m.date AS meeting_date
    FROM action_items ai
    JOIN meetings m ON m.id = ai.meeting_id
    ${where}
    ORDER BY m.date DESC, ai.position
    LIMIT @limit
  `;
  return db.prepare(sql).all(params) as ActionItemResult[];
}

// ── List meetings ────────────────────────────────────────────────────

export interface MeetingsOpts {
  since?: string;
  until?: string;
  title?: string;
  participant?: string;
  limit?: number;
  orderBy?: "date" | "title" | "duration";
}

export interface MeetingRow {
  id: string;
  title: string;
  date: string;
  duration_ms: number | null;
  platform: string;
  owner_name: string;
  participant_count: number;
  read_score: number | null;
}

export function getMeetings(db: Database.Database, opts?: MeetingsOpts): MeetingRow[] {
  const conditions: string[] = [];
  const params: Record<string, unknown> = { limit: opts?.limit ?? 50 };

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
  if (opts?.participant) {
    conditions.push("m.id IN (SELECT meeting_id FROM participants WHERE name LIKE @participant AND attended = 1)");
    params.participant = `%${opts.participant}%`;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderCol = opts?.orderBy === "title" ? "m.title" : opts?.orderBy === "duration" ? "m.duration_ms DESC" : "m.date DESC";

  const sql = `
    SELECT m.id, m.title, m.date, m.duration_ms, m.platform, m.owner_name,
           (SELECT COUNT(*) FROM participants p WHERE p.meeting_id = m.id AND p.attended = 1) AS participant_count,
           m.read_score
    FROM meetings m
    ${where}
    ORDER BY ${orderCol}
    LIMIT @limit
  `;
  return db.prepare(sql).all(params) as MeetingRow[];
}

// ── Meeting detail ───────────────────────────────────────────────────

export interface MeetingDetail {
  id: string;
  title: string;
  date: string;
  start_time_ms: number;
  end_time_ms: number;
  duration_ms: number | null;
  platform: string;
  owner_name: string;
  owner_email: string;
  summary: string;
  read_score: number | null;
  sentiment: number | null;
  engagement: number | null;
  recording_url: string | null;
  report_url: string | null;
  folder: string | null;
  participants: Array<{ name: string; email: string; invited: boolean; attended: boolean }>;
  chapters: Array<{ position: number; title: string; description: string }>;
  action_items: Array<{ position: number; text: string; assignee: string | null }>;
  key_questions: Array<{ position: number; text: string }>;
  topics: Array<{ position: number; text: string }>;
  transcript_turns: Array<{ position: number; speaker_name: string; text: string; start_time_ms: number; end_time_ms: number }>;
}

export function getMeetingDetail(db: Database.Database, meetingId: string): MeetingDetail | null {
  const meeting = db.prepare("SELECT * FROM meetings WHERE id = ?").get(meetingId) as Record<string, unknown> | undefined;
  if (!meeting) return null;

  const participants = db.prepare("SELECT name, email, invited, attended FROM participants WHERE meeting_id = ?").all(meetingId) as MeetingDetail["participants"];
  const chapters = db.prepare("SELECT position, title, description FROM chapters WHERE meeting_id = ? ORDER BY position").all(meetingId) as MeetingDetail["chapters"];
  const action_items = db.prepare("SELECT position, text, assignee FROM action_items WHERE meeting_id = ? ORDER BY position").all(meetingId) as MeetingDetail["action_items"];
  const key_questions = db.prepare("SELECT position, text FROM key_questions WHERE meeting_id = ? ORDER BY position").all(meetingId) as MeetingDetail["key_questions"];
  const topics = db.prepare("SELECT position, text FROM topics WHERE meeting_id = ? ORDER BY position").all(meetingId) as MeetingDetail["topics"];
  const transcript_turns = db.prepare("SELECT position, speaker_name, text, start_time_ms, end_time_ms FROM transcript_turns WHERE meeting_id = ? ORDER BY position").all(meetingId) as MeetingDetail["transcript_turns"];

  return {
    id: meeting.id as string,
    title: meeting.title as string,
    date: meeting.date as string,
    start_time_ms: meeting.start_time_ms as number,
    end_time_ms: meeting.end_time_ms as number,
    duration_ms: meeting.duration_ms as number | null,
    platform: meeting.platform as string,
    owner_name: meeting.owner_name as string,
    owner_email: meeting.owner_email as string,
    summary: meeting.summary as string,
    read_score: meeting.read_score as number | null,
    sentiment: meeting.sentiment as number | null,
    engagement: meeting.engagement as number | null,
    recording_url: meeting.recording_url as string | null,
    report_url: meeting.report_url as string | null,
    folder: meeting.folder as string | null,
    participants,
    chapters,
    action_items,
    key_questions,
    topics,
    transcript_turns,
  };
}

// ── Metrics trend ────────────────────────────────────────────────────

export interface MetricsTrendOpts {
  title?: string;
  since?: string;
}

export interface MetricsRow {
  id: string;
  title: string;
  date: string;
  read_score: number | null;
  sentiment: number | null;
  engagement: number | null;
}

export function getMetricsTrend(db: Database.Database, opts?: MetricsTrendOpts): MetricsRow[] {
  const conditions: string[] = ["read_score IS NOT NULL"];
  const params: Record<string, unknown> = {};

  if (opts?.title) {
    conditions.push("title LIKE @title");
    params.title = `%${opts.title}%`;
  }
  if (opts?.since) {
    conditions.push("date >= @since");
    params.since = opts.since;
  }

  const sql = `
    SELECT id, title, date, read_score, sentiment, engagement
    FROM meetings
    WHERE ${conditions.join(" AND ")}
    ORDER BY date
  `;
  return db.prepare(sql).all(params) as MetricsRow[];
}

// ── Speaker stats ────────────────────────────────────────────────────

export interface SpeakerStatsOpts {
  since?: string;
}

export interface SpeakerRow {
  speaker_name: string;
  turn_count: number;
  meeting_count: number;
}

export function getSpeakerStats(db: Database.Database, opts?: SpeakerStatsOpts): SpeakerRow[] {
  const conditions: string[] = ["tt.speaker_name IS NOT NULL", "tt.speaker_name != 'UNKNOWN_SPEAKER'"];
  const params: Record<string, unknown> = {};

  if (opts?.since) {
    conditions.push("m.date >= @since");
    params.since = opts.since;
  }

  const sql = `
    SELECT tt.speaker_name, COUNT(*) AS turn_count, COUNT(DISTINCT tt.meeting_id) AS meeting_count
    FROM transcript_turns tt
    JOIN meetings m ON m.id = tt.meeting_id
    WHERE ${conditions.join(" AND ")}
    GROUP BY tt.speaker_name
    ORDER BY turn_count DESC
  `;
  return db.prepare(sql).all(params) as SpeakerRow[];
}

// ── Combined search ──────────────────────────────────────────────────

export interface SearchAllResult {
  transcripts: TranscriptResult[];
  meetings: MeetingSearchResult[];
  chapters: Array<{ meeting_id: string; meeting_title: string; meeting_date: string; title: string; description: string; rank: number }>;
  action_items: Array<{ meeting_id: string; meeting_title: string; meeting_date: string; text: string; rank: number }>;
}

export function searchAll(db: Database.Database, query: string): SearchAllResult {
  const transcripts = searchTranscripts(db, query, { limit: 10 });
  const meetings = searchMeetings(db, query, { limit: 10 });

  const chapters = db.prepare(`
    SELECT cf.meeting_id, m.title AS meeting_title, m.date AS meeting_date,
           cf.title, cf.description, rank
    FROM chapters_fts cf
    JOIN meetings m ON m.id = cf.meeting_id
    WHERE cf.chapters_fts MATCH @query
    ORDER BY rank
    LIMIT 10
  `).all({ query }) as SearchAllResult["chapters"];

  // Action items: use LIKE since there's no FTS table for them
  const action_items = db.prepare(`
    SELECT ai.meeting_id, m.title AS meeting_title, m.date AS meeting_date, ai.text, 0 AS rank
    FROM action_items ai
    JOIN meetings m ON m.id = ai.meeting_id
    WHERE ai.text LIKE @pattern
    ORDER BY m.date DESC
    LIMIT 10
  `).all({ pattern: `%${query}%` }) as SearchAllResult["action_items"];

  return { transcripts, meetings, chapters, action_items };
}
