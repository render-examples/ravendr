/**
 * HTTP orchestration: dispatch Render Workflow tasks, poll status, emit SSE phases.
 * Mirrors the langchain-example web service pattern (thin server, streamed progress).
 */

import { Render } from "@renderinc/sdk";

type StartedTask = Awaited<ReturnType<Render["workflows"]["startTask"]>>;
import {
  trackWorkflowRun,
  completeWorkflowRun,
  failWorkflowRun,
} from "../lib/db.js";

const WORKFLOW_SLUG = process.env.WORKFLOW_SLUG ?? "ravendr-workflows";

function pollIntervalMs(): number {
  const raw = process.env.POLL_INTERVAL_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 500 ? n : 4000;
}

export const DASHBOARD_TASKS_URL =
  process.env.RENDER_DASHBOARD_TASKS_URL ?? "https://dashboard.render.com";

const TOOLS_INGEST = [
  "Render Workflows",
  "Mastra",
  "You.com",
  "Claude",
] as const;

const TOOLS_RECALL = [
  "Render Workflows",
  "PostgreSQL",
  "You.com",
  "Claude",
] as const;

const TOOLS_REPORT = [
  "Render Workflows",
  "PostgreSQL",
  "Claude",
] as const;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

function isTerminal(status: string): boolean {
  return (
    status === "completed" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "canceled"
  );
}

function isSuccess(status: string): boolean {
  return status === "completed" || status === "succeeded";
}

function extractResult(results: unknown[]): Record<string, unknown> {
  if (!results?.length) return {};
  const raw = results[0];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

/**
 * Polls `getTaskRun` for UI updates, and races the poll interval with
 * `started.get()` so completion uses the SDK wait path (task run events SSE).
 */
async function* pollTaskRun(
  render: Render,
  started: StartedTask,
  signal: AbortSignal | undefined,
  tools: readonly string[]
): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const taskRunId = started.taskRunId;
  const donePromise = started.get();
  const t0 = Date.now();
  while (true) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const details = await render.workflows.getTaskRun(taskRunId);
    const elapsed = Math.floor((Date.now() - t0) / 1000);
    const status = details.status;

    yield {
      event: "status",
      data: {
        phase: "running",
        workflowStatus: status,
        elapsed,
        tools: [...tools],
        taskRunId,
      },
    };

    if (!isTerminal(status)) {
      await Promise.race([
        sleep(pollIntervalMs(), signal),
        donePromise,
      ]);
      continue;
    }

    if (isSuccess(status)) {
      const result = extractResult(details.results as unknown[]);
      await completeWorkflowRun(taskRunId, result);
      yield {
        event: "done",
        data: {
          result,
          taskRunId,
          elapsed,
          tools: [...tools],
        },
      };
      return;
    }

    const errMsg = details.error ?? `Task ${status}`;
    await failWorkflowRun(taskRunId, errMsg);
    yield {
      event: "error",
      data: { message: errMsg, elapsed, taskRunId },
    };
    return;
  }
}

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
