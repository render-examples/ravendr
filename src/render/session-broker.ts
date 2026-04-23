import type { WebSocket as WSClient, RawData } from "ws";
import { randomBytes } from "node:crypto";
import { logger } from "../shared/logger.js";

/**
 * Pairs a browser audio WebSocket with the corresponding workflow task's
 * reverse WebSocket, by sessionId. Forwards every message byte-for-byte
 * in both directions. Zero business logic.
 *
 * Handles the race where one side connects and starts sending before the
 * other side registers: listeners are attached immediately on each
 * registration, and inbound messages are buffered until the peer is up.
 */
export interface SessionBroker {
  issueToken(sessionId: string): string;
  registerClient(sessionId: string, ws: WSClient): void;
  registerTask(sessionId: string, token: string, ws: WSClient): boolean;
  size(): number;
}

interface Slot {
  token: string;
  clientWS: WSClient | null;
  taskWS: WSClient | null;
  /** Messages from client queued while task isn't connected yet. */
  clientToTaskBuffer: string[];
  /** Messages from task queued while client isn't connected yet. */
  taskToClientBuffer: string[];
  createdAt: number;
}

/**
 * Coerce any RawData to a UTF-8 string before forwarding. All our app
 * messages are JSON strings — without this the ws library sends forwarded
 * Buffers as binary frames, which the browser's JSON-only handler drops.
 */
function toText(raw: RawData): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf-8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf-8");
  return Buffer.from(raw as ArrayBuffer).toString("utf-8");
}

const TOKEN_BYTES = 16;
const OPEN = 1; // ws.OPEN

export function createSessionBroker(): SessionBroker {
  const slots = new Map<string, Slot>();

  function ensure(sessionId: string): Slot {
    let slot = slots.get(sessionId);
    if (!slot) {
      slot = {
        token: randomBytes(TOKEN_BYTES).toString("hex"),
        clientWS: null,
        taskWS: null,
        clientToTaskBuffer: [],
        taskToClientBuffer: [],
        createdAt: Date.now(),
      };
      slots.set(sessionId, slot);
    }
    return slot;
  }

  function cleanup(sessionId: string): void {
    const slot = slots.get(sessionId);
    if (!slot) return;
    try { slot.clientWS?.close(); } catch { /* noop */ }
    try { slot.taskWS?.close(); } catch { /* noop */ }
    slots.delete(sessionId);
    logger.info(
      { sessionId, remaining: slots.size },
      "broker: session cleaned up"
    );
  }

  function flushBuffers(sessionId: string): void {
    const slot = slots.get(sessionId);
    if (!slot) return;
    if (slot.clientWS && slot.taskWS) {
      if (slot.clientToTaskBuffer.length > 0) {
        logger.info(
          { sessionId, count: slot.clientToTaskBuffer.length },
          "broker: flushing client→task buffer"
        );
        for (const m of slot.clientToTaskBuffer) {
          if (slot.taskWS.readyState === OPEN) slot.taskWS.send(m);
        }
        slot.clientToTaskBuffer = [];
      }
      if (slot.taskToClientBuffer.length > 0) {
        logger.info(
          { sessionId, count: slot.taskToClientBuffer.length },
          "broker: flushing task→client buffer"
        );
        for (const m of slot.taskToClientBuffer) {
          if (slot.clientWS.readyState === OPEN) slot.clientWS.send(m);
        }
        slot.taskToClientBuffer = [];
      }
    }
  }

  return {
    issueToken(sessionId) {
      return ensure(sessionId).token;
    },

    registerClient(sessionId, ws) {
      const slot = ensure(sessionId);
      if (slot.clientWS) {
        try { slot.clientWS.close(); } catch { /* noop */ }
      }
      slot.clientWS = ws;
      logger.info({ sessionId }, "broker: client WS registered");

      ws.on("message", (raw) => {
        const s = slots.get(sessionId);
        if (!s) return;
        const text = toText(raw);
        if (s.taskWS?.readyState === OPEN) {
          s.taskWS.send(text);
        } else {
          s.clientToTaskBuffer.push(text);
        }
      });
      ws.on("close", () => cleanup(sessionId));
      ws.on("error", () => cleanup(sessionId));

      flushBuffers(sessionId);
    },

    registerTask(sessionId, token, ws) {
      const slot = slots.get(sessionId);
      if (!slot || slot.token !== token) {
        logger.warn(
          { sessionId },
          "broker: task WS rejected (unknown session or bad token)"
        );
        try { ws.close(); } catch { /* noop */ }
        return false;
      }
      slot.taskWS = ws;
      logger.info({ sessionId }, "broker: task WS registered");

      ws.on("message", (raw) => {
        const s = slots.get(sessionId);
        if (!s) return;
        const text = toText(raw);
        if (s.clientWS?.readyState === OPEN) {
          s.clientWS.send(text);
        } else {
          s.taskToClientBuffer.push(text);
        }
      });
      ws.on("close", () => cleanup(sessionId));
      ws.on("error", () => cleanup(sessionId));

      flushBuffers(sessionId);
      return true;
    },

    size() {
      return slots.size;
    },
  };
}
