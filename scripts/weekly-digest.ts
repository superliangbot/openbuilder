#!/usr/bin/env tsx
/**
 * weekly-digest.ts — Generate and optionally save a weekly meeting digest.
 *
 * Usage:
 *   npx tsx scripts/weekly-digest.ts [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--save]
 */

import { openDb, initSchema } from "../src/db/schema.js";
import { generateWeeklyDigest } from "../src/digest.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Parse flags
const flags: Record<string, string> = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith("--")) {
    const key = arg.slice(2);
    flags[key] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
  }
}

const db = openDb();
initSchema(db);

const digest = generateWeeklyDigest(db, {
  since: flags.since,
  until: flags.until,
});

db.close();

if (!digest) {
  console.log("No meetings found in the last 7 days.");
  process.exit(0);
}

console.log(digest);

if (flags.save === "true") {
  const digestsDir = join(homedir(), ".openbuilder", "digests");
  mkdirSync(digestsDir, { recursive: true });

  // Determine ISO week: YYYY-WW
  const since = flags.since
    ? new Date(flags.since)
    : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const year = since.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const dayOfYear = Math.floor((since.getTime() - jan1.getTime()) / 86400000) + 1;
  const week = String(Math.ceil(dayOfYear / 7)).padStart(2, "0");
  const filename = `${year}-${week}.md`;

  const filePath = join(digestsDir, filename);
  writeFileSync(filePath, digest);
  console.log(`\nSaved to: ${filePath}`);
}
