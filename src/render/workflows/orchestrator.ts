/**
 * HTTP orchestration: dispatch Render Workflow tasks, poll status, emit SSE phases.
 * Mirrors the langchain-example web service pattern (thin server, streamed progress).
 */

import { Render } from "@renderinc/sdk";
import { trackWorkflowRun } from "../postgres/db.js";
import { getRenderDashboardTasksUrl } from "./render-dashboard-url.js";
import { pollTaskRun } from "./poll-task.js";

export const WORKFLOW_SLUG = process.env.WORKFLOW_SLUG ?? "ravendr-workflows";

/** Resolved at module load from env + validation; use getRenderDashboardTasksUrl() for the same rules. */
export const DASHBOARD_TASKS_URL = getRenderDashboardTasksUrl();

export const TOOLS_INGEST = [
  "Render Workflows",
  "Mastra",
  "You.com",
  "Claude",
] as const;

export const TOOLS_RECALL = [
  "Render Workflows",
  "PostgreSQL",
  "You.com",
  "Claude",
] as const;

export const TOOLS_REPORT = [
  "Render Workflows",
  "PostgreSQL",
  "Claude",
] as const;

export async function* runIngestPipeline(
  topic: string,
  claim: string,
  signal?: AbortSignal
): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const t0 = Date.now();
  const render = new Render();

  yield {
    event: "status",
    data: {
      phase: "dispatching",
      elapsed: 0,
      tools: [...TOOLS_INGEST],
    },
  };

  const started = await render.workflows.startTask(
    `${WORKFLOW_SLUG}/ingest`,
    [topic, claim],
    signal
  );

  await trackWorkflowRun({
    id: started.taskRunId,
    type: "ingest",
    input: { topic, claim },
  });

  yield {
    event: "started",
    data: {
      taskRunId: started.taskRunId,
      dashboardUrl: DASHBOARD_TASKS_URL,
      tools: [...TOOLS_INGEST],
      elapsed: Math.floor((Date.now() - t0) / 1000),
    },
  };

  yield* pollTaskRun(render, started, signal, TOOLS_INGEST);
}

export async function* runRecallPipeline(
  query: string,
  signal?: AbortSignal
): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const t0 = Date.now();
  const render = new Render();

  yield {
    event: "status",
    data: {
      phase: "dispatching",
      elapsed: 0,
      tools: [...TOOLS_RECALL],
    },
  };

  const started = await render.workflows.startTask(
    `${WORKFLOW_SLUG}/recall`,
    [query],
    signal
  );

  await trackWorkflowRun({
    id: started.taskRunId,
    type: "recall",
    input: { query },
  });

  yield {
    event: "started",
    data: {
      taskRunId: started.taskRunId,
      dashboardUrl: DASHBOARD_TASKS_URL,
      tools: [...TOOLS_RECALL],
      elapsed: Math.floor((Date.now() - t0) / 1000),
    },
  };

  yield* pollTaskRun(render, started, signal, TOOLS_RECALL);
}

export async function* runReportPipeline(
  signal?: AbortSignal
): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const t0 = Date.now();
  const render = new Render();

  yield {
    event: "status",
    data: {
      phase: "dispatching",
      elapsed: 0,
      tools: [...TOOLS_REPORT],
    },
  };

  const started = await render.workflows.startTask(
    `${WORKFLOW_SLUG}/report`,
    [],
    signal
  );

  await trackWorkflowRun({
    id: started.taskRunId,
    type: "report",
    input: {},
  });

  yield {
    event: "started",
    data: {
      taskRunId: started.taskRunId,
      dashboardUrl: DASHBOARD_TASKS_URL,
      tools: [...TOOLS_REPORT],
      elapsed: Math.floor((Date.now() - t0) / 1000),
    },
  };

  yield* pollTaskRun(render, started, signal, TOOLS_REPORT);
}
