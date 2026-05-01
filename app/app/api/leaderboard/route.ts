/**
 * GET /api/leaderboard?physio=<pubkey>
 *
 * Returns leaderboard pool balance + Torque epoch rankings.
 * Used by the physio dashboard to show prize pool size and ranking.
 */
import { NextRequest, NextResponse } from 'next/server'
import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js'

const LEADERBOARD_POOL_ATA = new PublicKey('zVwDKwwALnDee3JquRmoBzUUzpCFDTg7GiZzsW5CcHg')
const CAMPAIGN_POOL_ATA    = new PublicKey('Dt7o6GQxq187EjFjXJLqJUjoCSrT3r7mdBzYNHWLP7Bf')
const TORQUE_API_URL       = process.env.NEXT_PUBLIC_TORQUE_API_URL ?? 'https://server.torque.so'
const TORQUE_API_KEY       = process.env.TORQUE_API_KEY ?? ''
const LEADERBOARD_CAMPAIGN = process.env.NEXT_PUBLIC_TORQUE_CAMPAIGN_LEADERBOARD ?? ''

export async function GET(req: NextRequest) {
  const physio = req.nextUrl.searchParams.get('physio')

  try {
    const connection = new Connection(clusterApiUrl('devnet'), 'confirmed')

    // Pool balances
    let poolUsd = 0
    let campaignPoolUsd = 0
    try {
      const [lb, cp] = await Promise.allSettled([
        connection.getTokenAccountBalance(LEADERBOARD_POOL_ATA),
        connection.getTokenAccountBalance(CAMPAIGN_POOL_ATA),
      ])
      if (lb.status === 'fulfilled') poolUsd = Number(lb.value.value.amount) / 1_000_000
      if (cp.status === 'fulfilled') campaignPoolUsd = Number(cp.value.value.amount) / 1_000_000
    } catch {
      poolUsd = 0
    }

    // Torque leaderboard rankings
    let rankings: Array<{ rank: number; pubkey: string; score: number }> = []
    let physioRank: number | null = null

    if (LEADERBOARD_CAMPAIGN && TORQUE_API_KEY) {
      try {
        const res = await fetch(
          `${TORQUE_API_URL}/campaigns/${LEADERBOARD_CAMPAIGN}/leaderboard?limit=10`,
          { headers: { Authorization: `Bearer ${TORQUE_API_KEY}` }, cache: 'no-store' },
        )
        if (res.ok) {
          const data = await res.json() as {
            data?: Array<{ rank: number; userPubkey: string; score: number }>
          }
          rankings = (data.data ?? []).map(r => ({
            rank: r.rank,
            pubkey: r.userPubkey,
            score: r.score,
          }))
          if (physio) {
            const entry = rankings.find(r => r.pubkey === physio)
            physioRank = entry?.rank ?? null
          }
        }
      } catch {
        // Non-fatal — leaderboard data unavailable
      }
    }

    return NextResponse.json(
      { poolUsd, campaignPoolUsd, rankings, physioRank },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed' },
      { status: 500 },
    )
  }
}
