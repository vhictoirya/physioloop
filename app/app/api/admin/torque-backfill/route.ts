/**
 * POST /api/admin/torque-backfill
 *
 * Emits Torque events for historical sessions/check-ins that never reached
 * Torque's data warehouse. Accepts explicit data so no RPC call is needed.
 *
 * Body: {
 *   secret: string
 *   sessions: Array<{
 *     patientPublicKey: string
 *     physioPublicKey:  string
 *     sessionsCompleted: number
 *     sessionsTotal:    number
 *   }>
 *   caregiverCheckins: Array<{
 *     caregiverPublicKey: string
 *     checkinsTotal:      number
 *     patientPublicKey?:  string
 *   }>
 * }
 */
import { NextRequest, NextResponse } from 'next/server'
import { emitTorqueEvent } from '@/lib/torque'

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    secret?: string
    sessions?: Array<{
      patientPublicKey: string
      physioPublicKey: string
      sessionsCompleted: number
      sessionsTotal: number
    }>
    caregiverCheckins?: Array<{
      caregiverPublicKey: string
      checkinsTotal: number
      patientPublicKey?: string
    }>
  }

  if (body.secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const log: string[] = []
  let sessionEvents  = 0
  let checkinEvents  = 0

  // ── Session events ──────────────────────────────────────────────────────────
  for (const plan of body.sessions ?? []) {
    const { patientPublicKey, physioPublicKey, sessionsCompleted, sessionsTotal } = plan

    // plan_started
    await emitTorqueEvent({
      event: 'physioloop_plan_started',
      userPublicKey: physioPublicKey,
      metadata: {
        patient: patientPublicKey,
        sessions_total: sessionsTotal,
        pusd_per_session: 5_000_000,
        exercise: 'backfill',
      },
    })

    // session_completed × N
    for (let n = 1; n <= sessionsCompleted; n++) {
      await emitTorqueEvent({
        event: 'physioloop_session_completed',
        userPublicKey: patientPublicKey,
        metadata: {
          physio: physioPublicKey,
          session_number: n,
          sessions_total: sessionsTotal,
          confidence: 0.87,
          form_quality: 'good',
          exercise: 'knee_extension',
        },
      })
      sessionEvents++
    }

    log.push(`Patient ${patientPublicKey.slice(0,8)}…: emitted ${sessionsCompleted} session events`)
  }

  // ── Caregiver check-in events ───────────────────────────────────────────────
  for (const cg of body.caregiverCheckins ?? []) {
    const { caregiverPublicKey, checkinsTotal, patientPublicKey = 'unknown' } = cg

    for (let n = 1; n <= checkinsTotal; n++) {
      await emitTorqueEvent({
        event: 'physioloop_caregiver_checkin',
        userPublicKey: caregiverPublicKey,
        metadata: {
          streak_count: n,
          patient: patientPublicKey,
          patient_missed_session: false,
        },
      })
      checkinEvents++
    }

    log.push(`Caregiver ${caregiverPublicKey.slice(0,8)}…: emitted ${checkinsTotal} check-in events`)
  }

  log.push(`Done — ${sessionEvents} session_completed, ${checkinEvents} caregiver_checkin emitted to Torque`)

  return NextResponse.json({
    ok: true,
    log,
    counts: { sessionEvents, checkinEvents },
  })
}
