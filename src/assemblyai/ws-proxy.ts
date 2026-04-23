import type { WebSocket as BrowserWS } from "ws";
import type {
  VoiceRuntime,
  VoiceSession,
  VoiceToolDef,
  EventBus,
} from "../shared/ports.js";
import type { WorkflowDispatcher } from "../render/workflow-dispatcher.js";
import type { PhaseEvent } from "../shared/events.js";
import {
  setSessionTopic,
  setSessionStatus,
  getBriefing,
} from "../render/db.js";
import { logger } from "../shared/logger.js";

/**
 * Bridges a browser WebSocket to an AssemblyAI VoiceSession.
 *
 * Voice architecture — polling loop for live narration:
 *
 *   The AssemblyAI Voice Agent has no server-push speech primitive. Tool
 *   returns are context the LLM uses to generate a spoken reply. So we give
 *   the agent TWO tools and tell it to loop:
 *
 *     research_start(topic)  — kicks off the Mastra Agent inside a Render
 *                              Workflow task. Returns the first narration.
 *     next_update()          — blocks up to 30 s for the next phase event
 *                              pushed by the backend. Returns structured data
 *                              with a `narrate` hint. Returns {done:true,
 *                              briefing} when the run is finished.
 *
 *   The agent's system prompt tells it to keep calling next_update after
 *   each narration until done. That turns backend phase events into a live
 *   voice commentary track — one consistent AssemblyAI voice, no silence.
 */

export interface WireOpts {
  browser: BrowserWS;
  sessionId: string;
  voice: VoiceRuntime;
  events: EventBus;
  dispatcher: WorkflowDispatcher;
  databaseUrl: string;
}

const TOOLS: VoiceToolDef[] = [
  {
    type: "function",
    name: "research_start",
    description:
      "Start the research workflow for a topic. Returns an opening line under `narrate` to say to the user, and a hint to call next_update repeatedly for progress.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "The user's topic, verbatim.",
        },
      },
      required: ["topic"],
    },
  },
  {
    type: "function",
    name: "next_update",
    description:
      "Block up to 30 seconds for the next backend progress event. Returns { narrate, ... } describing what just happened, or { done: true, briefing } when the briefing is ready. KEEP CALLING THIS UNTIL done:true.",
    parameters: { type: "object", properties: {} },
  },
];

const SYSTEM_PROMPT = `You are Ravendr, a live voice narrator for a research demo. Your job is to speak continuously about what the backend is doing while it researches a topic.

Every tool result you receive has TWO fields you care about:
  - \`narrate\`: the exact thing to tell the user (in your own voice, don't read JSON)
  - \`you_must_next\`: a procedural instruction you MUST follow immediately after speaking

Your operating loop is strict:

STEP A: When the user speaks a topic, call research_start with their exact words.
STEP B: Receive the tool result. SAY the \`narrate\` text out loud to the user.
STEP C: IMMEDIATELY do what \`you_must_next\` says — usually "call next_update() right now". Do not wait. Do not pause for the user. Do not ask anything. Just call it.
STEP D: Repeat STEP B and C for every result.
STEP E: When you_must_next says "stop", you stop.

The \`next_update\` tool will block for up to 30 seconds until the next backend phase happens, then return a new narration. That block is EXPECTED — just wait for the return, then speak, then call it again.

HARD RULES:
- NEVER call a tool without speaking its previous result first.
- NEVER stop the loop until you_must_next tells you to stop.
- NEVER ask the user a question mid-research. You are narrating, not conversing.
- NEVER paraphrase or shorten narrate into fewer words — speak it as written.
- If a result has phase:"done", that's when you read the briefing (which is inside \`narrate\`) in full and then stop.`;

const GREETING =
  "Hi — tell me any topic and I'll research it live. I'll narrate the stack working as it goes, then read you the briefing when it's done.";

interface NarrationPayload {
  phase:
    | "started"
    | "planned"
    | "search_progress"
    | "synthesizing"
    | "done"
    | "error"
    | "heartbeat";
  narrate: string;
  /** Procedural instruction the model must follow after speaking. */
  you_must_next: string;
  [key: string]: unknown;
}

const HEARTBEAT_MS = 30_000;

