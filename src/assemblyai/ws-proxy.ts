import type { WebSocket as BrowserWS } from "ws";
import type { VoiceRuntime, VoiceSession, EventBus } from "../shared/ports.js";
import type { PhaseEvent } from "../shared/events.js";
import { logger } from "../shared/logger.js";

/**
 * Wires a browser-side WebSocket to an AssemblyAI VoiceSession and to the
 * phase-event bus. Called from routes/ws.ts when a client connects.
 *
 * Browser frames we accept (JSON):
 *   { type: "audio", audio: <base64 PCM16/24k> }
 *
 * Browser frames we emit (JSON):
 *   { type: "audio", audio: <base64> }
 *   { type: "event", event: <PhaseEvent> }
 *   { type: "ready" }
 */
export interface WireOpts {
  browser: BrowserWS;
  sessionId: string;
  voice: VoiceRuntime;
  events: EventBus;
  onUserTurn: (topic: string) => Promise<string>;
}

export async function wireVoiceSession(opts: WireOpts): Promise<void> {
  const { browser, sessionId, voice, events, onUserTurn } = opts;

  let session: VoiceSession | null = null;
  const abort = new AbortController();

  try {
    session = await voice.openSession({
      sessionId,
      onUserTurn,
      onEvent: (e) => {
        if (e.kind === "error") {
          logger.warn({ sessionId, message: e.message }, "voice upstream error");
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
    safeSendBinary(browser, {
      type: "audio",
      audio: Buffer.from(chunk).toString("base64"),
    });
  });

  const unsubscribe = events.subscribe(sessionId, (event: PhaseEvent) => {
    safeSend(browser, { type: "event", event });
    // Narrator speech is separately published via narrator.speech events.
    if (event.kind === "narrator.speech") {
      session?.say(event.text).catch((err) =>
        logger.warn({ err }, "narrator say failed")
      );
    }
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
    unsubscribe();
    abort.abort();
    session?.close().catch(() => {});
  };
  browser.on("close", cleanup);
  browser.on("error", cleanup);

  safeSend(browser, { type: "ready" });
}

function safeSend(ws: BrowserWS, payload: unknown): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    /* swallow — browser disconnected */
  }
}

function safeSendBinary(ws: BrowserWS, payload: unknown): void {
  safeSend(ws, payload);
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
