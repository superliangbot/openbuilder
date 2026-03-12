#!/usr/bin/env npx tsx
/**
 * builder-join.ts — Join a Google Meet meeting and capture live captions
 *
 * Usage:
 *   npx openbuilder join <meet-url> --auth
 *   npx openbuilder join <meet-url> --anon --bot-name "OpenBuilder Bot"
 *   npx openbuilder join <meet-url> --auth --duration 60m
 *
 * Extends OpenUtter patterns with OpenBuilder's AI report generation.
 * When a meeting ends, automatically generates an AI-powered report
 * if an API key is configured.
 */

import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  AUTH_FILE,
  OPENBUILDER_DIR,
  PID_FILE,
  SCREENSHOT_READY_FILE,
  TRANSCRIPTS_DIR,
  WORKSPACE_DIR,
  getConfig,
  ensureDirs,
} from "../src/utils/config.js";

type PlaywrightMod = typeof import("playwright-core");
type Page = import("playwright-core").Page;
type BrowserContext = import("playwright-core").BrowserContext;

// ── Send image/message to user's chat via openclaw ──────────────────────

function sendImage(opts: {
  channel?: string;
  target?: string;
  message: string;
  mediaPath: string;
}): void {
  if (opts.channel && opts.target) {
    try {
      execSync(
        `openclaw message send --channel ${opts.channel} --target ${JSON.stringify(opts.target)} --message ${JSON.stringify(opts.message)} --media ${JSON.stringify(opts.mediaPath)}`,
        { stdio: "inherit", timeout: 30_000 },
      );
    } catch (err) {
      console.error("Failed to send image:", err instanceof Error ? err.message : String(err));
    }
  }
}

function sendMessage(opts: { channel?: string; target?: string; message: string }): void {
  if (opts.channel && opts.target) {
    try {
      execSync(
        `openclaw message send --channel ${opts.channel} --target ${JSON.stringify(opts.target)} --message ${JSON.stringify(opts.message)}`,
        { stdio: "inherit", timeout: 30_000 },
      );
    } catch {
      // Best-effort
    }
  }
}

// ── CLI parsing ────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const meetUrl = args.find((a) => !a.startsWith("--"));
  const headed = args.includes("--headed");
  const useAuth = args.includes("--auth");
  const useAnon = args.includes("--anon");
  const noCamera = !args.includes("--camera");
  const noMic = !args.includes("--mic");
  const verbose = args.includes("--verbose");
  const noReport = args.includes("--no-report");
  const forceAudio = args.includes("--audio");
  const forceCaptions = args.includes("--captions");

  const durationIdx = args.indexOf("--duration");
  const durationRaw = durationIdx >= 0 ? args[durationIdx + 1] : undefined;
  const botNameIdx = args.indexOf("--bot-name");
  const botName = botNameIdx >= 0 ? args[botNameIdx + 1] : undefined;
  const channelIdx = args.indexOf("--channel");
  const channel = channelIdx >= 0 ? args[channelIdx + 1] : undefined;
  const targetIdx = args.indexOf("--target");
  const target = targetIdx >= 0 ? args[targetIdx + 1] : undefined;

  if (!meetUrl) {
    console.error(
      "Usage: npx openbuilder join <meet-url> --auth|--anon [--bot-name <name>] [--duration 60m] [--channel <ch>] [--target <id>]",
    );
    process.exit(1);
  }

  if (!useAuth && !useAnon) {
    console.error("ERROR: You must specify either --auth or --anon.");
    console.error("ASK THE USER which mode they want before retrying. Do NOT choose for them.");
    console.error("  --auth  Join using saved Google account (~/.openbuilder/auth.json)");
    console.error("  --anon  Join as a guest (no Google account)");
    process.exit(1);
  }

  if (useAuth && useAnon) {
    console.error("ERROR: Cannot use both --auth and --anon.");
    process.exit(1);
  }

  if (useAnon && !botName) {
    console.error("ERROR: --anon requires --bot-name <name>.");
    console.error("ASK THE USER what name they want the bot to use. Do NOT choose a default.");
    process.exit(1);
  }

  if (forceAudio && forceCaptions) {
    console.error("ERROR: Cannot use both --audio and --captions.");
    process.exit(1);
  }

  // Parse duration to milliseconds
  let durationMs: number | undefined;
  if (durationRaw) {
    const match = durationRaw.match(/^(\d+)(ms|s|m|h)?$/);
    if (match) {
      const value = parseInt(match[1]!, 10);
      const unit = match[2] ?? "ms";
      const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
      durationMs = value * (multipliers[unit] ?? 1);
    }
  }

  // Determine capture mode
  let captureMode: "audio" | "captions" | "auto" = "auto";
  if (forceAudio) captureMode = "audio";
  if (forceCaptions) captureMode = "captions";

  return {
    meetUrl,
    headed,
    noAuth: useAnon,
    noCamera,
    noMic,
    verbose,
    noReport,
    durationMs,
    botName,
    channel,
    target,
    captureMode,
  };
}

// ── Google Meet UI automation ──────────────────────────────────────────

async function isBlockedFromJoining(page: Page): Promise<boolean> {
  try {
    const blocked = page
      .locator("text=/You can't join this video call/i, text=/can.t join this video call/i")
      .first();
    return await blocked.isVisible({ timeout: 2000 });
  } catch {
    return false;
  }
}

async function dismissOverlays(page: Page): Promise<void> {
  const dismissTexts = ["Got it", "Dismiss", "OK", "Accept all", "Continue without microphone", "No thanks"];

  for (let round = 0; round < 3; round++) {
    let dismissed = false;

    for (const text of dismissTexts) {
      try {
        const btn = page.locator(`button:has-text("${text}")`).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click();
          console.log(`  Dismissed overlay ("${text}")`);
          dismissed = true;
          await page.waitForTimeout(500);
        }
      } catch {
        // Not present
      }
    }

    // Dismiss Gemini banner
    try {
      const gemini = page.locator("text=/Use Gemini/i").first();
      if (await gemini.isVisible({ timeout: 1000 })) {
        await page.keyboard.press("Escape");
        console.log("  Dismissed Gemini banner");
        dismissed = true;
        await page.waitForTimeout(500);
      }
    } catch {
      // Not present
    }

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    if (!dismissed) break;
  }
}

