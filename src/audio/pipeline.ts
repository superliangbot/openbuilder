/**
 * pipeline.ts — Audio capture + transcription pipeline
 *
 * Orchestrates PulseAudio audio capture and Whisper transcription
 * to produce a real-time transcript file in the same format as
 * the caption scraping approach: [HH:MM:SS] Speaker: text
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { startAudioCapture, checkAudioDeps, type AudioCapture } from "./capture.js";
import { Transcriber, type TranscriptionResult } from "./transcriber.js";

export interface AudioPipelineOptions {
  /** Unique sink name for this meeting (e.g. "openbuilder_abc-defg-hij") */
  sinkName: string;
  /** Path to write the transcript file */
  transcriptPath: string;
  /** OpenAI API key for Whisper */
  apiKey?: string;
  /** Whisper model (default "whisper-1") */
  whisperModel?: string;
  /** Audio chunk duration in seconds (default 30) */
  chunkDurationSec?: number;
  /** Whether to print transcript lines to stdout */
  verbose?: boolean;
}

export interface AudioPipeline {
  /** Stop the pipeline and finalize transcript */
  stop(): Promise<void>;
  /** Clean up temp files */
  cleanup(): void;
  /** Returns timestamp of last transcribed text (for idle detection) */
  getLastTranscriptAt(): number;
}

/**
 * Check whether audio capture mode is available on this system.
 * Returns { available, missing } where missing lists absent dependencies.
 */
export function isAudioCaptureAvailable(): { available: boolean; missing: string[] } {
  return checkAudioDeps();
}

/**
 * Start the audio capture + transcription pipeline.
 *
 * This function:
 * 1. Creates a PulseAudio sink for browser audio isolation
 * 2. Starts ffmpeg to capture audio into WAV chunks
 * 3. Polls for completed chunks and sends them to Whisper
 * 4. Writes transcription results to the transcript file
 *
 * The PULSE_SINK env var must be set to `sinkName` BEFORE launching
 * the browser, so browser audio is routed to our sink.
 */
export async function startAudioPipeline(
  options: AudioPipelineOptions,
): Promise<AudioPipeline> {
  const {
    sinkName,
    transcriptPath,
    apiKey,
    whisperModel,
    chunkDurationSec = 30,
    verbose = false,
  } = options;

  // Initialize transcript file
  writeFileSync(transcriptPath, "");

  // Start audio capture
  const capture: AudioCapture = startAudioCapture({
    sinkName,
    chunkDurationSec,
  });

  // Initialize transcriber
  const transcriber = new Transcriber({
    apiKey,
    model: whisperModel,
  });

  let lastTranscriptAt = Date.now();
  let running = true;
  let lastMinuteKey = "";
  let chunkIndex = 0;

  // Meeting start time — used to calculate absolute timestamps
  const meetingStartTime = Date.now();

  const writeTranscriptLine = (
    offsetSec: number,
    text: string,
  ): void => {
    // Convert chunk offset to absolute time
    const absoluteMs = meetingStartTime + offsetSec * 1000;
    const d = new Date(absoluteMs);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const minuteKey = `${hh}:${mm}`;

    let prefix = "";
    if (lastMinuteKey && minuteKey !== lastMinuteKey) {
      prefix = "\n";
    }
    lastMinuteKey = minuteKey;

    // MVP: no speaker diarization, use "Speaker" as default
    const line = `[${hh}:${mm}:${ss}] Speaker: ${text}`;
    try {
      appendFileSync(transcriptPath, `${prefix}${line}\n`);
    } catch {
      // Ignore write errors
    }

    lastTranscriptAt = Date.now();

    if (verbose) {
      console.log(`  [audio] ${line}`);
    }
  };

  const processChunk = async (chunkPath: string): Promise<void> => {
    const chunkStartSec = chunkIndex * chunkDurationSec;
    chunkIndex++;

    try {
      const result: TranscriptionResult = await transcriber.transcribeChunk(chunkPath);

      if (!result.text) return;

      // Use segment timestamps if available, otherwise write as single block
      if (result.segments.length > 0) {
        for (const seg of result.segments) {
          if (seg.text) {
            writeTranscriptLine(chunkStartSec + seg.start, seg.text);
          }
        }
      } else {
        writeTranscriptLine(chunkStartSec, result.text);
      }
    } catch (err) {
      console.error(
        `  Transcription error (chunk ${chunkIndex}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // Polling loop: check for new completed chunks and transcribe them
  const pollInterval = setInterval(async () => {
    if (!running) return;

    const chunks = capture.getCompletedChunks();
    for (const chunkPath of chunks) {
      await processChunk(chunkPath);
    }
  }, 5000); // Check every 5 seconds

  const stop = async (): Promise<void> => {
    running = false;
    clearInterval(pollInterval);

    // Stop ffmpeg (this finalizes the last chunk)
    capture.stop();

    // Wait a moment for the last chunk to be finalized
    await new Promise((r) => setTimeout(r, 1000));

    // Process any remaining chunks
    const remaining = capture.getCompletedChunks();
    for (const chunkPath of remaining) {
      await processChunk(chunkPath);
    }
  };

  const cleanup = (): void => {
    capture.cleanup();
  };

  console.log(`  Audio pipeline started (sink: ${sinkName})`);

  return {
    stop,
    cleanup,
    getLastTranscriptAt: () => lastTranscriptAt,
  };
}
