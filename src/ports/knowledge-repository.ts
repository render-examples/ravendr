import type { KnowledgeEntry } from "../lib/db.js";

/** Read-side access to stored knowledge (swap Postgres for another store via adapter). */
export interface KnowledgeRepository {
  getAll(): Promise<KnowledgeEntry[]>;
}
