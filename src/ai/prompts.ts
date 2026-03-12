/**
 * prompts.ts — Meeting analysis prompts for AI processing
 *
 * Designed to work with transcripts in [HH:MM:SS] Speaker: text format.
 * Handles long meetings via chunking when needed.
 */

export const SYSTEM_PROMPT = `You are an expert meeting analyst. You analyze meeting transcripts and produce structured, actionable meeting intelligence. Be concise but thorough. Focus on what matters most.`;

/**
 * Prompt for generating a full meeting analysis from a transcript.
 * Returns structured JSON for programmatic parsing.
 */
export function getMeetingAnalysisPrompt(transcript: string, chunkInfo?: string): string {
  const chunkNote = chunkInfo
    ? `\n\nNOTE: This is ${chunkInfo} of a longer meeting. Analyze this portion thoroughly.`
    : "";

  return `Analyze this meeting transcript and return a JSON object with the following structure. Be thorough but concise.${chunkNote}

Return ONLY valid JSON — no markdown fences, no explanation before or after.

{
  "summary": "2-3 paragraph summary covering the main topics discussed, key outcomes, and overall meeting flow",
  "chapters": [
    { "timestamp": "HH:MM", "title": "Topic name", "description": "Brief description of what was discussed" }
  ],
  "actionItems": [
    { "description": "What needs to be done", "assignee": "Person name or null if unspecified" }
  ],
  "keyDecisions": [
    "Decision that was made"
  ],
  "keyQuestions": [
    { "question": "Question that was asked", "status": "answered" or "unanswered" }
  ]
}

Guidelines:
- For chapters: Group discussion into logical topic segments with approximate timestamps
- For action items: Look for commitments, tasks, follow-ups. Detect assignees from context (e.g. "Alice will..." → assignee: "Alice")
- For key decisions: Only include explicit decisions, not suggestions or ideas
- For key questions: Include important questions raised. Mark as "answered" if the transcript shows a response
- Use the speaker names exactly as they appear in the transcript
- Timestamps should use HH:MM format from the transcript

TRANSCRIPT:
${transcript}`;
}

/**
 * Prompt for merging multiple chunk analyses into a single cohesive report.
 * Used when a transcript is too long to process in one pass.
 */
export function getMergeAnalysisPrompt(chunkResults: string[]): string {
  const numbered = chunkResults
    .map((r, i) => `--- CHUNK ${i + 1} ANALYSIS ---\n${r}`)
    .join("\n\n");

  return `You were given a long meeting transcript in chunks. Below are the analyses of each chunk. Merge them into a single cohesive meeting analysis.

Return ONLY valid JSON with the same structure — no markdown fences:

{
  "summary": "Unified 2-3 paragraph summary of the entire meeting",
  "chapters": [{ "timestamp": "HH:MM", "title": "...", "description": "..." }],
  "actionItems": [{ "description": "...", "assignee": "..." }],
  "keyDecisions": ["..."],
  "keyQuestions": [{ "question": "...", "status": "answered|unanswered" }]
}

Guidelines:
- Combine and deduplicate items across chunks
- Create a unified summary that flows naturally
- Merge chapter lists chronologically
- Deduplicate action items, decisions, and questions

CHUNK ANALYSES:
${numbered}`;
}

/**
 * Prompt for a quick summary (used by the summarize command).
 */
export function getQuickSummaryPrompt(transcript: string): string {
  return `Summarize this meeting transcript in 3-5 paragraphs. Focus on:
1. What was discussed (main topics)
2. Key outcomes or decisions
3. Action items or next steps mentioned

Write in clear, professional prose. Use the speaker names from the transcript.

TRANSCRIPT:
${transcript}`;
}
