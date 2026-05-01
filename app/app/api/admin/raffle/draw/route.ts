/**
 * POST /api/admin/raffle/draw
 *
 * Monthly raffle draw. Reads the raffle pool ATA balance, picks one winner
 * at random from the eligible patient list, and mints the full pot to them.
 *
 * Body:
 *   eligiblePatients  string[]   Wallet addresses of patients who completed a
 *                                plan since the last draw (caller's responsibility
 *                                to supply — read from on-chain PhysioProfile or DB)
 *   adminSecret       string     Must match ADMIN_SECRET env var
 *
 * Response:
 *   winner            string     The winning wallet address
 *   potUsd            number     PUSD amount paid out
 *   signature         string     On-chain tx signature
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

const PUSD_MINT       = new PublicKey("D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s");
const RAFFLE_POOL_ATA = new PublicKey("796puzSZryzLA865sPKko74Zj76bspGCsGnJ3tJ1cwyc");
const PUSD_DECIMALS   = 6;

function loadMintAuthority(): Keypair {
  const b64 = process.env.MINT_AUTHORITY_KEYPAIR;
  if (!b64) throw new Error("MINT_AUTHORITY_KEYPAIR not set");
  return Keypair.fromSecretKey(Buffer.from(b64, "base64"));
}

export async function POST(req: NextRequest) {
  try {
    const { eligiblePatients, adminSecret } = await req.json() as {
      eligiblePatients: string[];
      adminSecret: string;
    };

    if (adminSecret !== process.env.ADMIN_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!eligiblePatients || eligiblePatients.length === 0) {
      return NextResponse.json({ error: "No eligible patients for this draw" }, { status: 400 });
    }

    const authority   = loadMintAuthority();
    const connection  = new Connection(clusterApiUrl("devnet"), "confirmed");

    // Read the current raffle pool balance
    const poolAccount = await connection.getTokenAccountBalance(RAFFLE_POOL_ATA);
    const potRaw      = BigInt(poolAccount.value.amount);
    const potUsd      = Number(potRaw) / 10 ** PUSD_DECIMALS;

    if (potRaw === BigInt(0)) {
      return NextResponse.json({ error: "Raffle pool is empty" }, { status: 400 });
    }

    // Pick a random winner
    const winnerAddress = eligiblePatients[Math.floor(Math.random() * eligiblePatients.length)];
    const winner        = new PublicKey(winnerAddress);
    const winnerAta     = getAssociatedTokenAddressSync(
      PUSD_MINT, winner, false, TOKEN_2022_PROGRAM_ID,
    );

    // Mint the full pot to the winner
    const tx = new Transaction();
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, winnerAta, winner, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
    ));
    tx.add(createMintToInstruction(
      PUSD_MINT, winnerAta, authority.publicKey, potRaw, [], TOKEN_2022_PROGRAM_ID,
    ));

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash   = blockhash;
    tx.feePayer          = authority.publicKey;
    tx.sign(authority);

    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig, "confirmed");

    console.log(`[raffle] draw: ${winnerAddress} wins $${potUsd} PUSD from ${eligiblePatients.length} entries | sig: ${sig}`);
    return NextResponse.json({ winner: winnerAddress, potUsd, entries: eligiblePatients.length, signature: sig });
  } catch (err) {
    console.error("[raffle/draw] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Draw failed" },
      { status: 500 },
    );
  }
}
