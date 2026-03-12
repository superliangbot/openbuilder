#!/usr/bin/env npx tsx
/**
 * builder-screenshot.ts — Request an on-demand screenshot from a running bot
 *
 * Usage:
 *   npx openbuilder screenshot
 *
 * Sends SIGUSR1 to the running builder-join process, waits for the
 * screenshot to be saved, and prints the path.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { PID_FILE, SCREENSHOT_READY_FILE } from "../src/utils/config.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!existsSync(PID_FILE)) {
    console.error("No running OpenBuilder bot found (missing PID file).");
    console.error("Start a meeting first: npx openbuilder join <url> --auth|--anon");
    process.exit(1);
  }

  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid)) {
    console.error("Invalid PID file contents.");
    process.exit(1);
  }

  try {
    process.kill(pid, 0);
  } catch {
    console.error(`OpenBuilder process (PID ${pid}) is not running.`);
    try {
      unlinkSync(PID_FILE);
    } catch {
      /* ignore */
    }
    process.exit(1);
  }

  try {
    if (existsSync(SCREENSHOT_READY_FILE)) unlinkSync(SCREENSHOT_READY_FILE);
  } catch {
    /* ignore */
  }

  console.log(`Requesting screenshot from OpenBuilder (PID ${pid})...`);
  process.kill(pid, "SIGUSR1");

  const timeoutMs = 10_000;
  const pollMs = 500;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (existsSync(SCREENSHOT_READY_FILE)) {
      try {
        const data = JSON.parse(readFileSync(SCREENSHOT_READY_FILE, "utf-8")) as {
          path: string;
          timestamp: number;
        };
        console.log(`[OPENBUILDER_SCREENSHOT] ${data.path}`);
        return;
      } catch {
        // File partially written, retry
      }
    }
    await sleep(pollMs);
  }

  console.error("Timed out waiting for screenshot (10s).");
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
