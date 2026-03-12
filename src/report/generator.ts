/**
 * generator.ts — Meeting report generation
 *
 * Combines AI analysis results with speaker analytics to produce
 * a structured markdown meeting report.
 */

import type { MeetingAnalytics } from "../analytics/speaker-stats.js";

export interface MeetingAnalysis {
  summary: string;
  chapters: Array<{ timestamp: string; title: string; description: string }>;
  actionItems: Array<{ description: string; assignee: string | null }>;
  keyDecisions: string[];
  keyQuestions: Array<{ question: string; status: string }>;
}

export interface ReportOptions {
  meetingId?: string;
  date?: string;
  transcriptPath?: string;
  analysis: MeetingAnalysis;
  analytics: MeetingAnalytics;
}

/** Parse the JSON response from AI into a MeetingAnalysis object. */
export function parseAnalysisResponse(response: string): MeetingAnalysis {
  // Strip markdown fences if the AI included them
  let cleaned = response.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }

  const parsed = JSON.parse(cleaned) as Record<string, unknown>;

  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    chapters: Array.isArray(parsed.chapters)
      ? parsed.chapters.map((c: Record<string, unknown>) => ({
          timestamp: String(c.timestamp ?? ""),
          title: String(c.title ?? ""),
          description: String(c.description ?? ""),
        }))
      : [],
    actionItems: Array.isArray(parsed.actionItems)
      ? parsed.actionItems.map((a: Record<string, unknown>) => ({
          description: String(a.description ?? ""),
          assignee: a.assignee ? String(a.assignee) : null,
        }))
      : [],
    keyDecisions: Array.isArray(parsed.keyDecisions)
      ? parsed.keyDecisions.map((d: unknown) => String(d))
      : [],
    keyQuestions: Array.isArray(parsed.keyQuestions)
      ? parsed.keyQuestions.map((q: Record<string, unknown>) => ({
          question: String(q.question ?? ""),
          status: String(q.status ?? "unknown"),
        }))
      : [],
  };
}

/** Generate a formatted markdown meeting report. */
export function generateReport(options: ReportOptions): string {
  const { analysis, analytics, meetingId, date, transcriptPath } = options;
  const reportDate = date ?? new Date().toISOString().split("T")[0]!;
  const title = meetingId ? `${meetingId} — ${reportDate}` : reportDate;

  const lines: string[] = [];

  lines.push(`# Meeting Report: ${title}`);
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push(analysis.summary || "(No summary generated)");
  lines.push("");

  // Chapters
  if (analysis.chapters.length > 0) {
    lines.push("## Chapters");
    lines.push("");
    for (let i = 0; i < analysis.chapters.length; i++) {
      const ch = analysis.chapters[i]!;
      lines.push(`${i + 1}. [${ch.timestamp}] ${ch.title} — ${ch.description}`);
    }
    lines.push("");
  }

  // Action Items
  if (analysis.actionItems.length > 0) {
    lines.push("## Action Items");
    lines.push("");
    for (const item of analysis.actionItems) {
      const assignee = item.assignee ? ` (@${item.assignee})` : "";
      lines.push(`- [ ] ${item.description}${assignee}`);
    }
    lines.push("");
  }

  // Key Decisions
  if (analysis.keyDecisions.length > 0) {
    lines.push("## Key Decisions");
    lines.push("");
    for (const decision of analysis.keyDecisions) {
      lines.push(`- ${decision}`);
    }
    lines.push("");
  }

  // Key Questions
  if (analysis.keyQuestions.length > 0) {
    lines.push("## Key Questions");
    lines.push("");
    for (const q of analysis.keyQuestions) {
      lines.push(`- ${q.question} (${q.status})`);
    }
    lines.push("");
  }

  // Speaker Analytics
  if (analytics.speakers.length > 0) {
    lines.push("## Speaker Analytics");
    lines.push("");
    lines.push("| Speaker | Talk Time | % of Meeting | Words |");
    lines.push("|---------|-----------|--------------|-------|");
    for (const speaker of analytics.speakers) {
      lines.push(
        `| ${speaker.speaker} | ${speaker.talkTimeFormatted} | ${speaker.percentage}% | ${speaker.wordCount.toLocaleString()} |`,
      );
    }
    lines.push("");
  }

  // Metadata
  lines.push("## Metadata");
  lines.push("");
  lines.push(`- Duration: ${analytics.totalDurationFormatted}`);
  lines.push(`- Participants: ${analytics.participantCount}`);
  if (transcriptPath) {
    lines.push(`- Transcript: ${transcriptPath}`);
  }
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Powered by: OpenBuilder (https://github.com/superliangbot/openbuilder)`);
  lines.push("");

  return lines.join("\n");
}
