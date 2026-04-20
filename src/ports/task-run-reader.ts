/**
 * Fetches a Render Workflow task run by id (vendor-specific adapter behind this port).
 */
export interface WorkflowTaskRunDetails {
  status: string;
  results: unknown[];
}

export interface TaskRunReader {
  getTaskRun(taskRunId: string): Promise<WorkflowTaskRunDetails>;
}
