/**
 * Poll Render Workflow task runs and emit SSE-shaped events for the web tier.
 */

import type { Render } from "@renderinc/sdk";
import {
  completeWorkflowRun,
  failWorkflowRun,
} from "../postgres/db.js";

export type StartedTask = Awaited<
  ReturnType<Render["workflows"]["startTask"]>
>;

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

function pollIntervalMs(): number {
  const raw = process.env.POLL_INTERVAL_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 500 ? n : 4000;
}

/**
 * Polls `getTaskRun` for UI updates, and races the poll interval with
 * `started.get()` so completion uses the SDK wait path (task run events SSE).
 */
export async function* pollTaskRun(
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
