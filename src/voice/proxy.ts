import { WebSocket as WS } from "ws";
import { ASSEMBLYAI_WS_URL, SESSION_CONFIG } from "./config.js";
import { Render } from "@renderinc/sdk";
import { getRecentWorkflowRuns, trackWorkflowRun } from "../lib/db.js";
import {
  DASHBOARD_TASKS_URL,
  runRecallPipeline,
  TOOLS_INGEST,
  TOOLS_REPORT,
  WORKFLOW_SLUG,
} from "../pipeline/orchestrator.js";
import { pollTaskRun } from "../pipeline/poll-task.js";

type ToolArgs = Record<string, unknown>;

type PipelineChunk = { event: string; data: Record<string, unknown> };

function sendPipelineEvent(clientWs: WS, chunk: PipelineChunk): void {
  if (clientWs.readyState !== WS.OPEN) return;
  clientWs.send(
    JSON.stringify({
      type: "pipeline",
      sseEvent: chunk.event,
      data: chunk.data,
    })
  );
}

/**
 * Poll workflow run in the background so AssemblyAI receives `tool.result` quickly.
 * If we await the full poll inside the tool handler, the serialized WS queue blocks
 * and the model cannot speak until the workflow finishes (minutes of silence).
 */
function runPollInBackground(
  clientWs: WS,
  render: Render,
  started: Awaited<ReturnType<Render["workflows"]["startTask"]>>,
  tools: readonly string[]
): void {
  void (async () => {
    try {
      for await (const chunk of pollTaskRun(render, started, undefined, tools)) {
        sendPipelineEvent(clientWs, chunk);
      }
    } catch (e) {
      console.error("[voice-proxy] background workflow poll:", e);
    }
  })();
}

/**
 * Full pipeline for tools that must block until done (recall briefing).
 */
async function forwardPipeline(
  clientWs: WS,
  gen: AsyncGenerator<PipelineChunk>
): Promise<
  | { ok: true; result: Record<string, unknown>; taskRunId: string }
  | { ok: false; message: string }
> {
  let taskRunId = "";
  let result: Record<string, unknown> = {};

  for await (const chunk of gen) {
    sendPipelineEvent(clientWs, chunk);

    if (chunk.data.taskRunId && typeof chunk.data.taskRunId === "string") {
      taskRunId = chunk.data.taskRunId;
    }

    if (chunk.event === "error") {
      return {
        ok: false,
        message: String(chunk.data.message ?? "Pipeline error"),
      };
    }

    if (chunk.event === "done" && chunk.data.result) {
      result = chunk.data.result as Record<string, unknown>;
      if (typeof chunk.data.taskRunId === "string") {
        taskRunId = chunk.data.taskRunId;
      }
    }
  }

  return { ok: true, result, taskRunId };
}

/** Same dispatch + `started` as HTTP SSE, then background poll so voice is not silent for minutes. */
async function handleLearnTopic(clientWs: WS, args: ToolArgs) {
  const topic = args.topic as string;
  const claim = args.claim as string;
  const t0 = Date.now();
  const render = new Render();

  sendPipelineEvent(clientWs, {
    event: "status",
    data: { phase: "dispatching", elapsed: 0, tools: [...TOOLS_INGEST] },
  });

  const started = await render.workflows.startTask(
    `${WORKFLOW_SLUG}/ingest`,
    [topic, claim]
  );

  await trackWorkflowRun({
    id: started.taskRunId,
    type: "ingest",
    input: { topic, claim },
  });

  sendPipelineEvent(clientWs, {
    event: "started",
    data: {
      taskRunId: started.taskRunId,
      dashboardUrl: DASHBOARD_TASKS_URL,
      tools: [...TOOLS_INGEST],
      elapsed: Math.floor((Date.now() - t0) / 1000),
    },
  });

  runPollInBackground(clientWs, render, started, TOOLS_INGEST);

  return {
    taskRunId: started.taskRunId,
    message: `Started learning about "${topic}". I will keep researching in the background.`,
  };
}

/** Blocks until briefing exists (same as HTTP recall). */
async function handleRecallTopic(clientWs: WS, args: ToolArgs) {
  const query = args.query as string;
  const out = await forwardPipeline(clientWs, runRecallPipeline(query));
  if (!out.ok) {
    return {
      briefing: `Recall failed: ${out.message}`,
      entryCount: 0,
      staleCount: 0,
    };
  }
  const r = out.result as {
    briefing?: string;
    entryCount?: number;
    staleCount?: number;
  };
  return {
    briefing: r.briefing ?? "",
    entryCount: r.entryCount ?? 0,
    staleCount: r.staleCount ?? 0,
    taskRunId: out.taskRunId,
  };
}