async function dismissPostJoinDialogs(page: Page): Promise<void> {
  await page.waitForTimeout(2000);

  for (let round = 0; round < 3; round++) {
    let dismissed = false;

    for (const text of ["Got it", "OK", "Dismiss", "Close"]) {
      try {
        const btn = page.locator(`button:has-text("${text}")`).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          console.log(`  Dismissed post-join dialog ("${text}")`);
          dismissed = true;
          await page.waitForTimeout(500);
        }
      } catch {
        // Not present
      }
    }

    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    if (!dismissed) break;
  }
}

async function disableMediaOnPreJoin(page: Page, opts: { noCamera: boolean; noMic: boolean }) {
  if (opts.noMic) {
    try {
      const micBtn = page
        .locator(
          '[aria-label*="microphone" i][data-is-muted="false"], ' +
            'button[aria-label*="Turn off microphone" i]',
        )
        .first();
      if (await micBtn.isVisible({ timeout: 3000 })) {
        await micBtn.click();
        console.log("  Microphone turned off");
      }
    } catch {
      // Already muted
    }
  }

  if (opts.noCamera) {
    try {
      const camBtn = page
        .locator(
          '[aria-label*="camera" i][data-is-muted="false"], ' +
            'button[aria-label*="Turn off camera" i]',
        )
        .first();
      if (await camBtn.isVisible({ timeout: 3000 })) {
        await camBtn.click();
        console.log("  Camera turned off");
      }
    } catch {
      // Already off
    }
  }
}

async function enterNameIfNeeded(page: Page, botName: string): Promise<void> {
  try {
    const nameInput = page
      .locator('input[aria-label="Your name"], input[placeholder*="name" i]')
      .first();
    if (await nameInput.isVisible({ timeout: 3000 })) {
      await nameInput.fill(botName);
      console.log(`  Set display name: ${botName}`);
    }
  } catch {
    // Name field not shown
  }
}

async function clickJoinButton(page: Page, maxAttempts = 10): Promise<boolean> {
  const joinSelectors = [
    'button:has-text("Continue without microphone and camera")',
    'button:has-text("Ask to join")',
    'button:has-text("Join now")',
    'button:has-text("Join meeting")',
    'button:has-text("Join")',
    '[data-idom-class*="join"] button',
    "button >> text=/join/i",
  ];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Only check for blocks after giving the page time to load (not on first 2 attempts)
    if (attempt >= 2) {
      const isBlocked = await page
        .evaluate(() => {
          const text = document.body.innerText || "";
          return (
            /you can.t join this video call/i.test(text) || /return(ing)? to home screen/i.test(text)
          );
        })
        .catch(() => false);

      if (isBlocked) {
        console.log("  Detected 'can't join' — aborting join attempt");
        return false;
      }
    }

    for (const selector of joinSelectors) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          console.log("  Clicked join button");
          return true;
        }
      } catch {
        // Try next
      }
    }

    if (attempt < maxAttempts - 1) {
      console.log(`  Join button not found yet, retrying (${attempt + 1}/${maxAttempts})...`);
      if (attempt === 0) {
        const debugPath = join(WORKSPACE_DIR, "debug-pre-join.png");
        await page.screenshot({ path: debugPath }).catch(() => {});
        console.log(`  [OPENBUILDER_DEBUG_IMAGE] ${debugPath}`);
      }
      await page.waitForTimeout(5000);
    }
  }

  return false;
}

async function waitUntilInMeeting(page: Page, timeoutMs = 600_000): Promise<void> {
  console.log("  Waiting to be admitted to the meeting (up to 10 min)...");
  const start = Date.now();
  let nextBlockCheck = Date.now() + 120_000; // First block check after 2 MINUTES (give host time to admit)

  while (Date.now() - start < timeoutMs) {
    try {
      const endCallBtn = page
        .locator('[aria-label*="Leave call" i], [aria-label*="leave" i][data-tooltip*="Leave"]')
        .first();
      if (await endCallBtn.isVisible({ timeout: 2000 })) {
        return;
      }
    } catch {
      // Not visible yet
    }

    try {
      const inMeetingText = page
        .locator("text=/only one here/i, text=/you.ve been admitted/i")
        .first();
      if (await inMeetingText.isVisible({ timeout: 1000 })) {
        return;
      }
    } catch {
      // Keep waiting
    }

    // Check if we're in the "asking to be let in" lobby state — this is GOOD, keep waiting
    const isInLobby = await page
      .evaluate(() => {
        const text = document.body.innerText || "";
        return (
          /asking to be let in/i.test(text) ||
          /waiting for someone to let you in/i.test(text) ||
          /someone in the meeting/i.test(text) ||
          /the meeting host/i.test(text)
        );
      })
      .catch(() => false);

    if (isInLobby) {
      // We're in the lobby — this is expected, keep waiting for admission
      await page.waitForTimeout(5000);
      continue;
    }

    // Only check for hard blocks every 30 seconds (not every 2-3 seconds)
    if (Date.now() >= nextBlockCheck) {
      const isBlocked = await page
        .evaluate(() => {
          const text = document.body.innerText || "";
          return (
            /you can.t join this video call/i.test(text) ||
            /return(ing)? to home screen/i.test(text) ||
            /you have been removed/i.test(text) ||
            /denied your request/i.test(text) ||
            /meeting has been locked/i.test(text)
          );
        })
        .catch(() => false);

      if (isBlocked) {
        throw new Error("Blocked from joining — access denied or meeting unavailable");
      }

      nextBlockCheck = Date.now() + 60_000; // Next check in 60 seconds
    }

    // Wait longer between checks to be patient
    await page.waitForTimeout(5000);
  }

  throw new Error("Timed out waiting to be admitted (10 minutes)");
}

async function clickLeaveButton(page: Page): Promise<void> {
  try {
    const leaveBtn = page
      .locator('[aria-label*="Leave call" i], [aria-label*="leave" i][data-tooltip*="Leave"]')
      .first();
    if (await leaveBtn.isVisible({ timeout: 1000 })) {
      await leaveBtn.click();
      await page.waitForTimeout(1000);
    }
  } catch {
    // Best-effort
  }
}

