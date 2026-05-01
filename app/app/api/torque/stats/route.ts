/**
 * GET /api/torque/stats
 *
 * Returns live event counts + campaign status for the Torque analytics banner.
 * Event counts are tracked in-process (resets on cold start).
 * Campaign metadata comes from the Torque REST API.
 */
import { NextResponse } from 'next/server'
import { getStats } from '@/lib/eventStats'

const TORQUE_SERVER   = process.env.NEXT_PUBLIC_TORQUE_API_URL  ?? 'https://server.torque.so'
const TORQUE_API_KEY  = process.env.TORQUE_API_KEY              ?? ''
const PROJECT_ID      = process.env.NEXT_PUBLIC_TORQUE_PROJECT_ID ?? ''

// Recurring incentive IDs
const CAMPAIGN_IDS = {
  patientSession:    process.env.NEXT_PUBLIC_TORQUE_CAMPAIGN_ONBOARDING  ?? '',
  caregiverCheckin:  process.env.NEXT_PUBLIC_TORQUE_CAMPAIGN_CG_FIRST    ?? '',
  physioLeaderboard: process.env.NEXT_PUBLIC_TORQUE_CAMPAIGN_LEADERBOARD ?? '',
}

interface TorqueCampaignStatus {
  id: string
  name: string
  status: string
  epochStatus: string  // EVALUATING | UPCOMING | COMPLETED
  evalWindow: string
}

async function fetchCampaignStatus(id: string): Promise<TorqueCampaignStatus | null> {
  if (!id) return null
  try {
    // Use the MCP-internal endpoint pattern discovered via probing
    const res = await fetch(`${TORQUE_SERVER}/projects/${PROJECT_ID}/recurring-offers/${id}`, {
      headers: { Authorization: `Bearer ${TORQUE_API_KEY}` },
      next: { revalidate: 60 },
    })
    if (!res.ok) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = await res.json() as any
    const d = json.data
    const epoch = d?.epochConfigs?.[0]
    return {
      id,
      name: d?.name ?? id,
      status: d?.status ?? 'unknown',
      epochStatus: epoch?.status ?? 'unknown',
      evalWindow: epoch
        ? `${epoch.evalStart?.slice(0, 10)} → ${epoch.evalEnd?.slice(0, 10)}`
        : '—',
    }
  } catch {
    return null
  }
}

export async function GET() {
  const eventStats = getStats()

  // Fetch campaign statuses (best-effort, non-blocking)
  const [patientCampaign, caregiverCampaign, leaderboardCampaign] = await Promise.all([
    fetchCampaignStatus(CAMPAIGN_IDS.patientSession),
    fetchCampaignStatus(CAMPAIGN_IDS.caregiverCheckin),
    fetchCampaignStatus(CAMPAIGN_IDS.physioLeaderboard),
  ])

  return NextResponse.json({
    ok: true,
    events: {
      sessions:          eventStats.sessions,
      caregiverCheckins: eventStats.caregiverCheckins,
      plansStarted:      eventStats.plansStarted,
      plansCompleted:    eventStats.plansCompleted,
      physiosRegistered: eventStats.physiosRegistered,
      lastUpdated:       eventStats.lastUpdated,
    },
    campaigns: {
      patientSession:    patientCampaign,
      caregiverCheckin:  caregiverCampaign,
      physioLeaderboard: leaderboardCampaign,
    },
    // Hardcoded epoch info since we created them today
    epochStatus: 'EVALUATING',
    epochWindow: '2026-04-28 → 2026-04-29',
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
