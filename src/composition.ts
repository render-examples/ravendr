import { createPgKnowledgeRepository } from "./render/postgres/pg-knowledge-repository.js";
import { createPgWorkflowRunRepository } from "./render/postgres/pg-workflow-run-repository.js";
import { createRenderTaskRunReader } from "./render/workflows/render-task-run-reader.js";
import type { KnowledgeRepository } from "./ports/knowledge-repository.js";
import type { WorkflowRunRepository } from "./ports/workflow-run-repository.js";
import type { TaskRunReader } from "./ports/task-run-reader.js";

export type AppDeps = {
  knowledge: KnowledgeRepository;
  workflowRuns: WorkflowRunRepository;
  taskRuns: TaskRunReader;
};

/** Wires port implementations for the web service. */
export function createAppDeps(): AppDeps {
  return {
    knowledge: createPgKnowledgeRepository(),
    workflowRuns: createPgWorkflowRunRepository(),
    taskRuns: createRenderTaskRunReader(),
  };
}
