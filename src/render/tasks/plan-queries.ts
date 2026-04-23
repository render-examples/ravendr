import { task } from "@renderinc/sdk/workflows";
import { Agent } from "@mastra/core/agent";
import { loadWorkflowConfig } from "../../config.js";
import { createPostgresEventBus } from "../event-bus.js";
import { Tier } from "../../shared/events.js";
import { logger } from "../../shared/logger.js";

export interface PlannedQuery {
  query: string;
  tier: "lite" | "standard" | "deep";
  angle: string;
}

export interface PlanResult {
  queries: PlannedQuery[];
}

const PLAN_INSTRUCTIONS = `You plan research for Ravendr.

Given a topic, return 3-5 DISTINCT queries that cover different angles
(history, mechanism, key people, recent events, numerical data, contested
claims). Balance depth and breadth.

Tier guidance:
- "lite" for quick factual lookups or recency checks
- "standard" for substantive questions (default)
- "deep" for genuinely complex or contested topics (use sparingly)

Respond with ONLY valid JSON in this exact shape, no prose, no markdown fences:

{
  "queries": [
    { "query": "<actual search query>", "tier": "lite|standard|deep", "angle": "<short label>" }
  ]
}`;

/**
 * Render Workflow leaf task: plans research queries via Mastra Agent + Anthropic.
 *
 * This is its own task run so failures retry independently. The root
 * research task awaits this and gets the plan back.
 */
export const plan_queries = task(
  {
    name: "plan_queries",
    plan: "starter",
    timeoutSeconds: 60,
    retry: { maxRetries: 2, waitDurationMs: 1_000, backoffScaling: 1.5 },
  },
  async function plan_queries(
    sessionId: string,
    topic: string,
    feedback?: string
  ): Promise<PlanResult> {
    const config = loadWorkflowConfig();
    const events = createPostgresEventBus({
      connectionString: config.DATABASE_URL,
    });
    await events.start();

    try {
      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "agent.planning",
        step: "decomposing_topic",
      });

      const agent = new Agent({
        id: "ravendr-planner",
        name: "ravendr-planner",
        instructions: PLAN_INSTRUCTIONS,
        model: normalizeModelId(config.ANTHROPIC_MODEL),
      });

      const userPrompt = feedback
        ? `Topic: "${topic}"\n\nThe previous attempt failed verification. Verifier feedback:\n${feedback}\n\nAdjust your plan — the queries should target what was missed. Respond with JSON only.`
        : `Topic: "${topic}"\n\nPlan the queries now. Respond with JSON only.`;

      const result = await agent.generate(userPrompt);
      const text = (result as { text?: string }).text ?? "";
      const plan = parsePlan(text, topic);

      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "plan.ready",
        queries: plan.queries.map((q) => ({
          query: q.query,
          tier: q.tier,
          angle: q.angle,
        })),
      });

      return plan;
    } finally {
      await events.stop();
    }
  }
);

function parsePlan(text: string, topic: string): PlanResult {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1]!.trim() : text.trim();
  try {
    const parsed = JSON.parse(raw) as { queries?: unknown };
    if (!Array.isArray(parsed.queries)) throw new Error("queries missing");
    const queries: PlannedQuery[] = [];
    for (const q of parsed.queries) {
      const item = q as { query?: unknown; tier?: unknown; angle?: unknown };
      const query = String(item.query ?? "").trim();
      const tier = Tier.safeParse(item.tier).success
        ? (item.tier as PlannedQuery["tier"])
        : "standard";
      const angle = String(item.angle ?? "").trim() || "overview";
      if (query.length >= 4) queries.push({ query, tier, angle });
    }
    if (queries.length < 1) throw new Error("no valid queries");
    return { queries: queries.slice(0, 5) };
  } catch (err) {
    logger.warn({ err, text: text.slice(0, 200) }, "plan parse failed — falling back");
    return {
      queries: [
        { query: `Comprehensive overview of: ${topic}`, tier: "standard", angle: "overview" },
        { query: `Recent developments: ${topic} (last 12 months)`, tier: "lite", angle: "recent events" },
        { query: `Key people, groups, and milestones for: ${topic}`, tier: "lite", angle: "key actors" },
      ],
    };
  }
}

function normalizeModelId(model: string): string {
  return model.includes("/") ? model : `anthropic/${model}`;
}
