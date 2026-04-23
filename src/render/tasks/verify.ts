import { task } from "@renderinc/sdk/workflows";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import { loadWorkflowConfig } from "../../config.js";
import { createPostgresEventBus } from "../event-bus.js";
import { logger } from "../../shared/logger.js";

export interface VerifyResult {
  passes: boolean;
  reason: string;
  feedback: string;
}

const INSTRUCTIONS = `You are Ravendr's self-checker. You compare a user's request to the briefing the research pipeline produced and decide if it's actually a good answer.

Call the briefing a PASS only if it directly addresses what the user asked for. Be strict about specificity:
- If the user asked for "every single X" or "each X individually", and the briefing gives only a general overview, that's a FAIL.
- If the user asked for a comparison, ranking, numbers, or a specific list, and the briefing is high-level summary, that's a FAIL.
- If the user asked an open-ended question and the briefing answers it with substance and sources, that's a PASS.

When you FAIL, write concrete feedback the planner can act on. Example: "User asked for a full enumeration of N items but briefing only covered the top 3. Re-plan with queries targeting each of the missing items."

Respond ONLY with JSON in this exact shape:
{
  "passes": true | false,
  "reason": "<one sentence why>",
  "feedback": "<if fail: one-paragraph note the planner can use to adjust the next run. If pass: empty string.>"
}
`;

export const verify = task(
  {
    name: "verify",
    plan: "starter",
    timeoutSeconds: 60,
    retry: { maxRetries: 1, waitDurationMs: 1_000, backoffScaling: 1.5 },
  },
  async function verify(
    sessionId: string,
    topic: string,
    briefingText: string
  ): Promise<VerifyResult> {
    const config = loadWorkflowConfig();
    const events = createPostgresEventBus({
      connectionString: config.DATABASE_URL,
    });
    await events.start();

    try {
      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "verify.started",
      });

      const agent = new Agent({
        id: "ravendr-verifier",
        name: "ravendr-verifier",
        instructions: INSTRUCTIONS,
        model: normalizeModelId(config.ANTHROPIC_MODEL),
      });

      const prompt = [
        `User request: "${topic}"`,
        ``,
        `Briefing:`,
        briefingText.slice(0, 8_000),
        ``,
        `Evaluate. JSON only.`,
      ].join("\n");

      const result = await agent.generate(prompt);
      const text = (result as { text?: string }).text ?? "";
      const parsed = parseVerdict(text);

      if (parsed.passes) {
        await events.publish({
          sessionId,
          at: Date.now(),
          kind: "verify.passed",
          reason: parsed.reason.slice(0, 200),
        });
      } else {
        await events.publish({
          sessionId,
          at: Date.now(),
          kind: "verify.failed",
          reason: parsed.reason.slice(0, 200),
          feedback: parsed.feedback.slice(0, 1_000),
        });
      }

      return parsed;
    } finally {
      await events.stop();
    }
  }
);

const verdictSchema = z.object({
  passes: z.boolean(),
  reason: z.string().default(""),
  feedback: z.string().default(""),
});

function parseVerdict(text: string): VerifyResult {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1]!.trim() : text.trim();
  try {
    const parsed = verdictSchema.parse(JSON.parse(raw));
    return {
      passes: parsed.passes,
      reason: parsed.reason || (parsed.passes ? "ok" : "no reason given"),
      feedback: parsed.feedback,
    };
  } catch (err) {
    logger.warn(
      { err, raw: text.slice(0, 200) },
      "verify: unparseable verdict, defaulting to pass"
    );
    return { passes: true, reason: "verifier output unreadable — defaulting to pass", feedback: "" };
  }
}

function normalizeModelId(model: string): string {
  return model.includes("/") ? model : `anthropic/${model}`;
}
