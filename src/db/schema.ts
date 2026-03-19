/**
 * schema.ts — SQLite database initialization for meeting intelligence.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_DB_PATH = join(homedir(), ".openbuilder", "meetings.db");

export function getDbPath(): string {
  return process.env.OPENBUILDER_DB_PATH || DEFAULT_DB_PATH;
}

export function openDb(dbPath?: string): Database.Database {
  const p = dbPath ?? getDbPath();
  mkdirSync(dirname(p), { recursive: true });
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      date TEXT,
      start_time_ms INTEGER,
      end_time_ms INTEGER,
      duration_ms INTEGER,
      platform TEXT,
      platform_id TEXT,
      owner_name TEXT,
      owner_email TEXT,
      summary TEXT,
      read_score REAL,
      sentiment REAL,
      engagement REAL,
      recording_url TEXT,
      report_url TEXT,
      folder TEXT,
      raw_json TEXT,
      synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      name TEXT,
      email TEXT,
      invited BOOLEAN,
      attended BOOLEAN
    );

    CREATE TABLE IF NOT EXISTS chapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      position INTEGER,
      title TEXT,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS transcript_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      position INTEGER,
      speaker_name TEXT,
      text TEXT,
      start_time_ms INTEGER,
      end_time_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS action_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      position INTEGER,
      text TEXT,
      assignee TEXT
    );

    CREATE TABLE IF NOT EXISTS key_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      position INTEGER,
      text TEXT
    );

    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id),
      position INTEGER,
      text TEXT
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_participants_meeting ON participants(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_chapters_meeting ON chapters(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_transcript_turns_meeting ON transcript_turns(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_action_items_meeting ON action_items(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_key_questions_meeting ON key_questions(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_topics_meeting ON topics(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date);

    -- Full-text search (standalone tables populated during ingest)
    CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5(
      meeting_id,
      title,
      summary
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
      meeting_id,
      speaker_name,
      text
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chapters_fts USING fts5(
      meeting_id,
      title,
      description
    );
  `);
}

export function rebuildFts(db: Database.Database): void {
  db.exec(`DELETE FROM meetings_fts`);
  db.exec(`INSERT INTO meetings_fts(meeting_id, title, summary) SELECT id, title, summary FROM meetings`);
  db.exec(`DELETE FROM transcript_fts`);
  db.exec(`INSERT INTO transcript_fts(meeting_id, speaker_name, text) SELECT meeting_id, speaker_name, text FROM transcript_turns`);
  db.exec(`DELETE FROM chapters_fts`);
  db.exec(`INSERT INTO chapters_fts(meeting_id, title, description) SELECT meeting_id, title, description FROM chapters`);
}
