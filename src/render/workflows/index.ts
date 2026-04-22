/**
 * Task entry point (same role as `tasks/index.js` in render-workflows-llamaindex).
 * Registers Render Workflow tasks. Run: `tsx src/tasks/index.ts` or `node dist/tasks/index.js`.
 */

import "./ingest.js";
import "./recall.js";
import "./report.js";

console.log("Ravendr tasks registered: ingest, recall, report");
