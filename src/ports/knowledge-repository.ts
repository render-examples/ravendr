import type { KnowledgeEntry } from "../render/postgres/db.js";

/** Read-side access to stored knowledge (swap Postgres for another store via adapter). */
export interface KnowledgeRepository {
  getAll(): Promise<KnowledgeEntry[]>;
}
