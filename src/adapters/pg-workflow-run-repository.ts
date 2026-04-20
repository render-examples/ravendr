import { getRecentWorkflowRuns } from "../lib/db.js";
import type { WorkflowRunRepository } from "../ports/workflow-run-repository.js";

export function createPgWorkflowRunRepository(): WorkflowRunRepository {
  return {
    async listRecent(limit) {
      return getRecentWorkflowRuns(limit);
    },
  };
}
