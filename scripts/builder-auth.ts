#!/usr/bin/env npx tsx
/**
 * builder-auth.ts — Sign into Google via Playwright for authenticated joins
 *
 * Usage:
 *   npx openbuilder auth
 *
 * Opens a headed Chromium browser at accounts.google.com. Sign in manually,
 * then press Enter. The browser session (cookies + localStorage) is saved
 * to ~/.openbuilder/auth.json via Playwright's storageState.
 *
 * No OAuth client_secret.json or setup required.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import {
  AUTH_FILE,
  AUTH_META_FILE,
  OPENBUILDER_DIR,
} from "../src/utils/config.js";

async function waitForEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  mkdirSync(OPENBUILDER_DIR, { recursive: true });

  let pw: typeof import("playwright-core");
  try {
    pw = await import("playwright-core");
  } catch {
    console.error("playwright-core not found. Run `npm install` or use `npx openbuilder auth`.");
    process.exit(1);
  }

  console.log("OpenBuilder — Google Account Login\n");

  if (existsSync(AUTH_FILE)) {
    console.log(`Existing auth found at ${AUTH_FILE}`);
    console.log("This will overwrite it with a new session.\n");
  }

  console.log("A browser window will open. Sign into your Google account,");
  console.log("then come back here and press Enter to save the session.\n");

  const browser = await pw.chromium.launch({
    headless: false,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,720",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  await page.goto("https://accounts.google.com", { waitUntil: "domcontentloaded" });

  console.log("Browser opened — sign into Google now.\n");

  await waitForEnter("Press Enter after you've signed in to Google... ");

  // Extract signed-in email (best-effort)
  let email = "unknown";
  try {
    await page.goto("https://myaccount.google.com", { waitUntil: "domcontentloaded", timeout: 10_000 });
    await page.waitForTimeout(2000);

    email = await page.evaluate(() => {
      const emailEl = document.querySelector("[data-email]");
      if (emailEl) return emailEl.getAttribute("data-email") || "";

      const profileBtn = document.querySelector('[aria-label*="@"]');
      if (profileBtn) {
        const match = profileBtn.getAttribute("aria-label")?.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
        if (match) return match[0];
      }

      const bodyText = document.body.innerText || "";
      const match = bodyText.match(/[\w.+-]+@(gmail|googlemail|google)\.[\w.]+/);
      return match ? match[0] : "";
    });
  } catch {
    // Not critical
  }

  if (email && email !== "unknown") {
    console.log(`\nSigned in as: ${email}`);
  } else {
    console.log("\nCould not detect email — session will still be saved.");
  }

  await context.storageState({ path: AUTH_FILE });
  console.log(`Session saved to ${AUTH_FILE}`);

  const meta = { email: email || "unknown", savedAt: new Date().toISOString() };
  writeFileSync(AUTH_META_FILE, JSON.stringify(meta, null, 2));

  try {
    const state = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    const cookieCount = state.cookies?.length ?? 0;
    const originCount = state.origins?.length ?? 0;
    console.log(`  ${cookieCount} cookies, ${originCount} origins saved`);
  } catch {
    // Not critical
  }

  await browser.close();

  console.log("\nDone! The bot will now join meetings as an authenticated user.");
  console.log("Run: npx openbuilder join <meet-url> --auth");
  console.log('\nTo join as a guest instead: npx openbuilder join <meet-url> --anon --bot-name "OpenBuilder Bot"');
  console.log("If the session expires, re-run this command to sign in again.");
}

const isMain = process.argv[1]?.endsWith("builder-auth.ts");
if (isMain) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
