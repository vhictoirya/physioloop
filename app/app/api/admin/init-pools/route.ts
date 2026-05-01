/**
 * POST /api/admin/init-pools
 *
 * Idempotently creates the campaign pool ATA and leaderboard pool ATA on-chain.
 * Both are PDA-owned token accounts that accumulate PUSD from session fees and
 * subscription fees respectively. Safe to call multiple times.
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  clusterApiUrl,
} from '@solana/web3.js'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'

const PUSD_MINT = new PublicKey('D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s')

const CAMPAIGN_POOL_OWNER   = new PublicKey('E3ABe5iKhDKcfvGLjfD1reLjEc2fRzSzWoSnUZfSics3')
const CAMPAIGN_POOL_ATA     = new PublicKey('Dt7o6GQxq187EjFjXJLqJUjoCSrT3r7mdBzYNHWLP7Bf')

const LEADERBOARD_POOL_OWNER = new PublicKey('EP6DFJbrabRfQyPaBzAjpzs1QMHju917h3j3B1iaCNFb')
const LEADERBOARD_POOL_ATA   = new PublicKey('zVwDKwwALnDee3JquRmoBzUUzpCFDTg7GiZzsW5CcHg')

function loadMintAuthority(): Keypair {
  const b64 = process.env.MINT_AUTHORITY_KEYPAIR
  if (!b64) throw new Error('MINT_AUTHORITY_KEYPAIR not set')
  return Keypair.fromSecretKey(Buffer.from(b64, 'base64'))
}

export async function POST(req: NextRequest) {
  const { secret } = await req.json() as { secret?: string }
  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const authority  = loadMintAuthority()
    const connection = new Connection(clusterApiUrl('devnet'), 'confirmed')

    const tx = new Transaction()

    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, CAMPAIGN_POOL_ATA, CAMPAIGN_POOL_OWNER, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
    ))
    tx.add(createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, LEADERBOARD_POOL_ATA, LEADERBOARD_POOL_OWNER, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
    ))

    const { blockhash } = await connection.getLatestBlockhash()
    tx.recentBlockhash = blockhash
    tx.feePayer        = authority.publicKey
    tx.sign(authority)

    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false })
    await connection.confirmTransaction(sig, 'confirmed')

    console.log('[init-pools] both pool ATAs initialized | sig:', sig)

    return NextResponse.json({
      ok: true,
      signature: sig,
      pools: {
        campaign:    CAMPAIGN_POOL_ATA.toBase58(),
        leaderboard: LEADERBOARD_POOL_ATA.toBase58(),
      },
    })
  } catch (err) {
    console.error('[init-pools] error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed' },
      { status: 500 },
    )
  }
}
