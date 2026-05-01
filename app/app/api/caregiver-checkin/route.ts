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
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";

const PUSD_MINT  = new PublicKey("D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s");
const PROGRAM_ID = new PublicKey("3vArMkTYa2J95xVYsgdsnDu2pokBjRQGj7ZFUdeDutQi");

const REGISTER_CAREGIVER_DISC      = Buffer.from([159, 189, 20, 162, 94, 5, 149, 98]);
const SUBMIT_CAREGIVER_CHECKIN_DISC = Buffer.from([56, 65, 198, 103, 242, 129, 90, 20]);

function loadMintAuthority(): Keypair {
  const b64 = process.env.MINT_AUTHORITY_KEYPAIR;
  if (!b64) throw new Error("MINT_AUTHORITY_KEYPAIR not set");
  return Keypair.fromSecretKey(Buffer.from(b64, "base64"));
}

function getCaregiverProfilePDA(caregiver: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("caregiver"), caregiver.toBuffer()],
    PROGRAM_ID,
  );
  return pda;
}

function getTreatmentPlanPDA(physio: PublicKey, patient: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("plan"), physio.toBuffer(), patient.toBuffer()],
    PROGRAM_ID,
  );
  return pda;
}

function getEscrowVaultPDA(treatmentPlan: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), treatmentPlan.toBuffer()],
    PROGRAM_ID,
  );
  return pda;
}

function buildRegisterCaregiverIx(
  caregiverProfile: PublicKey,
  caregiver: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: caregiverProfile,         isSigner: false, isWritable: true  },
      { pubkey: caregiver,                isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
    ],
    data: REGISTER_CAREGIVER_DISC,
  });
}

function buildSubmitCheckinIx(
  caregiver: PublicKey,
  caregiverProfile: PublicKey,
  treatmentPlan: PublicKey,
  escrowVault: PublicKey,
  caregiverPusdAta: PublicKey,
  pusdMint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: caregiver,        isSigner: true,  isWritable: true  },
      { pubkey: caregiverProfile, isSigner: false, isWritable: true  },
      { pubkey: treatmentPlan,    isSigner: false, isWritable: true  },
      { pubkey: escrowVault,      isSigner: false, isWritable: true  },
      { pubkey: caregiverPusdAta, isSigner: false, isWritable: true  },
      { pubkey: pusdMint,         isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: SUBMIT_CAREGIVER_CHECKIN_DISC,
  });
}

/**
 * POST /api/caregiver-checkin
 *
 * Handles the full caregiver check-in flow server-side:
 * 1. Fund caregiver with SOL if empty (authority pays)
 * 2. Create caregiver PUSD ATA (authority pays, idempotent)
 * 3. Register CaregiverProfile on-chain if first time (caregiver signs)
 * 4. Submit the check-in ix (caregiver signs, authority pays fees)
 *
 * Body:
 *   caregiverSecretKey  string  bs58-encoded secret key (same value as URL ?key=)
 *   planAddress         string  TreatmentPlan PDA address
 *   physioPublicKey     string  Physio wallet (needed to derive plan PDA)
 *   patientPublicKey    string  Patient wallet (needed to derive plan PDA)
 */
export async function POST(req: NextRequest) {
  try {
    const { caregiverSecretKey, planAddress, physioPublicKey, patientPublicKey } =
      await req.json() as {
        caregiverSecretKey: string;
        planAddress: string;
        physioPublicKey: string;
        patientPublicKey: string;
      };

    if (!caregiverSecretKey || !planAddress || !physioPublicKey || !patientPublicKey) {
      return NextResponse.json({ error: "caregiverSecretKey, planAddress, physioPublicKey, patientPublicKey required" }, { status: 400 });
    }

    const authority    = loadMintAuthority();
    const cgKeypair    = Keypair.fromSecretKey(bs58.decode(caregiverSecretKey));
    const caregiver    = cgKeypair.publicKey;
    const connection   = new Connection(clusterApiUrl("devnet"), "confirmed");

    const planPDA          = new PublicKey(planAddress);
    const caregiverProfile = getCaregiverProfilePDA(caregiver);
    const escrowVault      = getEscrowVaultPDA(planPDA);
    const caregiverAta     = getAssociatedTokenAddressSync(PUSD_MINT, caregiver, false, TOKEN_2022_PROGRAM_ID);

    // Check if caregiver profile already exists
    const profileInfo = await connection.getAccountInfo(caregiverProfile);
    const needsRegister = profileInfo === null;

    // ── TX 1: Fund caregiver + create ATA (authority pays) ──────────────────
    const setupTx = new Transaction();

    // Give caregiver 0.05 SOL for current + future tx fees
    const cgBalance = await connection.getBalance(caregiver);
    if (cgBalance < 30_000_000) {
      setupTx.add(SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey:   caregiver,
        lamports:   50_000_000,
      }));
    }

    // Create caregiver PUSD ATA (idempotent)
    setupTx.add(createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, caregiverAta, caregiver, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
    ));

    const { blockhash: bh1 } = await connection.getLatestBlockhash();
    setupTx.recentBlockhash = bh1;
    setupTx.feePayer = authority.publicKey;
    setupTx.sign(authority);
    const sig1 = await connection.sendRawTransaction(setupTx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig1, "confirmed");

    // ── TX 2: Register + check-in (caregiver signs, authority pays fees) ────
    const checkinTx = new Transaction();

    if (needsRegister) {
      checkinTx.add(buildRegisterCaregiverIx(caregiverProfile, caregiver));
    }

    checkinTx.add(buildSubmitCheckinIx(
      caregiver, caregiverProfile, planPDA, escrowVault, caregiverAta, PUSD_MINT,
    ));

    const { blockhash: bh2 } = await connection.getLatestBlockhash();
    checkinTx.recentBlockhash = bh2;
    checkinTx.feePayer = authority.publicKey; // authority pays fees, caregiver signs only
    checkinTx.partialSign(authority);
    checkinTx.partialSign(cgKeypair);

    const sig2 = await connection.sendRawTransaction(checkinTx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig2, "confirmed");

    console.log(`[caregiver-checkin] ${caregiver.toBase58()} | plan=${planAddress} | sigs: ${sig1}, ${sig2}`);
    return NextResponse.json({ success: true, signature: sig2 });

  } catch (err) {
    console.error("[caregiver-checkin] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Check-in failed" },
      { status: 500 },
    );
  }
}
