import type { EventBus, LLMProvider } from "../shared/ports.js";
import { startNarrator } from "./narrator-agent.js";

/**
 * Thin wrapper so routes/ws.ts doesn't need to know the narrator's internals.
 * Returns a disposer that unsubscribes when the voice session closes.
 */
export interface NarratorSession {
  dispose(): void;
}

export function attachNarrator(opts: {
  sessionId: string;
  events: EventBus;
  llm: LLMProvider;
}): NarratorSession {
  const unsubscribe = startNarrator({
    sessionId: opts.sessionId,
    events: opts.events,
    llm: opts.llm,
  });
  return { dispose: unsubscribe };
}
