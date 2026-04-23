import { task } from "@renderinc/sdk/workflows";
import { Agent } from "@mastra/core/agent";
import { loadWorkflowConfig } from "../../config.js";
import { createPostgresEventBus } from "../event-bus.js";
import {
  addSources,
  completeBriefing,
  setSessionStatus,
} from "../db.js";
import type { BranchResult } from "./search-branch.js";

export interface SynthesizeResult {
  briefingId: string;
  sourceCount: number;
  content: string;
}

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

/**
 * Render Workflow leaf task: writes the spoken briefing from branches,
 * persists it + sources, emits briefing.ready.
 */
export const synthesize = task(
  {
    name: "synthesize",
    plan: "starter",
    timeoutSeconds: 120,
    retry: { maxRetries: 1, waitDurationMs: 1_000, backoffScaling: 1.5 },
  },
  async function synthesize(
    sessionId: string,
    briefingId: string,
    topic: string,
    branches: BranchResult[]
  ): Promise<SynthesizeResult> {
    const config = loadWorkflowConfig();
    const events = createPostgresEventBus({
      connectionString: config.DATABASE_URL,
    });
    await events.start();

    try {
      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "agent.synthesizing",
      });

      const usable = branches.filter((b) => b.content.trim().length > 0);
      if (usable.length === 0) {
        throw new Error("all research branches returned empty content");
      }

      const prompt = [
        `Topic: ${topic}`,
        ``,
        ...usable.flatMap((b, i) => [
          `--- Branch ${i + 1}: ${b.angle} ---`,
          `Query: ${b.query}`,
          b.content.slice(0, 6_000),
          ``,
        ]),
        `Synthesize the spoken briefing now.`,
      ].join("\n");

      const agent = new Agent({
        id: "ravendr-synthesizer",
        name: "ravendr-synthesizer",
        instructions: SYNTH_INSTRUCTIONS,
        model: normalizeModelId(config.ANTHROPIC_MODEL),
      });

      const result = await agent.generate(prompt);
      const raw = (result as { text?: string }).text ?? "";
      const content = stripCitationMarkers(raw).trim();

      const uniqueSources = dedupeSources(usable.flatMap((b) => b.sources));

      await completeBriefing(config.DATABASE_URL, briefingId, content);
      await addSources(config.DATABASE_URL, briefingId, uniqueSources);
      await setSessionStatus(config.DATABASE_URL, sessionId, "complete");

      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "briefing.ready",
        briefingId,
        sourceCount: uniqueSources.length,
      });

      return {
        briefingId,
        sourceCount: uniqueSources.length,
        content,
      };
    } finally {
      await events.stop();
    }
  }
);

function stripCitationMarkers(md: string): string {
  return md
    .replace(/\[\[\s*\d+(?:\s*,\s*\d+)*\s*\]\]/g, "")
    .replace(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function dedupeSources(
  sources: { url: string; title: string; snippet?: string }[]
): { url: string; title: string; snippet?: string }[] {
  const seen = new Set<string>();
  const out: { url: string; title: string; snippet?: string }[] = [];
  for (const s of sources) {
    if (!s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}

function normalizeModelId(model: string): string {
  return model.includes("/") ? model : `anthropic/${model}`;
}
