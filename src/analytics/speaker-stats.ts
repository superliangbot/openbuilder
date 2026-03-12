/**
 * speaker-stats.ts — Speaker talk-time analytics calculator
 *
 * Calculates per-speaker statistics from transcript data:
 * - Talk time (estimated from caption timestamps + text length)
 * - Percentage of meeting
 * - Word count
 */

import type { ParsedTranscript, TranscriptLine } from "../utils/transcript-parser.js";

export interface SpeakerStats {
  speaker: string;
  talkTimeSeconds: number;
  talkTimeFormatted: string;
  percentage: number;
  wordCount: number;
}

export interface MeetingAnalytics {
  speakers: SpeakerStats[];
  totalDurationSeconds: number;
  totalDurationFormatted: string;
  participantCount: number;
}

/**
 * Estimate talk time for each caption line.
 *
 * Strategy: For each speaker's line, estimate duration as the gap until the
 * next line (capped at 30s to avoid inflating during pauses). For the last
 * line, estimate based on word count (~150 words/minute speaking rate).
 */
function estimateLineDuration(lines: TranscriptLine[], index: number): number {
  const MAX_GAP_SECONDS = 30;
  const WORDS_PER_SECOND = 2.5; // ~150 words/minute

  if (index < lines.length - 1) {
    const gap = lines[index + 1]!.totalSeconds - lines[index]!.totalSeconds;
    return Math.min(Math.max(gap, 1), MAX_GAP_SECONDS);
  }

  // Last line: estimate from word count
  const wordCount = lines[index]!.text.split(/\s+/).length;
  return Math.max(Math.round(wordCount / WORDS_PER_SECOND), 1);
}

/** Format seconds as M:SS or H:MM:SS */
function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.round(totalSeconds % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Calculate speaker statistics from a parsed transcript. */
export function calculateSpeakerStats(transcript: ParsedTranscript): MeetingAnalytics {
  const speakerMap = new Map<string, { talkTimeSeconds: number; wordCount: number }>();

  for (let i = 0; i < transcript.lines.length; i++) {
    const line = transcript.lines[i]!;
    const duration = estimateLineDuration(transcript.lines, i);
    const wordCount = line.text.split(/\s+/).length;

    const existing = speakerMap.get(line.speaker) ?? { talkTimeSeconds: 0, wordCount: 0 };
    existing.talkTimeSeconds += duration;
    existing.wordCount += wordCount;
    speakerMap.set(line.speaker, existing);
  }

  // Calculate total talk time for percentage calculation
  let totalTalkTime = 0;
  for (const stats of speakerMap.values()) {
    totalTalkTime += stats.talkTimeSeconds;
  }

  // Use the greater of transcript duration or total talk time for meeting duration
  const totalDuration = Math.max(transcript.durationSeconds, totalTalkTime);

  const speakers: SpeakerStats[] = [];
  for (const [speaker, stats] of speakerMap.entries()) {
    speakers.push({
      speaker,
      talkTimeSeconds: stats.talkTimeSeconds,
      talkTimeFormatted: formatDuration(stats.talkTimeSeconds),
      percentage: totalDuration > 0 ? Math.round((stats.talkTimeSeconds / totalDuration) * 100) : 0,
      wordCount: stats.wordCount,
    });
  }

  // Sort by talk time descending
  speakers.sort((a, b) => b.talkTimeSeconds - a.talkTimeSeconds);

  return {
    speakers,
    totalDurationSeconds: totalDuration,
    totalDurationFormatted: formatDuration(totalDuration),
    participantCount: speakers.length,
  };
}
