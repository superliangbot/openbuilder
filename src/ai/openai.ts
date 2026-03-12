/**
 * openai.ts — OpenAI AI provider implementation
 *
 * Uses the openai package (optional peer dependency).
 * Dynamically imported to avoid crashing if not installed.
 */

import { type AICompletionOptions, type AIProvider, AIProviderError } from "./provider.js";
import { getConfig } from "../utils/config.js";

export class OpenAIProvider implements AIProvider {
  readonly name = "OpenAI";

  async complete(options: AICompletionOptions): Promise<string> {
    const config = getConfig();
    const apiKey = config.openaiApiKey;

    if (!apiKey) {
      throw new AIProviderError(
        "openai",
        "OpenAI API key not configured. Set OPENAI_API_KEY environment variable or run: openbuilder config set openaiApiKey <key>",
      );
    }

    let OpenAI: typeof import("openai").default;
    try {
      const mod = await import("openai");
      OpenAI = mod.default;
    } catch {
      throw new AIProviderError(
        "openai",
        "The openai package is not installed. Run: npm install openai",
      );
    }

    const client = new OpenAI({ apiKey });

    const response = await client.chat.completions.create({
      model: "gpt-4o",
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.3,
      messages: options.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new AIProviderError("openai", "No content in OpenAI response");
    }
    return content;
  }
}
