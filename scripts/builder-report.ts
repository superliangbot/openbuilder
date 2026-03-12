#!/usr/bin/env npx tsx
/**
 * builder-report.ts — Generate a full AI meeting report
 *
 * Usage:
 *   npx openbuilder report                          # report on latest transcript
 *   npx openbuilder report /path/to/transcript.txt  # report on specific file
 *
 * Generates: summary, chapters, action items, key decisions, key questions,
 * and speaker analytics. Output is a markdown report saved to disk.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { getConfig, TRANSCRIPTS_DIR, REPORTS_DIR, ensureDirs } from "../src/utils/config.js";
import { parseTranscript, formatTranscriptForAI, chunkTranscript } from "../src/utils/transcript-parser.js";
import { ClaudeProvider } from "../src/ai/claude.js";
import { OpenAIProvider } from "../src/ai/openai.js";
import { getMeetingAnalysisPrompt, getMergeAnalysisPrompt } from "../src/ai/prompts.js";
import { calculateSpeakerStats } from "../src/analytics/speaker-stats.js";
import { parseAnalysisResponse, generateReport } from "../src/report/generator.js";
import type { AIProvider } from "../src/ai/provider.js";

function findLatestTranscript(): string | null {
  if (!existsSync(TRANSCRIPTS_DIR)) return null;

  const files = readdirSync(TRANSCRIPTS_DIR)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => ({
      path: `${TRANSCRIPTS_DIR}/${f}`,
      mtime: statSync(`${TRANSCRIPTS_DIR}/${f}`).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? files[0]!.path : null;
}

function getProvider(): AIProvider {
  const config = getConfig();

  if (config.aiProvider === "openai" && config.openaiApiKey) {
    return new OpenAIProvider();
  }
  if (config.anthropicApiKey) {
    return new ClaudeProvider();
  }
  if (config.openaiApiKey) {
    return new OpenAIProvider();
  }

  console.error("No AI API key configured.");
  console.error("Set one of these environment variables or use `openbuilder config`:");
  console.error("  ANTHROPIC_API_KEY=your-key");
  console.error("  OPENAI_API_KEY=your-key");
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const transcriptPath = args.find((a) => !a.startsWith("--"));

  let filePath: string;
  if (transcriptPath) {
    if (!existsSync(transcriptPath)) {
      console.error(`File not found: ${transcriptPath}`);
      process.exit(1);
    }
    filePath = transcriptPath;
  } else {
    const latest = findLatestTranscript();
    if (!latest) {
      console.error("No transcript files found.");
      console.error("Provide a transcript path: npx openbuilder report /path/to/transcript.txt");
      process.exit(1);
    }
    filePath = latest;
  }

  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) {
    console.error("Transcript file is empty.");
    process.exit(1);
  }

  ensureDirs();

  console.log(`Generating meeting report for: ${filePath}\n`);

  const provider = getProvider();
  const transcript = parseTranscript(content);
  const analytics = calculateSpeakerStats(transcript);

  // Run AI analysis
  const chunks = chunkTranscript(transcript, 30000);
  let analysisResponse: string;

  if (chunks.length === 1) {
    console.log("Analyzing transcript...");
    const formatted = formatTranscriptForAI(transcript);
    analysisResponse = await provider.complete({
      messages: [
        { role: "system", content: "You are an expert meeting analyst. Return only valid JSON." },
        { role: "user", content: getMeetingAnalysisPrompt(formatted) },
      ],
      maxTokens: 4096,
      temperature: 0.3,
    });
  } else {
    const chunkResults: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Analyzing chunk ${i + 1}/${chunks.length}...`);
      const result = await provider.complete({
        messages: [
          { role: "system", content: "You are an expert meeting analyst. Return only valid JSON." },
          {
            role: "user",
            content: getMeetingAnalysisPrompt(chunks[i]!, `chunk ${i + 1} of ${chunks.length}`),
          },
        ],
        maxTokens: 4096,
        temperature: 0.3,
      });
      chunkResults.push(result);
    }

    console.log("Merging analyses...");
    analysisResponse = await provider.complete({
      messages: [
        { role: "system", content: "You are an expert meeting analyst. Return only valid JSON." },
        { role: "user", content: getMergeAnalysisPrompt(chunkResults) },
      ],
      maxTokens: 4096,
      temperature: 0.3,
    });
  }

  const analysis = parseAnalysisResponse(analysisResponse);

  // Derive meeting ID from filename
  const meetingId = basename(filePath, ".txt");

  const report = generateReport({
    meetingId,
    date: new Date().toISOString().split("T")[0],
    transcriptPath: filePath,
    analysis,
    analytics,
  });

  // Save report
  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = `${REPORTS_DIR}/${meetingId}-report.md`;
  writeFileSync(reportPath, report);

  console.log("\n" + report);
  console.log(`\nReport saved to: ${reportPath}`);
}

const isMain = process.argv[1]?.endsWith("builder-report.ts");
if (isMain) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
