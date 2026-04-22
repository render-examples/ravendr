import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { initDb } from "./render/postgres/db.js";
import { createVoiceProxy } from "./assemblyai/proxy.js";
import {
  runIngestPipeline,
  runRecallPipeline,
  runReportPipeline,
} from "./render/workflows/orchestrator.js";
import { getRenderDashboardTasksUrl } from "./render/workflows/render-dashboard-url.js";
import { createAppDeps } from "./composition.js";
import { ok, fail } from "./shared/api-envelope.js";

const app = new Hono();
const deps = createAppDeps();
const PORT = parseInt(process.env.PORT ?? "3000", 10);

function isTaskSuccess(status: string): boolean {
  return status === "completed" || status === "succeeded";
}

app.get("/health", (c) => c.json(ok({ status: "ok", service: "ravendr-web" })));

app.get("/api/config", (c) =>
  c.json(ok({ dashboardTasksUrl: getRenderDashboardTasksUrl() }))
);

app.get("/api/workflows/recent", async (c) => {
  try {
    const runs = await deps.workflowRuns.listRecent(10);
    return c.json(ok(runs));
  } catch {
    return c.json(fail("WORKFLOWS_FETCH_FAILED", "Failed to fetch workflows"), 500);
  }
});

app.get("/api/knowledge", async (c) => {
  try {
    const entries = await deps.knowledge.getAll();
    return c.json(ok(entries));
  } catch {
    return c.json(fail("KNOWLEDGE_FETCH_FAILED", "Failed to fetch knowledge"), 500);
  }
});

app.get("/api/report/:taskRunId", async (c) => {
  const { taskRunId } = c.req.param();
  try {
    const details = await deps.taskRuns.getTaskRun(taskRunId);
    if (isTaskSuccess(details.status) && details.results.length > 0) {
      return c.json(ok(details.results[0]));
    }
    return c.json(ok({ status: details.status }));
  } catch {
    return c.json(fail("TASK_RUN_NOT_FOUND", "Task run not found"), 404);
  }
});

app.post("/api/pipeline/ingest", async (c) => {
  c.header("X-Accel-Buffering", "no");
  let body: { topic?: string; claim?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(fail("INVALID_JSON", "Invalid JSON"), 400);
  }
  if (!body.topic?.trim() || !body.claim?.trim()) {
    return c.json(fail("VALIDATION_ERROR", "topic and claim are required"), 400);
  }
  const signal = c.req.raw.signal;
  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of runIngestPipeline(
        body.topic!.trim(),
        body.claim!.trim(),
        signal
      )) {
        await stream.writeSSE({
          event: chunk.event,
          data: JSON.stringify(chunk.data),
        });
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: "Request aborted" }),
        });
        return;
      }
      throw e;
    }
  });
});

app.post("/api/pipeline/recall", async (c) => {
  c.header("X-Accel-Buffering", "no");
  let body: { query?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(fail("INVALID_JSON", "Invalid JSON"), 400);
  }
  if (!body.query?.trim()) {
    return c.json(fail("VALIDATION_ERROR", "query is required"), 400);
  }
  const signal = c.req.raw.signal;
  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of runRecallPipeline(body.query!.trim(), signal)) {
        await stream.writeSSE({
          event: chunk.event,
          data: JSON.stringify(chunk.data),
        });
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: "Request aborted" }),
        });
        return;
      }
      throw e;
    }
  });
});

app.post("/api/pipeline/report", async (c) => {
  c.header("X-Accel-Buffering", "no");
  const signal = c.req.raw.signal;
  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of runReportPipeline(signal)) {
        await stream.writeSSE({
          event: chunk.event,
          data: JSON.stringify(chunk.data),
        });
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: "Request aborted" }),
        });
        return;
      }
      throw e;
    }
  });
});

app.use(
  "/*",
  serveStatic({
    root: "./src/static",
    rewriteRequestPath: (path) => {
      if (path === "/") return "/index.html";
      return path;
    },
  })
);

async function start() {
  try {
    await initDb();
    console.log("Database initialized");
  } catch (err) {
    console.warn("Database init skipped (will retry on first query):", (err as Error).message);
  }

  const server = createServer(getRequestListener(app.fetch));

  const voiceEnabled = process.env.ENABLE_VOICE_WEBSOCKET !== "false";
  if (voiceEnabled) {
    const wss = new WebSocketServer({ server, path: "/ws/voice" });
    wss.on("connection", (clientWs: WebSocket) => {
      console.log("Voice client connected");
      createVoiceProxy(clientWs, (event) => {
        const t = event.type as string;
        if (t === "session.ready") console.log("Voice session ready");
        if (t === "error") console.error("Voice error:", event.message);
      });
    });
  } else {
    console.warn("Voice WebSocket disabled (ENABLE_VOICE_WEBSOCKET=false)");
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Ravendr server listening on 0.0.0.0:${PORT}`);
  });
}

start().catch(console.error);
