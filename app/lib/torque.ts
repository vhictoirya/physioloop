/**
 * Torque protocol integration for PhysioLoop.
 *
 * Custom events emitted to Torque after every verifiable on-chain action:
 *   - session_completed   (QVAC attestation accepted, PUSD released)
 *   - plan_started        (treatment plan created + escrow staked)
 *   - plan_completed      (all sessions done)
 *   - streak_milestone    (3 or 7 consecutive sessions)
 *   - caregiver_checkin   (caregiver submits daily check-in)
 *   - physio_registered   (new physio joins the protocol)
 *
 * Torque campaigns (set IDs in .env.local):
 *   Patient:
 *   - ONBOARDING_GIFT      : first session completed → $0.50 PUSD gift (guaranteed, minted direct)
 *   - STREAK_REBATE        : 7-session streak → $0.50 PUSD rebate (guaranteed, minted direct)
 *   - PLAN_RAFFLE          : plan completion → $1.00 into raffle pool ATA (monthly draw)
 *
 *   Caregiver:
 *   - CG_FIRST_CHECKIN     : first daily check-in → $0.25 gift (guaranteed, minted direct)
 *   - CG_STREAK_7          : 7-day streak → $1.00 bonus (guaranteed, minted direct)
 *   - CG_RESCUE            : check-in after missed patient session → $0.50 (Torque conditional)
 *   - CG_COMPLETION        : plan completes with caregiver assigned → $2.00 (Torque conditional)
 *
 *   Physio:
 *   - PHYSIO_LEADERBOARD   : ranked by compliance rate, weekly $25/$12/$5 PUSD prize (Torque)
 */

export type TorqueEventName =
  | 'physioloop_session_completed'
  | 'physioloop_plan_started'
  | 'physioloop_plan_completed'
  | 'physioloop_streak_milestone'
  | 'physioloop_caregiver_checkin'
  | 'physioloop_caregiver_milestone'
  | 'physioloop_physio_registered'

export interface TorqueEventPayload {
  event: TorqueEventName
  /** Solana wallet address of the acting user (patient or physio) */
  userPublicKey: string
  /** On-chain tx signature for verification — Torque can cross-check the chain */
  txSignature?: string
  /** Arbitrary metadata passed through to Torque analytics */
  metadata?: Record<string, string | number | boolean>
}

const TORQUE_INGEST_URL = process.env.NEXT_PUBLIC_TORQUE_INGEST_URL ?? 'https://ingest.torque.so'
const TORQUE_SERVER_URL = process.env.NEXT_PUBLIC_TORQUE_API_URL ?? 'https://server.torque.so'
const TORQUE_INGEST_KEY = process.env.TORQUE_INGEST_KEY ?? ''
const TORQUE_API_KEY = process.env.TORQUE_API_KEY ?? ''

export const CAMPAIGN_IDS = {
  // Patient campaigns
  ONBOARDING_GIFT:    process.env.NEXT_PUBLIC_TORQUE_CAMPAIGN_ONBOARDING ?? '',
  STREAK_REBATE:      process.env.NEXT_PUBLIC_TORQUE_CAMPAIGN_STREAK ?? '',
  PLAN_RAFFLE:        process.env.NEXT_PUBLIC_TORQUE_CAMPAIGN_RAFFLE ?? '',
  // Caregiver campaigns
  CG_FIRST_CHECKIN:   process.env.NEXT_PUBLIC_TORQUE_CAMPAIGN_CG_FIRST ?? '',
  CG_STREAK_7:        process.env.NEXT_PUBLIC_TORQUE_CAMPAIGN_CG_STREAK7 ?? '',
  CG_RESCUE:          process.env.NEXT_PUBLIC_TORQUE_CAMPAIGN_CG_RESCUE ?? '',
  CG_COMPLETION:      process.env.NEXT_PUBLIC_TORQUE_CAMPAIGN_CG_COMPLETION ?? '',
  // Physio leaderboard
  PHYSIO_LEADERBOARD: process.env.NEXT_PUBLIC_TORQUE_CAMPAIGN_LEADERBOARD ?? '',
} as const

