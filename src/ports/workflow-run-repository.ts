import type { WorkflowRun } from "../render/postgres/db.js";

/** Read-side access to tracked workflow runs. */
export interface WorkflowRunRepository {
  listRecent(limit: number): Promise<WorkflowRun[]>;
}
