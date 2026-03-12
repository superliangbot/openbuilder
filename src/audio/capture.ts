/**
 * capture.ts — PulseAudio audio capture via ffmpeg
 *
 * Sets up a PulseAudio virtual sink for isolating browser audio,
 * then uses ffmpeg to capture audio from the sink monitor into
 * WAV chunks suitable for Whisper transcription.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface AudioCaptureOptions {
  sinkName: string;
  chunkDurationSec?: number; // default 30
  sampleRate?: number; // default 16000
  outputDir?: string; // default auto-created temp dir
}

export interface AudioCapture {
  /** The PulseAudio sink name (set PULSE_SINK to this before launching browser) */
  sinkName: string;
  /** Directory where WAV chunks are written */
  outputDir: string;
  /** PulseAudio module index (for unloading) */
  moduleIndex: string;
  /** Returns list of completed chunk file paths (not currently being written) */
  getCompletedChunks(): string[];
  /** Stops ffmpeg and cleans up PulseAudio sink */
  stop(): void;
  /** Cleans up temp files */
  cleanup(): void;
}

/** Check if a command is available on PATH */
function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Check if PulseAudio and ffmpeg are available */
export function checkAudioDeps(): { available: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!commandExists("pulseaudio") && !commandExists("pactl")) missing.push("pulseaudio");
  if (!commandExists("ffmpeg")) missing.push("ffmpeg");
  return { available: missing.length === 0, missing };
}

/** Start PulseAudio if not already running */
function ensurePulseAudio(): void {
  try {
    execSync("pactl info", { stdio: "ignore", timeout: 5000 });
  } catch {
    // PulseAudio not running, start it
    try {
      execSync("pulseaudio --start --exit-idle-time=-1", { stdio: "ignore", timeout: 10000 });
      // Wait a moment for it to be ready
      execSync("sleep 1 && pactl info", { stdio: "ignore", timeout: 10000 });
    } catch (err) {
      throw new Error(
        `Failed to start PulseAudio: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Create a PulseAudio null sink and return the module index */
function createSink(sinkName: string): string {
  try {
    const result = execSync(
      `pactl load-module module-null-sink sink_name=${sinkName} sink_properties=device.description=OpenBuilderSink`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    return result;
  } catch (err) {
    throw new Error(
      `Failed to create PulseAudio sink "${sinkName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Remove a PulseAudio module by index */
function removeSink(moduleIndex: string): void {
  try {
    execSync(`pactl unload-module ${moduleIndex}`, { stdio: "ignore", timeout: 5000 });
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Start audio capture from a PulseAudio sink monitor.
 *
 * ffmpeg writes segmented WAV files (chunk_000.wav, chunk_001.wav, ...)
 * of `chunkDurationSec` seconds each.
 */
export function startAudioCapture(options: AudioCaptureOptions): AudioCapture {
  const {
    sinkName,
    chunkDurationSec = 30,
    sampleRate = 16000,
    outputDir: providedDir,
  } = options;

  // Ensure deps
  const deps = checkAudioDeps();
  if (!deps.available) {
    throw new Error(`Missing audio dependencies: ${deps.missing.join(", ")}`);
  }

  // Start PulseAudio and create sink
  ensurePulseAudio();
  const moduleIndex = createSink(sinkName);
  console.log(`  PulseAudio sink created: ${sinkName} (module ${moduleIndex})`);

  // Create output directory
  const outputDir = providedDir ?? join(tmpdir(), `openbuilder-audio-${sinkName}-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  // Start ffmpeg capturing from the sink monitor
  // Uses segment muxer to write consecutive WAV chunks
  const monitorSource = `${sinkName}.monitor`;
  const chunkPattern = join(outputDir, "chunk_%03d.wav");

  const ffmpeg: ChildProcess = spawn(
    "ffmpeg",
    [
      "-f", "pulse",
      "-i", monitorSource,
      "-ac", "1",
      "-ar", String(sampleRate),
      "-f", "segment",
      "-segment_time", String(chunkDurationSec),
      "-reset_timestamps", "1",
      chunkPattern,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let ffmpegRunning = true;

  ffmpeg.on("exit", (code) => {
    ffmpegRunning = false;
    if (code && code !== 255) {
      console.error(`  ffmpeg exited with code ${code}`);
    }
  });

  ffmpeg.on("error", (err) => {
    ffmpegRunning = false;
    console.error(`  ffmpeg error: ${err.message}`);
  });

  // Track which chunk is currently being written
  // ffmpeg writes chunk_NNN.wav sequentially; the latest one is in-progress
  let lastSeenChunks = new Set<string>();

  const getCompletedChunks = (): string[] => {
    if (!existsSync(outputDir)) return [];

    const allChunks = readdirSync(outputDir)
      .filter((f) => f.startsWith("chunk_") && f.endsWith(".wav"))
      .sort();

    if (allChunks.length === 0) return [];

    // The last file is potentially still being written by ffmpeg
    // Only return chunks that are NOT the latest one (unless ffmpeg has stopped)
    if (ffmpegRunning && allChunks.length > 0) {
      const completed = allChunks.slice(0, -1);
      // Filter to only return newly completed (not yet seen)
      const newChunks = completed.filter((c) => !lastSeenChunks.has(c));
      for (const c of newChunks) lastSeenChunks.add(c);
      return newChunks.map((c) => join(outputDir, c));
    }

    // ffmpeg stopped — all chunks are complete
    const newChunks = allChunks.filter((c) => !lastSeenChunks.has(c));
    for (const c of newChunks) lastSeenChunks.add(c);
    return newChunks.map((c) => join(outputDir, c));
  };

  const stop = (): void => {
    if (ffmpegRunning && ffmpeg.pid) {
      // Send SIGINT for graceful shutdown (ffmpeg finalizes the current segment)
      ffmpeg.kill("SIGINT");

      // Give ffmpeg a moment to finalize, then force kill if needed
      setTimeout(() => {
        if (ffmpegRunning) {
          ffmpeg.kill("SIGKILL");
        }
      }, 3000);
    }

    removeSink(moduleIndex);
    ffmpegRunning = false;
  };

  const cleanup = (): void => {
    try {
      if (existsSync(outputDir)) {
        rmSync(outputDir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort
    }
  };

  console.log(`  ffmpeg capturing audio → ${outputDir}`);
  console.log(`  Chunk duration: ${chunkDurationSec}s, Sample rate: ${sampleRate}Hz`);

  return {
    sinkName,
    outputDir,
    moduleIndex,
    getCompletedChunks,
    stop,
    cleanup,
  };
}
