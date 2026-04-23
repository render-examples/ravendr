import { Memory } from "@mastra/memory";
import { PostgresStore } from "@mastra/pg";

export interface MastraMemoryConfig {
  databaseUrl: string;
}

let cached: Memory | null = null;

/**
 * Shared Mastra memory backed by Render Postgres (via @mastra/pg).
 * Both the narrator (web service) and researcher (workflow task) agents
 * reference the same memory store but pick different thread keys.
 */
export function getMastraMemory(config: MastraMemoryConfig): Memory {
  if (cached) return cached;
  cached = new Memory({
    storage: new PostgresStore({
      id: "ravendr-mastra",
      connectionString: config.databaseUrl,
      schemaName: "mastra",
    }),
  });
  return cached;
}

export function threadForSession(sessionId: string, role: "narrator" | "researcher"): string {
  return `${role}:${sessionId}`;
}
