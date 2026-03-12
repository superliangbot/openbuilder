---
name: open-builder
description: AI meeting assistant — joins Google Meet, captures live transcripts, generates AI-powered meeting reports with summaries, action items, decisions, and speaker analytics.
homepage: https://github.com/superliangbot/openbuilder
metadata: { "openclaw": { "emoji": "📋", "requires": { "bins": ["node"] } } }
---

# OpenBuilder

## STOP — Ask the user before doing anything

**When the user asks to join a meeting, you MUST do these steps IN ORDER. Do NOT skip ahead.**

**Step A:** Read the file `~/.openbuilder/auth-meta.json` (it may not exist — that's fine).

**Step B:** Ask the user how they want to join. Do NOT launch the bot yet.

If auth-meta.json exists and has an `email` field, ask:

> "How would you like to join the meeting?
> 1. Join as **user@gmail.com** (authenticated — no host approval needed)
> 2. Join as **OpenBuilder Bot** (guest — host must admit)
> 3. Join with a custom name (guest)"

If auth-meta.json does NOT exist, ask:

> "What name should the bot use to join the meeting?"

Default to "OpenBuilder Bot" if the user doesn't have a preference.

**Step C:** WAIT for the user to answer. Only then launch the bot with the right flags.

- User chose authenticated → use `--auth`
- User chose guest → use `--anon --bot-name "Their Name"` (always ask for a name)

**The bot will refuse to start without `--auth` or `--anon`.
When using `--anon`, `--bot-name` is also required.**

---

A meeting bot that joins Google Meet meetings via Playwright browser automation,
captures live captions as a real-time transcript, and generates AI-powered meeting
reports with summaries, action items, key decisions, and speaker analytics.

## Prerequisites

- `playwright-core` (ships with openclaw)
- Chromium browser: `npx playwright-core install chromium`
- Optional: `@anthropic-ai/sdk` or `openai` for AI report generation

## Join a Meeting

**IMPORTANT: Always run join commands with `background:true`** — the bot is a long-running
process that stays in the meeting. Do not wait for it to complete; background it immediately
and poll for status updates.

### Launch command

```bash
exec background:true command:"npx openbuilder join https://meet.google.com/abc-defg-hij --auth|--anon --channel <current-channel> --target <current-chat-id>"
```

**IMPORTANT:** Always pass `--channel` and `--target` from the current conversation context.
The bot uses these to send screenshots and status updates directly to the user's chat.

Options (required — bot will error without one):

- `--auth` — join using saved Google account (~/.openbuilder/auth.json)
- `--anon --bot-name "Name"` — join as a guest with this display name (both required together)

Other options:

- `--headed` — show the browser window (for debugging)
- `--camera` — join with camera on (default: off)
- `--mic` — join with microphone on (default: off)
- `--duration 60m` — auto-leave after duration (supports ms/s/m/h)
- `--no-report` — skip auto-report generation when meeting ends
- `--verbose` — show real-time caption output

## Live Caption Transcript

Captions are automatically captured whenever the bot is in a meeting. After joining,
the bot enables Google Meet's built-in live captions and captures the text via a
MutationObserver. Captions are deduplicated and flushed to a transcript file every 5 seconds.

**Transcript location:** `~/.openclaw/workspace/openbuilder/transcripts/<meeting-id>.txt`

**Format:**
```
[14:30:05] Alice: Hey everyone, let's get started
[14:30:12] Bob: Sounds good, I have the updates ready
[14:30:25] Alice: Great, go ahead
```

## Get Transcript (what are they saying?)

**When the user asks "what are they saying?", "what's happening?", "summarize the meeting",
or anything about meeting content — run this script. Do NOT use builder-screenshot.ts for this.**

```bash
exec command:"npx openbuilder transcript"
```

Use `--last 20` to get only the last 20 lines (for long meetings).

Read the output and summarize it for the user in natural language.

## Take a Screenshot (visual context only)

If the user asks to **see** the meeting (e.g. "send me a screenshot", "what does it look like"):

```bash
exec command:"npx openbuilder screenshot"
```

Send the screenshot image to the user via `message`. Do NOT read the screenshot yourself.

## AI Summary (quick summary)

When the user asks for a summary and the meeting is over (or for a standalone transcript):

```bash
exec command:"npx openbuilder summarize"
exec command:"npx openbuilder summarize /path/to/transcript.txt"
```

Returns a 3-5 paragraph summary of the meeting.

## Full Meeting Report (summary + actions + decisions + analytics)

For a comprehensive meeting report with all intelligence:

```bash
exec command:"npx openbuilder report"
exec command:"npx openbuilder report /path/to/transcript.txt"
```

Generates and saves a markdown report with:
- Meeting summary with chapters
- Action items with assignee detection
- Key decisions
- Key questions (answered/unanswered)
- Speaker talk-time analytics

Report saved to: `~/.openclaw/workspace/openbuilder/reports/<meeting-id>-report.md`

## Configuration

```bash
exec command:"npx openbuilder config"
exec command:"npx openbuilder config set anthropicApiKey sk-ant-..."
exec command:"npx openbuilder config set aiProvider claude"
```

Keys: `aiProvider`, `anthropicApiKey`, `openaiApiKey`, `botName`, `defaultDuration`

## How It Works

1. **Join**: Launches headless Chromium, navigates to the Meet URL, enters the bot name, clicks "Ask to join", and waits for host admission.

2. **Caption capture**: After joining, the bot clicks the CC button to enable live captions, then injects a MutationObserver to capture caption text from the DOM. Captions are deduplicated and written to a transcript file.

3. **AI Report** (automatic): When the meeting ends, if an AI API key is configured, the bot automatically processes the transcript through Claude or OpenAI to generate a structured meeting report.

## Authentication (Optional)

By default the bot joins as a guest and needs host admission. To join as an authenticated
Google user (no admission needed), run the auth script once:

```bash
npx openbuilder auth
```

This opens a headed browser — sign into Google, then press Enter. The session is saved to
`~/.openbuilder/auth.json` and automatically loaded on future joins. Re-run if the session expires.

## Files

- `~/.openbuilder/auth.json` — saved Google session (cookies + localStorage)
- `~/.openbuilder/auth-meta.json` — email + timestamp
- `~/.openbuilder/config.json` — bot configuration
- `~/.openbuilder/chrome-profile/` — persistent Chromium profile
- `~/.openbuilder/builder.pid` — running bot PID
- `~/.openclaw/workspace/openbuilder/transcripts/` — live caption transcripts
- `~/.openclaw/workspace/openbuilder/reports/` — AI meeting reports
- `~/.openclaw/workspace/openbuilder/on-demand-screenshot.png` — on-demand screenshot
- `~/.openclaw/workspace/openbuilder/joined-meeting.png` — confirmation screenshot
- `~/.openclaw/workspace/openbuilder/debug-*.png` — failure screenshots

## Agent Behavior — MANDATORY

After launching the bot with `exec background:true`, you MUST poll the process
to check for success/failure and send screenshots back to the user.

### Step 1: Poll for output

After starting the background exec, poll the process every 10-15 seconds:

```
process action:poll
```

### Step 2: Parse markers and send images using the message tool

The bot prints machine-readable markers. When you see them, you MUST use the
`message` tool to send the screenshot image to the user.

**On success** — bot prints `[OPENBUILDER_SUCCESS_IMAGE] <path>`:

```
message action:"send" media:"./openbuilder/joined-meeting.png" content:"Successfully joined the meeting!"
```

**On screenshot request** — bot prints `[OPENBUILDER_SCREENSHOT] <path>`:

```
message action:"send" media:"./openbuilder/on-demand-screenshot.png" content:"Here's the current meeting view"
```

**On failure** — bot prints `[OPENBUILDER_DEBUG_IMAGE] <path>`:

```
message action:"send" media:"./openbuilder/debug-join-failed.png" content:"Could not join the meeting. Here is what the bot saw"
```

**On report generated** — bot prints `[OPENBUILDER_REPORT] <path>`:

Read the report file and share a formatted summary with the user.

**CRITICAL: ALWAYS use the `message` tool with `media:"./openbuilder/<filename>.png"` to send screenshots.**
Use relative paths only (starting with `./`). Never use absolute paths or ~ paths.

### Step 3: When user asks about meeting content

**CRITICAL: When the user asks what's happening, what someone said, or anything about
meeting content — run `builder-transcript.ts`. NEVER use `builder-screenshot.ts` for this.**

```bash
exec command:"npx openbuilder transcript"
```

### Step 4: When meeting ends

When the bot reports the meeting has ended:
1. Run `npx openbuilder transcript` to get the full transcript
2. If a report was auto-generated (`[OPENBUILDER_REPORT]` marker), read and share it
3. If no report was generated, offer to run `npx openbuilder report` for the user

### When to use which command

| User asks...                              | Use this command              |
|-------------------------------------------|-------------------------------|
| "what are they saying?"                   | `openbuilder transcript`      |
| "what's happening in the meeting?"        | `openbuilder transcript`      |
| "summarize the meeting"                   | `openbuilder summarize`       |
| "give me a full report"                   | `openbuilder report`          |
| "what are the action items?"              | `openbuilder report`          |
| "send me a screenshot"                    | `openbuilder screenshot`      |
| "what does the meeting look like?"        | `openbuilder screenshot`      |
| "what did they talk about?"               | `openbuilder transcript`      |

**NEVER read or analyze screenshot images to understand meeting content.**

## Read AI Integration (No Bot Needed)

OpenBuilder can pull meeting data directly from **Read AI** without joining the meeting.
Read AI captures meeting content natively via Chrome extension or Google Workspace add-on —
no bot needs to join the call. The agent can access transcripts, summaries, action items,
and analytics from any past or live meeting the user has recorded with Read AI.

### Setup

Run the OAuth flow once to connect the user's Read AI account:

```bash
exec command:"npx openbuilder readai auth"
```

This opens a browser for the user to authorize OpenBuilder. Tokens are saved to
`~/.openbuilder/readai-auth.json` (separate from Google auth).

### List Meetings

```bash
exec command:"npx openbuilder readai meetings"
exec command:"npx openbuilder readai meetings --limit 5 --start-date 2025-01-01"
```

### Get Meeting Details

```bash
exec command:"npx openbuilder readai meeting <meeting-id>"
```

Returns summary, chapters, action items, questions, topics, transcript, and metrics.

### Get Live Meeting Data

```bash
exec command:"npx openbuilder readai live <meeting-id>"
```

Returns real-time transcript and chapter summaries for an in-progress meeting.

### Sync Latest Meeting

```bash
exec command:"npx openbuilder readai sync"
```

Pulls the latest meeting from Read AI, saves the transcript in OpenBuilder format
(to `~/.openclaw/workspace/openbuilder/transcripts/`), and generates a markdown report
(to `~/.openclaw/workspace/openbuilder/reports/`). Outputs `[OPENBUILDER_REPORT]` marker.

### When to Use Read AI vs. the Meeting Bot

| Scenario                                      | Use this                          |
|-----------------------------------------------|-----------------------------------|
| User has Read AI and wants past meeting data   | `openbuilder readai meeting <id>` |
| User has Read AI and meeting is live           | `openbuilder readai live <id>`    |
| User wants to pull latest meeting + report     | `openbuilder readai sync`         |
| User does NOT have Read AI / needs bot to join | `openbuilder join <url>`          |

### Files

- `~/.openbuilder/readai-auth.json` — Read AI OAuth tokens (separate from Google auth)
- `~/.openclaw/workspace/openbuilder/transcripts/readai-*.txt` — Synced transcripts
- `~/.openclaw/workspace/openbuilder/reports/readai-*-report.md` — Generated reports

## Headless VM Tips

- Chrome flags `--use-fake-ui-for-media-stream` and `--use-fake-device-for-media-stream` are set automatically.
- No X11/Wayland display is required — runs fully headless.
- Use `--duration` to auto-leave after a set time.

## Troubleshooting

- **Join button not found**: Google Meet UI changes occasionally. The debug screenshot shows what the bot saw — send it to the user.
- **Not admitted**: The bot joins as a guest and needs host approval. Ask the host to admit the bot. If timed out, the debug screenshot is sent automatically.
- **No captions captured**: The CC button selector may change with Meet updates. If the transcript is empty, captions may not have been enabled. Try `--headed` to verify.
- **Headless blocked**: The bot uses stealth patches to bypass headless detection. If Google Meet blocks it, try `--headed` for debugging.
- **AI report failed**: Ensure an API key is configured via `openbuilder config set anthropicApiKey <key>` or `ANTHROPIC_API_KEY` env var.
