# Ravendr

**Ask it anything by voice. Watch a platform stack build an answer for you in real time.**

Ravendr is a viral-demo-shaped web app that shows four vendors at four non-overlapping layers of the modern AI stack:

| Layer | Vendor |
|---|---|
| Voice I/O runtime (STT · VAD · turn · TTS) | **AssemblyAI** Voice Agent API |
| Compute, durable orchestration, state | **Render** (Web Service · Workflows · Postgres) |
| Agent reasoning + memory | **Mastra** |
| Deep research synthesis with citations | **You.com** Research API |

When you tap the mic and say a topic, the whole chain lights up on screen while a voice narrator tells you what each platform is doing. The briefing itself is the dessert; the orchestration is the main course.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ojusave/ravendr)

---

## Architecture

```
Browser ──(WS)──► Render Web Service ──(startTask)──► Render Workflow task
   ▲  (audio +               │                             │
   │   SSE events)            │ LISTEN                      │ NOTIFY
   │                          ▼                             ▼
   └──── AssemblyAI ◄── Postgres (LISTEN/NOTIFY event bus) ◄──┘
         (voice agent)          │                             │
                                │                             ├─► Mastra (memory)
                                │                             ├─► You.com Research
                                ▼                             └─► Anthropic (LLM synthesis)
                        Narrator (templates +
                        LLM summarization)
```

**Flow:** The user's voice utterance becomes a `research(topic)` tool call on AssemblyAI. The web service writes a session row, dispatches a Render Workflow task, and returns a short acknowledgement. The task runs multi-tier You.com calls (lite → standard → lite), synthesizes via Anthropic, writes the briefing to Postgres, and emits structured `PhaseEvent`s via `NOTIFY`. The web service `LISTEN`-s; every event goes both to the browser (SSE, for the chain ribbon) and to the narrator (which turns it into a short spoken line via `session.say()`).

## Repo layout

```
src/
  server.ts              composition root
  routes.ts              HTTP + SSE
  config.ts              Zod-validated env

  shared/                ports.ts · events.ts · envelope.ts · errors.ts · logger.ts
  research/              runner.ts · agent-prompts.ts
  narrator/              narrator-agent.ts · session.ts · templates.ts

  assemblyai/            runtime.ts (VoiceRuntime port) · ws-proxy.ts
  mastra/                memory.ts (@mastra/pg)
  youcom/                research.ts (ResearchProvider port)
  anthropic/             llm.ts (LLMProvider port)

  render/
    db.ts                typed Postgres queries
    event-bus.ts         LISTEN/NOTIFY EventBus port
    workflow-dispatcher.ts
    tasks/               research-task.ts (the hero-chain body)

static/                  vanilla ES modules — index.html · main.js · mic.js · chain-ribbon.js · api-client.js
migrations/              0001_init.sql
scripts/migrate.ts       applies every .sql file in order
render.yaml              Blueprint (web + db; Workflow service is created manually)
```

Every vendor folder implements exactly one port (`VoiceRuntime`, `LLMProvider`, `ResearchProvider`, `EventBus`). `src/research/` and `src/narrator/` import only from `src/shared/ports.ts` — never from a vendor folder directly.

## Run locally

```bash
cp .env.example .env   # fill in the keys
createdb ravendr
npm install
npm run migrate        # applies migrations/0001_init.sql
npm run dev            # web service on :3000
# in a second terminal, for the workflow task runner:
npm run dev:tasks
```

Open `http://localhost:3000`, grant mic permission, tap, and say a topic.

## Deploy on Render

1. **Fork** this repo.
2. Click **Deploy to Render** — the Blueprint provisions `ravendr-web` and `ravendr-db`.
3. **Create a Workflow service** (`ravendr-tasks`) manually in the dashboard, pointing at the same repo, using start command `node dist/render/tasks/index.js`. Set the same env group as the web service.
4. Set the three secrets (`ANTHROPIC_API_KEY`, `YOUCOM_API_KEY`, `ASSEMBLYAI_API_KEY`, `RENDER_API_KEY`) on both services.
5. Run migrations: `Shell` into the web service and `npm run migrate`.

## What each platform earns

- **AssemblyAI** — the only piece that can deliver sub-300ms turn-taking, barge-in, and a single-WebSocket voice loop. Owns the *feel*.
- **Render Workflows** — where the 60–120s research task lives. No HTTP handler can carry a task that long.
- **Mastra** — memory-backed agent primitives. Researcher loops + narrator state across sessions go here.
- **You.com** — turnkey deep research with inline citations. Removes the need to build your own web-scale RAG.

Swap any one of them by writing a new adapter behind its port. No feature code changes.

## License

MIT
