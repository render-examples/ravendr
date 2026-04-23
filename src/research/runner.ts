import type {
  EventBus,
  LLMProvider,
  ResearchProvider,
  ResearchSource,
} from "../shared/ports.js";
import { RESEARCHER_SYSTEM, renderBriefingPrompt } from "./agent-prompts.js";
import { addSources, completeBriefing, createBriefing, setSessionStatus } from "../render/db.js";
import { logger } from "../shared/logger.js";
import { AppError } from "../shared/errors.js";

export interface RunBriefingPorts {
  research: ResearchProvider;
  llm: LLMProvider;
  events: EventBus;
  databaseUrl: string;
}

export interface RunBriefingArgs {
  sessionId: string;
  topic: string;
  runId: string;
  signal?: AbortSignal;
}

/**
 * The hero chain body. Runs once per user ask.
 *
 *   emit(agent.planning) → You.com Lite → You.com Standard → You.com Lite (recent) →
 *   LLM synthesis → persist briefing + sources → emit(briefing.ready)
 *
 * Every step emits a PhaseEvent on the bus. Both the frontend (via ws) and
 * the narrator agent (in the web service) subscribe to those events.
 */
export async function runBriefing(
  args: RunBriefingArgs,
  ports: RunBriefingPorts
): Promise<{ briefingId: string; sourceCount: number }> {
  const { sessionId, topic, runId, signal } = args;
  const { research, llm, events, databaseUrl } = ports;

  const briefingId = await createBriefing(databaseUrl, sessionId, topic, runId);

  const emit = (event: Parameters<EventBus["publish"]>[0]) =>
    events.publish(event).catch((err) => logger.warn({ err }, "emit failed"));

  try {
    await emit({
      sessionId,
      at: Date.now(),
      kind: "agent.planning",
      step: "decomposing_topic",
    });

    // ── Phase 1: quick overview ────────────────────────────────────
    await emit({
      sessionId,
      at: Date.now(),
      kind: "youcom.call.started",
      query: topic,
      tier: "lite",
    });
    const overview = await research.research({ query: topic, tier: "lite", signal });
    await emit({
      sessionId,
      at: Date.now(),
      kind: "youcom.call.completed",
      query: topic,
      tier: "lite",
      sourceCount: overview.sources.length,
      latencyMs: overview.latencyMs,
    });

    // ── Phase 2: deeper standard pass ──────────────────────────────
    await emit({
      sessionId,
      at: Date.now(),
      kind: "agent.planning",
      step: "choosing_tier",
    });
    const deepQuery = `Comprehensive overview: ${topic}. Include history, mechanism, and contested points.`;
    await emit({
      sessionId,
      at: Date.now(),
      kind: "youcom.call.started",
      query: deepQuery,
      tier: "standard",
    });
    const deep = await research.research({
      query: deepQuery,
      tier: "standard",
      signal,
    });
    await emit({
      sessionId,
      at: Date.now(),
      kind: "youcom.call.completed",
      query: deepQuery,
      tier: "standard",
      sourceCount: deep.sources.length,
      latencyMs: deep.latencyMs,
    });

    // ── Phase 3: recency scan ──────────────────────────────────────
    const recentQuery = `Recent developments in the last 12 months: ${topic}`;
    await emit({
      sessionId,
      at: Date.now(),
      kind: "youcom.call.started",
      query: recentQuery,
      tier: "lite",
    });
    const recent = await research.research({
      query: recentQuery,
      tier: "lite",
      signal,
    });
    await emit({
      sessionId,
      at: Date.now(),
      kind: "youcom.call.completed",
      query: recentQuery,
      tier: "lite",
      sourceCount: recent.sources.length,
      latencyMs: recent.latencyMs,
    });

    // ── Phase 4: LLM synthesis ─────────────────────────────────────
    await emit({ sessionId, at: Date.now(), kind: "agent.synthesizing" });
    const briefingContent = await llm.generate({
      system: RESEARCHER_SYSTEM,
      prompt: renderBriefingPrompt({
        topic,
        overview: overview.content,
        deep: deep.content,
        recent: recent.content,
      }),
      maxTokens: 2_048,
      signal,
    });

    const allSources = mergeSources([
      ...overview.sources,
      ...deep.sources,
      ...recent.sources,
    ]);

    await completeBriefing(databaseUrl, briefingId, briefingContent);
    await addSources(databaseUrl, briefingId, allSources);
    await setSessionStatus(databaseUrl, sessionId, "complete");

    await emit({
      sessionId,
      at: Date.now(),
      kind: "briefing.ready",
      briefingId,
      sourceCount: allSources.length,
    });

    return { briefingId, sourceCount: allSources.length };
  } catch (err) {
    logger.error({ err, sessionId }, "runBriefing failed");
    await setSessionStatus(databaseUrl, sessionId, "error").catch(() => {});
    await emit({
      sessionId,
      at: Date.now(),
      kind: "workflow.failed",
      runId,
      message: err instanceof Error ? err.message : String(err),
    });
    throw AppError.from(err, "UPSTREAM_WORKFLOW");
  }
}

function mergeSources(sources: ResearchSource[]): ResearchSource[] {
  const seen = new Set<string>();
  const out: ResearchSource[] = [];
  for (const s of sources) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}