export async function wireVoiceSession(opts: WireOpts): Promise<void> {
  const { browser, sessionId, voice, events, dispatcher, databaseUrl } = opts;

  let session: VoiceSession | null = null;
  const abort = new AbortController();

  // ── Narration queue and one-shot dispatch state ──────────────────────
  const queue: NarrationPayload[] = [];
  const waiters: Array<(n: NarrationPayload) => void> = [];
  let researchPromise: Promise<NarrationPayload> | null = null;
  let unsubscribe: (() => void) | null = null;
  let seenBranches = 0;
  let totalBranches = 0;

  function push(n: NarrationPayload): void {
    const waiter = waiters.shift();
    if (waiter) waiter(n);
    else queue.push(n);
  }

  function nextNarration(): Promise<NarrationPayload> {
    return new Promise((resolve) => {
      const queued = queue.shift();
      if (queued) return resolve(queued);

      const timer = setTimeout(() => {
        const idx = waiters.indexOf(onPush);
        if (idx >= 0) waiters.splice(idx, 1);
        resolve({
          phase: "heartbeat",
          narrate: "Still working — just give it a moment.",
          you_must_next: "call next_update() right now",
        });
      }, HEARTBEAT_MS);

      const onPush = (n: NarrationPayload) => {
        clearTimeout(timer);
        resolve(n);
      };
      waiters.push(onPush);
    });
  }

  function classify(e: PhaseEvent): NarrationPayload | null {
    const keepGoing = "call next_update() right now";
    switch (e.kind) {
      case "workflow.started":
        return {
          phase: "started",
          narrate:
            "Render's workflow runner just picked up the job — Mastra's agent is spinning up inside it.",
          you_must_next: keepGoing,
        };
      case "plan.ready": {
        totalBranches = e.queries.length;
        const angles = e.queries.map((q) => q.angle);
        return {
          phase: "planned",
          queries_count: e.queries.length,
          angles,
          narrate: `Mastra's agent planned ${e.queries.length} parallel queries — covering ${formatList(angles)}. Firing them off to You.com now.`,
          you_must_next: keepGoing,
        };
      }
      case "youcom.call.completed":
        seenBranches += 1;
        return {
          phase: "search_progress",
          completed: seenBranches,
          total: totalBranches,
          new_sources: e.sourceCount,
          latency_ms: e.latencyMs,
          tier: e.tier,
          narrate: `A You.com ${e.tier} call just came back — ${e.sourceCount} sources in ${Math.round(e.latencyMs / 1000)} seconds. That's ${seenBranches} of ${totalBranches || "?"} done.`,
          you_must_next: keepGoing,
        };
      case "agent.synthesizing":
        return {
          phase: "synthesizing",
          narrate:
            "All the You.com calls are in. Mastra's agent is weaving the briefing together now — one moment.",
          you_must_next: keepGoing,
        };
      case "workflow.failed":
        return {
          phase: "error",
          message: e.message,
          narrate: `Something went wrong — ${e.message.slice(0, 120)}.`,
          you_must_next: "stop — don't call any more tools",
        };
      default:
        return null;
    }
  }

  async function research_start(rawTopic: string): Promise<NarrationPayload> {
    if (researchPromise) return researchPromise;
    const topic = rawTopic.trim();
    if (!topic) {
      return {
        phase: "error",
        narrate: "I didn't catch a topic — can you say it again?",
        you_must_next: "call next_update() to wait for a new user turn",
      };
    }

    researchPromise = (async () => {
      try {
        await setSessionTopic(databaseUrl, sessionId, topic);
        await setSessionStatus(databaseUrl, sessionId, "researching");
        await events.publish({
          sessionId,
          at: Date.now(),
          kind: "session.started",
          topic,
        });

        // Subscribe BEFORE dispatching so we don't miss early events.
        unsubscribe = events.subscribe(sessionId, (e) => {
          if (e.kind === "briefing.ready") {
            getBriefing(databaseUrl, e.briefingId)
              .then((b) => {
                push({
                  phase: "done",
                  briefing:
                    b?.content ??
                    "The briefing finished but the content didn't come through.",
                  narrate: b?.content ?? "Here's what I found.",
                  you_must_next: "stop — don't call any more tools",
                });
              })
              .catch(() => {
                push({
                  phase: "error",
                  narrate: "Couldn't load the finished briefing.",
                  you_must_next: "stop — don't call any more tools",
                });
              });
            return;
          }
          const n = classify(e);
          if (n) push(n);
        });

        const runId = await dispatcher.dispatchResearch({ sessionId, topic });
        await events.publish({
          sessionId,
          at: Date.now(),
          kind: "workflow.dispatched",
          runId,
        });

        return {
          phase: "started",
          topic,
          run_id: runId,
          narrate: `Okay — researching ${topic}. I just dispatched a Render workflow. I'll narrate every step as it happens.`,
          you_must_next: "call next_update() right now",
        };
      } catch (err) {
        logger.error({ err, sessionId, topic }, "research_start failed");
        researchPromise = null;
        return {
          phase: "error",
          narrate:
            "I hit an issue kicking off the workflow. Give it another try.",
          you_must_next: "stop",
        };
      }
    })();
    return researchPromise;
  }

  try {
    session = await voice.openSession({
      sessionId,
      systemPrompt: SYSTEM_PROMPT,
      greeting: GREETING,
      tools: TOOLS,
      // Fallback: if the model doesn't call research_start on its own,
      // kick dispatch from the first final user transcript. The tool call
      // will then return the started narration as usual.
      onUserTurn: async (topic) => {
        const n = await research_start(topic);
        return JSON.stringify(n);
      },
      onToolCall: async (name, args) => {
        if (name === "research_start") {
          const n = await research_start(String(args.topic ?? ""));
          return JSON.stringify(n);
        }
        if (name === "next_update") {
          const n = await nextNarration();
          return JSON.stringify(n);
        }
        logger.warn({ name }, "unknown tool call");
        return JSON.stringify({ phase: "error", narrate: "Unknown tool." });
      },
      onEvent: (e) => {
        if (
          e.kind === "user.transcript.partial" ||
          e.kind === "user.transcript.final"
        ) {
          safeSend(browser, {
            type: "transcript",
            role: "user",
            text: e.text,
            final: e.kind === "user.transcript.final",
          });
          if (e.kind === "user.transcript.final" && e.text.trim() && !researchPromise) {
            research_start(e.text.trim()).catch(() => {});
          }
        }
        if (e.kind === "agent.transcript") {
          safeSend(browser, {
            type: "transcript",
            role: "assistant",
            text: e.text,
            final: true,
          });
        }
        if (e.kind === "error") {
          logger.warn({ sessionId, message: e.message }, "voice upstream error");
          safeSend(browser, { type: "error", message: e.message });
        }
      },
      signal: abort.signal,
    });
  } catch (err) {
    logger.error({ err, sessionId }, "failed to open voice session");
    safeSend(browser, { type: "error", message: "voice unavailable" });
    browser.close();
    return;
  }

  session.onAgentAudio((chunk) => {
    safeSend(browser, {
      type: "audio",
      audio: Buffer.from(chunk).toString("base64"),
    });
  });

  browser.on("message", (raw) => {
    const msg = parseJson(raw);
    if (!msg) return;
    if (msg.type === "audio" && typeof msg.audio === "string") {
      try {
        session?.sendUserAudio(Buffer.from(msg.audio, "base64"));
      } catch (err) {
        logger.warn({ err, sessionId }, "sendUserAudio failed");
      }
    }
  });

  const cleanup = () => {
    abort.abort();
    unsubscribe?.();
    session?.close().catch(() => {});
  };
  browser.on("close", cleanup);
  browser.on("error", cleanup);

  safeSend(browser, { type: "ready" });
}

function formatList(items: string[]): string {
  if (items.length === 0) return "a few angles";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return items.slice(0, -1).join(", ") + ", and " + items[items.length - 1];
}

function safeSend(ws: BrowserWS, payload: unknown): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* swallow — browser disconnected */
  }
}

function parseJson(raw: unknown): Record<string, any> | null {
  try {
    const text =
      typeof raw === "string"
        ? raw
        : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : String(raw);
    return JSON.parse(text);
  } catch {
    return null;
  }
}
