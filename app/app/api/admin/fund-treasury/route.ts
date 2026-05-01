/**
 * POST /api/admin/fund-treasury
 *
 * One-time devnet setup: mints PUSD into the platform treasury ATA.
 * On mainnet this is replaced by PalmUSD team depositing real PUSD.
 *
 * Protected by ADMIN_SECRET header.
 */
import { NextRequest, NextResponse } from "next/server"
import { Connection, Keypair, PublicKey, Transaction, clusterApiUrl } from "@solana/web3.js"
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token"

const PUSD_MINT = new PublicKey("D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s")

function loadKeypair(envVar: string): Keypair {
  const b64 = process.env[envVar]
  if (!b64) throw new Error(`${envVar} not set`)
  return Keypair.fromSecretKey(Buffer.from(b64, "base64"))
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-secret") !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  try {
    const { amountUsd = 10_000 } = await req.json().catch(() => ({})) as { amountUsd?: number }

    const authority = loadKeypair("MINT_AUTHORITY_KEYPAIR")
    const treasury  = loadKeypair("TREASURY_KEYPAIR")
    const connection = new Connection(clusterApiUrl("devnet"), "confirmed")

    const treasuryAta = getAssociatedTokenAddressSync(
      PUSD_MINT, treasury.publicKey, false, TOKEN_2022_PROGRAM_ID,
    )

    const tx = new Transaction()

    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, treasuryAta, treasury.publicKey, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
    ))

    const amountRaw = Math.round(amountUsd * 1_000_000)
    tx.add(createMintToInstruction(
      PUSD_MINT, treasuryAta, authority.publicKey, amountRaw, [], TOKEN_2022_PROGRAM_ID,
    ))

    const { blockhash } = await connection.getLatestBlockhash()
    tx.recentBlockhash = blockhash
    tx.feePayer = authority.publicKey
    tx.sign(authority)

    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false })
    await connection.confirmTransaction(sig, "confirmed")

    console.log(`[fund-treasury] minted ${amountUsd} PUSD → treasury ATA ${treasuryAta.toBase58()} | ${sig}`)

    return NextResponse.json({
      success: true,
      treasuryPubkey: treasury.publicKey.toBase58(),
      treasuryAta: treasuryAta.toBase58(),
      amountUsd,
      signature: sig,
    })
  } catch (err) {
    console.error("[fund-treasury] error:", err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed" },
      { status: 500 },
    )
  }
}
