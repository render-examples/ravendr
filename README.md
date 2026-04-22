# Ravendr

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ojusave/ravendr)

A **workflow-first** knowledge demo: the straightforward path is **HTTP + SSE** (same mental model as [render-workflows-llamaindex](https://github.com/ojusave/render-workflows-llamaindex)—thin web service, `startTask`, task worker). Optional **voice** (AssemblyAI) calls the same tasks when the model uses tools.

This repo is written as a **Render learning path**: the product is real, but the point is to see how [Render Workflows](https://render.com/workflows) and the [`@renderinc/sdk`](https://www.npmjs.com/package/@renderinc/sdk) fit together so the app is straightforward to deploy and safe to change.

## Table of contents

- [Highlights](#highlights)
- [Same shape as `llamaindex-example`](#same-shape-as-llamaindex-example)
- [Why build it this way on Render](#why-build-it-this-way-on-render)
- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Deploy](#deploy)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [API](#api)
- [Troubleshooting](#troubleshooting)

## Highlights

- **Same SDK, two roles**: the workflow service registers work with `task()` from `@renderinc/sdk/workflows`; the web service triggers runs with `Render` from `@renderinc/sdk`. One dependency, two clear boundaries.
- **Thin web, heavy tasks**: HTTP, WebSockets, and streaming stay in the Hono app. Research, Claude calls, and Postgres writes run in workflow tasks with their own plans, timeouts, and retries.
- **Same orchestrator for voice and HTTP**: `src/pipeline/orchestrator.ts` dispatches workflow tasks, polls, and emits phase events. **`POST /api/pipeline/*`** streams them as SSE; **`/ws/voice`** runs the same generators and forwards each phase to the browser as `type: "pipeline"` (mirrors the langchain-example FastAPI + SSE pattern, but over the voice socket).
- **Ports and adapters**: the web layer depends on small interfaces (`KnowledgeRepository`, `WorkflowRunRepository`, `TaskRunReader`) wired in [`src/composition.ts`](src/composition.ts). Postgres and the Render SDK live in `src/adapters/` so you can swap storage or workflow APIs without rewriting routes.
- **One JSON contract**: non-streaming HTTP responses use `{ data, error, meta }` ([`src/shared/api-envelope.ts`](src/shared/api-envelope.ts)). The browser uses a single module ([`src/static/api-client.js`](src/static/api-client.js)) to unwrap that envelope. SSE pipeline bodies stay event-stream (not wrapped).
- **Blueprint for the boring parts**: [`render.yaml`](render.yaml) stands up the web service and Postgres. You add the workflow service in the dashboard once; after that, most changes are “edit task code, redeploy the workflow,” not replumbing the whole stack.
- **Four tools, one pipeline**: [AssemblyAI](https://www.assemblyai.com) handles voice tool calls on the web service. [You.com](https://you.com) supplies web evidence inside workflow tasks. [Mastra](https://github.com/mastra-ai/mastra) agents (`factCheckerAgent`, `connectorAgent`, `synthesizerAgent`) run structured judgments and prose in those same tasks via [`src/lib/mastra-workflow.ts`](src/lib/mastra-workflow.ts). [Render Workflows](https://render.com/workflows) executes the durable graph (fact-check, deep dive, connect, store, recall).

## Same shape as `llamaindex-example`

If you know [render-workflows-llamaindex](https://github.com/ojusave/render-workflows-llamaindex), Ravendr is the same **three-layer** layout with different domain tasks:

| Layer | Document pipeline (llamaindex) | Ravendr |
| --- | --- | --- |
| Web | Express: upload → SSE progress | Hono: `POST /api/pipeline/*` → SSE progress |
| Orchestration | [`pipeline/orchestrator.ts`](https://github.com/ojusave/render-workflows-llamaindex/blob/main/pipeline/orchestrator.ts) chains tasks | [`src/pipeline/orchestrator.ts`](src/pipeline/orchestrator.ts) dispatches `ingest` / `recall` / `report` |
| Worker | [`tasks/index.js`](https://github.com/ojusave/render-workflows-llamaindex) registers tasks | [`src/tasks/index.ts`](src/tasks/index.ts) registers tasks |
| Extra | — | Optional `/ws/voice` + AssemblyAI (same `startTask` as HTTP) |

**Canonical demo:** use the **Knowledge pipeline** buttons on the home page (HTTP). Voice is additive, not required to understand Render Workflows.

## Why build it this way on Render

If you are learning Render, the useful idea is not “use workflows because the docs say so.” It is **where state and CPU live**.

The browser talks to [AssemblyAI](https://www.assemblyai.com) over a WebSocket relay in `src/server.ts` and `src/voice/proxy.ts`. That connection should stay responsive. If you run long research loops and LLM calls in the same process as that relay, you risk timeouts, memory pressure, and noisy deploys: every research tweak becomes a web deploy.

Render Workflows move that work to a **separate service** with isolated scaling and runtime settings. The web service only needs an API key and the SDK to **dispatch** work and optionally **wait** for a result.

**Define tasks** in the workflow service (see `src/tasks/`). Each exported `task({ name, plan, timeoutSeconds, retry }, fn)` is one unit you can tune without touching the web tier. Ingest combines You.com search with Mastra structured outputs in [`src/lib/mastra-workflow.ts`](src/lib/mastra-workflow.ts), then stores to Postgres. Example: `factCheck` in [`src/tasks/ingest.ts`](src/tasks/ingest.ts) calls You.com `quickSearch` and passes evidence into the Mastra fact-checker agent.

**Trigger tasks** from the web service with `new Render()` and `render.workflows.startTask(\`${WORKFLOW_SLUG}/ingest\`, [topic, claim])`. The string `${WORKFLOW_SLUG}/taskExportName` is the contract between services: it must match the workflow service name in the Render dashboard and the `name` you pass to `task()`.

**Change behavior** by editing the task implementation and redeploying the workflow service. The web service keeps dispatching the same slug until you intentionally change arguments or add new tasks. That is the main payoff of the split: product iteration on agents and tools does not require redeploying the voice edge on every tweak.

**Observe runs** in the Render dashboard (task runs, logs, failures). The UI also surfaces recent runs via Postgres-backed tracking; see `src/pipeline/orchestrator.ts` for how SSE phases mirror polling and `started.get()`.

Together with the [langchain-example](https://github.com/ojusave/langchain-test) and [render-workflows-llamaindex](https://github.com/ojusave/render-workflows-llamaindex) repos in the same family, this layout shows the same “thin orchestrator, fat tasks” pattern in Python and Node so you can pick the stack you prefer without guessing how Render fits in.

## How it works

![Architecture](static/images/architecture.png)

**Primary path:** the browser calls `POST /api/pipeline/*`; the web service `startTask`s Render Workflows and streams SSE phases—same idea as uploading a file in the document pipeline example.

![Workflow pipelines](static/images/pipelines.png)

**Optional voice:** the web service proxies WebSocket audio to AssemblyAI. When the agent calls a tool, it hits the same tasks as HTTP. **ingest** and **report** return `tool.result` right after dispatch so the model can speak while work continues (polling still emits `pipeline` events). **Recall** waits for the briefing like the HTTP recall stream.

## Prerequisites

- [AssemblyAI](https://www.assemblyai.com/app), [Render](https://render.com/docs/api#1-create-an-api-key), [Anthropic](https://console.anthropic.com/), and [You.com](https://you.com) API keys
- A [Render account](https://render.com/register?utm_source=github&utm_medium=referral&utm_campaign=ojus_demos&utm_content=readme_link)

## Deploy

### 1. Web service + database (via Blueprint)

Click **Deploy to Render** above. The [`render.yaml`](render.yaml) creates the web service and a PostgreSQL database. During setup, set `ASSEMBLYAI_API_KEY`, `RENDER_API_KEY`, and **`WORKFLOW_SLUG`** (the Workflow service name you will create or already use, for example `ravendr-workflows`). The slug must match the Workflow service name in the dashboard exactly.

### 2. Workflow service (manual)

1. [Render Dashboard](https://dashboard.render.com) > **New** > **Workflow**
2. Connect the same repo
3. Build: `npm ci && npm run build` (same as Blueprint; requires committed `package-lock.json`)
4. Start: `node dist/tasks/index.js`
5. Name: `ravendr-workflows` (must match `WORKFLOW_SLUG`)
6. Env vars: `ANTHROPIC_API_KEY`, `YOU_API_KEY`, `DATABASE_URL` ([Internal URL](https://render.com/docs/databases#connecting-from-within-render)), `NODE_VERSION`: `22`

## Configuration

| Variable | Where | Default | Description |
|---|---|---|---|
| `ASSEMBLYAI_API_KEY` | Web service | (required) | Voice agent |
| `RENDER_API_KEY` | Web service | (required) | Workflow triggers |
| `DATABASE_URL` | Both | (required) | PostgreSQL connection string |
| `WORKFLOW_SLUG` | Web service | `ravendr-workflows` | Must match workflow service name |
| `ANTHROPIC_API_KEY` | Workflow | (required) | Claude for AI agents |
| `YOU_API_KEY` | Workflow | (required) | Web research |
| `ANTHROPIC_MODEL` | Workflow | `claude-sonnet-4-20250514` | Claude model ID |

Optional on the web service only (add in the Dashboard **Environment** tab; omitted from [`render.yaml`](render.yaml) so Deploy stays short): `POLL_INTERVAL_MS`, `RENDER_DASHBOARD_TASKS_URL`.

**Build time**: [`render.yaml`](render.yaml) uses `npm ci` (with [`package-lock.json`](package-lock.json)) and [`.npmrc`](.npmrc) skips npm audit during install. Render still has to download and install a large dependency tree (`@mastra/*` pulls a lot of packages): first builds or cache-cleared builds are slow. Avoid **Clear build cache & deploy** unless you need a clean `node_modules`. In **Workspace Settings** > **Build Pipeline**, Professional workspaces can switch to the **Performance** pipeline tier for heavier CPU or memory during builds ([docs](https://render.com/docs/build-pipeline)).

## Project structure

```
src/
  server.ts              Hono web server (HTTP + WebSocket)
  composition.ts         Wires ports to adapters
  shared/api-envelope.ts JSON response envelope helpers
  ports/                 Repository and task-run reader interfaces
  adapters/              Postgres + Render SDK implementations
  voice/
    config.ts            AssemblyAI session config and tool definitions
    proxy.ts             WebSocket proxy: browser <> AssemblyAI <> Workflows
  agents/
    fact-checker.ts      Scores claim confidence against evidence
    synthesizer.ts       Voice-friendly summaries
    connector.ts         Cross-topic relationship detection
    ingest-research.ts   Mastra tools for quick/deep search in ingest
  tasks/
    index.ts             Task entry point (register with Render Workflows)
    ingest.ts            factCheck + deepDive > connect > store
    recall.ts            search > freshen > synthesize
    report.ts            gather > cluster > crossRef (parallel) > generate
  lib/
    db.ts                PostgreSQL schema + queries
    you-client.ts        You.com Research API wrapper
    mastra-workflow.ts   Mastra agents + You.com evidence inside tasks
  static/
    index.html           Voice UI shell
    app.js               UI logic (ES module)
    api-client.js        Single client for JSON APIs + SSE helpers
render.yaml              Render Blueprint
```

## API

**JSON responses** (everything except SSE streams) use:

```json
{ "data": <T | null>, "error": { "code": "...", "message": "..." } | null, "meta": {} }
```

Success: `error` is `null` and the payload is in `data`. Errors: HTTP status reflects the failure; `error.code` and `error.message` are stable for clients.

| Method | Path | Notes |
|--------|------|--------|
| GET | `/health` | `data`: `{ "status": "ok", "service": "ravendr-web" }` |
| GET | `/api/config` | `data`: `{ dashboardTasksUrl }` |
| GET | `/api/workflows/recent` | `data`: recent workflow run rows |
| GET | `/api/knowledge` | `data`: knowledge entries |
| GET | `/api/report/:taskRunId` | `data`: task result object, or `{ status }` while pending |
| POST | `/api/pipeline/ingest` | Body: `topic`, `claim` — **SSE** phases (not envelope) |
| POST | `/api/pipeline/recall` | Body: `query` — **SSE** phases |
| POST | `/api/pipeline/report` | **SSE** phases |
| WS | `/ws/voice` | Voice session (off if `ENABLE_VOICE_WEBSOCKET=false`) |
| GET | `/` | Static UI |

**WebSocket `/ws/voice`**: proxies audio between browser and AssemblyAI; tool calls route to Render Workflows (same orchestration as HTTP SSE).

### Monorepo (optional)

If this folder lives inside a monorepo (e.g. **Samples**), use the repository root [`render.yaml`](../render.yaml) for preview environments and multi-service deploy.

## Troubleshooting

**Deploy fails or health check never goes green**: the web process listens on `0.0.0.0` and `PORT` (set by Render). The HTTP server must use Hono’s Node adapter (`getRequestListener` from `@hono/node-server`), not raw `createServer(app.fetch)`, or static file middleware can throw `this.raw.headers.get is not a function` during health checks. Confirm **Build** logs show `npm run build` succeeding and **Shell** start command is `node dist/server.js` from the repo root. If the **workflow** service failed, open its logs: it needs `DATABASE_URL` (Internal URL), `YOU_API_KEY`, `ANTHROPIC_API_KEY`, and a start command that runs the compiled entry (`node dist/tasks/index.js` after the same build as the web service).

**Voice connection fails**: check `ASSEMBLYAI_API_KEY` is set on the web service.

**Workflows never complete**: verify the workflow service name matches `WORKFLOW_SLUG` (default: `ravendr-workflows`).

**"recall" returns empty**: ingest runs in the background. If you recall a topic right after mentioning it, the research may still be running.

**You.com research not triggering**: verify `YOU_API_KEY` is set on the **Workflow service** (not the web service). Check workflow logs for `[you-client] YOU_API_KEY is not set` warnings. The Mastra agent calls You.com via tools; if the key is missing, research silently returns empty results.

**Ingest completes but no knowledge stored**: check `ANTHROPIC_API_KEY` is set on the Workflow service. The Mastra agents (fact-checker, connector, synthesizer) require Claude access. Also verify `DATABASE_URL` points to the Internal URL of the PostgreSQL database.

**Database errors**: web service gets `DATABASE_URL` from Blueprint. Workflow service needs it copied manually from the database settings (Internal URL).
