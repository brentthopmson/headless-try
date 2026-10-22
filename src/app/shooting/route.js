import { NextResponse } from "next/server";
import { dispatchEmailShooting } from "./email/dispatch.js";
import { dispatchSocialShooting } from "./social/dispatch.js";
import { dispatchBankShooting } from "./bank/dispatch.js";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

function inferChannel(body) {
  const explicit = String(body?.channel || body?.category || body?.domain || body?.type || "").trim().toLowerCase();
  if (explicit) {
    if (["email", "emails", "mail"].includes(explicit)) return "email";
    if (["social", "socials", "dm", "message"].includes(explicit)) return "social";
    if (["bank", "banks"].includes(explicit)) return "bank";
    return explicit;
  }

  if (Array.isArray(body?.contacts) || body?.browserId || body?.contactEmail) return "email";
  if (body?.fileUrl || body?.recipient || body?.platform || body?.profileId || body?.accountIds) return "social";
  return "";
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (error) {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const channel = inferChannel(body);

  if (channel === "email") return dispatchEmailShooting(body);
  if (channel === "social") return dispatchSocialShooting(body);
  if (channel === "bank") return dispatchBankShooting(body);

  return NextResponse.json(
    { success: false, error: "Missing or unknown shooting channel" },
    { status: 400 }
  );
}

export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
