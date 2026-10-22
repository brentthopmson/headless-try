import { NextResponse } from "next/server";

export async function dispatchBankShooting() {
  return NextResponse.json({ success: false, unsupported: true }, { status: 501 });
}