async function handleGenerateReport(clientWs: WS) {
  const t0 = Date.now();
  const render = new Render();

  sendPipelineEvent(clientWs, {
    event: "status",
    data: { phase: "dispatching", elapsed: 0, tools: [...TOOLS_REPORT] },
  });

  const started = await render.workflows.startTask(
    `${WORKFLOW_SLUG}/report`,
    []
  );

  await trackWorkflowRun({
    id: started.taskRunId,
    type: "report",
    input: {},
  });

  sendPipelineEvent(clientWs, {
    event: "started",
    data: {
      taskRunId: started.taskRunId,
      dashboardUrl: DASHBOARD_TASKS_URL,
      tools: [...TOOLS_REPORT],
      elapsed: Math.floor((Date.now() - t0) / 1000),
    },
  });

  runPollInBackground(clientWs, render, started, TOOLS_REPORT);

  return {
    taskRunId: started.taskRunId,
    message:
      "Started the full knowledge report in the background. I will summarize when it is ready if you ask, or check status.",
  };
}

async function handleCheckStatus(args: ToolArgs) {
  const taskRunId = args.taskRunId as string | undefined;
  const render = new Render();
  if (taskRunId) {
    try {
      const details = await render.workflows.getTaskRun(taskRunId);
      return {
        status: details.status,
        details: `Task ${taskRunId} is ${details.status}.`,
      };
    } catch {
      return {
        status: "unknown",
        details: `Could not find task run ${taskRunId}.`,
      };
    }
  }
  const recent = await getRecentWorkflowRuns(5);
  if (recent.length === 0)
    return { status: "empty", details: "No recent workflow activity." };
  const running = recent.filter((r) => r.status === "running");
  return {
    status: running.length > 0 ? `${running.length} running` : "all done",
    details: recent.map((r) => `${r.type}: ${r.status}`).join(", "),
  };
}

/**
 * Creates a proxy WebSocket connection between a browser client and AssemblyAI.
 * Voice tools use the same Render Workflow tasks as HTTP SSE; ingest/report return
 * immediately so the voice model can speak while workflows run.
 */
export function createVoiceProxy(
  clientWs: WS,
  onEvent?: (event: Record<string, unknown>) => void
) {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    clientWs.send(
      JSON.stringify({
        type: "error",
        message: "ASSEMBLYAI_API_KEY not configured",
      })
    );
    clientWs.close();
    return;
  }

  const assemblyWs = new WS(ASSEMBLYAI_WS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const pendingTools: { call_id: string; result: unknown }[] = [];

  /**
   * Process AssemblyAI messages one at a time. If we handle `tool.call` with async
   * work while another `message` event runs, `reply.done` can be processed before
   * `pendingTools` is populated, so `tool.result` is never sent and the agent hangs.
   */
  let assemblyMessageChain = Promise.resolve();

  assemblyWs.on("open", () => {
    assemblyWs.send(
      JSON.stringify({
        type: "session.update",
        session: SESSION_CONFIG,
      })
    );
  });

  assemblyWs.on("message", (data: Buffer) => {
    assemblyMessageChain = assemblyMessageChain
      .then(async () => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        const eventType = event.type as string;

        onEvent?.(event);

        if (eventType === "tool.call") {
          const name = event.name as string;
          const args = (event.args ?? {}) as ToolArgs;
          const callId = event.call_id as string;

          let result: unknown;

          try {
            if (name === "learn_topic") {
              result = await handleLearnTopic(clientWs, args);
            } else if (name === "recall_topic") {
              result = await handleRecallTopic(clientWs, args);
            } else if (name === "generate_report") {
              result = await handleGenerateReport(clientWs);
            } else if (name === "check_status") {
              result = await handleCheckStatus(args);
            } else {
              result = { error: `Unknown tool: ${name}` };
            }
          } catch (err) {
            result = {
              error: err instanceof Error ? err.message : "Tool execution failed",
            };
          }

          pendingTools.push({ call_id: callId, result });
        } else if (eventType === "reply.done") {
          const status = event.status as string | undefined;
          if (status === "interrupted") {
            pendingTools.length = 0;
          } else if (pendingTools.length > 0) {
            for (const tool of pendingTools) {
              assemblyWs.send(
                JSON.stringify({
                  type: "tool.result",
                  call_id: tool.call_id,
                  result: JSON.stringify(tool.result),
                })
              );
            }
            pendingTools.length = 0;
          }
        }

        if (eventType !== "tool.call" && clientWs.readyState === WS.OPEN) {
          clientWs.send(data.toString());
        }
      })
      .catch((err) => {
        console.error("[voice-proxy] AssemblyAI message handler error:", err);
      });
  });

  assemblyWs.on("error", (err) => {
    console.error("AssemblyAI WS error:", err.message);
    if (clientWs.readyState === WS.OPEN) {
      clientWs.send(
        JSON.stringify({ type: "error", message: "Voice connection error" })
      );
    }
  });

  assemblyWs.on("close", () => {
    if (clientWs.readyState === WS.OPEN) {
      clientWs.close();
    }
  });

  clientWs.on("message", (data: Buffer) => {
    if (assemblyWs.readyState === WS.OPEN) {
      assemblyWs.send(data.toString());
    }
  });

  clientWs.on("close", () => {
    if (assemblyWs.readyState === WS.OPEN) {
      assemblyWs.close();
    }
  });

  clientWs.on("error", () => {
    if (assemblyWs.readyState === WS.OPEN) {
      assemblyWs.close();
    }
  });
}
