import { task } from "@renderinc/sdk/workflows";
import { loadWorkflowConfig } from "../../config.js";
import { createPostgresEventBus } from "../event-bus.js";
import { createBriefing, setSessionStatus } from "../db.js";
import { logger } from "../../shared/logger.js";
import { plan_queries } from "./plan-queries.js";
import { search_branch, type BranchResult } from "./search-branch.js";
import { synthesize } from "./synthesize.js";

export interface ResearchResult {
  briefingId: string;
  sourceCount: number;
  content: string;
}

/**
 * Render Workflow subtask: orchestrates the research pipeline.
 *
 * Each `await` below dispatches a NEW Render task run. That's the checkpoint
 * boundary — failures in a child retry independently without restarting
 * this parent.
 *
 *   plan_queries (1 run)
 *   search_branch (N parallel runs)
 *   synthesize    (1 run)
 */
export const research = task(
  {
    name: "research",
    plan: "starter",
    timeoutSeconds: 600,
    retry: { maxRetries: 0, waitDurationMs: 1_000, backoffScaling: 1.5 },
  },
  async function research(
    sessionId: string,
    topic: string
  ): Promise<ResearchResult> {
    logger.info({ sessionId, topic }, "research: start");
    const config = loadWorkflowConfig();
    const events = createPostgresEventBus({
      connectionString: config.DATABASE_URL,
    });
    await events.start();

    const runId = process.env.RENDER_TASK_RUN_ID ?? `local-${Date.now()}`;
    const briefingId = await createBriefing(
      config.DATABASE_URL,
      sessionId,
      topic,
      runId
    );

    try {
      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "workflow.started",
        runId,
      });

      // ── subtask 1: plan ─────────────────────────────────────────────
      const plan = await plan_queries(sessionId, topic);

      // ── subtask 2: search (parallel) ────────────────────────────────
      const branches: BranchResult[] = await Promise.all(
        plan.queries.map((q) =>
          search_branch(sessionId, q.angle, q.query, q.tier)
        )
      );

      // ── subtask 3: synthesize ───────────────────────────────────────
      const result = await synthesize(sessionId, briefingId, topic, branches);

      await events.publish({
        sessionId,
        at: Date.now(),
        kind: "workflow.completed",
        runId,
        briefingId: result.briefingId,
      });

      return result;
    } catch (err) {
      logger.error({ err, sessionId }, "research: failed");
      await setSessionStatus(config.DATABASE_URL, sessionId, "error").catch(
        () => {}
      );
      await events
        .publish({
          sessionId,
          at: Date.now(),
          kind: "workflow.failed",
          runId,
          message: err instanceof Error ? err.message : String(err),
        })
        .catch(() => {});
      throw err;
    } finally {
      await events.stop();
    }
  }
);
