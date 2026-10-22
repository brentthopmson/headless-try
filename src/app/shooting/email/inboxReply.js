import { processInboxInteract } from "../../emails/inbox-interact/route.js";

export async function shootEmailReplies(body) {
  return processInboxInteract(body);
}
