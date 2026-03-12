#!/usr/bin/env npx tsx
/**
 * builder-transcript.ts — Print the latest transcript from a meeting
 *
 * Usage:
 *   npx openbuilder transcript
 *   npx openbuilder transcript --last 20
 *
 * Finds the most recent transcript file and prints its contents.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { TRANSCRIPTS_DIR } from "../src/utils/config.js";

function main() {
  const args = process.argv.slice(2);
  const lastIdx = args.indexOf("--last");
  const lastN = lastIdx >= 0 ? parseInt(args[lastIdx + 1] ?? "0", 10) : 0;

  if (!existsSync(TRANSCRIPTS_DIR)) {
    console.error("No transcripts directory found. Is the bot running in a meeting?");
    process.exit(1);
  }

  const files = readdirSync(TRANSCRIPTS_DIR)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => ({
      name: f,
      path: `${TRANSCRIPTS_DIR}/${f}`,
      mtime: statSync(`${TRANSCRIPTS_DIR}/${f}`).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) {
    console.error("No transcript files found. Captions may not have been captured yet.");
    console.error("Make sure the bot is in a meeting and captions are enabled.");
    process.exit(1);
  }

  const latest = files[0]!;
  const content = readFileSync(latest.path, "utf-8").trim();

  if (!content) {
    console.log(`[OPENBUILDER_TRANSCRIPT] ${latest.path}`);
    console.log("\n(No captions captured yet — is someone speaking?)");
    return;
  }

  const lines = content.split("\n");

  console.log(`[OPENBUILDER_TRANSCRIPT] ${latest.path}`);
  console.log(`Transcript: ${latest.name} (${lines.length} lines)\n`);

  if (lastN > 0 && lines.length > lastN) {
    console.log(`(showing last ${lastN} of ${lines.length} lines)\n`);
    console.log(lines.slice(-lastN).join("\n"));
  } else {
    console.log(content);
  }
}

main();
