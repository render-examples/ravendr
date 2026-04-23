
<h1 align="center">Ravendr</h1>

<p align="center">
  Voice-first research demo. Click the mic, say a topic, get a cited briefing back.<br/>
  Every step is a Render Workflow task.
</p>

<p align="center">
  <a href="https://render.com/deploy?repo=https://github.com/ojusave/ravendr"><img src="https://render.com/images/deploy-to-render-button.svg" alt="Deploy to Render" height="32" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white&style=flat-square" alt="Node 22+" />
  <img src="https://img.shields.io/badge/typescript-strict-3178c6?logo=typescript&logoColor=white&style=flat-square" alt="TypeScript strict" />
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT" />
</p>

## Stack

| | Platform | Job |
|---|---|---|
| <img src="./static/images/logos/render.svg" width="28" /> | **[Render Workflows](https://render.com/docs/workflows)** | Orchestrator. `voiceSession` task owns the session; `plan_queries → search_branch × N → synthesize` are independently-retried subtasks. |
| <img src="./static/images/logos/assemblyai.png" width="28" /> | **[AssemblyAI Voice Agent](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)** | STT + VAD + LLM + TTS in one WebSocket. Lives inside the voiceSession task. |
| <img src="./static/images/logos/mastra.png" width="28" /> | **[Mastra](https://mastra.ai/docs/agents/overview)** | Agent primitive. Plans queries and writes the briefing via `anthropic/claude-sonnet-4`. |
| <img src="./static/images/logos/youcom.png" width="28" /> | **[You.com Research](https://you.com/docs/search/overview)** | One call per planned angle, fanned out in parallel. |

## Architecture

```
Browser ←audio WS→ Web service (broker) ←reverse WS→ voiceSession task ←→ AssemblyAI
                        │                                   │
                   Postgres NOTIFY  ←── phase events ──     │
                        │                                   │
                        ▼ SSE                               ▼ on tool.call "research":
                   Browser activity feed           research subtask
                                                     ├─ plan_queries
                                                     ├─ search_branch × N
                                                     └─ synthesize
```

- Click mic → `POST /api/start` → Render dispatches `voiceSession`.
- Task opens AssemblyAI and a reverse WS back to the broker; audio tunnels through.
- You speak a topic. AssemblyAI fires `research(topic)`. The tool dispatches the research subtask.
- Each subtask emits a phase event via Postgres NOTIFY → SSE → activity feed.
- `briefing.ready` fires; tool.result returns the full briefing; AssemblyAI reads it aloud.

## Run locally

```bash
cp .env.example .env
createdb ravendr
npm install
npm run migrate
npm run dev           # web service on :3000
npm run dev:tasks     # workflow runner in a second terminal
```

Required env on **both** services:
- `DATABASE_URL`, `ANTHROPIC_API_KEY`, `YOU_API_KEY`, `ASSEMBLYAI_API_KEY`

Web only: `RENDER_API_KEY`, `WORKFLOW_SLUG` (default `ravendr-workflow`).

## Deploy

1. Fork. Hit **Deploy to Render** — Blueprint creates `ravendr-web` + `ravendr-db`.
2. In the dashboard, create a Workflow service `ravendr-workflow`, same repo, start command `node dist/render/tasks/index.js`.
3. Put secrets in an env group `ravendr-shared` so both services share them.
4. Migrations run on every web deploy (`preDeployCommand: npm run migrate`).

## Repo layout

```
src/
  server.ts routes.ts config.ts        web service
  render/session-broker.ts              pairs /ws/client and /ws/task
  render/tasks/voice-session.ts         ROOT: owns AssemblyAI + reverse WS
  render/tasks/research.ts              orchestrates the subtasks below
  render/tasks/plan-queries.ts          leaf — Mastra + Anthropic
  render/tasks/search-branch.ts         leaf — You.com (× N parallel)
  render/tasks/synthesize.ts            leaf — Mastra + Anthropic
  youcom/research.ts                    You.com adapter
static/                                 vanilla ES modules (index.html + main.js + mic.js)
```

## Known limitation

AssemblyAI's Voice Agent doesn't let the server force the agent to speak a specific string. After `tool.result` the agent's LLM usually reads the briefing aloud, but not always. When it goes silent, the briefing still renders on screen — voice is the soft path, UI is the hard one. For guaranteed single-voice narration of every phase, swap AssemblyAI for OpenAI Realtime (`conversation.item.create`).

## License

MIT
