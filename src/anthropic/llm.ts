import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, LLMInput } from "../shared/ports.js";
import { AppError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

export interface AnthropicLLMConfig {
  apiKey: string;
  model: string;
}

export function createAnthropicLLM(config: AnthropicLLMConfig): LLMProvider {
  const client = new Anthropic({ apiKey: config.apiKey });
  const model = config.model;

  return {
    async generate(input: LLMInput): Promise<string> {
      try {
        const response = await client.messages.create(
          {
            model,
            max_tokens: input.maxTokens ?? 1024,
            system: input.system,
            messages: [{ role: "user", content: input.prompt }],
          },
          { signal: input.signal }
        );
        const first = response.content[0];
        return first && first.type === "text" ? first.text : "";
      } catch (err) {
        logger.error({ err }, "anthropic.generate failed");
        throw new AppError("UPSTREAM_LLM", "LLM request failed", { cause: err });
      }
    },

    async *stream(input: LLMInput): AsyncIterable<string> {
      try {
        const stream = client.messages.stream(
          {
            model,
            max_tokens: input.maxTokens ?? 1024,
            system: input.system,
            messages: [{ role: "user", content: input.prompt }],
          },
          { signal: input.signal }
        );
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            yield event.delta.text;
          }
        }
      } catch (err) {
        logger.error({ err }, "anthropic.stream failed");
        throw new AppError("UPSTREAM_LLM", "LLM stream failed", { cause: err });
      }
    },
  };
}
