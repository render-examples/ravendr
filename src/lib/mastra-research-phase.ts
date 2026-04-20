/**
 * Ingest research phase: Mastra tool-calling plus You.com fallback.
 * Separated from other Mastra helpers to keep modules under ~200 lines.
 */

import { getIngestResearchAgent } from "../agents/ingest-research.js";
import { quickSearch, deepResearch } from "./you-client.js";
import {
  buildMastraRequestContext,
  threadKeyIngest,
} from "./mastra-memory.js";

export type ResearchBundle = {
  quickContent: string;
  deepSummary: string;
  quickSources: { url: string; title: string; snippet: string }[];
  deepSources: { url: string; title: string; snippet: string }[];
};

function extractResearchFromSteps(out: {
  steps?: Array<{
    toolResults?: Array<{
      type?: string;
      payload?: { toolName?: string; result?: unknown };
    }>;
  }>;
}): Partial<ResearchBundle> {
  const partial: Partial<ResearchBundle> = {};
  for (const step of out.steps ?? []) {
    for (const tr of step.toolResults ?? []) {
      if (tr.type && tr.type !== "tool-result") continue;
      const name = tr.payload?.toolName;
      const result = tr.payload?.result as
        | { content?: string; sources?: ResearchBundle["quickSources"] }
        | undefined;
      if (!result?.content) continue;
      if (name === "quick_search") {
        partial.quickContent = result.content;
        partial.quickSources = result.sources ?? [];
      }
      if (name === "deep_research") {
        partial.deepSummary = result.content;
        partial.deepSources = result.sources ?? [];
      }
    }
  }
  return partial;
}

/**
 * Mastra tool-calling agent runs quick_search + deep_research; falls back to parallel You.com if needed.
 */
export async function runResearchPhaseWithMastraTools(
  topic: string,
  claim: string
): Promise<ResearchBundle> {
  const rc = buildMastraRequestContext(threadKeyIngest(topic, claim));
  const agent = getIngestResearchAgent();

  const out = await agent.generate(
    `Topic: "${topic}"
User claim: "${claim}"

Call quick_search first for fact-check evidence, then deep_research for a full overview.`,
    {
      requestContext: rc,
      maxSteps: 12,
    }
  );

  const extracted = extractResearchFromSteps(out);
  if (
    extracted.quickContent &&
    extracted.deepSummary &&
    extracted.quickSources &&
    extracted.deepSources
  ) {
    return {
      quickContent: extracted.quickContent,
      deepSummary: extracted.deepSummary,
      quickSources: extracted.quickSources,
      deepSources: extracted.deepSources,
    };
  }

  const [quick, deep] = await Promise.all([
    quickSearch(`Fact check: ${claim} regarding ${topic}`),
    deepResearch(
      `Comprehensive overview of: ${topic}. Include recent developments and key facts.`
    ),
  ]);

  return {
    quickContent: quick.content,
    deepSummary: deep.content,
    quickSources: quick.sources,
    deepSources: deep.sources,
  };
}
