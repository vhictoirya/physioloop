import { NextRequest, NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";

const PUSD_MINT = new PublicKey("D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s");
const PROGRAM_ID = new PublicKey("3vArMkTYa2J95xVYsgdsnDu2pokBjRQGj7ZFUdeDutQi");
const PUSD_DECIMALS = 6;

// Campaign pool PDA — seeds=["campaign_pool"], program=PROGRAM_ID
const CAMPAIGN_POOL_OWNER = new PublicKey("E3ABe5iKhDKcfvGLjfD1reLjEc2fRzSzWoSnUZfSics3");
const CAMPAIGN_POOL_ATA   = new PublicKey("Dt7o6GQxq187EjFjXJLqJUjoCSrT3r7mdBzYNHWLP7Bf");

// Discriminator from IDL: [117, 255, 148, 190, 2, 238, 184, 250]
const STAKE_ESCROW_DISC = Buffer.from([117, 255, 148, 190, 2, 238, 184, 250]);

function loadMintAuthority(): Keypair {
  const b64 = process.env.MINT_AUTHORITY_KEYPAIR;
  if (!b64) throw new Error("MINT_AUTHORITY_KEYPAIR not set");
  return Keypair.fromSecretKey(Buffer.from(b64, "base64"));
}

function getEscrowVaultPDA(treatmentPlan: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), treatmentPlan.toBuffer()],
    PROGRAM_ID,
  );
  return pda;
}

function buildStakeEscrowIx(
  treatmentPlan: PublicKey,
  escrowVault: PublicKey,
  patientPusdAta: PublicKey,
  pusdMint: PublicKey,
  patient: PublicKey,
  amountRaw: number,
): TransactionInstruction {
  // Serialize u64 amount as little-endian 8 bytes — bypasses Anchor account resolution
  const amountBuf = Buffer.alloc(8);
  const lo = amountRaw >>> 0;
  const hi = Math.floor(amountRaw / 0x100000000);
  amountBuf.writeUInt32LE(lo, 0);
  amountBuf.writeUInt32LE(hi, 4);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: treatmentPlan,  isSigner: false, isWritable: true  },
      { pubkey: escrowVault,    isSigner: false, isWritable: true  },
      { pubkey: patientPusdAta, isSigner: false, isWritable: true  },
      { pubkey: pusdMint,       isSigner: false, isWritable: false },
      { pubkey: patient,        isSigner: true,  isWritable: true  },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([STAKE_ESCROW_DISC, amountBuf]),
  });
}

export async function POST(req: NextRequest) {
  try {
    const { planAddress, patientSecretKey, amountUsd, physioPublicKey } = await req.json() as {
      planAddress: string;
      patientSecretKey: string;   // bs58-encoded — same value already in patient's URL
      amountUsd: number;
      physioPublicKey?: string;
    };

    if (!planAddress || !patientSecretKey || !amountUsd || amountUsd <= 0) {
      return NextResponse.json({ error: "planAddress, patientSecretKey and amountUsd required" }, { status: 400 });
    }

    const authority = loadMintAuthority();
    const patientKeypair = Keypair.fromSecretKey(bs58.decode(patientSecretKey));
    const patient = patientKeypair.publicKey;
    const treatmentPlan = new PublicKey(planAddress);
    const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

    const patientAta = getAssociatedTokenAddressSync(
      PUSD_MINT, patient, false, TOKEN_2022_PROGRAM_ID,
    );
    const escrowVault = getEscrowVaultPDA(treatmentPlan);
    const amountRaw = Math.round(amountUsd * 10 ** PUSD_DECIMALS);

    const tx = new Transaction();

    // 1. Give patient 0.05 SOL for session transaction fees
    tx.add(SystemProgram.transfer({
      fromPubkey: authority.publicKey,
      toPubkey: patient,
      lamports: 50_000_000,
    }));

    // 2. Create patient PUSD ATA (idempotent)
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, patientAta, patient, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
    ));

    // 3. Create ops treasury ATA (idempotent) — submit_attestation transfers 15% here
    const opsTreasuryAta = getAssociatedTokenAddressSync(
      PUSD_MINT, authority.publicKey, false, TOKEN_2022_PROGRAM_ID,
    );
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, opsTreasuryAta, authority.publicKey, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
    ));

    // 4. Create campaign pool ATA (idempotent, PDA owner) — submit_attestation transfers 10% here
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, CAMPAIGN_POOL_ATA, CAMPAIGN_POOL_OWNER, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
    ));

    // 5. Create physio PUSD ATA (idempotent) — submit_attestation transfers 70% here
    if (physioPublicKey) {
      const physio = new PublicKey(physioPublicKey);
      const physioAta = getAssociatedTokenAddressSync(
        PUSD_MINT, physio, false, TOKEN_2022_PROGRAM_ID,
      );
      tx.add(createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey, physioAta, physio, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
      ));
    }

    // 6. Mint PUSD to patient (mock Paystack on-ramp)
    tx.add(createMintToInstruction(
      PUSD_MINT, patientAta, authority.publicKey, amountRaw, [], TOKEN_2022_PROGRAM_ID,
    ));

    // 7. stake_escrow — built from raw discriminator + args to avoid Anchor PDA resolution
    tx.add(buildStakeEscrowIx(
      treatmentPlan, escrowVault, patientAta, PUSD_MINT, patient, amountRaw,
    ));

    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = authority.publicKey; // authority pays — patient needs no SOL for this tx

    // Both authority (fee payer + mint auth) and patient (required signer) must sign
    tx.sign(authority, patientKeypair);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    await connection.confirmTransaction(sig, "confirmed");

    return NextResponse.json({ success: true, signature: sig });
  } catch (err) {
    console.error("activate-plan error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Activation failed" },
      { status: 500 },
    );
  }
}
