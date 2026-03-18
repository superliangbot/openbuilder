import { getAccessToken } from "../src/readai/auth.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const REPORTS_DIR = join(homedir(), ".openclaw/workspace/openbuilder/reports");
const TRANSCRIPTS_DIR = join(homedir(), ".openclaw/workspace/openbuilder/transcripts");

const meetingId = process.argv[2];
if (!meetingId) {
  console.error("Usage: npx tsx scripts/resync-meeting.ts <MEETING_ID>");
  process.exit(1);
}

async function mcpCall(token: string, toolName: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch("https://api.read.ai/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error(`No data in MCP response`);
  const json = JSON.parse(dataLine.slice(5));
  const content = json.result?.content?.[0]?.text;
  if (!content) throw new Error(`No content in MCP result`);
  return JSON.parse(content);
}

async function main() {
  const token = await getAccessToken();
  console.log(`Fetching meeting ${meetingId} with ALL expand fields...`);

  const detail = await mcpCall(token, "get_meeting_by_id", {
    id: meetingId,
    expand: ["summary", "chapter_summaries", "action_items", "key_questions", "topics", "transcript", "metrics", "recording_download"],
  });

  // Report what we got
  for (const [k, v] of Object.entries(detail)) {
    if (v === null || v === undefined) console.log(`  ${k}: None`);
    else if (Array.isArray(v)) console.log(`  ${k}: list[${v.length}]`);
    else if (typeof v === "string" && v.length > 200) console.log(`  ${k}: str(${v.length} chars)`);
    else if (typeof v === "object") console.log(`  ${k}: dict(${Object.keys(v).join(",")})`);
    else console.log(`  ${k}: ${String(v).slice(0, 80)}`);
  }

  // Save
  writeFileSync(join(REPORTS_DIR, `readai-${meetingId}-data.json`), JSON.stringify(detail, null, 2));

  if (detail.transcript?.turns?.length) {
    const transcript = detail.transcript.turns
      .map((t: any) => `${t.speaker?.name || "Unknown"}: ${t.text}`)
      .join("\n");
    writeFileSync(join(TRANSCRIPTS_DIR, `readai-${meetingId}.txt`), transcript);
    console.log(`  → transcript saved (${detail.transcript.turns.length} turns)`);
  }

  // Rich report
  const lines: string[] = [];
  const dt = new Date(detail.start_time_ms).toISOString().slice(0, 10);
  lines.push(`# ${detail.title || meetingId}`);
  lines.push(`\n**Date:** ${dt}`);

  if (detail.metrics) {
    lines.push(`\n## Metrics`);
    lines.push(`- Read Score: ${detail.metrics.read_score ?? "N/A"}`);
    lines.push(`- Engagement: ${detail.metrics.engagement ?? "N/A"}`);
    lines.push(`- Sentiment: ${detail.metrics.sentiment ?? "N/A"}`);
  }

  if (detail.summary) lines.push(`\n## Summary\n${detail.summary}`);

  if (detail.chapter_summaries?.length) {
    lines.push("\n## Chapters");
    detail.chapter_summaries.forEach((ch: any) => {
      lines.push(`\n### ${ch.title || "Untitled"}`);
      if (ch.description) lines.push(ch.description);
    });
  }

  if (detail.action_items?.length) {
    lines.push("\n## Action Items");
    detail.action_items.forEach((ai: string) => lines.push(`- ${ai}`));
  }

  if (detail.key_questions?.length) {
    lines.push("\n## Key Questions");
    detail.key_questions.forEach((q: string) => lines.push(`- ${q}`));
  }

  if (detail.topics?.length) {
    lines.push("\n## Topics");
    detail.topics.forEach((t: string) => lines.push(`- ${t}`));
  }

  writeFileSync(join(REPORTS_DIR, `readai-${meetingId}-report.md`), lines.join("\n"));
  console.log("\nDone! Full report saved.");
}

main();
