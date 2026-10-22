// Thin wrapper — email inbox implementation lives in
// emails/inbox-interact (shared by the email campaign stage and direct calls).
export { POST } from "../../emails/inbox-interact/route.js";

export const maxDuration = 120;
export const dynamic = "force-dynamic";
