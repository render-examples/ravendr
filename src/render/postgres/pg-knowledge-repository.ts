import { getAllKnowledge } from "./db.js";
import type { KnowledgeRepository } from "../../ports/knowledge-repository.js";

export function createPgKnowledgeRepository(): KnowledgeRepository {
  return {
    async getAll() {
      return getAllKnowledge();
    },
  };
}
