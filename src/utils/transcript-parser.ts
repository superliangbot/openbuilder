/**
 * transcript-parser.ts — Parse OpenBuilder transcript files
 *
 * Transcript format: [HH:MM:SS] Speaker: text
 * Handles both live-captured and manually-created transcripts.
 */

import { readFileSync } from "node:fs";

export interface TranscriptLine {
  timestamp: string;
  hours: number;
  minutes: number;
  seconds: number;
  totalSeconds: number;
  speaker: string;
  text: string;
}

export interface ParsedTranscript {
  lines: TranscriptLine[];
  speakers: string[];
  durationSeconds: number;
  wordCount: number;
  rawText: string;
}

const LINE_RE = /^\[(\d{2}):(\d{2}):(\d{2})\]\s+(.+?):\s+(.+)$/;

/** Parse a single transcript line. Returns null if the line doesn't match. */
export function parseTranscriptLine(line: string): TranscriptLine | null {
  const match = line.trim().match(LINE_RE);
  if (!match) return null;

  const hours = parseInt(match[1]!, 10);
  const minutes = parseInt(match[2]!, 10);
  const seconds = parseInt(match[3]!, 10);

  return {
    timestamp: `${match[1]}:${match[2]}:${match[3]}`,
    hours,
    minutes,
    seconds,
    totalSeconds: hours * 3600 + minutes * 60 + seconds,
    speaker: match[4]!.trim(),
    text: match[5]!.trim(),
  };
}

/** Parse an entire transcript file or string. */
export function parseTranscript(input: string): ParsedTranscript {
  const rawLines = input.split("\n").filter((l) => l.trim().length > 0);
  const lines: TranscriptLine[] = [];

  for (const rawLine of rawLines) {
    const parsed = parseTranscriptLine(rawLine);
    if (parsed) lines.push(parsed);
  }

  const speakers = [...new Set(lines.map((l) => l.speaker))];
  const wordCount = lines.reduce((sum, l) => sum + l.text.split(/\s+/).length, 0);

  // Duration: difference between first and last timestamp
  let durationSeconds = 0;
  if (lines.length >= 2) {
    durationSeconds = lines[lines.length - 1]!.totalSeconds - lines[0]!.totalSeconds;
  }

  return { lines, speakers, durationSeconds, wordCount, rawText: input };
}

/** Read and parse a transcript file from disk. */
export function parseTranscriptFile(filePath: string): ParsedTranscript {
  const content = readFileSync(filePath, "utf-8");
  return parseTranscript(content);
}

/**
 * Format transcript as a clean string for AI processing.
 * Includes all lines with timestamps and speaker names.
 */
export function formatTranscriptForAI(transcript: ParsedTranscript): string {
  return transcript.lines
    .map((l) => `[${l.timestamp}] ${l.speaker}: ${l.text}`)
    .join("\n");
}

/**
 * Chunk a transcript into segments that fit within a token limit.
 * Uses a rough estimate of 4 characters per token.
 * Each chunk preserves complete lines (never splits mid-line).
 */
export function chunkTranscript(
  transcript: ParsedTranscript,
  maxCharsPerChunk: number = 30000,
): string[] {
  const chunks: string[] = [];
  let currentChunk = "";

  for (const line of transcript.lines) {
    const formattedLine = `[${line.timestamp}] ${line.speaker}: ${line.text}\n`;

    if (currentChunk.length + formattedLine.length > maxCharsPerChunk && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = "";
    }

    currentChunk += formattedLine;
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : ["(empty transcript)"];
}
