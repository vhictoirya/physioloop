/**
 * Exercise screen — camera capture + QVAC on-device inference + on-chain proof.
 *
 * Flow:
 *   1. Camera preview runs continuously
 *   2. Patient presses "Verify Rep" → frame saved to temp file
 *   3. Frame path sent to QVAC bare worklet via IPC
 *   4. SmolVLM2-500M analyzes frame locally (no upload)
 *   5. JSON attestation returned (exercise_detected, confidence, form_quality, notes)
 *   6. SHA-256 proof hash computed from attestation + session context
 *   7. submit_attestation tx sent to Solana → PUSD released from escrow → physio
 */

import { useEffect, useRef, useState, useCallback, memo } from 'react'
import {
  View, Text, TouchableOpacity, ActivityIndicator,
  StyleSheet, Alert, ScrollView, Animated, Dimensions,
} from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as FileSystem from 'expo-file-system'
import { router, useLocalSearchParams } from 'expo-router'
import { PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { qvacBridge, type ExerciseAttestation } from '../lib/bare-bridge'
import { generateMultiFrameProofHash } from '../lib/proof'
import { submitAttestation } from '../lib/solana'
import { getOrCreateKeypair, makeWalletAdapter } from '../lib/wallet'
import {
  PUSD_MINT_ADDRESS,
  TOKEN_PROGRAM_ID,
  MIN_CONFIDENCE_THRESHOLD,
  type ExerciseName,
} from '../lib/constants'
import type { Keypair } from '@solana/web3.js'

type Phase =
  | 'idle'         // waiting for patient to press verify
  | 'capturing'    // saving camera frame
  | 'inferring'    // QVAC running on-device
  | 'between'      // countdown to next capture
  | 'submitting'   // Solana tx in flight
  | 'success'      // proof accepted, PUSD released
  | 'rejected'     // QVAC didn't detect the exercise (< 2/3 frames passed)

const TOTAL_FRAMES = 3
const BETWEEN_FRAMES_SECS = 3
const FRAMES_NEEDED = 2   // 2/3 must pass

const SCREEN_WIDTH = Dimensions.get('window').width
// Fixed camera height prevents the view from resizing when bottom panel content changes
const CAMERA_HEIGHT = Math.round(SCREEN_WIDTH * (4 / 3))

// Memoised so phase/state changes in the parent never remount or resize the camera
const StableCamera = memo(function StableCamera({
  cameraRef,
  overlayText,
  sessionLabel,
  inferringPhase,
  countdownText,
  pulseAnim,
}: {
  cameraRef: React.RefObject<CameraView>
  overlayText: string
  sessionLabel: string
  inferringPhase: boolean
  countdownText: string
  pulseAnim: Animated.Value
}) {
  return (
    <View style={{ width: SCREEN_WIDTH, height: CAMERA_HEIGHT }}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        muted
      />
      <View style={s.overlay}>
        <View style={s.exerciseTag}>
          <Text style={s.exerciseTagText}>{overlayText}</Text>
        </View>
        <Text style={s.sessionTag}>{sessionLabel}</Text>
      </View>
      {inferringPhase && (
        <Animated.View style={[s.inferringBanner, { transform: [{ scale: pulseAnim }] }]}>
          {!countdownText.startsWith('Next') && <ActivityIndicator color="#fff" size="small" />}
          <Text style={s.inferringText}>{countdownText}</Text>
        </Animated.View>
      )}
    </View>
  )
})

const FALLBACK_EXERCISE: ExerciseName = 'knee_extension'
const FALLBACK_PHYSIO = '11111111111111111111111111111111'

export default function ExerciseScreen() {
  const params = useLocalSearchParams<{
    sessionNumber?: string
    sessionsTotal?: string
    physio?: string
  }>()

  const sessionNumber = params.sessionNumber ? parseInt(params.sessionNumber, 10) : 1
  const sessionsTotal = params.sessionsTotal ? parseInt(params.sessionsTotal, 10) : 12
  const exerciseName: ExerciseName = FALLBACK_EXERCISE

  const physioPubkey = new PublicKey(params.physio ?? FALLBACK_PHYSIO)
  const physioAta = (() => {
    try {
      return getAssociatedTokenAddressSync(
        new PublicKey(PUSD_MINT_ADDRESS),
        physioPubkey,
        false,
        new PublicKey(TOKEN_PROGRAM_ID),
      )
    } catch {
      return new PublicKey(FALLBACK_PHYSIO)
    }
  })()

  const cameraRef = useRef<CameraView>(null)
  const [permission, requestPermission] = useCameraPermissions()
  const [phase, setPhase] = useState<Phase>('idle')
  const [keypair, setKeypair] = useState<Keypair | null>(null)
  const [frameIndex, setFrameIndex] = useState(0)          // 1-3, shown in UI
  const [countdown, setCountdown] = useState(0)            // between-frame countdown
  const [allAttestations, setAllAttestations] = useState<ExerciseAttestation[]>([])
  const [txSig, setTxSig] = useState<string | null>(null)
  const [totalInferenceMs, setTotalInferenceMs] = useState<number | null>(null)
  const pulseAnim = useRef(new Animated.Value(1)).current

  // Derived from collected attestations
  const framesPassed = allAttestations.filter(a => a.exercise_detected).length
  const avgConfidence = allAttestations.length > 0
    ? allAttestations.reduce((s, a) => s + a.confidence, 0) / allAttestations.length
    : 0
  const bestAttestation = allAttestations.length > 0
    ? allAttestations.reduce((best, a) => a.confidence > best.confidence ? a : best)
    : null

  useEffect(() => { getOrCreateKeypair().then(setKeypair) }, [])

  // Pulse animation while inferring
  useEffect(() => {
    if (phase === 'inferring') {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.05, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ])
      ).start()
    } else {
      pulseAnim.setValue(1)
    }
  }, [phase, pulseAnim])

  const handleVerifyRep = useCallback(async () => {
    if (!cameraRef.current || !keypair || phase !== 'idle') return

    const collected: ExerciseAttestation[] = []
    let cumulativeMs = 0

    try {
      // ── Steps 1–3: 3 captures with QVAC on each ───────────────────────────
      for (let i = 0; i < TOTAL_FRAMES; i++) {
        setFrameIndex(i + 1)

        // Capture
        setPhase('capturing')
        const photo = await cameraRef.current.takePictureAsync({
          quality: 0.6,
          base64: false,
        })
        if (!photo?.uri) throw new Error('Camera capture failed')

        const framePath = `${FileSystem.documentDirectory}physioloop_frame_${i}.jpg`
        await FileSystem.copyAsync({ from: photo.uri, to: framePath })

        // QVAC on-device inference
        setPhase('inferring')
        const t0 = Date.now()
        const { attestation: result } = await qvacBridge.analyzeExerciseAsync(framePath, exerciseName)
        cumulativeMs += Date.now() - t0

        await FileSystem.deleteAsync(framePath, { idempotent: true })

        if (result) {
          collected.push(result)
          setAllAttestations([...collected])
        }

        // Countdown before next frame
        if (i < TOTAL_FRAMES - 1) {
          setPhase('between')
          for (let c = BETWEEN_FRAMES_SECS; c >= 1; c--) {
            setCountdown(c)
            await new Promise<void>(r => setTimeout(r, 1000))
          }
        }
      }

      setTotalInferenceMs(cumulativeMs)

      // ── Step 4: Require FRAMES_NEEDED / TOTAL_FRAMES to pass ──────────────
      const passed = collected.filter(
        a => a.exercise_detected && a.confidence >= MIN_CONFIDENCE_THRESHOLD
      )

      if (passed.length < FRAMES_NEEDED) {
        setPhase('rejected')
        return
      }

      // ── Step 5: Multi-frame proof hash ────────────────────────────────────
      const timestamp = Date.now()
      const avgConf = collected.reduce((s, a) => s + a.confidence, 0) / collected.length
      const bestForm = passed.reduce((b, a) => a.confidence > b.confidence ? a : b).form_quality

      const { proofHash, proofHashHex } = await generateMultiFrameProofHash({
        attestations: collected,
        sessionNumber,
        patientPublicKey: keypair.publicKey.toBase58(),
        exerciseName,
        treatmentPlanPublicKey: keypair.publicKey.toBase58(),
        timestamp,
      })

      console.log('[PhysioLoop] multi-frame proof hash:', proofHashHex)

      // ── Step 6: Submit to Solana ──────────────────────────────────────────
      setPhase('submitting')
      const wallet = makeWalletAdapter(keypair)
      const sig = await submitAttestation({
        wallet,
        patientPublicKey: keypair.publicKey,
        physioPubkey,
        physioAtaPublicKey: physioAta,
        pusdMintPublicKey: new PublicKey(PUSD_MINT_ADDRESS),
        sessionNumber,
        proofHash,
      })

      setTxSig(sig)
      setPhase('success')

      fetch(`${process.env.EXPO_PUBLIC_DASHBOARD_URL ?? 'http://localhost:3000'}/api/torque/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'physioloop_session_completed',
          userPublicKey: keypair.publicKey.toBase58(),
          txSignature: sig,
          metadata: {
            exercise: exerciseName,
            session_number: sessionNumber,
            sessions_total: sessionsTotal,
            confidence: avgConf,
            form_quality: bestForm,
            physio: physioPubkey.toBase58(),
          },
        }),
      }).catch(() => {})

    } catch (err) {
      console.error('[PhysioLoop] exercise verification error:', err)
      Alert.alert('Error', err instanceof Error ? err.message : 'Verification failed')
      setAllAttestations([])
      setFrameIndex(0)
      setPhase('idle')
    }
  }, [keypair, phase, sessionNumber, sessionsTotal, exerciseName, physioPubkey, physioAta])

  // ─── Camera permission ────────────────────────────────────────────────────

  if (!permission) return <View style={s.root} />

  if (!permission.granted) {
    return (
      <View style={[s.root, s.center]}>
        <Text style={s.permText}>Camera access is required to verify exercises locally.</Text>
        <TouchableOpacity style={s.button} onPress={requestPermission}>
          <Text style={s.buttonText}>Grant Camera Access</Text>
        </TouchableOpacity>
      </View>
    )
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const activePhases: Phase[] = ['capturing', 'inferring', 'between', 'submitting']
  const isBusy = activePhases.includes(phase)

  const inferringText =
    phase === 'capturing' ? `Capturing frame ${frameIndex}/${TOTAL_FRAMES}…`
    : phase === 'inferring' ? `AI analyzing frame ${frameIndex}/${TOTAL_FRAMES}…`
    : phase === 'between' ? `Next frame in ${countdown}s — hold position`
    : ''

  return (
    <View style={s.root}>
      {/* Fixed-size camera — never resizes, never remounts, always visible */}
      <StableCamera
        cameraRef={cameraRef}
        overlayText={exerciseName.replace(/_/g, ' ').toUpperCase()}
        sessionLabel={`Session ${sessionNumber} / ${sessionsTotal}`}
        inferringPhase={phase === 'capturing' || phase === 'inferring' || phase === 'between'}
        countdownText={inferringText}
        pulseAnim={pulseAnim}
      />

      {/* Bottom panel */}
      <ScrollView style={s.panel} contentContainerStyle={s.panelContent}>
        {/* Result display — shown as frames accumulate */}
        {allAttestations.length > 0 && phase !== 'idle' && (
          <View style={[s.resultCard, phase === 'rejected' && s.resultRejected]}>
            <Text style={s.resultLabel}>
              QVAC Attestation · {framesPassed}/{allAttestations.length} frames confirmed
            </Text>
            <Text style={s.resultLine}>
              {framesPassed >= FRAMES_NEEDED ? '✅ Exercise confirmed' : '⚠️ Verifying…'}
            </Text>
            {bestAttestation && (
              <Text style={s.resultLine}>
                Form: <Text style={s.resultBold}>{bestAttestation.form_quality}</Text>
                {'  '}Avg confidence: <Text style={s.resultBold}>{(avgConfidence * 100).toFixed(0)}%</Text>
              </Text>
            )}
            {bestAttestation?.notes ? (
              <Text style={s.resultNotes}>"{bestAttestation.notes}"</Text>
            ) : null}
            {totalInferenceMs && (
              <Text style={s.resultMeta}>
                {(totalInferenceMs / 1000).toFixed(1)}s total · {TOTAL_FRAMES} frames · on-device · no upload
              </Text>
            )}
          </View>
        )}

        {/* Success: tx sig */}
        {phase === 'success' && txSig && (
          <View style={s.successCard}>
            <Text style={s.successTitle}>✅ Session Verified On-Chain</Text>
            <Text style={s.successSub}>PUSD released to your physiotherapist</Text>
            <Text style={s.txSig} numberOfLines={1} ellipsizeMode="middle">{txSig}</Text>
          </View>
        )}

        {/* Rejected */}
        {phase === 'rejected' && (
          <View style={s.rejectedCard}>
            <Text style={s.rejectedTitle}>⚠️ Exercise Not Verified</Text>
            <Text style={s.rejectedSub}>
              {`Only ${framesPassed}/${TOTAL_FRAMES} frames confirmed (need ${FRAMES_NEEDED}). Ensure you're clearly visible throughout the rep.`}
            </Text>
          </View>
        )}

        {/* Action button */}
        <TouchableOpacity
          style={[
            s.button,
            isBusy && s.buttonDisabled,
            phase === 'success' && s.buttonSecondary,
            phase === 'rejected' && s.buttonAmber,
          ]}
          onPress={phase === 'success'
            ? () => router.back()
            : phase === 'rejected'
              ? () => { setAllAttestations([]); setFrameIndex(0); setPhase('idle') }
              : handleVerifyRep}
          disabled={isBusy}
          activeOpacity={0.8}
        >
          {isBusy ? (
            <View style={s.buttonRow}>
              {phase !== 'between' && <ActivityIndicator color="#fff" size="small" style={{ marginRight: 8 }} />}
              <Text style={s.buttonText}>
                {phase === 'capturing' ? `Capturing ${frameIndex}/${TOTAL_FRAMES}…`
                  : phase === 'inferring' ? `Analyzing ${frameIndex}/${TOTAL_FRAMES}…`
                  : phase === 'between' ? `Next in ${countdown}s…`
                  : 'Recording on Solana…'}
              </Text>
            </View>
          ) : (
            <Text style={s.buttonText}>
              {phase === 'success' ? 'Done →'
                : phase === 'rejected' ? 'Try Again'
                : 'Verify Rep  (3 frames)'}
            </Text>
          )}
        </TouchableOpacity>

        <Text style={s.footer}>
          SmolVLM2-500M runs on your phone.{'\n'}
          No images leave your device.
        </Text>
      </ScrollView>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { justifyContent: 'center', alignItems: 'center', gap: 16, padding: 24 },
  overlay: {
    position: 'absolute', top: 16, left: 16, right: 16,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  exerciseTag: {
    backgroundColor: 'rgba(22,163,74,0.85)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6,
  },
  exerciseTagText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  sessionTag: { color: '#fff', fontWeight: '600', fontSize: 13, textShadowColor: 'rgba(0,0,0,0.8)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
  inferringBanner: {
    position: 'absolute', bottom: 16, left: 24, right: 24,
    backgroundColor: 'rgba(22,163,74,0.9)', borderRadius: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 10, gap: 8,
  },
  inferringText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  panel: { backgroundColor: '#f9fafb', maxHeight: 340 },
  panelContent: { padding: 16, gap: 12 },
  resultCard: {
    backgroundColor: '#fff', borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: '#e5e7eb', gap: 4,
  },
  resultRejected: { borderColor: '#fcd34d', backgroundColor: '#fffbeb' },
  resultLabel: { fontSize: 10, fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 },
  resultLine: { fontSize: 14, color: '#374151' },
  resultBold: { fontWeight: '700', color: '#111827' },
  resultNotes: { fontSize: 13, color: '#6b7280', fontStyle: 'italic', marginTop: 2 },
  resultMeta: { fontSize: 11, color: '#9ca3af', marginTop: 4 },
  successCard: {
    backgroundColor: '#f0fdf4', borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: '#86efac', gap: 4,
  },
  successTitle: { fontSize: 16, fontWeight: '700', color: '#15803d' },
  successSub: { fontSize: 13, color: '#166534' },
  txSig: { fontSize: 11, fontFamily: 'monospace', color: '#6b7280', marginTop: 2 },
  rejectedCard: {
    backgroundColor: '#fffbeb', borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: '#fcd34d', gap: 4,
  },
  rejectedTitle: { fontSize: 15, fontWeight: '700', color: '#92400e' },
  rejectedSub: { fontSize: 13, color: '#78350f' },
  button: {
    backgroundColor: '#16a34a', borderRadius: 14, paddingVertical: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  buttonDisabled: { backgroundColor: '#86efac' },
  buttonSecondary: { backgroundColor: '#2563eb' },
  buttonAmber: { backgroundColor: '#d97706' },
  buttonRow: { flexDirection: 'row', alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  permText: { fontSize: 16, color: '#374151', textAlign: 'center', lineHeight: 24 },
  footer: { fontSize: 12, color: '#9ca3af', textAlign: 'center', lineHeight: 18 },
})
