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

/** Create a PulseAudio pipe sink and return the module index and pipe path */
function createPipeSink(sinkName: string): { moduleIndex: string; pipePath: string } {
  const pipePath = `/tmp/${sinkName}-audio-pipe`;
  
  try {
    // Create FIFO pipe
    execSync(`mkfifo ${pipePath}`, { timeout: 5000 });
    
    // Load module-pipe-sink
    const result = execSync(
      `pactl load-module module-pipe-sink file=${pipePath} sink_name=${sinkName} format=s16le rate=16000 channels=1 sink_properties=device.description=OpenBuilderPipeSink`,
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    
    // Set as default sink
    execSync(`pactl set-default-sink ${sinkName}`, { timeout: 5000 });
    
    return { moduleIndex: result, pipePath };
  } catch (err) {
    // Clean up pipe if it was created
    try {
      unlinkSync(pipePath);
    } catch {}
    throw new Error(
      `Failed to create PulseAudio pipe sink "${sinkName}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Test if pipe-sink approach works by playing a test sound and checking if data flows */
async function testPipeSink(pipePath: string, sampleRate = 16000): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    }, 10000); // 10 second timeout

    // Spawn ffmpeg to read from pipe - it should receive data if pipe works
    const ffmpeg = spawn("ffmpeg", [
      "-f", "s16le",
      "-ar", String(sampleRate),
      "-ac", "1",
      "-i", pipePath,
      "-t", "2", // Only capture for 2 seconds
      "-f", "null",
      "-"
    ], { stdio: ["ignore", "pipe", "pipe"] });

    // Generate test audio in background
    setTimeout(() => {
      try {
        execSync(`pactl play-sample bell`, { timeout: 3000, stdio: "ignore" });
      } catch {
        // Try alternative test sound
        try {
          execSync(`speaker-test -t sine -f 440 -l 1 -s 1 2>/dev/null`, { timeout: 3000, stdio: "ignore" });
        } catch {
          // No test sound available, but ffmpeg might still detect silence vs no pipe
        }
      }
    }, 1000);

    ffmpeg.on("exit", (code) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        // If ffmpeg exits normally (even if no audio), pipe is working
        resolve(code !== null);
      }
    });

    ffmpeg.on("error", () => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    });
  });
}

/**
 * Start audio capture from PulseAudio using pipe-sink approach with null-sink fallback.
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

  // Start PulseAudio
  ensurePulseAudio();

  // Create output directory
  const outputDir = providedDir ?? join(tmpdir(), `openbuilder-audio-${sinkName}-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });

  let moduleIndex: string;
  let pipePath: string | null = null;
  let ffmpeg: ChildProcess;
  let audioMethod: "pipe-sink" | "null-sink";

  // Try pipe-sink approach first
  try {
    const pipeResult = createPipeSink(sinkName);
    moduleIndex = pipeResult.moduleIndex;
    pipePath = pipeResult.pipePath;
    
    console.log(`  PulseAudio pipe-sink created: ${sinkName} (module ${moduleIndex})`);
    
    // Start ffmpeg reading from the pipe
    const chunkPattern = join(outputDir, "chunk_%03d.wav");
    ffmpeg = spawn(
      "ffmpeg",
      [
        "-f", "s16le",
        "-ar", String(sampleRate),
        "-ac", "1",
        "-i", pipePath,
        "-f", "segment",
        "-segment_time", String(chunkDurationSec),
        "-reset_timestamps", "1",
        chunkPattern,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    
    audioMethod = "pipe-sink";
    console.log(`  Using pipe-sink method with ffmpeg reading from ${pipePath}`);
    
  } catch (pipeErr) {
    console.log(`  Pipe-sink failed: ${pipeErr instanceof Error ? pipeErr.message : String(pipeErr)}`);
    console.log(`  Falling back to null-sink method...`);
    
    try {
      // Fallback to null-sink approach (original method)
      moduleIndex = createSink(sinkName);
      pipePath = null;
      console.log(`  PulseAudio null-sink created: ${sinkName} (module ${moduleIndex})`);

      // Start ffmpeg capturing from the sink monitor
      const monitorSource = `${sinkName}.monitor`;
      const chunkPattern = join(outputDir, "chunk_%03d.wav");

      ffmpeg = spawn(
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
      
      audioMethod = "null-sink";
      console.log(`  Using null-sink method with PulseAudio monitor ${monitorSource}`);
      
    } catch (nullErr) {
      throw new Error(
        `Both pipe-sink and null-sink methods failed. Pipe: ${pipeErr instanceof Error ? pipeErr.message : String(pipeErr)}. Null: ${nullErr instanceof Error ? nullErr.message : String(nullErr)}`,
      );
    }
  }

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
    
    // Clean up pipe file if using pipe-sink
    if (pipePath) {
      try {
        unlinkSync(pipePath);
      } catch {
        // Best-effort cleanup
      }
    }
    
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
  console.log(`  Method: ${audioMethod}, Chunk duration: ${chunkDurationSec}s, Sample rate: ${sampleRate}Hz`);

  return {
    sinkName,
    outputDir,
    moduleIndex,
    getCompletedChunks,
    stop,
    cleanup,
  };
}
