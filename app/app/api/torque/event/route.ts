/**
 * POST /api/torque/event
 *
 * Proxy endpoint called by the patient app after a verified session,
 * the physio dashboard for plan_started / physio_registered,
 * and the caregiver app for daily check-ins.
 *
 * Handles two concerns:
 *  1. Forward events to Torque for analytics + campaign enrollment
 *  2. Mint guaranteed PUSD rewards directly when milestone thresholds are hit
 *
 * Guaranteed direct PUSD payouts:
 *   patient  session 1   → $0.50 first-rep gift (direct mint, instant)
 *   caregiver streak 1   → $0.25 first check-in gift (direct mint, instant)
 *
 * Torque distributor (CLAIM) payouts:
 *   patient  session 7   → $0.50 streak rebate (STREAK_REBATE epoch evaluation)
 *   caregiver streak 7   → $1.00 7-day streak bonus (CG_STREAK_7 epoch evaluation)
 *   caregiver rescue     → $0.50 per rescue (CG_RESCUE epoch evaluation)
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  onSessionCompleted,
  onPlanStarted,
  onPhysioRegistered,
  onCaregiverCheckin,
  onPlanCompleted,
  type TorqueEventName,
} from '@/lib/torque'
import { incrementStat } from '@/lib/eventStats'

interface EventBody {
  event: TorqueEventName
  userPublicKey: string
  txSignature?: string
  metadata?: Record<string, string | number | boolean>
}

const RAFFLE_POOL_ATA = "796puzSZryzLA865sPKko74Zj76bspGCsGnJ3tJ1cwyc"

/** Mints $1.00 PUSD directly into the raffle pool ATA — accumulates for monthly draw. */
async function mintRaffleContribution(amountUsd: number): Promise<void> {
  try {
    const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
    await fetch(`${base}/api/payout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientPublicKey: RAFFLE_POOL_ATA,
        amountUsd,
        reason: 'raffle_pool_contribution',
        mintDirectToAta: true,
      }),
    })
  } catch (err) {
    console.warn('[raffle] contribution failed (non-fatal):', err)
  }
}

async function mintPayout(
  recipientPublicKey: string,
  amountUsd: number,
  reason: string,
): Promise<void> {
  try {
    const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
    const res = await fetch(`${base}/api/payout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipientPublicKey, amountUsd, reason }),
    })
    const json = await res.json() as { success?: boolean; signature?: string; error?: string }
    if (json.success) {
      console.log(`[payout] ${reason} → ${recipientPublicKey} $${amountUsd} | ${json.signature}`)
    } else {
      console.warn(`[payout] ${reason} failed:`, json.error)
    }
  } catch (err) {
    console.warn(`[payout] ${reason} delivery failed (non-fatal):`, err)
  }
}

export async function POST(req: NextRequest) {
  let body: EventBody
  try {
    body = await req.json() as EventBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  const { event, userPublicKey, txSignature, metadata } = body

  if (!event || !userPublicKey) {
    return NextResponse.json({ error: 'event and userPublicKey required' }, { status: 400 })
  }

  // Track in-process stats for the live dashboard
  incrementStat(event)

  try {
    switch (event) {
      case 'physioloop_session_completed': {
        const sessionNumber = (metadata?.session_number as number) ?? 0
        const sessionsTotal = (metadata?.sessions_total as number) ?? 0

        await onSessionCompleted({
          patientPublicKey: userPublicKey,
          physioPubkey: (metadata?.physio as string) ?? '',
          sessionNumber,
          sessionsTotal,
          exerciseName: (metadata?.exercise as string) ?? '',
          confidence: (metadata?.confidence as number) ?? 0,
          formQuality: (metadata?.form_quality as string) ?? '',
          txSignature: txSignature ?? '',
        })

        // Session 1 → immediate $0.50 gift (direct mint, instant reward)
        if (sessionNumber === 1) {
          mintPayout(userPublicKey, 0.5, 'patient_first_rep_gift').catch(() => {})
        }
        // Session 7 → streak rebate via Torque CLAIM distributor (not direct mint).
        // physioloop_streak_milestone event + STREAK_REBATE enrollment already fired
        // inside onSessionCompleted — Torque evaluates weekly and patient claims $0.50.
        break
      }

      case 'physioloop_plan_started':
        await onPlanStarted({
          physioPubkey: userPublicKey,
          patientPublicKey: (metadata?.patient as string) ?? '',
          exerciseName: (metadata?.exercise as string) ?? '',
          sessionsTotal: (metadata?.sessions_total as number) ?? 0,
          pusdPerSession: (metadata?.pusd_per_session as number) ?? 0,
          txSignature: txSignature ?? '',
        })
        break

      case 'physioloop_plan_completed': {
        const caregiverPubkey = (metadata?.caregiver as string) || undefined
        await onPlanCompleted({
          physioPubkey: userPublicKey,
          patientPublicKey: (metadata?.patient as string) ?? '',
          caregiverPublicKey: caregiverPubkey,
          sessionsCompleted: (metadata?.sessions_completed as number) ?? 0,
          txSignature: txSignature ?? '',
        })
        // $1.00 → raffle pool (accumulates for monthly draw, not paid out now)
        mintRaffleContribution(1.0).catch(() => {})
        // Caregiver completion bonus — $2.00 direct payout
        if (caregiverPubkey) {
          mintPayout(caregiverPubkey, 2.0, 'caregiver_completion_bonus').catch(() => {})
        }
        break
      }

      case 'physioloop_physio_registered':
        await onPhysioRegistered(userPublicKey, txSignature ?? '')
        break

      case 'physioloop_caregiver_checkin': {
        const streakCount = (metadata?.streak_count as number) ?? 0

        await onCaregiverCheckin({
          caregiverPublicKey: userPublicKey,
          patientPublicKey: (metadata?.patient as string) ?? '',
          streakCount,
          patientMissedSession: (metadata?.patient_missed_session as boolean) ?? false,
          txSignature: txSignature ?? '',
        })

        // Direct PUSD payouts — no Torque campaign required
        if (streakCount === 1) {
          mintPayout(userPublicKey, 0.25, 'caregiver_first_checkin_gift').catch(() => {})
        }
        if (streakCount === 7) {
          mintPayout(userPublicKey, 1.0, 'caregiver_streak_7_bonus').catch(() => {})
        }
        // Rescue bonus — caregiver checked in on a day the patient missed their session
        if ((metadata?.patient_missed_session as boolean) === true) {
          mintPayout(userPublicKey, 0.5, 'caregiver_rescue_bonus').catch(() => {})
        }
        break
      }

      default:
        break
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[/api/torque/event] error:', err)
    // Return 200 — client must not retry-storm Torque
    return NextResponse.json({ ok: false, error: 'delivery failed' })
  }
}