/** Check how many participants are in the meeting (excluding the bot) */
async function getParticipantCount(page: Page): Promise<number> {
  try {
    return await page.evaluate(() => {
      // Method 1: Check the participant count badge/text in the toolbar
      // Google Meet shows participant count near the people icon
      const countEl = document.querySelector('[data-participant-count]');
      if (countEl) {
        const count = parseInt(countEl.getAttribute('data-participant-count') || '0', 10);
        return count;
      }

      // Method 2: Look for "X in call" or participant count text
      const allText = document.body.innerText || '';

      // "You're the only one here" means just the bot
      if (/you.re the only one here/i.test(allText)) return 1;

      // Look for participant count patterns
      const countMatch = allText.match(/(\d+)\s+(?:in call|participant|people|in this call)/i);
      if (countMatch) return parseInt(countMatch[1], 10);

      // Method 3: Count video tiles / participant elements
      // Google Meet uses specific containers for each participant
      const tiles = document.querySelectorAll(
        '[data-participant-id], [data-requested-participant-id]'
      );
      if (tiles.length > 0) return tiles.length;

      // Method 4: Count elements in the participant list if open
      const participantItems = document.querySelectorAll(
        '[role="listitem"][data-participant-id]'
      );
      if (participantItems.length > 0) return participantItems.length;

      return -1; // Unknown
    });
  } catch {
    return -1; // Error — can't determine
  }
}

async function waitForMeetingEnd(
  page: Page,
  opts?: {
    durationMs?: number;
    captionIdleTimeoutMs?: number;
    getLastCaptionAt?: () => number;
  },
): Promise<string> {
  const start = Date.now();
  const durationMs = opts?.durationMs;
  const captionIdleTimeoutMs = opts?.captionIdleTimeoutMs;
  const getLastCaptionAt = opts?.getLastCaptionAt;

  // Track when we first detected being alone (to avoid premature exit)
  let aloneDetectedAt: number | null = null;
  const ALONE_GRACE_PERIOD_MS = 45_000; // Wait 45s to confirm everyone left (participant detection can be unreliable)
  let lastParticipantLog = 0;

  const checkEnded = async (): Promise<string | null> => {
    try {
      const endedText = page
        .locator(
          "text=/meeting has ended/i, text=/removed from/i, text=/You left the meeting/i, text=/You.ve left the call/i",
        )
        .first();
      if (await endedText.isVisible({ timeout: 500 })) {
        return "Meeting ended";
      }
    } catch {
      // Still in meeting
    }

    if (!page.url().includes("meet.google.com")) {
      return "Navigated away from meeting";
    }

    // Check if all other participants have left
    const participantCount = await getParticipantCount(page);

    // Log participant count periodically (every 30s)
    if (Date.now() - lastParticipantLog > 30_000 && participantCount >= 0) {
      console.log(`  [participants] ${participantCount} in meeting`);
      lastParticipantLog = Date.now();
    }

    if (participantCount === 1 || participantCount === 0) {
      // Possibly only the bot is left (or count is wrong)
      if (!aloneDetectedAt) {
        aloneDetectedAt = Date.now();
        console.log(`  Participant count is ${participantCount} — waiting 45s to confirm alone...`);
      } else if (Date.now() - aloneDetectedAt >= ALONE_GRACE_PERIOD_MS) {
        // Re-check with a screenshot for debugging before leaving
        const recheck = await getParticipantCount(page);
        if (recheck <= 1) {
          await clickLeaveButton(page);
          return "All other participants left";
        } else {
          // False alarm — reset
          aloneDetectedAt = null;
        }
      }
    } else if (participantCount > 1) {
      // Someone is still here — reset the alone timer
      if (aloneDetectedAt) {
        console.log("  Participant rejoined — continuing...");
        aloneDetectedAt = null;
      }
    }
    // participantCount === -1 means unknown, don't act on it

    return null;
  };

  while (true) {
    if (durationMs && Date.now() - start >= durationMs) {
      await clickLeaveButton(page);
      return "Duration limit reached";
    }

    if (captionIdleTimeoutMs && getLastCaptionAt && Date.now() - getLastCaptionAt() >= captionIdleTimeoutMs) {
      await clickLeaveButton(page);
      return "No captions captured for 10 minutes";
    }

    const reason = await checkEnded();
    if (reason) return reason;

    await page.waitForTimeout(3000);
  }
}

// ── Stealth patches ────────────────────────────────────────────────────

const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, "webdriver", { get: () => false });

  if (!window.chrome) {
    window.chrome = { runtime: {} };
  }

  Object.defineProperty(navigator, "plugins", {
    get: () => [1, 2, 3, 4, 5],
  });

  Object.defineProperty(navigator, "languages", {
    get: () => ["en-US", "en"],
  });

  const originalQuery = window.Permissions?.prototype?.query;
  if (originalQuery) {
    window.Permissions.prototype.query = function (params) {
      if (params.name === "notifications") {
        return Promise.resolve({ state: "default", onchange: null });
      }
      return originalQuery.call(this, params);
    };
  }

  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (param) {
    if (param === 37445) return "Google Inc. (Apple)";
    if (param === 37446) return "ANGLE (Apple, Apple M1, OpenGL 4.1)";
    return getParameter.call(this, param);
  };
