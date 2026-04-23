import type { WebSocket as WSClient } from "ws";
import { randomBytes } from "node:crypto";
import { logger } from "../shared/logger.js";

/**
 * Pairs a browser audio WebSocket with the corresponding workflow task's
 * reverse WebSocket, by sessionId. Forwards every message byte-for-byte
 * in both directions. Zero business logic.
 *
 * The web service holds this map; both WS endpoints register here. When
 * both peers are connected for a sessionId, messages flow through.
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
  createdAt: number;
}

const TOKEN_BYTES = 16;

export function createSessionBroker(): SessionBroker {
  const slots = new Map<string, Slot>();

  function ensure(sessionId: string, token?: string): Slot {
    let slot = slots.get(sessionId);
    if (!slot) {
      slot = {
        token: token ?? randomBytes(TOKEN_BYTES).toString("hex"),
        clientWS: null,
        taskWS: null,
        createdAt: Date.now(),
      };
      slots.set(sessionId, slot);
    }
    return slot;
  }

  function cleanup(sessionId: string): void {
    const slot = slots.get(sessionId);
    if (!slot) return;
    try {
      slot.clientWS?.close();
    } catch {
      /* noop */
    }
    try {
      slot.taskWS?.close();
    } catch {
      /* noop */
    }
    slots.delete(sessionId);
    logger.info({ sessionId, remaining: slots.size }, "broker: session cleaned up");
  }

  function wirePipe(sessionId: string): void {
    const slot = slots.get(sessionId);
    if (!slot || !slot.clientWS || !slot.taskWS) return;
    const { clientWS, taskWS } = slot;
    logger.info({ sessionId }, "broker: pipe ready");

    clientWS.on("message", (raw) => {
      if (taskWS.readyState === 1 /* OPEN */) taskWS.send(raw);
    });
    taskWS.on("message", (raw) => {
      if (clientWS.readyState === 1 /* OPEN */) clientWS.send(raw);
    });

    const onAnyClose = () => cleanup(sessionId);
    clientWS.on("close", onAnyClose);
    clientWS.on("error", onAnyClose);
    taskWS.on("close", onAnyClose);
    taskWS.on("error", onAnyClose);
  }

  return {
    issueToken(sessionId) {
      const slot = ensure(sessionId);
      return slot.token;
    },
    registerClient(sessionId, ws) {
      const slot = ensure(sessionId);
      if (slot.clientWS) {
        try {
          slot.clientWS.close();
        } catch {
          /* noop */
        }
      }
      slot.clientWS = ws;
      logger.info({ sessionId }, "broker: client WS registered");
      wirePipe(sessionId);
    },
    registerTask(sessionId, token, ws) {
      const slot = slots.get(sessionId);
      if (!slot || slot.token !== token) {
        logger.warn({ sessionId }, "broker: task WS rejected (unknown/bad token)");
        try {
          ws.close();
        } catch {
          /* noop */
        }
        return false;
      }
      slot.taskWS = ws;
      logger.info({ sessionId }, "broker: task WS registered");
      wirePipe(sessionId);
      return true;
    },
    size() {
      return slots.size;
    },
  };
}
