import { Client as PgClient } from "pg";
import type { EventBus } from "../shared/ports.js";
import { parsePhaseEvent, type PhaseEvent } from "../shared/events.js";
import { logger } from "../shared/logger.js";
import { recordPhaseEvent } from "./db.js";

export interface EventBusConfig {
  connectionString: string;
  channel?: string;
}

type Handler = (event: PhaseEvent) => void;

/**
 * EventBus backed by Postgres LISTEN/NOTIFY.
 *
 * publish()  → INSERT into phase_events, NOTIFY <channel> <JSON>
 * subscribe() → register handler; a dedicated listener Client dispatches
 *               incoming NOTIFYs to handlers matching sessionId.
 *
 * Workflow tasks and the web service can both publish. Only the web service
 * subscribes (to forward to browser WS + narrator agent).
 */
export function createPostgresEventBus(config: EventBusConfig): EventBus & {
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  const channel = config.channel ?? "phase_events";
  const handlers = new Map<string, Set<Handler>>();
  let listenClient: PgClient | null = null;
  let stopped = false;

  async function connectListener(): Promise<PgClient> {
    const client = new PgClient({ connectionString: config.connectionString });
    client.on("error", (err) => {
      logger.error({ err }, "pg listener error, will reconnect");
      scheduleReconnect();
    });
    client.on("notification", (msg) => {
      if (msg.channel !== channel || !msg.payload) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.payload);
      } catch {
        return;
      }
      const event = parsePhaseEvent(parsed);
      if (!event) return;
      const set = handlers.get(event.sessionId);
      if (!set) return;
      for (const h of set) {
        try {
          h(event);
        } catch (err) {
          logger.warn({ err }, "event handler threw");
        }
      }
    });
    await client.connect();
    await client.query(`LISTEN ${channel}`);
    return client;
  }

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        listenClient?.end().catch(() => {});
        listenClient = await connectListener();
      } catch (err) {
        logger.error({ err }, "pg listener reconnect failed");
        scheduleReconnect();
      }
    }, 1_000);
  }

  return {
    async start() {
      listenClient = await connectListener();
      logger.info({ channel }, "pg event bus listening");
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      await listenClient?.end().catch(() => {});
      listenClient = null;
    },
    async publish(event: PhaseEvent): Promise<void> {
      // Record (audit) + notify. Both happen via the normal pool; LISTEN is on a separate connection.
      try {
        await recordPhaseEvent(config.connectionString, event);
      } catch (err) {
        // Audit failure shouldn't block live propagation.
        logger.warn({ err, kind: event.kind }, "recordPhaseEvent failed");
      }
      // NOTIFY via the pool:
      const payload = JSON.stringify(event);
      if (payload.length > 7_500) {
        // Postgres NOTIFY payload hard limit is 8000 bytes — trim if needed.
        logger.warn({ kind: event.kind, size: payload.length }, "phase event too large to notify");
        return;
      }
      // Use the listener client for NOTIFY too — it's reused and this avoids a pool checkout.
      if (!listenClient) return;
      await listenClient.query(`SELECT pg_notify($1, $2)`, [channel, payload]);
    },
    subscribe(sessionId, handler) {
      let set = handlers.get(sessionId);
      if (!set) {
        set = new Set();
        handlers.set(sessionId, set);
      }
      set.add(handler);
      return () => {
        const s = handlers.get(sessionId);
        if (!s) return;
        s.delete(handler);
        if (s.size === 0) handlers.delete(sessionId);
      };
    },
  };
}
