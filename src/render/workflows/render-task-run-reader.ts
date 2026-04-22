import { Render } from "@renderinc/sdk";
import type { TaskRunReader, WorkflowTaskRunDetails } from "../../ports/task-run-reader.js";

export function createRenderTaskRunReader(): TaskRunReader {
  const render = new Render();
  return {
    async getTaskRun(taskRunId: string): Promise<WorkflowTaskRunDetails> {
      const details = await render.workflows.getTaskRun(taskRunId);
      return {
        status: details.status,
        results: details.results ?? [],
      };
    },
  };
}
