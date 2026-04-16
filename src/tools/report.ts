import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Render } from "@renderinc/sdk";
import {
  trackWorkflowRun,
  completeWorkflowRun,
  failWorkflowRun,
} from "../lib/db.js";

const WORKFLOW_SLUG = process.env.WORKFLOW_SLUG ?? "ravendr-workflows";

export const generateReportTool = createTool({
  id: "generate_report",
  description:
    "Generate a comprehensive synthesis report of the entire knowledge base. " +
    "Use this when the user asks for a full report, summary of everything they've learned, " +
    "or wants to see connections across all their topics. This is a long-running task.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    taskRunId: z.string(),
    message: z.string(),
  }),
  execute: async () => {
    const render = new Render();
    const started = await render.workflows.startTask(
      `${WORKFLOW_SLUG}/report`,
      []
    );

    await trackWorkflowRun({
      id: started.taskRunId,
      type: "report",
      input: {},
    });

    void started
      .get()
      .then(async (details) => {
        const status = details.status;
        if (status === "completed" || status === "succeeded") {
          const result = (details.results[0] ?? {}) as Record<string, unknown>;
          await completeWorkflowRun(started.taskRunId, result);
        } else {
          await failWorkflowRun(
            started.taskRunId,
            details.error ?? `Task ended with status ${status}`
          );
        }
      })
      .catch(async (err) => {
        const message = err instanceof Error ? err.message : String(err);
        await failWorkflowRun(started.taskRunId, message);
      });

    return {
      taskRunId: started.taskRunId,
      message:
        "Started generating a synthesis report. This may take a minute or two. " +
        "You can ask me to check the status when you're ready.",
    };
  },
});