/** Send a custom_event to Torque ingest endpoint. Never blocks main flow. */
export async function emitTorqueEvent(payload: TorqueEventPayload): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      eventName: payload.event,
      userPubkey: payload.userPublicKey,
      timestamp: new Date().toISOString(),
      data: {
        ...(payload.metadata ?? {}),
        tx_signature: payload.txSignature ?? 'none',  // required field in every Torque event schema
      },
    }

    const res = await fetch(`${TORQUE_INGEST_URL}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': TORQUE_INGEST_KEY,
      },
      body: JSON.stringify(body),
    })

    const resText = await res.text()
    if (!res.ok) {
      console.error(`[Torque] ✗ event rejected (${res.status}): ${payload.event} | key_set=${!!TORQUE_INGEST_KEY} | ${resText}`)
    } else {
      console.log(`[Torque] ✓ event accepted: ${payload.event} | user=${payload.userPublicKey.slice(0, 8)}… | ${resText.slice(0, 80)}`)
    }
  } catch (err) {
    console.error(`[Torque] ✗ event delivery failed: ${payload.event} |`, err)
  }
}

/** Enroll a user in a Torque campaign by ID. No-op if campaignId is empty. */
export async function enrollInCampaign(
  campaignId: string,
  userPublicKey: string,
): Promise<void> {
  if (!campaignId) return
  try {
    await fetch(`${TORQUE_SERVER_URL}/campaigns/${campaignId}/enroll`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TORQUE_API_KEY}`,
      },
      body: JSON.stringify({ userPubkey: userPublicKey }),
    })
  } catch (err) {
    console.warn('[Torque] campaign enroll failed (non-fatal):', err)
  }
}

/**
 * Called after submit_attestation tx confirms.
 *
 * Guaranteed payouts (minted directly via /api/payout — caller's responsibility):
 *   session 1    → $0.50 first-rep gift to patient
 *   session 7    → $0.50 streak rebate to patient
 *   last session → $1.00 into raffle pool ATA (monthly draw via /api/admin/raffle/draw)
 *
 * Torque-managed:
 *   physio always → enroll in PHYSIO_LEADERBOARD
 */
export async function onSessionCompleted(opts: {
  patientPublicKey: string
  physioPubkey: string
  sessionNumber: number
  sessionsTotal: number
  exerciseName: string
  confidence: number
  formQuality: string
  txSignature: string
}): Promise<void> {
  const {
    patientPublicKey,
    physioPubkey,
    sessionNumber,
    sessionsTotal,
    exerciseName,
    confidence,
    formQuality,
    txSignature,
  } = opts

  const promises: Promise<void>[] = []

  // Core event — always fires
  promises.push(emitTorqueEvent({
    event: 'physioloop_session_completed',
    userPublicKey: patientPublicKey,
    txSignature,
    metadata: {
      exercise: exerciseName,
      session_number: sessionNumber,
      sessions_total: sessionsTotal,
      confidence,
      form_quality: formQuality,
      physio: physioPubkey,
    },
  }))

  // Session 1 → first-rep gift campaign
  if (sessionNumber === 1) {
    promises.push(enrollInCampaign(CAMPAIGN_IDS.ONBOARDING_GIFT, patientPublicKey))
  }

  // Streak milestones → emit event
  if (sessionNumber === 3 || sessionNumber === 7) {
    promises.push(emitTorqueEvent({
      event: 'physioloop_streak_milestone',
      userPublicKey: patientPublicKey,
      txSignature,
      metadata: { streak_length: sessionNumber, exercise: exerciseName },
    }))
  }

  // Session 7 → streak rebate campaign
  if (sessionNumber === 7) {
    promises.push(enrollInCampaign(CAMPAIGN_IDS.STREAK_REBATE, patientPublicKey))
  }

  // Plan complete → emit event (completion reward minted by event route)
  if (sessionNumber === sessionsTotal) {
    promises.push(emitTorqueEvent({
      event: 'physioloop_plan_completed',
      userPublicKey: patientPublicKey,
      txSignature,
      metadata: { sessions_total: sessionsTotal, physio: physioPubkey },
    }))
  }

  // Physio always enrolled in leaderboard (idempotent)
  promises.push(enrollInCampaign(CAMPAIGN_IDS.PHYSIO_LEADERBOARD, physioPubkey))

  await Promise.allSettled(promises)
}

/** Called after create_treatment_plan + stake_escrow succeed. */
export async function onPlanStarted(opts: {
  physioPubkey: string
  patientPublicKey: string
  exerciseName: string
  sessionsTotal: number
  pusdPerSession: number
  txSignature: string
}): Promise<void> {
  await Promise.allSettled([
    emitTorqueEvent({
      event: 'physioloop_plan_started',
      userPublicKey: opts.physioPubkey,
      txSignature: opts.txSignature,
      metadata: {
        patient: opts.patientPublicKey,
        exercise: opts.exerciseName,
        sessions_total: opts.sessionsTotal,
        pusd_per_session: opts.pusdPerSession,
      },
    }),
    enrollInCampaign(CAMPAIGN_IDS.PHYSIO_LEADERBOARD, opts.physioPubkey),
  ])
}

