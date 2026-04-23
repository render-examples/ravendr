import type { PhaseEvent, Tier } from "./events.js";

/**
 * Ports — contracts the app depends on. Adapters:
 *   EventBus         → src/render/event-bus.ts   (Postgres LISTEN/NOTIFY)
 *   ResearchProvider → src/youcom/research.ts    (You.com Research API)
 *
 * Voice runtime used to be a port; now it lives inside the voiceSession
 * workflow task (src/render/tasks/voice-session.ts) since the task owns
 * the AssemblyAI WebSocket directly.
 */

// ─── Research (You.com) ─────────────────────────────────────────────
export interface ResearchProvider {
  research(input: ResearchInput): Promise<ResearchResult>;
}

export interface ResearchInput {
  query: string;
  tier: Tier;
  signal?: AbortSignal;
}

export interface ResearchResult {
  content: string;
  sources: ResearchSource[];
  latencyMs: number;
}

export interface ResearchSource {
  url: string;
  title: string;
  snippet?: string;
}

// ─── Event bus (Postgres LISTEN/NOTIFY) ─────────────────────────────
export interface EventBus {
  publish(event: PhaseEvent): Promise<void>;
  subscribe(sessionId: string, handler: (event: PhaseEvent) => void): () => void;
}
