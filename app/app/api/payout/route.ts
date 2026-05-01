/**
 * POST /api/payout
 *
 * Mints PUSD rewards to a recipient.
 * Called internally by /api/torque/event when a milestone fires.
 *
 * Set mintDirectToAta=true when the recipient address IS already an ATA
 * (e.g. raffle pool ATA owned by a PDA — no ATA derivation needed).
 */
import { NextRequest, NextResponse } from "next/server";
import { emitTorqueEvent } from "@/lib/torque";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

const PUSD_MINT = new PublicKey("D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s");

// Maximum single payout — guards against misconfiguration
const MAX_PAYOUT_USD = 10;

function loadKeypair(envVar: string): Keypair {
  const b64 = process.env[envVar];
  if (!b64) throw new Error(`${envVar} not set`);
  return Keypair.fromSecretKey(Buffer.from(b64, "base64"));
}

export type PayoutReason =
  | "patient_first_rep_gift"
  | "patient_streak_7_rebate"
  | "raffle_pool_contribution"
  | "raffle_winner_draw"
  | "caregiver_first_checkin_gift"
  | "caregiver_streak_7_bonus"
  | "caregiver_rescue_bonus"
  | "caregiver_completion_bonus"
  | "leaderboard_1st_place"
  | "leaderboard_2nd_place"
  | "leaderboard_3rd_place";

export async function POST(req: NextRequest) {
  try {
    const { recipientPublicKey, amountUsd, reason, mintDirectToAta } = await req.json() as {
      recipientPublicKey: string;
      amountUsd: number;
      reason: PayoutReason;
      mintDirectToAta?: boolean;
    };

    if (!recipientPublicKey || !amountUsd || !reason) {
      return NextResponse.json({ error: "recipientPublicKey, amountUsd and reason required" }, { status: 400 });
    }
    if (amountUsd <= 0 || amountUsd > MAX_PAYOUT_USD) {
      return NextResponse.json({ error: `amountUsd must be between 0 and ${MAX_PAYOUT_USD}` }, { status: 400 });
    }

    const authority = loadKeypair("MINT_AUTHORITY_KEYPAIR"); // fee payer
    const treasury  = loadKeypair("TREASURY_KEYPAIR");        // PUSD source
    const recipient = new PublicKey(recipientPublicKey);
    const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
    const amountRaw = Math.round(amountUsd * 1_000_000);

    const treasuryAta = getAssociatedTokenAddressSync(
      PUSD_MINT, treasury.publicKey, false, TOKEN_2022_PROGRAM_ID,
    );

    const tx = new Transaction();

    // Ensure treasury ATA exists (idempotent — no-op after first run)
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, treasuryAta, treasury.publicKey, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
    ));

    let targetAta: PublicKey;
    if (mintDirectToAta) {
      // recipientPublicKey IS already an ATA (e.g. PDA-owned raffle pool ATA)
      targetAta = recipient;
    } else {
      targetAta = getAssociatedTokenAddressSync(
        PUSD_MINT, recipient, false, TOKEN_2022_PROGRAM_ID,
      );
      // Create recipient ATA if it doesn't exist yet
      tx.add(createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey, targetAta, recipient, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
      ));
    }

    // Transfer PUSD from treasury → recipient (no minting — PalmUSD-compatible)
    tx.add(createTransferInstruction(
      treasuryAta, targetAta, treasury.publicKey, amountRaw, [], TOKEN_2022_PROGRAM_ID,
    ));

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = authority.publicKey;
    tx.sign(authority, treasury); // authority pays fees, treasury authorises transfer

    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig, "confirmed");

    console.log(`[payout] ${reason} → ${recipientPublicKey} $${amountUsd} PUSD | sig: ${sig}`);

    // Emit to Torque so every direct reward is visible in their analytics
    emitTorqueEvent({
      event: 'physioloop_session_completed',
      userPublicKey: recipientPublicKey,
      txSignature: sig,
      metadata: {
        reward_reason: reason,
        amount_usd: amountUsd,
        exercise: 'reward_payout',
        session_number: reason === 'patient_first_rep_gift' ? 1 : reason === 'patient_streak_7_rebate' ? 7 : 0,
        sessions_total: 0,
        confidence: 1,
        form_quality: 'reward',
      },
    }).catch(() => {});

    return NextResponse.json({ success: true, signature: sig, amountUsd, reason });
  } catch (err) {
    console.error("[payout] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Payout failed" },
      { status: 500 },
    );
  }
}
