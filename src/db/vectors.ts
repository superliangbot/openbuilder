/**
 * vectors.ts — Vector embeddings and semantic search for meeting intelligence.
 *
 * Uses OpenAI text-embedding-3-small (1536 dims) stored as JSON arrays in SQLite.
 * At <50k vectors, brute-force cosine similarity is fast enough (<100ms).
 */

import type Database from "better-sqlite3";
import "dotenv/config";

const EMBEDDING_MODEL = "text-embedding-3-small";
const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 100;
const MAX_TOKEN_CHARS = 30000; // ~8192 tokens ≈ ~30k chars, leave margin

// ── OpenAI embedding API ────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.error(
      "Error: OPENAI_API_KEY is not set.\n" +
        "Set it in your environment or add it to .env in the project root.\n" +
        "  export OPENAI_API_KEY=sk-...\n" +
        "Get a key at https://platform.openai.com/api-keys",
    );
    process.exit(1);
  }
  return key;
}

export async function embedText(text: string): Promise<number[]> {
  const [result] = await embedTexts([text]);
  return result;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const apiKey = getApiKey();
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey });

  const results: number[][] = [];

  // OpenAI supports up to 2048 inputs per call
  for (let i = 0; i < texts.length; i += 2048) {
    const batch = texts.slice(i, i + 2048);
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    });
    for (const item of response.data) {
      results.push(item.embedding);
    }
  }

  return results;
}

// ── Cosine similarity ───────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Chunking ────────────────────────────────────────────────────────

interface TranscriptTurn {
  speaker_name: string;
  text: string;
}

interface Chunk {
  text: string;
  speaker_name?: string;
  index: number;
}

export function chunkTranscript(turns: TranscriptTurn[]): Chunk[] {
  if (turns.length === 0) return [];

  // Merge consecutive turns by same speaker
  const merged: { speaker: string; text: string }[] = [];
  for (const turn of turns) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === turn.speaker_name) {
      last.text += " " + turn.text;
    } else {
      merged.push({ speaker: turn.speaker_name, text: turn.text });
    }
  }

  // Build formatted text blocks: "[Speaker] text"
  const blocks: { speaker: string; text: string }[] = merged.map((m) => ({
    speaker: m.speaker,
    text: `[${m.speaker}] ${m.text}`,
  }));

  // Split into chunks of ~CHUNK_SIZE chars with CHUNK_OVERLAP overlap
  const chunks: Chunk[] = [];
  let currentText = "";
  let currentSpeaker = blocks[0]?.speaker ?? "";
  let chunkIdx = 0;

  for (const block of blocks) {
    if (currentText.length + block.text.length + 1 > CHUNK_SIZE && currentText.length > 0) {
      chunks.push({ text: currentText.trim(), speaker_name: currentSpeaker, index: chunkIdx++ });

      // Overlap: keep the tail of the current chunk
      const overlapStart = Math.max(0, currentText.length - CHUNK_OVERLAP);
      currentText = currentText.slice(overlapStart);
      currentSpeaker = block.speaker;
    }
    currentText += (currentText.length > 0 ? " " : "") + block.text;
    if (chunks.length === 0) currentSpeaker = blocks[0]?.speaker ?? "";
  }

  if (currentText.trim().length > 0) {
    chunks.push({ text: currentText.trim(), speaker_name: currentSpeaker, index: chunkIdx });
  }

  return chunks;
}

// ── Embed a single meeting ──────────────────────────────────────────

export async function embedMeeting(db: Database.Database, meetingId: string): Promise<number> {
  // Check if already embedded
  const existing = db.prepare("SELECT COUNT(*) AS c FROM embeddings WHERE meeting_id = ?").get(meetingId) as { c: number };
  if (existing.c > 0) return 0;

  const meeting = db.prepare("SELECT id, title, summary FROM meetings WHERE id = ?").get(meetingId) as
    | { id: string; title: string; summary: string | null }
    | undefined;
  if (!meeting) return 0;

  const textsToEmbed: Array<{ chunk_type: string; chunk_text: string; chunk_index: number; speaker_name: string | null }> = [];

  // Summary
  if (meeting.summary) {
    textsToEmbed.push({ chunk_type: "summary", chunk_text: meeting.summary, chunk_index: 0, speaker_name: null });
  }

  // Chapters
  const chapters = db
    .prepare("SELECT position, title, description FROM chapters WHERE meeting_id = ? ORDER BY position")
    .all(meetingId) as Array<{ position: number; title: string; description: string | null }>;
  for (const ch of chapters) {
    const text = ch.description ? `${ch.title}: ${ch.description}` : ch.title;
    textsToEmbed.push({ chunk_type: "chapter", chunk_text: text, chunk_index: ch.position, speaker_name: null });
  }

  // Action items
  const actions = db
    .prepare("SELECT position, text, assignee FROM action_items WHERE meeting_id = ? ORDER BY position")
    .all(meetingId) as Array<{ position: number; text: string; assignee: string | null }>;
  for (const ai of actions) {
    const text = ai.assignee ? `${ai.text} (assigned to ${ai.assignee})` : ai.text;
    textsToEmbed.push({ chunk_type: "action_item", chunk_text: text, chunk_index: ai.position, speaker_name: null });
  }

  // Topics
  const topics = db
    .prepare("SELECT position, text FROM topics WHERE meeting_id = ? ORDER BY position")
    .all(meetingId) as Array<{ position: number; text: string }>;
  for (const t of topics) {
    textsToEmbed.push({ chunk_type: "topic", chunk_text: t.text, chunk_index: t.position, speaker_name: null });
  }

  // Transcript chunks
  const turns = db
    .prepare("SELECT speaker_name, text FROM transcript_turns WHERE meeting_id = ? ORDER BY position")
    .all(meetingId) as TranscriptTurn[];
  const chunks = chunkTranscript(turns);
  for (const chunk of chunks) {
    textsToEmbed.push({
      chunk_type: "transcript",
      chunk_text: chunk.text,
      chunk_index: chunk.index,
      speaker_name: chunk.speaker_name ?? null,
    });
  }

  if (textsToEmbed.length === 0) return 0;

  // Truncate any texts that exceed the token limit
  for (const t of textsToEmbed) {
    if (t.chunk_text.length > MAX_TOKEN_CHARS) {
      t.chunk_text = t.chunk_text.slice(0, MAX_TOKEN_CHARS);
    }
  }

  // Batch embed all texts
  const vectors = await embedTexts(textsToEmbed.map((t) => t.chunk_text));

  // Insert all embeddings
  const insert = db.prepare(
    "INSERT INTO embeddings (meeting_id, chunk_type, chunk_text, chunk_index, speaker_name, embedding) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertAll = db.transaction(() => {
    for (let i = 0; i < textsToEmbed.length; i++) {
      const t = textsToEmbed[i];
      insert.run(meetingId, t.chunk_type, t.chunk_text, t.chunk_index, t.speaker_name, JSON.stringify(vectors[i]));
    }
  });
  insertAll();

  return textsToEmbed.length;
}

