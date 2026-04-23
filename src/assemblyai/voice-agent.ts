import { WebSocket } from "ws";
import { logger } from "../shared/logger.js";

/**
 * Thin client over AssemblyAI's Voice Agent WebSocket protocol.
 *
 * Owns the protocol: session.update, input.audio, tool.result outbound;
 * session.ready / transcript.* / reply.audio / reply.done / tool.call inbound.
 *
 * Callers (currently the voiceSession Render Workflow task) pass in:
 *   - connection config (api key, url, voice, system prompt, greeting, tools)
 *   - a browserWS they're piping audio through (from the web-service broker)
 *   - a tool.call handler that returns a tool.result payload
 *
 * Everything AssemblyAI-specific stays in this file.
 */

export interface AssemblyVoiceAgentOpts {
  sessionId: string;
  apiKey: string;
  agentUrl: string;
  voice: string;
  systemPrompt: string;
  greeting: string;
  tools: ToolDef[];
  /** Called for every tool.call from the agent. Return the string payload for tool.result. */
  onToolCall: (args: {
    callId: string;
    name: string;
    args: Record<string, unknown>;
  }) => Promise<string>;
  /** Stream back into the browser (PCM16 base64 audio + transcripts + errors). */
  onBrowserMessage: (msg: BrowserOutgoing) => void;
  /** Called on fatal close for cleanup. */
  onClose?: () => void;
}

export interface ToolDef {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type BrowserOutgoing =
  | { type: "audio"; audio: string }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  | { type: "error"; message: string }
  | { type: "ready" };

export interface AssemblyVoiceAgent {
  /** Send a single PCM16/base64 mic frame from the browser. */
  sendUserAudio(base64Audio: string): void;
  close(): void;
}

interface AssemblyEvent {
  type?: string;
  [key: string]: unknown;
}

/**
 * Opens the WebSocket, sends session.update, wires both directions.
 * Resolves once the WS is open and session.update has been dispatched.
 */
export async function openVoiceAgent(
  opts: AssemblyVoiceAgentOpts
): Promise<AssemblyVoiceAgent> {
  const { sessionId } = opts;
  logger.info({ sessionId, url: opts.agentUrl }, "voiceAgent: opening");

  const ws = new WebSocket(opts.agentUrl, {
    headers: { authorization: `Bearer ${opts.apiKey}` },
  });

  await waitForOpen(ws, "assemblyai");

  ws.send(
    JSON.stringify({
      type: "session.update",
      session: {
        system_prompt: opts.systemPrompt,
        output: { voice: opts.voice },
        greeting: opts.greeting,
        tools: opts.tools,
      },
    })
  );

  opts.onBrowserMessage({ type: "ready" });

  let upstreamCount = 0;
  ws.on("message", (raw: Buffer) => {
    const event = parseJson<AssemblyEvent>(raw);
    if (!event) return;
    if (event.type !== "reply.audio" && upstreamCount < 80) {
      logger.info(
        { sessionId, type: event.type, keys: Object.keys(event).slice(0, 6) },
        "AssemblyAI event"
      );
      upstreamCount++;
    }
    handleUpstream(ws, event, opts);
  });

  ws.once("close", () => opts.onClose?.());
  ws.once("error", () => opts.onClose?.());

  return {
    sendUserAudio(base64) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "input.audio", audio: base64 }));
    },
    close() {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    },
  };
}

function handleUpstream(
  ws: WebSocket,
  event: AssemblyEvent,
  opts: AssemblyVoiceAgentOpts
): void {
  switch (event.type) {
    case "reply.audio": {
      const data = event.data;
      if (typeof data === "string") {
        opts.onBrowserMessage({ type: "audio", audio: data });
      }
      break;
    }
    case "transcript.user.delta":
      opts.onBrowserMessage({
        type: "transcript",
        role: "user",
        text: String(event.text ?? ""),
        final: false,
      });
      break;
    case "transcript.user":
      logger.info(
        {
          sessionId: opts.sessionId,
          text: String(event.text ?? "").slice(0, 120),
        },
        "transcript.user (final)"
      );
      opts.onBrowserMessage({
        type: "transcript",
        role: "user",
        text: String(event.text ?? ""),
        final: true,
      });
      break;
    case "transcript.agent":
      opts.onBrowserMessage({
        type: "transcript",
        role: "assistant",
        text: String(event.text ?? ""),
        final: true,
      });
      break;
    case "tool.call": {
      const callId = String(event.call_id ?? "");
      const name = String(event.name ?? "");
      const args =
        (event.args as Record<string, unknown> | undefined) ?? {};
      logger.info(
        { sessionId: opts.sessionId, callId, name, args },
        "AssemblyAI tool.call"
      );
      opts
        .onToolCall({ callId, name, args })
        .then((result) => {
          logger.info(
            {
              sessionId: opts.sessionId,
              callId,
              resultLen: result.length,
            },
            "sending tool.result (success)"
          );
          ws.send(
            JSON.stringify({
              type: "tool.result",
              call_id: callId,
              result: JSON.stringify(result),
            })
          );
        })
        .catch((err) => {
          logger.error(
            { err, sessionId: opts.sessionId, callId },
            "tool.call handler threw"
          );
          ws.send(
            JSON.stringify({
              type: "tool.result",
              call_id: callId,
              result: JSON.stringify(
                "I hit an issue running that. Please try again."
              ),
            })
          );
        });
      break;
    }
    case "session.error":
    case "error":
      logger.warn(
        {
          sessionId: opts.sessionId,
          code: event.code,
          message: event.message,
        },
        "AssemblyAI error"
      );
      opts.onBrowserMessage({
        type: "error",
        message: `${event.code ?? ""}: ${event.message ?? "unknown"}`,
      });
      break;
  }
}

function waitForOpen(ws: WebSocket, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => {
      logger.info({ label }, "WS opened");
      resolve();
    });
    ws.once("error", (err) =>
      reject(new Error(`${label} WS error: ${(err as Error).message}`))
    );
    ws.once("close", (code, reason) =>
      reject(
        new Error(
          `${label} WS closed before open (code=${code} reason=${reason?.toString()})`
        )
      )
    );
  });
}

function parseJson<T>(raw: unknown): T | null {
  try {
    const text =
      typeof raw === "string"
        ? raw
        : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : String(raw);
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
