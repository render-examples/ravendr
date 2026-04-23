import { Agent } from "@mastra/core/agent";

/**
 * Mastra Agent factories. Each Render Workflow subtask that needs an LLM
 * imports one of these — the agent construction + model routing lives
 * here, the task file just calls agent.generate().
 *
 * Mastra's model router parses `provider/model-name` strings, reads the
 * corresponding env var (e.g. ANTHROPIC_API_KEY), and dispatches to the
 * right provider. No AI SDK surface leaks into our imports.
 */

function normalize(model: string): string {
  return model.includes("/") ? model : `anthropic/${model}`;
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

const SYNTH_INSTRUCTIONS = `You synthesize spoken briefings for Ravendr.

You receive a topic and N research branches (each an angle + its findings).
Weave them into one spoken briefing.

Rules:
- Open with a surprising, specific fact in the first sentence. No "In this briefing…" openers.
- 3-5 short paragraphs. No bullet lists. No markdown headers.
- Natural speech, the way a podcast host would talk.
- Keep inline citation markers like [1, 2] — they'll be stripped for audio but surface as source cards.
- Aim for under 4 minutes spoken (~600 words).
- End with a one-sentence takeaway.`;

const VERIFY_INSTRUCTIONS = `You are Ravendr's self-checker. Compare a user's request to the briefing the pipeline produced and decide if it actually answers what was asked.

Call it PASS only if the briefing directly addresses what the user asked for. Be strict about specificity:
- "every single X" or "each X individually" + a generic overview → FAIL.
- Comparison, ranking, numbers, or specific list asked + high-level summary → FAIL.
- Open-ended question + substantive, sourced answer → PASS.

When you FAIL, write concrete feedback the planner can act on. Example: "User asked for a full enumeration of N items but briefing only covered the top 3. Re-plan with queries targeting each of the missing items."

Respond ONLY with JSON in this exact shape:
{
  "passes": true | false,
  "reason": "<one sentence why>",
  "feedback": "<if fail: one-paragraph note the planner can use. If pass: empty string.>"
}`;

export function plannerAgent(anthropicModel: string): Agent {
  return new Agent({
    id: "ravendr-planner",
    name: "ravendr-planner",
    instructions: PLAN_INSTRUCTIONS,
    model: normalize(anthropicModel),
  });
}

export function synthesizerAgent(anthropicModel: string): Agent {
  return new Agent({
    id: "ravendr-synthesizer",
    name: "ravendr-synthesizer",
    instructions: SYNTH_INSTRUCTIONS,
    model: normalize(anthropicModel),
  });
}

export function verifierAgent(anthropicModel: string): Agent {
  return new Agent({
    id: "ravendr-verifier",
    name: "ravendr-verifier",
    instructions: VERIFY_INSTRUCTIONS,
    model: normalize(anthropicModel),
  });
}