`;

// ── Screenshot handler ─────────────────────────────────────────────────

function registerScreenshotHandler(page: Page): void {
  writeFileSync(PID_FILE, String(process.pid));

  process.on("SIGUSR1", async () => {
    try {
      const screenshotPath = join(WORKSPACE_DIR, "on-demand-screenshot.png");
      await page.screenshot({ path: screenshotPath });
      const payload = JSON.stringify({ path: screenshotPath, timestamp: Date.now() });
      writeFileSync(SCREENSHOT_READY_FILE, payload);
      console.log(`[OPENBUILDER_SCREENSHOT] ${screenshotPath}`);
    } catch (err) {
      console.error("Screenshot failed:", err instanceof Error ? err.message : String(err));
    }
  });
}

function cleanupPidFile(): void {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {
    // best-effort
  }
}

// ── Caption capture ────────────────────────────────────────────────────

function extractMeetingId(meetUrl: string): string {
  try {
    const url = new URL(meetUrl);
    return url.pathname.replace(/^\//, "").replace(/\//g, "-") || "unknown";
  } catch {
    return "unknown";
  }
}

async function enableCaptions(page: Page): Promise<void> {
  await page.waitForTimeout(5000);

  // Dismiss overlays aggressively (RecallAI pattern: press Escape many times)
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(1000);

  for (const text of ["Got it", "Dismiss", "Continue", "OK", "No thanks"]) {
    try {
      const btn = page.locator(`button:has-text("${text}")`).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click();
        await page.waitForTimeout(300);
      }
    } catch {
      // Not present
    }
  }

  const checkCaptions = async (): Promise<boolean> =>
    page
      .evaluate(`
      !!(document.querySelector('[role="region"][aria-label*="Captions"]') ||
         document.querySelector('[aria-label="Captions are on"]') ||
         document.querySelector('button[aria-label*="Turn off captions" i]') ||
         document.querySelector('[data-is-persistent-caption="true"]') ||
         document.querySelector('[jscontroller][data-caption-id]'))
    `)
      .catch(() => false) as Promise<boolean>;

  if (await checkCaptions()) {
    console.log("  Captions already enabled");
    return;
  }

  // Debug: take screenshot before attempting caption enable
  const debugPath = join(WORKSPACE_DIR, "debug-captions.png");
  await page.screenshot({ path: debugPath }).catch(() => {});
  console.log(`  [DEBUG] Pre-caption screenshot saved`);

  // Method 1: Move mouse across bottom toolbar area to reveal it, then click CC
  // Try multiple Y positions since toolbar position varies by viewport
  for (const y of [680, 700, 650, 720, 600]) {
    try {
      await page.mouse.move(640, y);
      await page.waitForTimeout(1500);

      const ccButton = page
        .locator(
          'button[aria-label*="Turn on captions" i], ' +
            'button[aria-label*="captions" i][aria-pressed="false"], ' +
            'button[aria-label*="captions (c)" i], ' +
            'button[aria-label*="closed captions" i]',
        )
        .first();
      if (await ccButton.isVisible({ timeout: 2000 })) {
        await ccButton.click();
        await page.waitForTimeout(2000);
        if (await checkCaptions()) {
          console.log("  Captions enabled (clicked CC button)");
          return;
        }
      }
    } catch {
      // Try next position
    }
  }

  // Method 2: Keyboard shortcut 'c' — click body first to ensure focus
  try {
    await page.click("body");
    await page.waitForTimeout(500);
  } catch {}

  await page.keyboard.press("c");
  await page.waitForTimeout(3000);
  if (await checkCaptions()) {
    console.log("  Captions enabled (pressed 'c')");
    return;
  }

  // Method 3: Try pressing 'c' multiple times with focus resets
  for (let i = 0; i < 5; i++) {
    try { await page.click("body"); } catch {}
    await page.waitForTimeout(300);
    await page.keyboard.press("c");
    await page.waitForTimeout(2000);
    if (await checkCaptions()) {
      console.log(`  Captions enabled (press 'c', attempt ${i + 1})`);
      return;
    }
  }

  // Method 4: Use JavaScript to find and click the CC button by scanning all buttons
  try {
    const clicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const label = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (label.includes("caption") && !label.includes("turn off")) {
          (btn as HTMLElement).click();
          return label;
        }
      }
      // Try finding by the closed_caption icon
      const icons = document.querySelectorAll('[data-icon*="caption"]');
      for (const icon of icons) {
        const btn = icon.closest("button");
        if (btn) {
          (btn as HTMLElement).click();
          return "icon-based click";
        }
      }
      return null;
    });
    if (clicked) {
      console.log(`  Clicked caption button via JS: ${clicked}`);
      await page.waitForTimeout(3000);
      if (await checkCaptions()) {
        console.log("  Captions enabled (JS click)");
        return;
      }
    }
  } catch {}

  // Method 5: More options / activities menu
  try {
    const moreBtn = page
      .locator(
        'button[aria-label*="more options" i], button[aria-label*="More actions" i], ' +
          'button[aria-label*="activities" i]',
      )
      .first();
    if (await moreBtn.isVisible({ timeout: 2000 })) {
      await moreBtn.click();
      await page.waitForTimeout(1500);
      const captionsItem = page
        .locator(
          '[role="menuitem"]:has-text("Captions"), li:has-text("Captions"), ' +
            '[role="option"]:has-text("Captions")',
        )
        .first();
      if (await captionsItem.isVisible({ timeout: 2000 })) {
        await captionsItem.click();
        await page.waitForTimeout(2000);
        if (await checkCaptions()) {
          console.log("  Captions enabled (via menu)");
          return;
        }
      } else {
        await page.keyboard.press("Escape");
      }
    }
  } catch {}

  // Method 6: CC icon by data-icon attribute
  try {
    await page.mouse.move(640, 680);
    await page.waitForTimeout(500);
    const ccByIcon = page
      .locator(
        'button:has([data-icon="closed_caption"]), button:has([data-icon="closed_caption_off"])',
      )
      .first();
    if (await ccByIcon.isVisible({ timeout: 2000 })) {
      await ccByIcon.click();
      await page.waitForTimeout(2000);
      if (await checkCaptions()) {
        console.log("  Captions enabled (clicked CC icon)");
        return;
      }
    }
  } catch {}

  // Last resort: dump all visible button labels for debugging
  await page.screenshot({ path: debugPath }).catch(() => {});
  const allButtons = await page
    .evaluate(() => {
      return Array.from(document.querySelectorAll("button"))
        .map((b) => ({
          label: b.getAttribute("aria-label"),
          text: (b.textContent || "").slice(0, 60),
          visible: b.offsetParent !== null,
        }))
        .filter((b) => b.visible);
    })
    .catch(() => []);
  console.log("  [DEBUG] All visible buttons:", JSON.stringify(allButtons));
  console.log("  WARNING: Could not verify captions are on — caption capture may not work");
  console.log(`  [DEBUG] Screenshot: ${debugPath}`);
}

// Caption observer injected into the browser context
const CAPTION_OBSERVER_SCRIPT = `
(function() {
  var BADGE_SEL = ".NWpY1d, .xoMHSc";
  var captionContainer = null;

  var getSpeaker = function(node) {
    if (!node || !node.querySelector) return "";
    var badge = node.querySelector(BADGE_SEL);
    return badge ? badge.textContent.trim() : "";
  };

  var getText = function(node) {
    if (!node || !node.cloneNode) return "";
    var clone = node.cloneNode(true);
    var badges = clone.querySelectorAll ? clone.querySelectorAll(BADGE_SEL) : [];
    for (var i = 0; i < badges.length; i++) badges[i].remove();
    var imgs = clone.querySelectorAll ? clone.querySelectorAll("img") : [];
    for (var j = 0; j < imgs.length; j++) imgs[j].remove();
    return clone.textContent.trim();
  };

  var send = function(node) {
    if (!(node instanceof HTMLElement)) return;

    var el = node;
    var speaker = "";
    for (var depth = 0; depth < 6 && el && el !== document.body; depth++) {
      speaker = getSpeaker(el);
      if (speaker) break;
      el = el.parentElement;
    }

    if (!speaker || !el) return;

    var text = getText(el);
    if (!text || text.length > 500) return;

    if (/^(mic_off|videocam|call_end|more_vert|keyboard|arrow_)/i.test(text)) return;
    if (text.indexOf("extension") !== -1 && text.indexOf("developers.google") !== -1) return;

    try {
      window.__openbuilder_onCaption(speaker, text);
    } catch(e) {}
  };

  new MutationObserver(function(mutations) {
    if (!captionContainer || !document.contains(captionContainer)) {
      captionContainer = document.querySelector('[aria-label="Captions"]') ||
                         document.querySelector('[aria-live]');
    }

    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (captionContainer && !captionContainer.contains(m.target)) continue;

      var added = m.addedNodes;
      for (var j = 0; j < added.length; j++) {
        if (added[j] instanceof HTMLElement) send(added[j]);
      }

      if (m.type === "characterData" && m.target && m.target.parentElement) {
        send(m.target.parentElement);
      }
    }
  }).observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true
  });

  console.log("[OpenBuilder] Caption observer active");
})();
`;

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function setupCaptionCapture(
  page: Page,
  transcriptPath: string,
  verbose: boolean,
): Promise<{ cleanup: () => void; getLastCaptionAt: () => number }> {
  const tracking = new Map<string, { text: string; ts: number; startTs: number }>();
  const lastWritten = new Map<string, string>();
  let lastMinuteKey = "";
  let lastCaptionAt = Date.now();

  const finalizeCaption = (speaker: string, text: string, startTs: number): void => {
    const prevWritten = lastWritten.get(speaker) ?? "";
    const normNew = normalizeForCompare(text);
    const normPrev = normalizeForCompare(prevWritten);

    if (
      normPrev &&
      (normNew === normPrev ||
        normPrev.startsWith(normNew) ||
        (normNew.startsWith(normPrev) && normNew.length - normPrev.length < 3))
    ) {
      return;
    }

    // Extract only the NEW text (deduplicate the accumulating Google Meet CC buffer)
    let textToWrite = text;
    if (prevWritten && text.startsWith(prevWritten)) {
      // The caption buffer is growing — only write the new part
      textToWrite = text.slice(prevWritten.length).replace(/^[\s,.!?;:]+/, "").trim();
      if (!textToWrite) return;
    } else if (prevWritten) {
      // Try normalized comparison for fuzzy prefix matching
      const prevWords = normPrev.split(/\s+/);
      const newWords = normNew.split(/\s+/);
      // Find the longest common prefix by words
      let commonLen = 0;
      for (let i = 0; i < Math.min(prevWords.length, newWords.length); i++) {
        if (prevWords[i] === newWords[i]) commonLen = i + 1;
        else break;
      }
      if (commonLen > 0 && commonLen >= prevWords.length * 0.8) {
        // Most of the previous text is a prefix of the new text — extract only new words
        const newPart = newWords.slice(commonLen).join(" ").trim();
        if (newPart) textToWrite = newPart;
      }
    }

    lastWritten.set(speaker, text);

    const d = new Date(startTs);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const minuteKey = `${hh}:${mm}`;

    let prefix = "";
    if (lastMinuteKey && minuteKey !== lastMinuteKey) {
      prefix = "\n";
    }
    lastMinuteKey = minuteKey;

    const line = `[${hh}:${mm}:${ss}] ${speaker}: ${text}`;
    try {
      appendFileSync(transcriptPath, `${prefix}${line}\n`);
    } catch {
      // Ignore write errors
    }
    lastCaptionAt = Date.now();
    if (verbose) {
      console.log(`  [caption] ${line}`);
    }
  };

  await page.exposeFunction("__openbuilder_onCaption", (speaker: string, text: string) => {
    const existing = tracking.get(speaker);
    const prevWritten = lastWritten.get(speaker) ?? "";

    const normNew = normalizeForCompare(text);
    const normWritten = normalizeForCompare(prevWritten);
    if (normWritten && (normNew === normWritten || normWritten.startsWith(normNew))) {
      return;
    }

    if (existing) {
      const normOld = normalizeForCompare(existing.text);

      const isGrowing =
        normNew.startsWith(normOld) ||
        normOld.startsWith(normNew) ||
        (normNew.length > normOld.length &&
          normNew.includes(normOld.slice(0, Math.min(20, normOld.length))));

      if (isGrowing) {
        if (text.length >= existing.text.length) {
          existing.text = text;
          existing.ts = Date.now();
        }
        return;
      }

      finalizeCaption(speaker, existing.text, existing.startTs);
    }

    tracking.set(speaker, { text, ts: Date.now(), startTs: Date.now() });
  });

  const settleInterval = setInterval(() => {
    const now = Date.now();
    for (const [speaker, data] of tracking.entries()) {
      if (now - data.ts >= 5000) {
        finalizeCaption(speaker, data.text, data.startTs);
        tracking.delete(speaker);
      }
    }
  }, 1000);

  await page.evaluate(CAPTION_OBSERVER_SCRIPT);

  return {
    getLastCaptionAt: () => lastCaptionAt,
    cleanup: () => {
      clearInterval(settleInterval);
      for (const [speaker, data] of tracking.entries()) {
        finalizeCaption(speaker, data.text, data.startTs);
      }
      tracking.clear();
    },
  };
}

// ── Auto-report generation ─────────────────────────────────────────────

async function generateAutoReport(
  transcriptPath: string,
  meetingId: string,
  channel?: string,
  target?: string,
): Promise<void> {
  const config = getConfig();
  const hasApiKey = config.anthropicApiKey || config.openaiApiKey;

  if (!hasApiKey) {
    console.log("  No AI API key configured — skipping auto-report generation");
    console.log("  Set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable auto-reports");
    return;
  }

  const transcriptContent = readFileSync(transcriptPath, "utf-8").trim();
  if (!transcriptContent) {
    console.log("  Empty transcript — skipping report generation");
    return;
  }

  console.log("Generating AI meeting report...");
  sendMessage({ channel, target, message: "Generating AI meeting report..." });

  try {
    // Dynamically import to avoid circular deps and keep the join script lean
    const { parseTranscript, formatTranscriptForAI, chunkTranscript } = await import(
      "../src/utils/transcript-parser.js"
    );
    const { ClaudeProvider } = await import("../src/ai/claude.js");
    const { OpenAIProvider } = await import("../src/ai/openai.js");
    const { getMeetingAnalysisPrompt, getMergeAnalysisPrompt } = await import(
      "../src/ai/prompts.js"
    );
    const { calculateSpeakerStats } = await import("../src/analytics/speaker-stats.js");
    const { parseAnalysisResponse, generateReport } = await import("../src/report/generator.js");
    const { REPORTS_DIR } = await import("../src/utils/config.js");

    // Select AI provider
    const provider = config.aiProvider === "openai" && config.openaiApiKey
      ? new OpenAIProvider()
      : new ClaudeProvider();

    const transcript = parseTranscript(transcriptContent);
    const analytics = calculateSpeakerStats(transcript);

    // Chunk if needed (long meetings)
    const chunks = chunkTranscript(transcript, 30000);
    let analysisResponse: string;

    if (chunks.length === 1) {
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
      // Process chunks and merge
      const chunkResults: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        console.log(`  Processing chunk ${i + 1}/${chunks.length}...`);
        const result = await provider.complete({
          messages: [
            { role: "system", content: "You are an expert meeting analyst. Return only valid JSON." },
            {
              role: "user",
              content: getMeetingAnalysisPrompt(
                chunks[i]!,
                `chunk ${i + 1} of ${chunks.length}`,
              ),
            },
          ],
          maxTokens: 4096,
          temperature: 0.3,
        });
        chunkResults.push(result);
      }

      console.log("  Merging chunk analyses...");
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
    const report = generateReport({
      meetingId,
      date: new Date().toISOString().split("T")[0],
      transcriptPath,
      analysis,
      analytics,
    });

    mkdirSync(REPORTS_DIR, { recursive: true });
    const reportPath = join(REPORTS_DIR, `${meetingId}-report.md`);
    writeFileSync(reportPath, report);
    console.log(`[OPENBUILDER_REPORT] ${reportPath}`);
    sendMessage({
      channel,
      target,
      message: `Meeting report generated! View at: ${reportPath}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Report generation failed: ${msg}`);
    sendMessage({ channel, target, message: `Report generation failed: ${msg}` });
  }
}

// ── Main ───────────────────────────────────────────────────────────────

export async function joinMeeting(opts: {
  meetUrl: string;
  headed?: boolean;
  noAuth?: boolean;
  noCamera?: boolean;
  noMic?: boolean;
  verbose?: boolean;
  noReport?: boolean;
  durationMs?: number;
  botName?: string;
  channel?: string;
  target?: string;
  captureMode?: "audio" | "captions" | "auto";
}): Promise<{ context: BrowserContext; page: Page; reason: string }> {
  const {
    meetUrl,
    headed = false,
    noAuth = false,
    noCamera = true,
    noMic = true,
    verbose = false,
    noReport = false,
    durationMs,
    botName: botNameOpt,
    channel,
    target,
    captureMode: captureModeOpt,
  } = opts;

  // Resolve bot name from config or arg
  const config = getConfig();
  let botName = botNameOpt ?? config.botName ?? "OpenBuilder Bot";

  // Resolve duration from config if not specified
  let effectiveDurationMs = durationMs;
  if (!effectiveDurationMs && config.defaultDuration) {
    const match = config.defaultDuration.match(/^(\d+)(ms|s|m|h)?$/);
    if (match) {
      const value = parseInt(match[1]!, 10);
      const unit = match[2] ?? "ms";
      const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
      effectiveDurationMs = value * (multipliers[unit] ?? 1);
    }
  }

  ensureDirs();

  // Resolve capture mode: CLI flag > config > "auto"
  let useAudioCapture = false;
  const resolvedCaptureMode = captureModeOpt ?? config.captureMode ?? "auto";

  if (resolvedCaptureMode === "audio" || resolvedCaptureMode === "auto") {
    const { isAudioCaptureAvailable } = await import("../src/audio/pipeline.js");
    const audioDeps = isAudioCaptureAvailable();
    if (audioDeps.available) {
      useAudioCapture = true;
      if (resolvedCaptureMode === "auto") {
        console.log("  Auto-detected PulseAudio + ffmpeg — using audio capture mode");
      }
    } else if (resolvedCaptureMode === "audio") {
      console.error(`ERROR: --audio requires: ${audioDeps.missing.join(", ")}`);
      console.error("Install the missing dependencies or use --captions instead.");
      process.exit(1);
    } else {
      console.log(`  Audio capture not available (missing: ${audioDeps.missing.join(", ")}) — falling back to captions`);
    }
  }

  // Check for OpenAI API key when using audio mode (needed for Whisper)
  if (useAudioCapture && !config.openaiApiKey && !process.env.OPENAI_API_KEY) {
    console.warn("  WARNING: Audio capture requires OPENAI_API_KEY for Whisper transcription.");
    console.warn("  Set it with: npx openbuilder config set openaiApiKey <key>");
    console.warn("  Falling back to captions mode.");
    useAudioCapture = false;
  }

  const meetingId = extractMeetingId(meetUrl);
  const audioSinkName = `openbuilder_${meetingId.replace(/[^a-z0-9_-]/gi, "_")}`;

  // If using audio capture, set up PulseAudio routing before browser launch
  if (useAudioCapture) {
    process.env.PULSE_SINK = audioSinkName;
    // Also set PULSE_SERVER so Chromium finds PulseAudio
    if (!process.env.PULSE_SERVER) {
      const { execSync } = await import("node:child_process");
      try {
        const serverInfo = execSync("pactl info 2>/dev/null | grep 'Server String' | cut -d: -f2-", { encoding: "utf-8" }).trim();
        if (serverInfo) process.env.PULSE_SERVER = serverInfo;
      } catch {}
    }
  }

  console.log(`OpenBuilder — Joining meeting: ${meetUrl}`);
  console.log(`  Bot name: ${botName}`);
  console.log(`  Capture mode: ${useAudioCapture ? "audio (PulseAudio + Whisper)" : "captions (DOM scraping)"}`);
  console.log(`  Camera: ${noCamera ? "off" : "on"}, Mic: ${noMic ? "off" : "on"}`);
  if (effectiveDurationMs) {
    console.log(`  Max duration: ${Math.round(effectiveDurationMs / 60_000)}m`);
  }

  let pw: PlaywrightMod;
  try {
    pw = await import("playwright-core");
  } catch {
    console.error("playwright-core not found. Run `npm install` or use `npx openbuilder join ...`.");
    process.exit(1);
  }

  const hasAuth = !noAuth && existsSync(AUTH_FILE);
  if (noAuth) {
    console.log("  Joining as guest (--anon)");
  } else if (hasAuth) {
    console.log(`  Using saved auth: ${AUTH_FILE}`);
  } else {
    console.log("  No auth.json found — joining as guest (run `npx openbuilder auth` to sign in)");
  }

  const chromiumArgs = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--auto-select-desktop-capture-source=Entire screen",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-dev-shm-usage",
    "--window-size=1280,720",
  ];

  if (!headed) {
    chromiumArgs.push("--headless=new", "--disable-gpu");
  }

  // Launch browser and attempt to join (up to 3 retries with fresh contexts)
  let context: BrowserContext;
  let page: Page;

  if (hasAuth) {
    // For audio capture, use full Chrome (not headless-shell) with headless: false
    // so the browser actually outputs audio to PulseAudio. Xvfb provides the virtual display.
    const useFullChrome = useAudioCapture;
    let fullChromePath: string | undefined;
    if (useFullChrome) {
      try {
        const result = execSync(
          'find ~/.cache/ms-playwright/chromium-*/chrome-linux64 -name "chrome" -type f | head -1',
          { encoding: "utf-8" },
        ).trim();
        fullChromePath = result || undefined;
      } catch { /* fallback to default */ }
    }
    if (useFullChrome && fullChromePath) {
      console.log(`  Using full Chrome for audio: ${fullChromePath}`);
    }

    const browser = await pw.chromium.launch({
      headless: useFullChrome ? false : !headed,
      ...(fullChromePath ? { executablePath: fullChromePath } : {}),
      args: chromiumArgs,
      ignoreDefaultArgs: ["--enable-automation", "--mute-audio"],
    });
    context = await browser.newContext({
      storageState: AUTH_FILE,
      viewport: { width: 1280, height: 720 },
      permissions: ["camera", "microphone"],
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    page = await context.newPage();
  } else {
    const userDataDir = join(OPENBUILDER_DIR, "chrome-profile");
    mkdirSync(userDataDir, { recursive: true });

    // When using audio capture, use full Chrome (not headless-shell) with headless: false
    // so the browser actually outputs audio. Xvfb provides the virtual display.
    const useFullChrome = useAudioCapture;
    const fullChromePath = useFullChrome
      ? (() => {
          try {
            const result = execSync(
              'find ~/.cache/ms-playwright/chromium-*/chrome-linux64 -name "chrome" -type f | head -1',
              { encoding: "utf-8" },
            ).trim();
            return result || undefined;
          } catch {
            return undefined;
          }
        })()
      : undefined;

    if (useFullChrome && fullChromePath) {
      console.log(`  Using full Chrome for audio: ${fullChromePath}`);
    }

    context = await pw.chromium.launchPersistentContext(userDataDir, {
      headless: useFullChrome ? false : true,
      ...(fullChromePath ? { executablePath: fullChromePath } : {}),
      args: chromiumArgs,
      ignoreDefaultArgs: ["--enable-automation", "--mute-audio"],
      viewport: { width: 1280, height: 720 },
      permissions: ["camera", "microphone"],
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    } as Record<string, unknown>);
    page = context.pages()[0] ?? (await context.newPage());
  }

  await context.addInitScript(STEALTH_SCRIPT);

  const MAX_JOIN_RETRIES = 2;
  let currentContext = context;
  let currentPage = page;
  let joined = false;

  sendMessage({ channel, target, message: `Trying to join the meeting (up to 2 attempts)...` });

  for (let attempt = 1; attempt <= MAX_JOIN_RETRIES; attempt++) {
    console.log(`\nNavigating to meeting... (attempt ${attempt}/${MAX_JOIN_RETRIES})`);
    await currentPage.goto(meetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await currentPage.waitForTimeout(3000);

    await dismissOverlays(currentPage);

    // Only check for blocks on retry attempts (not first attempt)
    if (attempt > 1 && await isBlockedFromJoining(currentPage)) {
      console.warn(`  Blocked: "You can't join this video call" (attempt ${attempt})`);

      if (attempt < MAX_JOIN_RETRIES) {
        console.log(`  Waiting 60s before retrying...`);
        await currentPage.waitForTimeout(60 * 1000);
        // Just reload the page, don't create fresh context
        continue;
      }

      const screenshotPath = join(WORKSPACE_DIR, "debug-join-failed.png");
      await currentPage.screenshot({ path: screenshotPath, fullPage: true });
      console.error(`[OPENBUILDER_DEBUG_IMAGE] ${screenshotPath}`);
      sendImage({
        channel,
        target,
        message: "Blocked from joining after multiple attempts. Here's what the bot saw:",
        mediaPath: screenshotPath,
      });
      await currentContext.close();
      throw new Error(
        `Blocked from joining after ${MAX_JOIN_RETRIES} attempts. Debug screenshot: ${screenshotPath}`,
      );
    }

    // First attempt: wait longer before checking for blocks (let page fully load)
    if (attempt === 1) {
      await currentPage.waitForTimeout(5000); // Extra 5s for page to settle
      const earlyBlockCheck = await isBlockedFromJoining(currentPage).catch(() => false);

      if (earlyBlockCheck) {
        console.log("  Page shows 'can't join' — waiting 15s and reloading...");
        await currentPage.waitForTimeout(15000);
        await currentPage.reload({ waitUntil: "domcontentloaded" });
        await currentPage.waitForTimeout(5000);
        await dismissOverlays(currentPage);
      }
    }

    await enterNameIfNeeded(currentPage, botName);
    await disableMediaOnPreJoin(currentPage, { noCamera, noMic });
    await currentPage.waitForTimeout(1000);

    console.log("\nAttempting to join...");
    joined = await clickJoinButton(currentPage);

    // Handle 2-step join preview
    if (joined) {
      await currentPage.waitForTimeout(2000);
      try {
        const secondJoin = currentPage.locator('button:has-text("Join now")').first();
        if (await secondJoin.isVisible({ timeout: 2000 })) {
          await secondJoin.click();
          console.log("  Clicked second join button (2-step preview)");
        }
      } catch {
        // Single-step flow
      }
    }

    if (joined) {
      registerScreenshotHandler(currentPage);
      sendMessage({
        channel,
        target,
        message: `Waiting to be admitted — please ask the host to let "${botName}" in`,
      });
      try {
        await waitUntilInMeeting(currentPage);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  Post-join block: ${msg} (attempt ${attempt})`);
        joined = false;
      }
    }

    if (attempt < MAX_JOIN_RETRIES) {
      console.log(`  Waiting 60s before retrying...`);
      await new Promise(r => setTimeout(r, 60 * 1000));
      // Just reload the page, don't create fresh context to avoid bot detection
    }
  }

  if (!joined) {
    const screenshotPath = join(WORKSPACE_DIR, "debug-join-failed.png");
    await currentPage.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    console.error("Could not join the meeting after all attempts.");
    console.error(`[OPENBUILDER_DEBUG_IMAGE] ${screenshotPath}`);
    sendImage({
      channel,
      target,
      message: "Could not join the meeting. Here is what the bot saw:",
      mediaPath: screenshotPath,
    });
    await currentContext.close();
    throw new Error(
      `Failed to join after ${MAX_JOIN_RETRIES} attempts. Debug screenshot: ${screenshotPath}`,
    );
  }

  // Successfully joined
  const successScreenshotPath = join(WORKSPACE_DIR, "joined-meeting.png");
  await currentPage.screenshot({ path: successScreenshotPath });
  console.log("\nSuccessfully joined the meeting!");
  console.log(`[OPENBUILDER_JOINED] ${meetUrl}`);
  console.log(`[OPENBUILDER_SUCCESS_IMAGE] ${successScreenshotPath}`);
  sendImage({
    channel,
    target,
    message: "Successfully joined the meeting!",
    mediaPath: successScreenshotPath,
  });

  await dismissPostJoinDialogs(currentPage);

  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const transcriptPath = join(TRANSCRIPTS_DIR, `${meetingId}.txt`);
  writeFileSync(transcriptPath, "");

  let reason: string;

  if (useAudioCapture) {
    // ── Audio capture mode ──────────────────────────────────────────
    sendMessage({ channel, target, message: "Starting audio capture (PulseAudio + Whisper)..." });
    console.log("Starting audio capture pipeline...");

    const { startAudioPipeline } = await import("../src/audio/pipeline.js");
    const pipeline = await startAudioPipeline({
      sinkName: audioSinkName,
      transcriptPath,
      apiKey: config.openaiApiKey,
      whisperModel: config.whisperModel,
      verbose,
    });

    sendMessage({
      channel,
      target,
      message: "All set! Capturing audio and transcribing with Whisper. I'll save the transcript when the meeting ends.",
    });

    console.log("Waiting in meeting... (Ctrl+C to leave)");
    reason = await waitForMeetingEnd(currentPage, {
      durationMs: effectiveDurationMs,
      captionIdleTimeoutMs: 10 * 60_000,
      getLastCaptionAt: pipeline.getLastTranscriptAt,
    });
    console.log(`\nLeaving meeting: ${reason}`);

    await pipeline.stop();
    pipeline.cleanup();
    // Clean up PULSE_SINK env
    delete process.env.PULSE_SINK;
  } else {
    // ── Caption scraping mode (fallback) ────────────────────────────
    sendMessage({ channel, target, message: "Enabling live captions..." });
    await enableCaptions(currentPage);

    const { cleanup: cleanupCaptions, getLastCaptionAt } = await setupCaptionCapture(
      currentPage,
      transcriptPath,
      verbose,
    );

    sendMessage({
      channel,
      target,
      message: "All set! Listening and capturing captions. I'll save the transcript when the meeting ends.",
    });

    console.log("Waiting in meeting... (Ctrl+C to leave)");
    reason = await waitForMeetingEnd(currentPage, {
      durationMs: effectiveDurationMs,
      captionIdleTimeoutMs: 10 * 60_000,
      getLastCaptionAt,
    });
    console.log(`\nLeaving meeting: ${reason}`);

    cleanupCaptions();
  }

  if (existsSync(transcriptPath)) {
    const content = readFileSync(transcriptPath, "utf-8").trim();
    console.log(`[OPENBUILDER_TRANSCRIPT] ${transcriptPath}`);
    sendMessage({ channel, target, message: `Meeting ended (${reason}). Transcript saved.` });

    // Auto-generate report if API key is configured
    if (!noReport && content) {
      await generateAutoReport(transcriptPath, meetingId, channel, target);
    }
  } else {
    sendMessage({ channel, target, message: `Meeting ended (${reason}). No transcript was captured.` });
  }

  return { context: currentContext, page: currentPage, reason };
}

// ── CLI entry ──────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  const { context } = await joinMeeting(opts);
  await context.close();
  cleanupPidFile();
  console.log("Done.");
}

const isMain = process.argv[1]?.endsWith("builder-join.ts");
if (isMain) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
