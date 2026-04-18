import { WebSocket as WS } from "ws";
import { ASSEMBLYAI_WS_URL, SESSION_CONFIG } from "./config.js";
import { Render } from "@renderinc/sdk";
import { getRecentWorkflowRuns } from "../lib/db.js";
import {
  runIngestPipeline,
  runRecallPipeline,
  runReportPipeline,
} from "../pipeline/orchestrator.js";

type ToolArgs = Record<string, unknown>;

type PipelineChunk = { event: string; data: Record<string, unknown> };

/**
 * Same dispatch + poll + phase events as HTTP SSE (`pipeline/orchestrator.ts`),
 * but events are sent to the browser over the voice WebSocket as `type: "pipeline"`.
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
    if (clientWs.readyState === WS.OPEN) {
      clientWs.send(
        JSON.stringify({
          type: "pipeline",
          sseEvent: chunk.event,
          data: chunk.data,
        })
      );
    }

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

async function handleLearnTopic(clientWs: WS, args: ToolArgs) {
  const topic = args.topic as string;
  const claim = args.claim as string;
  const out = await forwardPipeline(clientWs, runIngestPipeline(topic, claim));
  if (!out.ok) {
    return { error: out.message, topic, claim };
  }
  return {
    taskRunId: out.taskRunId,
    entryId: out.result.entryId,
    confidence: out.result.confidence,
    message: `Stored knowledge about "${topic}" (entry ${String(out.result.entryId ?? "").slice(0, 8)}…).`,
  };
}

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
  const out = await forwardPipeline(clientWs, runReportPipeline());
  if (!out.ok) {
    return { error: out.message };
  }
  return {
    taskRunId: out.taskRunId,
    report: out.result,
    message: "Report task finished. Summarize key themes for the user from the result.",
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
 * Voice tools use the same Render Workflow orchestration as HTTP SSE (`/api/pipeline/*`).
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
