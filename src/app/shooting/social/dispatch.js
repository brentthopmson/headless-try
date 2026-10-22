import { NextResponse } from "next/server";
import { handleSendMessages } from "./dm.js";
import { getCampaignLimits } from "../../socials/_shared/limits.js";

function actionOf(body) {
  return String(body?.action || "").trim().toLowerCase();
}

export async function dispatchSocialShooting(body) {
  const action = actionOf(body);

  if (action === "probe") {
    return handleSendMessages({ ...body, action: "probe" });
  }

  if (action === "limits") {
    const limits = await getCampaignLimits();
    return NextResponse.json({ success: true, channel: "social", limits });
  }

  if (action === "reply") {
    return NextResponse.json(
      { success: false, unsupported: true, error: "Social shooting reply is handled by /socials/inbox-interact" },
      { status: 501 }
    );
  }

  if (!action || action === "send" || action === "compose") {
    return handleSendMessages(body);
  }

  return NextResponse.json(
    { success: false, error: `Unknown social shooting action: ${action}` },
    { status: 400 }
  );
}
