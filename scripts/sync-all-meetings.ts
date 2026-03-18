import { listMeetings, getMeeting } from "../src/readai/client.js";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const REPORTS_DIR = join(homedir(), ".openclaw/workspace/openbuilder/reports");
const TRANSCRIPTS_DIR = join(homedir(), ".openclaw/workspace/openbuilder/transcripts");
mkdirSync(REPORTS_DIR, { recursive: true });
mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

async function syncAll() {
  let offset = 0;
  let total = 0;
  let synced = 0;

  while (true) {
    console.log(`Fetching meetings offset=${offset}...`);
    const res = await listMeetings({ limit: 10, offset, start_date: "2024-01-01" });
    const meetings = res.meetings || [];

    if (meetings.length === 0) break;

    for (const m of meetings) {
      total++;
      const safeId = m.id.replace(/[^a-zA-Z0-9_-]/g, "_");
      const dataPath = join(REPORTS_DIR, `readai-${safeId}-data.json`);

      if (existsSync(dataPath)) {
        console.log(`  Skip: ${m.title || m.id}`);
        continue;
      }

      try {
        console.log(`  Fetching: ${m.title || m.id}`);
        const detail = await getMeeting(m.id);

        writeFileSync(dataPath, JSON.stringify(detail, null, 2));

        if ((detail as any).transcript?.length) {
          const entries = (detail as any).transcript as any[];
          const transcript = entries.map((e: any) => {
            const speaker = e.speaker || "Unknown";
            const time = e.start_time || "";
            return time ? `[${time}] ${speaker}: ${e.text}` : `${speaker}: ${e.text}`;
          }).join("\n");
          writeFileSync(join(TRANSCRIPTS_DIR, `readai-${safeId}.txt`), transcript);
          console.log(`    → transcript (${entries.length} entries)`);
        }

        const lines: string[] = [];
        lines.push(`# ${(detail as any).title || m.id}`);
        if ((detail as any).summary) lines.push(`\n## Summary\n${(detail as any).summary}`);
        if ((detail as any).action_items?.length) {
          lines.push("\n## Action Items");
          (detail as any).action_items.forEach((ai: any) =>
            lines.push(`- ${ai.text}${ai.assignee ? ` (${ai.assignee})` : ""}`)
          );
        }
        writeFileSync(join(REPORTS_DIR, `readai-${safeId}-report.md`), lines.join("\n"));
        synced++;
      } catch (err: any) {
        console.error(`  ❌ ${m.id}: ${err.message}`);
      }
    }

    if (!(res as any).has_more) break;
    offset += meetings.length;
  }

  console.log(`\nDone! ${synced} new meetings synced, ${total} total found.`);
}

syncAll();
