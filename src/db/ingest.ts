/**
 * ingest.ts — Pipeline for ingesting Read AI meeting JSON into SQLite.
 */

import type Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { rebuildFts } from "./schema.js";

/** Extract assignee from action item text using a simple heuristic. */
function extractAssignee(text: string): string | null {
  // Match "Name [Name...] will/should/needs to/is going to ..."
  const m = text.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:will|should|needs?\s+to|is\s+going\s+to)\b/);
  return m ? m[1] : null;
}

export function ingestMeeting(db: Database.Database, raw: Record<string, unknown>): void {
  const id = raw.id as string;
  if (!id) return;

  const startMs = (raw.start_time_ms as number) ?? null;
  const endMs = (raw.end_time_ms as number) ?? null;
  const durationMs = startMs != null && endMs != null ? endMs - startMs : null;
  const date = startMs != null ? new Date(startMs).toISOString().slice(0, 10) : null;

  const owner = raw.owner as { name?: string; email?: string } | null;
  const metrics = raw.metrics as { read_score?: number; sentiment?: number; engagement?: number } | null;
  const folders = raw.folders as string[] | null;
  const folder = folders && folders.length > 0 ? folders[0] : null;

  // Delete existing data for idempotency
  const childTables = ["participants", "chapters", "transcript_turns", "action_items", "key_questions", "topics"] as const;
  for (const table of childTables) {
    db.prepare(`DELETE FROM ${table} WHERE meeting_id = ?`).run(id);
  }
  db.prepare("DELETE FROM meetings WHERE id = ?").run(id);

  // Insert meeting
  db.prepare(`
    INSERT INTO meetings (id, title, date, start_time_ms, end_time_ms, duration_ms, platform, platform_id,
      owner_name, owner_email, summary, read_score, sentiment, engagement, recording_url, report_url, folder, raw_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    (raw.title as string) ?? null,
    date,
    startMs,
    endMs,
    durationMs,
    (raw.platform as string) ?? null,
    (raw.platform_id as string) ?? null,
    owner?.name ?? null,
    owner?.email ?? null,
    (raw.summary as string) ?? null,
    metrics?.read_score ?? null,
    metrics?.sentiment ?? null,
    metrics?.engagement ?? null,
    (typeof raw.recording_download === "string"
      ? raw.recording_download
      : (raw.recording_download as { url?: string } | null)?.url ?? null),
    (raw.report_url as string) ?? null,
    folder,
    JSON.stringify(raw),
    new Date().toISOString(),
  );

  // Participants
  const participants = raw.participants as Array<{ name?: string; email?: string; invited?: boolean; attended?: boolean }> | null;
  if (participants) {
    const stmt = db.prepare("INSERT INTO participants (meeting_id, name, email, invited, attended) VALUES (?, ?, ?, ?, ?)");
    for (const p of participants) {
      stmt.run(id, p.name ?? null, p.email ?? null, p.invited ? 1 : 0, p.attended ? 1 : 0);
    }
  }

  // Chapters
  const chapters = raw.chapter_summaries as Array<{ title?: string; description?: string }> | null;
  if (chapters) {
    const stmt = db.prepare("INSERT INTO chapters (meeting_id, position, title, description) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < chapters.length; i++) {
      stmt.run(id, i, chapters[i].title ?? null, chapters[i].description ?? null);
    }
  }

  // Transcript
  const transcript = raw.transcript as { turns?: Array<{ speaker?: { name?: string }; text?: string; start_time_ms?: number; end_time_ms?: number }> } | null;
  if (transcript?.turns) {
    const stmt = db.prepare("INSERT INTO transcript_turns (meeting_id, position, speaker_name, text, start_time_ms, end_time_ms) VALUES (?, ?, ?, ?, ?, ?)");
    for (let i = 0; i < transcript.turns.length; i++) {
      const t = transcript.turns[i];
      stmt.run(id, i, t.speaker?.name ?? null, t.text ?? null, t.start_time_ms ?? null, t.end_time_ms ?? null);
    }
  }

  // Action items
  const actionItems = raw.action_items as string[] | null;
  if (actionItems) {
    const stmt = db.prepare("INSERT INTO action_items (meeting_id, position, text, assignee) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < actionItems.length; i++) {
      const text = actionItems[i];
      stmt.run(id, i, text, extractAssignee(text));
    }
  }

  // Key questions
  const keyQuestions = raw.key_questions as string[] | null;
  if (keyQuestions) {
    const stmt = db.prepare("INSERT INTO key_questions (meeting_id, position, text) VALUES (?, ?, ?)");
    for (let i = 0; i < keyQuestions.length; i++) {
      stmt.run(id, i, keyQuestions[i]);
    }
  }

  // Topics
  const topics = raw.topics as string[] | null;
  if (topics) {
    const stmt = db.prepare("INSERT INTO topics (meeting_id, position, text) VALUES (?, ?, ?)");
    for (let i = 0; i < topics.length; i++) {
      stmt.run(id, i, topics[i]);
    }
  }
}

export function ingestFromFile(db: Database.Database, filePath: string): void {
  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  ingestMeeting(db, raw);
}

export interface IngestStats {
  total: number;
  ingested: number;
  errors: number;
}

export function ingestAllFromDirectory(db: Database.Database, dirPath: string): IngestStats {
  const files = readdirSync(dirPath).filter((f) => f.match(/^readai-.*-data\.json$/));
  const stats: IngestStats = { total: files.length, ingested: 0, errors: 0 };

  const ingestTxn = db.transaction((filePaths: string[]) => {
    for (const fp of filePaths) {
      try {
        const raw = JSON.parse(readFileSync(fp, "utf-8"));
        ingestMeeting(db, raw);
        stats.ingested++;
        if (stats.ingested % 20 === 0 || stats.ingested === stats.total) {
          console.log(`  Ingested ${stats.ingested}/${stats.total}`);
        }
      } catch (err: unknown) {
        stats.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Error ingesting ${fp}: ${msg}`);
      }
    }
  });

  const fullPaths = files.map((f) => join(dirPath, f));
  ingestTxn(fullPaths);

  // Rebuild FTS indexes after bulk ingest
  rebuildFts(db);

  return stats;
}
