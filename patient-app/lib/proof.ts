/**
 * Proof hash generation.
 *
 * Deterministically hashes the QVAC attestation + session context → 32-byte array
 * submitted to the submit_attestation Anchor instruction.
 *
 * Anyone with the attestation JSON can independently verify the hash, making
 * the proof off-chain auditable even though on-chain storage is just 32 bytes.
 */

import * as Crypto from 'expo-crypto'
import type { ExerciseAttestation } from './bare-bridge'

export interface ProofInput {
  attestation: ExerciseAttestation
  sessionNumber: number
  patientPublicKey: string
  exerciseName: string
  treatmentPlanPublicKey: string
  timestamp: number
}

export interface ProofResult {
  proofHash: number[]   // [u8; 32] — ready for the Anchor instruction
  attestationJson: string
  proofHashHex: string
}

/** Build the canonical attestation JSON that gets hashed. */
export function buildAttestationJson(input: ProofInput): string {
  // Keys are sorted to ensure deterministic serialization
  const payload = {
    confidence: input.attestation.confidence,
    exercise: input.exerciseName,
    exercise_detected: input.attestation.exercise_detected,
    form_quality: input.attestation.form_quality,
    model: 'SmolVLM2-500M-MultiModal-Q8_0',
    notes: input.attestation.notes,
    patient_pubkey: input.patientPublicKey,
    rep_visible: input.attestation.rep_visible,
    session_number: input.sessionNumber,
    timestamp: input.timestamp,
    treatment_plan: input.treatmentPlanPublicKey,
  }
  return JSON.stringify(payload)
}

/** Generate the 32-byte proof hash from a QVAC attestation. */
export async function generateProofHash(input: ProofInput): Promise<ProofResult> {
  const attestationJson = buildAttestationJson(input)

  const proofHashHex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    attestationJson,
    { encoding: Crypto.CryptoEncoding.HEX }
  )

  const proofHash: number[] = []
  for (let i = 0; i < 32; i++) {
    proofHash.push(parseInt(proofHashHex.slice(i * 2, i * 2 + 2), 16))
  }

  return { proofHash, attestationJson, proofHashHex }
}

// ─── Multi-frame proof (3 captures per rep) ───────────────────────────────────

export interface MultiFrameProofInput {
  attestations: ExerciseAttestation[]
  sessionNumber: number
  patientPublicKey: string
  exerciseName: string
  treatmentPlanPublicKey: string
  timestamp: number
}

/** Canonical JSON for 3-frame attestation — keys sorted for deterministic hashing. */
export function buildMultiFrameAttestationJson(input: MultiFrameProofInput): string {
  const payload = {
    attestations: input.attestations.map((a, i) => ({
      confidence: a.confidence,
      exercise_detected: a.exercise_detected,
      form_quality: a.form_quality,
      frame: i + 1,
      notes: a.notes,
      rep_visible: a.rep_visible,
    })),
    avg_confidence: input.attestations.reduce((s, a) => s + a.confidence, 0) / input.attestations.length,
    exercise: input.exerciseName,
    frames_passed: input.attestations.filter(a => a.exercise_detected).length,
    frames_total: input.attestations.length,
    model: 'SmolVLM2-500M-MultiModal-Q8_0',
    patient_pubkey: input.patientPublicKey,
    session_number: input.sessionNumber,
    timestamp: input.timestamp,
    treatment_plan: input.treatmentPlanPublicKey,
  }
  return JSON.stringify(payload)
}

/** Generate the 32-byte proof hash from 3 QVAC frames. */
export async function generateMultiFrameProofHash(input: MultiFrameProofInput): Promise<ProofResult> {
  const attestationJson = buildMultiFrameAttestationJson(input)

  const proofHashHex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    attestationJson,
    { encoding: Crypto.CryptoEncoding.HEX }
  )

  const proofHash: number[] = []
  for (let i = 0; i < 32; i++) {
    proofHash.push(parseInt(proofHashHex.slice(i * 2, i * 2 + 2), 16))
  }

  return { proofHash, attestationJson, proofHashHex }
}
