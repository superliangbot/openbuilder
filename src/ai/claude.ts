/**
 * claude.ts — Claude/Anthropic AI provider implementation
 *
 * Uses the @anthropic-ai/sdk package (optional peer dependency).
 * Dynamically imported to avoid crashing if not installed.
 */

import { type AICompletionOptions, type AIProvider, AIProviderError } from "./provider.js";
import { getConfig } from "../utils/config.js";

export class ClaudeProvider implements AIProvider {
  readonly name = "Claude";

  async complete(options: AICompletionOptions): Promise<string> {
    const config = getConfig();
    const apiKey = config.anthropicApiKey;

    if (!apiKey) {
      throw new AIProviderError(
        "claude",
        "Anthropic API key not configured. Set ANTHROPIC_API_KEY environment variable or run: openbuilder config set anthropicApiKey <key>",
      );
    }

    let Anthropic: typeof import("@anthropic-ai/sdk").default;
    try {
      const mod = await import("@anthropic-ai/sdk");
      Anthropic = mod.default;
    } catch {
      throw new AIProviderError(
        "claude",
        "The @anthropic-ai/sdk package is not installed. Run: npm install @anthropic-ai/sdk",
      );
    }

    const client = new Anthropic({ apiKey });

    // Separate system message from user/assistant messages
    const systemMessages = options.messages.filter((m) => m.role === "system");
    const chatMessages = options.messages.filter((m) => m.role !== "system");

    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.3,
      system: systemMessages.map((m) => m.content).join("\n\n") || undefined,
      messages: chatMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new AIProviderError("claude", "No text content in Claude response");
    }
    return textBlock.text;
  }
}