// ── Embed all meetings ──────────────────────────────────────────────

export interface EmbedAllOpts {
  force?: boolean;
}

export interface EmbedAllStats {
  meetings: number;
  chunks: number;
  skipped: number;
}

export async function embedAllMeetings(db: Database.Database, opts?: EmbedAllOpts): Promise<EmbedAllStats> {
  if (opts?.force) {
    db.prepare("DELETE FROM embeddings").run();
  }

  const meetings = db.prepare("SELECT id, title FROM meetings ORDER BY date").all() as Array<{ id: string; title: string }>;
  let totalChunks = 0;
  let skipped = 0;
  let embedded = 0;

  for (let i = 0; i < meetings.length; i++) {
    const m = meetings[i];
    const count = await embedMeeting(db, m.id);
    if (count === 0) {
      skipped++;
    } else {
      embedded++;
      totalChunks += count;
      process.stdout.write(`\r  Embedded ${embedded}/${meetings.length - skipped} meetings (${totalChunks} chunks)...`);
    }
  }

  if (embedded > 0) process.stdout.write("\n");

  return { meetings: embedded, chunks: totalChunks, skipped };
}

// ── Embedding stats ─────────────────────────────────────────────────

export interface EmbedStats {
  total_embeddings: number;
  meetings_embedded: number;
  by_type: Record<string, number>;
}

export function getEmbedStats(db: Database.Database): EmbedStats {
  const total = (db.prepare("SELECT COUNT(*) AS c FROM embeddings").get() as { c: number }).c;
  const meetingCount = (db.prepare("SELECT COUNT(DISTINCT meeting_id) AS c FROM embeddings").get() as { c: number }).c;
  const typeRows = db.prepare("SELECT chunk_type, COUNT(*) AS c FROM embeddings GROUP BY chunk_type").all() as Array<{
    chunk_type: string;
    c: number;
  }>;
  const by_type: Record<string, number> = {};
  for (const r of typeRows) {
    by_type[r.chunk_type] = r.c;
  }
  return { total_embeddings: total, meetings_embedded: meetingCount, by_type };
}

// ── Semantic search ─────────────────────────────────────────────────

export interface SemanticSearchOpts {
  limit?: number;
  chunkType?: string;
  meetingId?: string;
  since?: string;
}

export interface SemanticResult {
  meeting_id: string;
  meeting_title: string;
  meeting_date: string;
  chunk_type: string;
  chunk_text: string;
  speaker_name: string | null;
  similarity: number;
}

export async function semanticSearch(
  db: Database.Database,
  query: string,
  opts?: SemanticSearchOpts,
): Promise<SemanticResult[]> {
  const queryVec = await embedText(query);
  const limit = opts?.limit ?? 10;

  // Build SQL conditions for filtering
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.chunkType) {
    conditions.push("e.chunk_type = ?");
    params.push(opts.chunkType);
  }
  if (opts?.meetingId) {
    conditions.push("e.meeting_id = ?");
    params.push(opts.meetingId);
  }
  if (opts?.since) {
    conditions.push("m.date >= ?");
    params.push(opts.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT e.meeting_id, m.title AS meeting_title, m.date AS meeting_date,
              e.chunk_type, e.chunk_text, e.speaker_name, e.embedding
       FROM embeddings e
       JOIN meetings m ON m.id = e.meeting_id
       ${where}`,
    )
    .all(...params) as Array<{
    meeting_id: string;
    meeting_title: string;
    meeting_date: string;
    chunk_type: string;
    chunk_text: string;
    speaker_name: string | null;
    embedding: string;
  }>;

  // Compute similarities
  const scored: SemanticResult[] = rows.map((row) => {
    const emb = JSON.parse(row.embedding) as number[];
    return {
      meeting_id: row.meeting_id,
      meeting_title: row.meeting_title,
      meeting_date: row.meeting_date,
      chunk_type: row.chunk_type,
      chunk_text: row.chunk_text,
      speaker_name: row.speaker_name,
      similarity: cosineSimilarity(queryVec, emb),
    };
  });

  // Sort by similarity descending and take top N
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}
