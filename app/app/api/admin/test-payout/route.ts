/**
 * GET /api/admin/test-payout?secret=<ADMIN_SECRET>&recipient=<pubkey>&amount=<usd>
 *
 * Fires a real PUSD mint to any wallet — used to verify the payout pipeline
 * and to manually top-up caregivers / patients during demos.
 *
 * Example:
 *   /api/admin/test-payout?secret=physioloop-admin-2026&recipient=<wallet>&amount=0.25
 */
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const secret    = searchParams.get("secret");
  const recipient = searchParams.get("recipient");
  const amount    = parseFloat(searchParams.get("amount") ?? "0");

  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!recipient || !amount || amount <= 0 || amount > 10) {
    return NextResponse.json({ error: "recipient and amount (0–10) required" }, { status: 400 });
  }

  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const res = await fetch(`${base}/api/payout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipientPublicKey: recipient,
      amountUsd: amount,
      reason: "caregiver_first_checkin_gift",
    }),
  });

  const json = await res.json() as { success?: boolean; signature?: string; error?: string };
  if (!json.success) {
    return NextResponse.json({ error: json.error ?? "Payout failed" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    recipient,
    amountUsd: amount,
    signature: json.signature,
    explorer: `https://explorer.solana.com/tx/${json.signature}?cluster=devnet`,
  });
}
