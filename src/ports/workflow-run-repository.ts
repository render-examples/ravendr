import type { WorkflowRun } from "../lib/db.js";

/** Read-side access to tracked workflow runs. */
export interface WorkflowRunRepository {
  listRecent(limit: number): Promise<WorkflowRun[]>;
}
