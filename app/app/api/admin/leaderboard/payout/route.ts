/**
 * POST /api/admin/leaderboard/payout
 *
 * Weekly physio leaderboard payout. Mints $25/$12/$5 PUSD to the top 3
 * physios ranked by patient compliance rate for the week.
 *
 * Funded by the 10% leaderboard slice of every subscription.
 * The leaderboard pool ATA (PDA-owned) accumulates on-chain as collateral;
 * prizes are minted from the platform authority keypair.
 *
 * Body:
 *   winners      { address: string; place: 1 | 2 | 3 }[]   Top 3 physio wallets
 *   adminSecret  string                                     Must match ADMIN_SECRET
 *
 * Response:
 *   payouts      { address, place, amountUsd, signature }[]
 */
import { NextRequest, NextResponse } from "next/server";
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
  createMintToInstruction,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

const PUSD_MINT = new PublicKey("D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s");

const PRIZE_AMOUNTS: Record<1 | 2 | 3, number> = {
  1: 25_000_000, // $25
  2: 12_000_000, // $12
  3:  5_000_000, // $5
};

function loadMintAuthority(): Keypair {
  const b64 = process.env.MINT_AUTHORITY_KEYPAIR;
  if (!b64) throw new Error("MINT_AUTHORITY_KEYPAIR not set");
  return Keypair.fromSecretKey(Buffer.from(b64, "base64"));
}

export async function POST(req: NextRequest) {
  try {
    const { winners, adminSecret } = await req.json() as {
      winners: { address: string; place: 1 | 2 | 3 }[];
      adminSecret: string;
    };

    if (adminSecret !== process.env.ADMIN_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!winners || winners.length === 0 || winners.length > 3) {
      return NextResponse.json({ error: "Provide 1-3 winners with place 1/2/3" }, { status: 400 });
    }

    const authority  = loadMintAuthority();
    const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

    const payouts: { address: string; place: number; amountUsd: number; signature: string }[] = [];

    for (const { address, place } of winners) {
      if (![1, 2, 3].includes(place)) continue;
      const prizeRaw  = PRIZE_AMOUNTS[place as 1 | 2 | 3];
      const amountUsd = prizeRaw / 1_000_000;
      const physio    = new PublicKey(address);
      const physioAta = getAssociatedTokenAddressSync(
        PUSD_MINT, physio, false, TOKEN_2022_PROGRAM_ID,
      );

      const tx = new Transaction();
      tx.add(createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey, physioAta, physio, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
      ));
      tx.add(createMintToInstruction(
        PUSD_MINT, physioAta, authority.publicKey, prizeRaw, [], TOKEN_2022_PROGRAM_ID,
      ));

      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash   = blockhash;
      tx.feePayer          = authority.publicKey;
      tx.sign(authority);

      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await connection.confirmTransaction(sig, "confirmed");

      console.log(`[leaderboard] ${place}st place: ${address} $${amountUsd} PUSD | sig: ${sig}`);
      payouts.push({ address, place, amountUsd, signature: sig });
    }

    return NextResponse.json({ payouts });
  } catch (err) {
    console.error("[leaderboard/payout] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Leaderboard payout failed" },
      { status: 500 },
    );
  }
}
