#!/usr/bin/env npx tsx
/**
 * builder-summarize.ts — Run AI summary on a transcript file
 *
 * Usage:
 *   npx openbuilder summarize                        # summarize latest transcript
 *   npx openbuilder summarize /path/to/transcript.txt  # summarize specific file
 *
 * Works standalone on any transcript file in [HH:MM:SS] Speaker: text format.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

import { getConfig, TRANSCRIPTS_DIR } from "../src/utils/config.js";
import { parseTranscript, formatTranscriptForAI, chunkTranscript } from "../src/utils/transcript-parser.js";
import { ClaudeProvider } from "../src/ai/claude.js";
import { OpenAIProvider } from "../src/ai/openai.js";
import { getQuickSummaryPrompt } from "../src/ai/prompts.js";
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
      console.error("Provide a transcript path: npx openbuilder summarize /path/to/transcript.txt");
      process.exit(1);
    }
    filePath = latest;
  }

  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) {
    console.error("Transcript file is empty.");
    process.exit(1);
  }

  console.log(`Summarizing: ${filePath}\n`);

  const provider = getProvider();
  const transcript = parseTranscript(content);
  const chunks = chunkTranscript(transcript, 30000);

  let summary: string;

  if (chunks.length === 1) {
    const formatted = formatTranscriptForAI(transcript);
    summary = await provider.complete({
      messages: [
        { role: "system", content: "You are an expert meeting analyst. Write clear, professional summaries." },
        { role: "user", content: getQuickSummaryPrompt(formatted) },
      ],
      maxTokens: 2048,
      temperature: 0.3,
    });
  } else {
    // For long transcripts, summarize each chunk then combine
    const chunkSummaries: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Processing chunk ${i + 1}/${chunks.length}...`);
      const result = await provider.complete({
        messages: [
          { role: "system", content: "You are an expert meeting analyst. Write clear, professional summaries." },
          { role: "user", content: getQuickSummaryPrompt(chunks[i]!) },
        ],
        maxTokens: 2048,
        temperature: 0.3,
      });
      chunkSummaries.push(result);
    }

    summary = await provider.complete({
      messages: [
        { role: "system", content: "You are an expert meeting analyst. Combine these summaries into one cohesive summary." },
        {
          role: "user",
          content: `Combine these meeting summaries into a single 3-5 paragraph summary:\n\n${chunkSummaries.join("\n\n---\n\n")}`,
        },
      ],
      maxTokens: 2048,
      temperature: 0.3,
    });
  }

  console.log("---\n");
  console.log(summary);
  console.log("\n---");
  console.log(`\nTranscript: ${filePath}`);
  console.log(`Lines: ${transcript.lines.length}, Speakers: ${transcript.speakers.join(", ")}`);
}

const isMain = process.argv[1]?.endsWith("builder-summarize.ts");
if (isMain) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
