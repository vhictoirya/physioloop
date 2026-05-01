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
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

const PUSD_MINT         = new PublicKey("D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s");
const CAMPAIGN_POOL_OWNER = new PublicKey("E3ABe5iKhDKcfvGLjfD1reLjEc2fRzSzWoSnUZfSics3");
const CAMPAIGN_POOL_ATA   = new PublicKey("Dt7o6GQxq187EjFjXJLqJUjoCSrT3r7mdBzYNHWLP7Bf");

function loadMintAuthority(): Keypair {
  const b64 = process.env.MINT_AUTHORITY_KEYPAIR;
  if (!b64) throw new Error("MINT_AUTHORITY_KEYPAIR not set");
  return Keypair.fromSecretKey(Buffer.from(b64, "base64"));
}

/**
 * POST /api/ensure-atas
 * Idempotently creates the three ATAs that submit_attestation writes to.
 * Call this once before each session submission to guarantee they exist,
 * regardless of when the plan was activated.
 */
export async function POST(req: NextRequest) {
  try {
    const { physioPublicKey } = await req.json() as { physioPublicKey: string };
    if (!physioPublicKey) {
      return NextResponse.json({ error: "physioPublicKey required" }, { status: 400 });
    }

    const authority  = loadMintAuthority();
    const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
    const physio     = new PublicKey(physioPublicKey);

    const physioAta      = getAssociatedTokenAddressSync(PUSD_MINT, physio,            false, TOKEN_2022_PROGRAM_ID);
    const opsTreasuryAta = getAssociatedTokenAddressSync(PUSD_MINT, authority.publicKey, false, TOKEN_2022_PROGRAM_ID);

    const tx = new Transaction();
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, physioAta, physio, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
    ));
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, opsTreasuryAta, authority.publicKey, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
    ));
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, CAMPAIGN_POOL_ATA, CAMPAIGN_POOL_OWNER, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
    ));

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer        = authority.publicKey;
    tx.sign(authority);

    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig, "confirmed");

    return NextResponse.json({ ok: true, signature: sig });
  } catch (err) {
    // If all ATAs already exist Solana still succeeds (idempotent instruction).
    // Only a genuine network / config error reaches here.
    console.error("[ensure-atas] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 },
    );
  }
}
