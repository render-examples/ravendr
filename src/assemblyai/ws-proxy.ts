import type { WebSocket as BrowserWS } from "ws";
import type {
  VoiceRuntime,
  VoiceSession,
  VoiceToolDef,
  EventBus,
} from "../shared/ports.js";
import type { WorkflowDispatcher } from "../render/workflow-dispatcher.js";
import {
  setSessionTopic,
  setSessionStatus,
  getBriefing,
} from "../render/db.js";
import { logger } from "../shared/logger.js";

/**
 * Bridges a browser WebSocket to an AssemblyAI VoiceSession.
 *
 * Architecture note — why a single tool:
 *   AssemblyAI's Voice Agent has no server-initiated speech API. The agent
 *   speaks only when *its* LLM decides to, typically after a tool return.
 *   Chaining multiple tools with "speak between each" is unreliable — the
 *   model either batches them in parallel or silently skips the verbalization.
 *
 *   So: ONE tool, `research(topic)`, blocks until the Render Workflow has
 *   produced a briefing (~2 min), and returns a single narrated string
 *   covering the whole run (what Render did, what Mastra planned, what
 *   You.com fetched, the briefing itself). The model has one return to speak
 *   and it speaks it.
 *
 *   Real-time feedback during the wait comes from the visual chain ribbon +
 *   activity log, wired via SSE at /api/sessions/:id/events. The UI is the
 *   narration while the research runs; the voice is the payoff at the end.
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
    name: "research",
    description:
      "Research a topic end-to-end. Blocks for up to a few minutes while the backend runs, then returns a narrated briefing the agent reads aloud verbatim.",
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
];

const SYSTEM_PROMPT = `You are Ravendr, a voice research host.

When the user gives you a topic (any topic, even a greeting), you MUST call the \`research\` tool with their exact words as the \`topic\` argument. Do this immediately — do not ask follow-up questions.

The \`research\` tool takes a minute or two to return. That is expected. When it returns, the result is a narrated briefing written in first person — YOU speak it out loud to the user, verbatim, in full. Do not paraphrase, summarize, or shorten it. Do not add commentary before or after. Just read the returned text as your spoken reply.

After speaking the briefing, stop. Do not call the tool again unless the user asks for a new topic.`;

const GREETING =
  "Hi — tell me any topic and I'll research it live. You'll see the stack working on screen while I dig in, then I'll read you back what I found.";

export async function wireVoiceSession(opts: WireOpts): Promise<void> {
  const { browser, sessionId, voice, events, dispatcher, databaseUrl } = opts;

  let session: VoiceSession | null = null;
  const abort = new AbortController();

  // Memoize: the agent may call `research` once, but we also fire it as a
  // fallback from the first final user transcript. Both paths share one run.
  let researchPromise: Promise<string> | null = null;

  async function research(rawTopic: string): Promise<string> {
    if (researchPromise) return researchPromise;
    researchPromise = (async () => {
      const topic = rawTopic.trim();
      if (!topic) return "I didn't catch a topic — can you say it again?";

      // Collect phase data as events fly by so we can narrate in past tense.
      const collected = {
        runId: null as string | null,
        plannedCount: 0,
        angles: [] as string[],
        branchesComplete: 0,
        totalSources: 0,
      };

      const unsubscribe = events.subscribe(sessionId, (e) => {
        if (e.kind === "plan.ready") {
          collected.plannedCount = e.queries.length;
          collected.angles = e.queries.map((q) => q.angle);
        } else if (e.kind === "youcom.call.completed") {
          collected.branchesComplete += 1;
          collected.totalSources += e.sourceCount;
        }
      });

      try {
        await setSessionTopic(databaseUrl, sessionId, topic);
        await setSessionStatus(databaseUrl, sessionId, "researching");
        await events.publish({
          sessionId,
          at: Date.now(),
          kind: "session.started",
          topic,
        });

        const runId = await dispatcher.dispatchResearch({ sessionId, topic });
        collected.runId = runId;
        await events.publish({
          sessionId,
          at: Date.now(),
          kind: "workflow.dispatched",
          runId,
        });

        // Block until briefing.ready, with a wide timeout (workflow is slow).
        const briefingEvent = await waitForBriefing(events, sessionId, 300_000);
        const briefing = await getBriefing(databaseUrl, briefingEvent.briefingId);
        const body =
          briefing?.content ??
          "I got the sources back but couldn't synthesize them cleanly — try again in a moment.";

        return composeNarration(topic, collected, body);
      } catch (err) {
        logger.error({ err, sessionId, topic }, "research tool failed");
        researchPromise = null;
        return "I hit an issue running the research workflow. Give it another try in a moment.";
      } finally {
        unsubscribe();
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
      onUserTurn: (topic) => research(topic),
      onToolCall: async (name, args) => {
        if (name === "research") return research(String(args.topic ?? ""));
        logger.warn({ name }, "unknown tool call");
        return "";
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
          // Fallback: if the model doesn't call `research` quickly, start the
          // workflow ourselves from the first final transcript. Memoization
          // in research() makes a later tool.call a no-op (returns same result).
          if (e.kind === "user.transcript.final" && e.text.trim()) {
            research(e.text.trim()).catch(() => {});
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
    session?.close().catch(() => {});
  };
  browser.on("close", cleanup);
  browser.on("error", cleanup);

  safeSend(browser, { type: "ready" });
}

function waitForBriefing(
  events: EventBus,
  sessionId: string,
  timeoutMs: number
): Promise<{ briefingId: string; sourceCount: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`briefing.ready timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    const unsubscribe = events.subscribe(sessionId, (e) => {
      if (e.kind === "briefing.ready") {
        clearTimeout(timer);
        unsubscribe();
        resolve({ briefingId: e.briefingId, sourceCount: e.sourceCount });
      } else if (e.kind === "workflow.failed") {
        clearTimeout(timer);
        unsubscribe();
        reject(new Error(`workflow.failed: ${e.message}`));
      }
    });
  });
}

function composeNarration(
  topic: string,
  data: {
    runId: string | null;
    plannedCount: number;
    angles: string[];
    branchesComplete: number;
    totalSources: number;
  },
  briefing: string
): string {
  const anglesList =
    data.angles.length > 0
      ? data.angles.slice(0, -1).join(", ") +
        (data.angles.length > 1 ? ", and " : "") +
        data.angles[data.angles.length - 1]
      : "a few angles";

  const prefix = [
    `Okay — here's what I found on ${topic}.`,
    `Render spun up a durable workflow to orchestrate this.`,
    `Mastra's planner broke the topic into ${data.plannedCount || "a handful of"} angles — ${anglesList}.`,
    `Then You.com ran ${data.branchesComplete || data.plannedCount || "those"} searches in parallel and came back with ${data.totalSources || "a stack of"} sources.`,
    `Here's the briefing:`,
  ].join(" ");

  return `${prefix}\n\n${briefing}`;
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
