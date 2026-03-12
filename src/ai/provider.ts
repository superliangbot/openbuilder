/**
 * provider.ts — AI provider interface for OpenBuilder
 *
 * Clean abstraction layer so adding new AI providers is trivial.
 * Providers are dynamically imported — the app won't crash if SDKs aren't installed.
 */

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AICompletionOptions {
  messages: AIMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface AIProvider {
  /** Human-readable name of this provider (e.g. "Claude", "OpenAI") */
  readonly name: string;

  /**
   * Send a chat completion request and return the response text.
   * Throws if the API key is missing or the request fails.
   */
  complete(options: AICompletionOptions): Promise<string>;
}

/** Error thrown when an AI provider is not available (SDK not installed or no API key). */
export class AIProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}
