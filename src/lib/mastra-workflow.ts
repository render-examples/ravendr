/**
 * Mastra agents for fact-check, synthesis, and recall briefing (ingest uses mastra-research-phase).
 */

import { z } from "zod";
import type { RequestContext } from "@mastra/core/request-context";
import { getFactCheckerAgent } from "../agents/fact-checker.js";
import { getConnectorAgent } from "../agents/connector.js";
import { getSynthesizerAgent } from "../agents/synthesizer.js";
import {
  buildMastraRequestContext,
  threadKeyRecall,
} from "./mastra-memory.js";
import type { KnowledgeEntry } from "./db.js";

export {
  runResearchPhaseWithMastraTools,
  type ResearchBundle,
} from "./mastra-research-phase.js";

const REVIEW_THRESHOLD = 0.45;

const factCheckSchema = z.object({
  confidence: z.number().min(0).max(1),
  corrections: z.string(),
});

const connectSchema = z.object({
  content: z.string(),
  confidence: z.number().min(0).max(1),
  relatedEntryIds: z.array(z.string()).default([]),
});

export async function mastraFactCheckFromEvidence(
  topic: string,
  claim: string,
  searchEvidence: string,
  rc: RequestContext
): Promise<{ confidence: number; corrections: string }> {
  const prompt = `Topic: "${topic}"
Claim to evaluate: "${claim}"

Web search evidence (You.com):
${searchEvidence.slice(0, 14_000)}

Assess whether the claim is accurate given the evidence. confidence is 0–1. corrections: empty string if accurate, otherwise brief fixes.`;

  const out = await getFactCheckerAgent().generate(prompt, {
    structuredOutput: { schema: factCheckSchema },
    requestContext: rc,
  });

  if (out.object) {
    return {
      confidence: out.object.confidence,
      corrections: out.object.corrections,
    };
  }

  return { confidence: 0.5, corrections: out.text?.slice(0, 500) ?? "" };
}

export async function mastraSynthesizeKnowledgeEntry(input: {
  topic: string;
  claim: string;
  factCheck: { confidence: number; corrections: string };
  deepSummary: string;
  existingLines: string;
  rc: RequestContext;
}): Promise<z.infer<typeof connectSchema>> {
  let extra = "";
  if (input.factCheck.confidence < REVIEW_THRESHOLD) {
    extra =
      "\n\nNote: fact-check confidence is low. Prefer careful wording and flag uncertainty in the stored content if appropriate.";
  }

  const prompt = `Synthesize a single knowledge base entry for topic "${input.topic}" (user claim: "${input.claim}").

Fact-check (confidence ${input.factCheck.confidence}):
${input.factCheck.corrections || "No corrections."}

Deep research (You.com):
${input.deepSummary.slice(0, 12_000)}

Existing knowledge rows (ids matter for linking):
${input.existingLines || "None."}
${extra}

Produce:
- content: 2–4 paragraphs, factual, suitable for storage
- confidence: your overall confidence 0–1 in this synthesis
- relatedEntryIds: ids of existing entries that strongly relate (subset of ids above, or empty)`;

  const out = await getConnectorAgent().generate(prompt, {
    structuredOutput: { schema: connectSchema },
    requestContext: input.rc,
  });

  if (out.object) {
    let content = out.object.content;
    if (input.factCheck.confidence < REVIEW_THRESHOLD) {
      content = `[Review suggested: low fact-check confidence] ${content}`;
    }
    return {
      content,
      confidence: out.object.confidence,
      relatedEntryIds: out.object.relatedEntryIds ?? [],
    };
  }

  return {
    content: out.text ?? "",
    confidence: input.factCheck.confidence,
    relatedEntryIds: [],
  };
}

export async function mastraVoiceBriefing(input: {
  query: string;
  entries: KnowledgeEntry[];
  staleIds: string[];
  freshnessNotes: string;
}): Promise<{ briefing: string; entryCount: number; staleCount: number }> {
  if (input.entries.length === 0) {
    return {
      briefing: `I don't have any knowledge stored about "${input.query}" yet. Would you like me to research it?`,
      entryCount: 0,
      staleCount: 0,
    };
  }

  const rc = buildMastraRequestContext(threadKeyRecall(input.query));

  const entryTexts = input.entries
    .map((e) => {
      const staleTag = input.staleIds.includes(e.id) ? " [OUTDATED]" : "";
      return `Topic: ${e.topic}${staleTag}\n${e.content.slice(0, 500)}`;
    })
    .join("\n\n---\n\n");

  const prompt = `The user asked what they know about: "${input.query}"

Knowledge entries:
${entryTexts}

Freshness notes: ${input.freshnessNotes}

Write a concise voice briefing: 3–5 sentences, natural speech, mention outdated info if any.`;

  const out = await getSynthesizerAgent().generate(prompt, {
    requestContext: rc,
  });
  const briefing = out.text?.trim() ?? "";

  return {
    briefing,
    entryCount: input.entries.length,
    staleCount: input.staleIds.length,
  };
}
