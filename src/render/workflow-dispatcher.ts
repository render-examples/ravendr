import { Render } from "@renderinc/sdk";
import { AppError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

export interface WorkflowDispatcherConfig {
  apiKey: string;
  workflowSlug: string;
}

export interface ResearchDispatchArgs {
  sessionId: string;
  topic: string;
}

export interface WorkflowDispatcher {
  dispatchResearch(args: ResearchDispatchArgs): Promise<string>;
}

/**
 * Dispatches Render Workflow tasks. The Workflow service must already be
 * created in the Render dashboard with its slug matching config.workflowSlug.
 */
export function createWorkflowDispatcher(
  config: WorkflowDispatcherConfig
): WorkflowDispatcher {
  process.env.RENDER_API_KEY = config.apiKey;
  const render = new Render();

  return {
    async dispatchResearch(args) {
      try {
        const started = await render.workflows.startTask(
          `${config.workflowSlug}/research`,
          [args.sessionId, args.topic]
        );
        const runId = (started as { taskRunId?: string }).taskRunId;
        if (!runId) throw new AppError("UPSTREAM_WORKFLOW", "missing taskRunId");
        return runId;
      } catch (err) {
        logger.error({ err, args }, "dispatchResearch failed");
        throw new AppError("UPSTREAM_WORKFLOW", "failed to dispatch research task", {
          cause: err,
        });
      }
    },
  };
}