/** Called after register_physio tx succeeds. */
export async function onPhysioRegistered(physioPubkey: string, txSignature: string): Promise<void> {
  await Promise.allSettled([
    emitTorqueEvent({
      event: 'physioloop_physio_registered',
      userPublicKey: physioPubkey,
      txSignature,
    }),
    enrollInCampaign(CAMPAIGN_IDS.PHYSIO_LEADERBOARD, physioPubkey),
  ])
}

/**
 * Called after submit_caregiver_checkin tx confirms.
 *
 * Guaranteed payouts (minted directly via /api/payout — caller's responsibility):
 *   streak 1 → $0.25 first check-in gift to caregiver
 *   streak 7 → $1.00 7-day streak bonus to caregiver
 *
 * Torque-managed (conditional/situational):
 *   - CG_RESCUE: fires when patientMissedSession flag is true (~50% of plans)
 *   - CG_COMPLETION: fires via onPlanCompleted when caregiver was assigned
 */
export async function onCaregiverCheckin(opts: {
  caregiverPublicKey: string
  patientPublicKey: string
  streakCount: number
  patientMissedSession?: boolean
  txSignature: string
}): Promise<void> {
  const { caregiverPublicKey, patientPublicKey, streakCount, patientMissedSession, txSignature } = opts
  const promises: Promise<void>[] = []

  // Core event
  promises.push(emitTorqueEvent({
    event: 'physioloop_caregiver_checkin',
    userPublicKey: caregiverPublicKey,
    txSignature,
    metadata: {
      patient: patientPublicKey,
      streak_count: streakCount,
      patient_missed_session: patientMissedSession ?? false,
    },
  }))

  // First check-in → gift campaign
  if (streakCount === 1) {
    promises.push(enrollInCampaign(CAMPAIGN_IDS.CG_FIRST_CHECKIN, caregiverPublicKey))
    promises.push(emitTorqueEvent({
      event: 'physioloop_caregiver_milestone',
      userPublicKey: caregiverPublicKey,
      txSignature,
      metadata: { milestone: 'first_checkin', streak_count: 1, patient: patientPublicKey },
    }))
  }

  // 7-day streak → bonus campaign
  if (streakCount === 7) {
    promises.push(enrollInCampaign(CAMPAIGN_IDS.CG_STREAK_7, caregiverPublicKey))
    promises.push(emitTorqueEvent({
      event: 'physioloop_caregiver_milestone',
      userPublicKey: caregiverPublicKey,
      txSignature,
      metadata: { milestone: 'streak_7', streak_count: 7, patient: patientPublicKey },
    }))
  }

  // Rescue bonus — caregiver checked in when patient missed a session
  if (patientMissedSession) {
    promises.push(enrollInCampaign(CAMPAIGN_IDS.CG_RESCUE, caregiverPublicKey))
    promises.push(emitTorqueEvent({
      event: 'physioloop_caregiver_milestone',
      userPublicKey: caregiverPublicKey,
      txSignature,
      metadata: { milestone: 'rescue', streak_count: streakCount, patient: patientPublicKey },
    }))
  }

  await Promise.allSettled(promises)
}

/**
 * Called after complete_plan tx confirms.
 * Handles completion bonus for caregivers + raffle confirmation.
 */
export async function onPlanCompleted(opts: {
  physioPubkey: string
  patientPublicKey: string
  caregiverPublicKey?: string
  sessionsCompleted: number
  txSignature: string
}): Promise<void> {
  const { physioPubkey, patientPublicKey, caregiverPublicKey, sessionsCompleted, txSignature } = opts
  const promises: Promise<void>[] = []

  promises.push(emitTorqueEvent({
    event: 'physioloop_plan_completed',
    userPublicKey: patientPublicKey,
    txSignature,
    metadata: {
      physio: physioPubkey,
      sessions_completed: sessionsCompleted,
      has_caregiver: !!caregiverPublicKey,
    },
  }))

  // Caregiver completion bonus ($2.00, direct mint via event route)
  if (caregiverPublicKey) {
    promises.push(enrollInCampaign(CAMPAIGN_IDS.CG_COMPLETION, caregiverPublicKey))
    promises.push(emitTorqueEvent({
      event: 'physioloop_caregiver_milestone',
      userPublicKey: caregiverPublicKey,
      txSignature,
      metadata: {
        milestone: 'plan_completion',
        patient: patientPublicKey,
        sessions_completed: sessionsCompleted,
      },
    }))
  }

  // Refresh physio leaderboard ranking
  promises.push(emitTorqueEvent({
    event: 'physioloop_plan_completed',
    userPublicKey: physioPubkey,
    txSignature,
    metadata: { role: 'physio', patient: patientPublicKey },
  }))

  await Promise.allSettled(promises)
}

export { CAMPAIGN_IDS as default }
