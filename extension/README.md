# OpenBuilder Chrome Extension

A Chrome extension that captures meeting captions and audio directly from your Google Meet tab — no bot joining needed. Like Read AI and Granola, it runs silently in your browser.

## Features

- **Caption capture** — Automatically scrapes Google Meet captions via MutationObserver
- **Audio recording** — Records tab audio using `chrome.tabCapture` API
- **AI reports** — Generates structured meeting reports using Claude or OpenAI
- **Copy transcript** — One-click copy of the full transcript to clipboard
- **Real-time popup** — Live caption count and meeting duration in the extension popup
- **No server needed** — Works completely standalone in your browser

## Installation (Developer Mode)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` directory from this repository
5. The OpenBuilder icon will appear in your toolbar

## Setup

1. Click the OpenBuilder extension icon
2. Click the gear icon to open Settings
3. Choose your AI provider (Claude or OpenAI)
4. Enter your API key
5. Save settings

## Usage

1. Join a Google Meet as you normally would
2. The extension automatically detects the meeting and enables captions
3. Captions are captured in real-time (visible in the popup counter)
4. Optionally click **Start Audio Recording** to capture tab audio
5. Click **Copy Transcript** to copy the raw transcript to your clipboard
6. Click **Generate Report** to create an AI-powered meeting analysis

## How It Works

### Caption Capture
The content script (`content.js`) is injected into meet.google.com pages. It:
1. Detects when you're in a meeting (looks for the leave-call button)
2. Auto-enables captions by clicking the CC button
3. Sets up a MutationObserver on the caption DOM elements
4. Extracts speaker names and caption text
5. Deduplicates the accumulating Google Meet caption buffer (extracts only new text)
6. Sends clean caption data to the background service worker

### Audio Recording
The background service worker (`background.js`) uses `chrome.tabCapture` to capture audio from the meeting tab. An offscreen document handles the MediaRecorder since service workers don't have DOM access. Audio is recorded in 30-second WebM chunks.

### AI Reports
When you click "Generate Report", the extension:
1. Assembles the full transcript from stored captions
2. Sends it to the Claude or OpenAI API (using your API key)
3. Receives a structured JSON analysis (summary, chapters, action items, decisions, questions)
4. Formats it as a clean markdown report with speaker analytics
5. Opens the report in a new tab

## File Structure

```
extension/
├── manifest.json      # Manifest V3 configuration
├── background.js      # Service worker — data management, audio, AI
├── content.js         # Content script — caption scraping from Meet DOM
├── offscreen.html     # Offscreen document for audio recording
├── offscreen.js       # MediaRecorder logic for audio capture
├── popup.html         # Extension popup UI
├── popup.js           # Popup logic and real-time updates
├── popup.css          # Popup styles
├── options.html       # Settings page
├── options.js         # Settings logic
├── options.css        # Settings styles
├── icons/
│   ├── icon16.png     # Toolbar icon
│   ├── icon48.png     # Extension management icon
│   └── icon128.png    # Chrome Web Store icon
└── README.md          # This file
```

## Report Format

Generated reports include:
- **Summary** — 2-3 paragraph overview of the meeting
- **Chapters** — Topic segments with timestamps
- **Action Items** — Tasks with assignees detected from context
- **Key Decisions** — Explicit decisions made during the meeting
- **Key Questions** — Important questions raised (answered/unanswered)
- **Speaker Analytics** — Word count and percentage per participant

## Privacy

- All caption data stays in your browser (`chrome.storage.local`)
- API keys are stored in `chrome.storage.sync` (encrypted by Chrome)
- Transcripts are only sent to AI providers when you explicitly click "Generate Report"
- No data is sent to any third-party server
- Audio recordings stay local in your browser

## License

MIT — Part of the [OpenBuilder](https://github.com/superliangbot/openbuilder) project.
