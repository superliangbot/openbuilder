import { getAccessToken } from "../src/readai/auth.js";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const REPORTS_DIR = join(homedir(), ".openclaw/workspace/openbuilder/reports");
const TRANSCRIPTS_DIR = join(homedir(), ".openclaw/workspace/openbuilder/transcripts");
mkdirSync(REPORTS_DIR, { recursive: true });
mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

interface McpMeeting {
  id: string;
  title?: string;
  start_time_ms: number;
  end_time_ms?: number;
  participants?: any[];
  owner?: any;
  platform?: string;
  report_url?: string;
  summary?: string;
  action_items?: string[];
  key_questions?: string[];
  topics?: string[];
  transcript?: any;
  metrics?: any;
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
  // Parse SSE response
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error(`No data in MCP response: ${text.slice(0, 200)}`);
  const json = JSON.parse(dataLine.slice(5));
  const content = json.result?.content?.[0]?.text;
  if (!content) throw new Error(`No content in MCP result: ${JSON.stringify(json).slice(0, 200)}`);
  return JSON.parse(content);
}

async function syncAll() {
  const token = await getAccessToken();
  let cursor: string | null = null;
  let totalFound = 0;
  let newSynced = 0;
  let page = 0;

  while (true) {
    page++;
    const args: Record<string, unknown> = { limit: 10 };
    if (cursor) args.cursor = cursor;

    console.log(`Page ${page} (cursor=${cursor || "start"})...`);
    const data = await mcpCall(token, "list_meetings", args);
    const meetings: McpMeeting[] = data.data || [];

    if (meetings.length === 0) break;

    for (const m of meetings) {
      totalFound++;
      const safeId = m.id;
      const dataPath = join(REPORTS_DIR, `readai-${safeId}-data.json`);

      if (existsSync(dataPath)) {
        const dt = new Date(m.start_time_ms).toISOString().slice(0, 10);
        console.log(`  Skip: ${dt} | ${m.title || m.id}`);
        cursor = m.id;
        continue;
      }

      // Fetch full meeting with expand
      try {
        const dt = new Date(m.start_time_ms).toISOString().slice(0, 10);
        console.log(`  Fetch: ${dt} | ${m.title || m.id}`);

        const detail = await mcpCall(token, "get_meeting_by_id", {
          id: m.id,
          expand: ["summary", "chapter_summaries", "action_items", "key_questions", "topics", "transcript", "metrics", "recording_download"],
        });

        // Save full data
        writeFileSync(dataPath, JSON.stringify(detail, null, 2));

        // Save transcript
        if (detail.transcript?.turns?.length) {
          const transcript = detail.transcript.turns
            .map((t: any) => `${t.speaker?.name || "Unknown"}: ${t.text}`)
            .join("\n");
          writeFileSync(join(TRANSCRIPTS_DIR, `readai-${safeId}.txt`), transcript);
          console.log(`    → transcript (${detail.transcript.turns.length} turns)`);
        }

        // Save report
        const lines: string[] = [];
        lines.push(`# ${detail.title || m.id}`);
        lines.push(`\n**Date:** ${dt}`);
        if (detail.summary) lines.push(`\n## Summary\n${detail.summary}`);
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
        writeFileSync(join(REPORTS_DIR, `readai-${safeId}-report.md`), lines.join("\n"));
        newSynced++;
      } catch (err: any) {
        console.error(`  ❌ ${m.id}: ${err.message.slice(0, 100)}`);
      }

      cursor = m.id;
    }

    if (!data.has_more) break;
  }

  console.log(`\nDone! ${newSynced} new meetings synced, ${totalFound} total found.`);
}

syncAll();
