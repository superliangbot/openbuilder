/**
 * transcriber.ts — Whisper transcription via OpenAI API
 *
 * Sends WAV audio chunks to the OpenAI Whisper API and returns
 * transcription text with timestamps.
 */

import { createReadStream } from "node:fs";

export interface TranscriptionSegment {
  start: number; // seconds
  end: number; // seconds
  text: string;
}

export interface TranscriptionResult {
  text: string;
  segments: TranscriptionSegment[];
}

export interface TranscriberOptions {
  /** OpenAI API key (defaults to OPENAI_API_KEY env var) */
  apiKey?: string;
  /** Whisper model name (default "whisper-1") */
  model?: string;
  /** Language hint for Whisper (e.g. "en") */
  language?: string;
}

export class Transcriber {
  private client: InstanceType<typeof import("openai").default> | null = null;
  private model: string;
  private language?: string;
  private apiKey?: string;

  constructor(options: TranscriberOptions = {}) {
    this.model = options.model ?? "whisper-1";
    this.language = options.language;
    this.apiKey = options.apiKey;
  }

  /** Lazily initialize the OpenAI client */
  private async getClient(): Promise<InstanceType<typeof import("openai").default>> {
    if (this.client) return this.client;

    try {
      const { default: OpenAI } = await import("openai");
      this.client = new OpenAI({
        apiKey: this.apiKey ?? process.env.OPENAI_API_KEY,
      });
      return this.client;
    } catch {
      throw new Error(
        "OpenAI package not found. Install it with: npm install openai",
      );
    }
  }

  /**
   * Transcribe a WAV audio chunk using the Whisper API.
   *
   * Returns text and segment-level timestamps.
   * Retries on rate limit (429) errors with exponential backoff.
   */
  async transcribeChunk(wavPath: string): Promise<TranscriptionResult> {
    const client = await this.getClient();

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await client.audio.transcriptions.create({
          model: this.model,
          file: createReadStream(wavPath),
          response_format: "verbose_json",
          timestamp_granularities: ["segment"],
          ...(this.language ? { language: this.language } : {}),
        });

        // The response with verbose_json includes segments
        const raw = response as Record<string, unknown>;
        const segments: TranscriptionSegment[] = [];

        if (Array.isArray(raw.segments)) {
          for (const seg of raw.segments) {
            if (seg && typeof seg === "object") {
              const s = seg as { start?: number; end?: number; text?: string };
              segments.push({
                start: s.start ?? 0,
                end: s.end ?? 0,
                text: (s.text ?? "").trim(),
              });
            }
          }
        }

        return {
          text: (response.text ?? "").trim(),
          segments,
        };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Check for rate limit (429) — retry with backoff
        const statusCode =
          err && typeof err === "object" && "status" in err
            ? (err as { status: number }).status
            : 0;

        if (statusCode === 429 && attempt < 2) {
          const delay = Math.pow(2, attempt + 1) * 1000; // 2s, 4s
          console.log(`  Whisper rate limited, retrying in ${delay / 1000}s...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        // Non-retryable error
        break;
      }
    }

    throw new Error(
      `Whisper transcription failed: ${lastError?.message ?? "unknown error"}`,
    );
  }
}
