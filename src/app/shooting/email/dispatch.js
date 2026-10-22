import { NextResponse } from "next/server";
import { shootEmailContacts } from "./standalone.js";
import { shootEmailReplies } from "./inboxReply.js";
import { composeEmail } from "../../emails/compose-email/route.js";
import { getCampaignLimits } from "../../socials/_shared/limits.js";

function actionOf(body) {
  return String(body?.action || "").trim().toLowerCase();
}

export async function dispatchEmailShooting(body) {
  const action = actionOf(body);

  if (action === "reply") {
    return shootEmailReplies(body);
  }

  if (action === "limits") {
    const limits = await getCampaignLimits();
    return NextResponse.json({ success: true, channel: "email", limits });
  }

  if (action === "probe") {
    return NextResponse.json(
      { success: false, unsupported: true, error: "Email shooting probe is not supported" },
      { status: 501 }
    );
  }

  if (action === "compose") {
    return composeEmail(body);
  }

  if (!action || action === "send" || action === "schedule") {
    const payload = action === "schedule" ? { ...body, sendMode: "schedule" } : body;
    return shootEmailContacts(payload);
  }

  return NextResponse.json(
    { success: false, error: `Unknown email shooting action: ${action}` },
    { status: 400 }
  );
}
