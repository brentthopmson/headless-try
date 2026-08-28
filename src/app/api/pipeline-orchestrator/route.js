// Alias route so the orchestrator is reachable at /api/pipeline-orchestrator
// (matching the /api/<stage> convention used by the WebFixx-Hoo Apps Script
// stage triggers) while reusing the real handler at /campaign/pipeline-orchestrator.
export { POST, OPTIONS } from '../campaign/pipeline-orchestrator/route.js';
