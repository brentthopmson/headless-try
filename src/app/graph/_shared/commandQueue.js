// In-memory command queue for graph devices (relay between launcher/web and agent).
// Commands flow IN via exec (launcher/web) and OUT via poll (agent), results flow back.

const queues = new Map(); // deviceId -> Array<command>
const results = new Map(); // commandId -> { result, error, done }

export function enqueueCommand(deviceId, cmd) {
  if (!queues.has(deviceId)) queues.set(deviceId, []);
  const command = Object.assign({ id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, createdAt: new Date().toISOString(), status: "pending" }, cmd);
  queues.get(deviceId).push(command);
  return command;
}

export function dequeueCommands(deviceId) {
  const q = queues.get(deviceId) || [];
  const out = q.filter((c) => c.status === "pending");
  out.forEach((c) => { c.status = "dispatched"; });
  return out;
}

export function storeResult(commandId, payload) {
  results.set(commandId, Object.assign({ done: true, at: new Date().toISOString() }, payload));
}

export function getResult(commandId) {
  return results.get(commandId) || null;
}

export function listQueued(deviceId) {
  return queues.get(deviceId) || [];
}