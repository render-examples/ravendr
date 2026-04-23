import type { EventBus, ResearchProvider } from "../shared/ports.js";
import { createBriefing, setSessionStatus } from "../render/db.js";
import { createResearchAgent } from "./agent.js";
import { logger } from "../shared/logger.js";
import { AppError } from "../shared/errors.js";

export interface RunBriefingPorts {
  research: ResearchProvider;
  events: EventBus;
  databaseUrl: string;
  anthropicModel: string;
}

export interface RunBriefingArgs {
  sessionId: string;
  topic: string;
  runId: string;
  signal?: AbortSignal;
}

/**
 * Runs the Mastra Agent research loop inside a Render Workflow task.
 *
 * Success is measured by whether write_briefing's execute actually ran
 * (captured via closure in the agent factory). We don't parse Mastra's
 * generate() return shape — the tool's side effect is the source of truth.
 */
export async function runBriefing(
  args: RunBriefingArgs,
  ports: RunBriefingPorts
): Promise<{ briefingId: string; sourceCount: number }> {
  const { sessionId, topic, runId } = args;

  const briefingId = await createBriefing(
    ports.databaseUrl,
    sessionId,
    topic,
    runId
  );

  const { agent, getResult } = createResearchAgent({
    research: ports.research,
    events: ports.events,
    databaseUrl: ports.databaseUrl,
    anthropicModel: ports.anthropicModel,
    sessionId,
    briefingId,
  });

  try {
    await agent.generate(`Research this topic for me: ${topic}`, {
      maxSteps: 20,
    });

    const result = getResult();
    if (result) return result;

    logger.warn(
      { sessionId, topic },
      "agent finished without calling write_briefing — no briefing persisted"
    );
    throw new Error("Agent did not call write_briefing");
  } catch (err) {
    logger.error({ err, sessionId }, "runBriefing failed");
    await setSessionStatus(ports.databaseUrl, sessionId, "error").catch(() => {});
    await ports.events
      .publish({
        sessionId,
        at: Date.now(),
        kind: "workflow.failed",
        runId,
        message: err instanceof Error ? err.message : String(err),
      })
      .catch(() => {});
    throw AppError.from(err, "UPSTREAM_WORKFLOW");
  }
}
