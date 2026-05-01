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
  createTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

const PUSD_MINT = new PublicKey("D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s");
const PROGRAM_ID = new PublicKey("3vArMkTYa2J95xVYsgdsnDu2pokBjRQGj7ZFUdeDutQi");
const PUSD_DECIMALS = 6;
const REGISTER_PHYSIO_DISC = Buffer.from([254, 84, 91, 239, 251, 80, 221, 140]);

// Leaderboard pool PDA owner: seeds=["leaderboard_pool"], program=PROGRAM_ID
const LEADERBOARD_POOL_OWNER = new PublicKey("EP6DFJbrabRfQyPaBzAjpzs1QMHju917h3j3B1iaCNFb");
const LEADERBOARD_POOL_ATA   = new PublicKey("zVwDKwwALnDee3JquRmoBzUUzpCFDTg7GiZzsW5CcHg");

// Monthly subscription costs in PUSD base units (6 decimals)
const TIER_COSTS: Record<number, number> = {
  1:  5_000_000, // $5  Starter
  2: 15_000_000, // $15 Professional
  3: 50_000_000, // $50 Elite
};

// Subscription split: 90% ops treasury, 10% leaderboard prize pool
const SUB_OPS_BPS         = 9_000;
const SUB_LEADERBOARD_BPS = 1_000;

function loadMintAuthority(): Keypair {
  const b64 = process.env.MINT_AUTHORITY_KEYPAIR;
  if (!b64) throw new Error("MINT_AUTHORITY_KEYPAIR not set");
  return Keypair.fromSecretKey(Buffer.from(b64, "base64"));
}

function buildRegisterPhysioIx(
  physioProfile: PublicKey,
  physio: PublicKey,
  tier: number,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: physioProfile,           isSigner: false, isWritable: true  },
      { pubkey: physio,                  isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([REGISTER_PHYSIO_DISC, Buffer.from([tier])]),
  });
}

export async function POST(req: NextRequest) {
  try {
    const { physioPublicKey, tier } = await req.json() as {
      physioPublicKey: string;
      tier: number;
    };

    if (!physioPublicKey || ![1, 2, 3].includes(tier)) {
      return NextResponse.json(
        { error: "physioPublicKey and valid tier (1-3) required" },
        { status: 400 },
      );
    }

    const authority = loadMintAuthority();
    const physio = new PublicKey(physioPublicKey);
    const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

    const physioAta = getAssociatedTokenAddressSync(
      PUSD_MINT, physio, false, TOKEN_2022_PROGRAM_ID,
    );
    const opsTreasuryAta = getAssociatedTokenAddressSync(
      PUSD_MINT, authority.publicKey, false, TOKEN_2022_PROGRAM_ID,
    );
    const [physioProfile] = PublicKey.findProgramAddressSync(
      [Buffer.from("physio"), physio.toBuffer()],
      PROGRAM_ID,
    );

    const cost = TIER_COSTS[tier] ?? TIER_COSTS[1];
    const opsAmount         = Math.round(cost * SUB_OPS_BPS / 10_000);
    const leaderboardAmount = cost - opsAmount; // remainder avoids rounding gaps

    const tx = new Transaction();

    // Create ATAs (all idempotent)
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, physioAta, physio, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
    ));
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, opsTreasuryAta, authority.publicKey, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
    ));
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, LEADERBOARD_POOL_ATA, LEADERBOARD_POOL_OWNER, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
    ));

    // Mint full subscription PUSD to physio (platform-funded on-ramp)
    tx.add(createMintToInstruction(
      PUSD_MINT, physioAta, authority.publicKey, cost, [], TOKEN_2022_PROGRAM_ID,
    ));

    // 90% → ops treasury (physio signs as ATA owner)
    tx.add(createTransferCheckedInstruction(
      physioAta, PUSD_MINT, opsTreasuryAta, physio, opsAmount, PUSD_DECIMALS, [], TOKEN_2022_PROGRAM_ID,
    ));

    // 10% → leaderboard prize pool (physio signs as ATA owner)
    tx.add(createTransferCheckedInstruction(
      physioAta, PUSD_MINT, LEADERBOARD_POOL_ATA, physio, leaderboardAmount, PUSD_DECIMALS, [], TOKEN_2022_PROGRAM_ID,
    ));

    // register_physio(tier) — physio must sign
    tx.add(buildRegisterPhysioIx(physioProfile, physio, tier));

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = authority.publicKey;

    // Authority partially signs (fee payer + mint authority)
    tx.partialSign(authority);

    return NextResponse.json({
      transaction: tx.serialize({ requireAllSignatures: false }).toString("base64"),
      lastValidBlockHeight,
    });
  } catch (err) {
    console.error("register-physio error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Registration failed" },
      { status: 500 },
    );
  }
}
