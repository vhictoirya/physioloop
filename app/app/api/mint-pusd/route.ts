import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
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
const PUSD_DECIMALS = 6;

function loadMintAuthority(): Keypair {
  const b64 = process.env.MINT_AUTHORITY_KEYPAIR;
  if (!b64) throw new Error("MINT_AUTHORITY_KEYPAIR not set");
  return Keypair.fromSecretKey(Buffer.from(b64, "base64"));
}

export async function POST(req: NextRequest) {
  try {
    const { patientPubkey, amountUsd } = await req.json() as {
      patientPubkey: string;
      amountUsd: number;
    };

    if (!patientPubkey || !amountUsd || amountUsd <= 0) {
      return NextResponse.json({ error: "patientPubkey and amountUsd required" }, { status: 400 });
    }

    const authority = loadMintAuthority();
    const patient = new PublicKey(patientPubkey);
    const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

    const patientAta = getAssociatedTokenAddressSync(
      PUSD_MINT,
      patient,
      false,
      TOKEN_2022_PROGRAM_ID,
    );

    const amountRaw = Math.round(amountUsd * 10 ** PUSD_DECIMALS);

    const tx = new Transaction();

    // Send 0.05 SOL to patient so they can afford stake_escrow + future session fees
    tx.add(SystemProgram.transfer({
      fromPubkey: authority.publicKey,
      toPubkey: patient,
      lamports: 50_000_000,
    }));

    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey,
      patientAta,
      patient,
      PUSD_MINT,
      TOKEN_2022_PROGRAM_ID,
    ));

    tx.add(createMintToInstruction(
      PUSD_MINT,
      patientAta,
      authority.publicKey,
      amountRaw,
      [],
      TOKEN_2022_PROGRAM_ID,
    ));

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = authority.publicKey;
    tx.sign(authority);

    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");

    return NextResponse.json({ success: true, signature: sig, amountRaw });
  } catch (err) {
    console.error("mint-pusd error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Mint failed" },
      { status: 500 },
    );
  }
}
