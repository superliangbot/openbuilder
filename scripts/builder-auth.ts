#!/usr/bin/env npx tsx
/**
 * builder-auth.ts — Automated Google sign-in via Playwright
 *
 * Usage:
 *   npx openbuilder auth              # Interactive (headed browser)
 *   npx openbuilder auth --auto       # Automated using GOOGLE_EMAIL + GOOGLE_PASSWORD from .env
 *
 * Saves session to ~/.openbuilder/auth.json via Playwright's storageState.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { config as dotenvConfig } from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTH_FILE,
  AUTH_META_FILE,
  OPENBUILDER_DIR,
} from "../src/utils/config.js";

// Load .env from project root
const __dirname2 = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: join(__dirname2, "..", ".env") });

type PlaywrightMod = typeof import("playwright-core");
type Page = import("playwright-core").Page;

async function waitForEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function autoSignIn(page: Page, email: string, password: string): Promise<boolean> {
  console.log("Navigating to Google sign-in...");
  await page.goto("https://accounts.google.com/signin", { waitUntil: "domcontentloaded" });
  await sleep(2000);

  // Screenshot for debugging
  const ssDir = join(OPENBUILDER_DIR, "auth-debug");
  mkdirSync(ssDir, { recursive: true });

  // Enter email
  console.log("Entering email...");
  const emailInput = page.locator('input[type="email"]');
  await emailInput.waitFor({ state: "visible", timeout: 15000 });
  await emailInput.fill(email);
  await sleep(500);

  // Click Next
  const nextBtn = page.locator('#identifierNext button, button:has-text("Next")').first();
  await nextBtn.click();
  await sleep(3000);

  await page.screenshot({ path: join(ssDir, "after-email.png") });

  // Check for CAPTCHA or challenge
  const pageText = await page.textContent("body").catch(() => "");
  if (pageText?.includes("Verify it's you") || pageText?.includes("confirm your identity")) {
    console.error("\n⚠️  Google is requesting additional verification (CAPTCHA/challenge).");
    console.error("You may need to run `npx openbuilder auth` interactively (without --auto).");
    await page.screenshot({ path: join(ssDir, "challenge.png") });
    return false;
  }

  // Enter password
  console.log("Entering password...");
  const passwordInput = page.locator('input[type="password"]');
  try {
    await passwordInput.waitFor({ state: "visible", timeout: 10000 });
  } catch {
    console.error("Password field not found. Google may be showing a challenge.");
    await page.screenshot({ path: join(ssDir, "no-password-field.png") });
    return false;
  }
  await passwordInput.fill(password);
  await sleep(500);

  // Click Next for password
  const passNext = page.locator('#passwordNext button, button:has-text("Next")').first();
  await passNext.click();
  await sleep(5000);

  await page.screenshot({ path: join(ssDir, "after-password.png") });

  // Check if we landed on myaccount or got challenged
  const url = page.url();
  const bodyText = await page.textContent("body").catch(() => "");

  if (url.includes("myaccount.google.com") || url.includes("accounts.google.com/signin/v2/challenge") === false) {
    // Try navigating to myaccount to confirm
    await page.goto("https://myaccount.google.com", { waitUntil: "domcontentloaded", timeout: 15000 });
    await sleep(2000);
    await page.screenshot({ path: join(ssDir, "myaccount.png") });

    const finalUrl = page.url();
    if (finalUrl.includes("myaccount.google.com") && !finalUrl.includes("signin")) {
      console.log("✅ Sign-in successful!");
      return true;
    }
  }

  // Check for 2FA
  if (bodyText?.includes("2-Step Verification") || bodyText?.includes("Verify it")) {
    console.error("\n⚠️  2-Step Verification required.");
    console.error("Either disable 2FA on this account or use interactive mode.");
    await page.screenshot({ path: join(ssDir, "2fa.png") });
    return false;
  }

  // Check for wrong password
  if (bodyText?.includes("Wrong password") || bodyText?.includes("Couldn't sign you in")) {
    console.error("\n❌ Wrong password or sign-in rejected.");
    await page.screenshot({ path: join(ssDir, "wrong-password.png") });
    return false;
  }

  // Might have succeeded anyway — try to save
  console.log("Sign-in status unclear, attempting to save session...");
  await page.screenshot({ path: join(ssDir, "unclear.png") });
  return true;
}

async function main() {
  mkdirSync(OPENBUILDER_DIR, { recursive: true });

  const args = process.argv.slice(2);
  const autoMode = args.includes("--auto");
  const headed = args.includes("--headed") || !autoMode; // Auto mode can run headless

  let pw: PlaywrightMod;
  try {
    pw = await import("playwright-core");
  } catch {
    console.error("playwright-core not found. Run `npm install`.");
    process.exit(1);
  }

  console.log("OpenBuilder — Google Account Login\n");

  if (existsSync(AUTH_FILE)) {
    console.log(`Existing auth found at ${AUTH_FILE}`);
    console.log("This will overwrite it with a new session.\n");
  }

  // For auto mode on headless server, use Xvfb
  const headless = !headed;
  const chromiumArgs = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,720",
  ];

  // Find full Chrome for headed mode
  let executablePath: string | undefined;
  const fullChromePath = join(
    process.env.HOME || "~",
    ".cache/ms-playwright/chromium-1208/chrome-linux64/chrome"
  );
  if (existsSync(fullChromePath)) {
    executablePath = fullChromePath;
  }

  const browser = await pw.chromium.launch({
    headless,
    executablePath,
    args: chromiumArgs,
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  let email = "unknown";

  if (autoMode) {
    const gEmail = process.env.GOOGLE_EMAIL;
    const gPassword = process.env.GOOGLE_PASSWORD;

    if (!gEmail || !gPassword) {
      console.error("--auto requires GOOGLE_EMAIL and GOOGLE_PASSWORD in .env");
      await browser.close();
      process.exit(1);
    }

    console.log(`Attempting automated sign-in for ${gEmail}...\n`);
    const success = await autoSignIn(page, gEmail, gPassword);

    if (!success) {
      console.error("\nAutomated sign-in failed. Check screenshots in ~/.openbuilder/auth-debug/");
      await browser.close();
      process.exit(1);
    }

    email = gEmail;
  } else {
    // Interactive mode
    await page.goto("https://accounts.google.com", { waitUntil: "domcontentloaded" });
    console.log("Browser opened — sign into Google now.\n");
    await waitForEnter("Press Enter after you've signed in to Google... ");

    // Extract email
    try {
      await page.goto("https://myaccount.google.com", { waitUntil: "domcontentloaded", timeout: 10000 });
      await sleep(2000);
      email = await page.evaluate(() => {
        const emailEl = document.querySelector("[data-email]");
        if (emailEl) return emailEl.getAttribute("data-email") || "";
        const profileBtn = document.querySelector('[aria-label*="@"]');
        if (profileBtn) {
          const match = profileBtn.getAttribute("aria-label")?.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
          if (match) return match[0];
        }
        return "";
      });
    } catch { /* not critical */ }
  }

  if (email && email !== "unknown") {
    console.log(`\nSigned in as: ${email}`);
  }

  // Save session
  await context.storageState({ path: AUTH_FILE });
  console.log(`Session saved to ${AUTH_FILE}`);

  const meta = { email: email || "unknown", savedAt: new Date().toISOString() };
  writeFileSync(AUTH_META_FILE, JSON.stringify(meta, null, 2));

  try {
    const state = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    const cookieCount = state.cookies?.length ?? 0;
    const originCount = state.origins?.length ?? 0;
    console.log(`  ${cookieCount} cookies, ${originCount} origins saved`);
  } catch { /* not critical */ }

  await browser.close();

  console.log("\nDone! The bot will now join meetings as an authenticated user.");
  console.log("Run: npx openbuilder join <meet-url> --auth");
}

const isMain = process.argv[1]?.endsWith("builder-auth.ts");
if (isMain) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
