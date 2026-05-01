/**
 * PhysioLoop QVAC Demo — runnable on any machine with @qvac/sdk.
 *
 * Demonstrates the exact on-device inference pipeline that runs in the
 * patient mobile app. No cloud API, no key, no upload.
 *
 * Usage:
 *   cd demo && npm install && npx tsx verify-exercise.ts [path/to/exercise.jpg]
 *
 * On first run: SmolVLM2-500M (~500 MB) downloads once and is cached.
 * Subsequent runs use the local cache.
 */

import {
  loadModel,
  completion,
  unloadModel,
  SMOLVLM2_500M_MULTIMODAL_Q8_0,
  MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
} from '@qvac/sdk'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { resolve } from 'path'

// ─── Config ───────────────────────────────────────────────────────────────────

const IMAGE_PATH = process.argv[2]
  ? resolve(process.argv[2])
  : resolve('./sample-exercise.jpg')  // put any exercise photo here

const EXERCISE_NAME = 'knee_extension'
const SESSION_NUMBER = 1
const PATIENT_PUBKEY = 'DemoPatient11111111111111111111111111111111'
const TREATMENT_PLAN = 'DemoPlan1111111111111111111111111111111111'

// ─── Prompt ───────────────────────────────────────────────────────────────────

const PROMPT = `You are a physical therapy compliance AI running entirely on-device.
No image data is sent to any server.

Analyze this image and determine whether the patient is performing: "${EXERCISE_NAME}"

Reply ONLY with this exact JSON object and nothing else:
{
  "exercise_detected": true,
  "rep_visible": true,
  "form_quality": "good",
  "confidence": 0.85,
  "notes": "Patient demonstrates correct knee angle at 90 degrees"
}

Rules:
- exercise_detected: true if the movement is visible, false otherwise
- rep_visible: true if a complete or partial rep is captured
- form_quality: "good" | "fair" | "poor"
- confidence: 0.0–1.0
- notes: one short descriptive sentence`

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('━'.repeat(60))
console.log('  PhysioLoop · QVAC Exercise Verification Demo')
console.log('━'.repeat(60))

if (!existsSync(IMAGE_PATH)) {
  console.error(`\n❌  Image not found: ${IMAGE_PATH}`)
  console.error('   Place any exercise photo at demo/sample-exercise.jpg')
  console.error('   or pass a path: npx tsx verify-exercise.ts /path/to/photo.jpg\n')
  process.exit(1)
}

console.log(`\n📸  Image:    ${IMAGE_PATH}`)
console.log(`🏃  Exercise: ${EXERCISE_NAME}`)
console.log(`🔢  Session:  ${SESSION_NUMBER}`)
console.log('\n⬇️   Loading SmolVLM2-500M (on-device, no cloud)…\n')

let lastPct = -1
const modelId = await loadModel({
  modelSrc: SMOLVLM2_500M_MULTIMODAL_Q8_0,
  modelType: 'llm',
  modelConfig: {
    ctx_size: 2048,
    projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
    device: 'gpu',
    gpu_layers: 99,
    temp: 0.1,
    predict: 256,
  },
  onProgress: (p: { percentage: number }) => {
    const pct = Math.floor(p.percentage)
    if (pct !== lastPct) {
      process.stdout.write(`\r   Downloading: ${pct}%  `)
      lastPct = pct
    }
  },
})

console.log('\n\n✅  Model loaded — running entirely on this machine\n')
console.log('🔍  Analyzing exercise frame…\n')

const t0 = Date.now()
let rawResponse = ''

const result = completion({
  modelId,
  history: [
    {
      role: 'user',
      content: PROMPT,
      attachments: [{ path: IMAGE_PATH }],
    },
  ],
  stream: true,
})

for await (const token of result.tokenStream) {
  process.stdout.write(token)
  rawResponse += token
}

const inferenceMs = Date.now() - t0

// ─── Parse attestation ────────────────────────────────────────────────────────

const jsonMatch = rawResponse.match(/\{[\s\S]*?\}/)
if (!jsonMatch) {
  console.error('\n\n❌  Model did not return valid JSON')
  await unloadModel({ modelId, clearStorage: false })
  process.exit(1)
}

let attestation: {
  exercise_detected: boolean
  rep_visible: boolean
  form_quality: string
  confidence: number
  notes: string
}

try {
  attestation = JSON.parse(jsonMatch[0])
} catch {
  console.error('\n\n❌  Failed to parse model JSON output')
  await unloadModel({ modelId, clearStorage: false })
  process.exit(1)
}

// ─── Multi-frame proof hash (same format as the mobile app) ──────────────────
// The mobile app captures 3 live frames during the rep and requires 2/3 to pass.
// This demo uses 1 frame; the proof JSON structure is identical.

const timestamp = Date.now()

const attestationPayload = {
  attestations: [
    {
      confidence: attestation.confidence,
      exercise_detected: attestation.exercise_detected,
      form_quality: attestation.form_quality,
      frame: 1,
      notes: attestation.notes,
      rep_visible: attestation.rep_visible,
    },
  ],
  avg_confidence: attestation.confidence,
  exercise: EXERCISE_NAME,
  frames_passed: attestation.exercise_detected ? 1 : 0,
  frames_total: 1,
  model: 'SmolVLM2-500M-MultiModal-Q8_0',
  patient_pubkey: PATIENT_PUBKEY,
  session_number: SESSION_NUMBER,
  timestamp,
  treatment_plan: TREATMENT_PLAN,
}

const attestationJson = JSON.stringify(attestationPayload)
const proofHashHex = createHash('sha256').update(attestationJson).digest('hex')

// Convert to [u8; 32] for Anchor instruction
const proofHashBytes = Buffer.from(proofHashHex, 'hex')

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n\n' + '━'.repeat(60))
console.log('  RESULTS')
console.log('━'.repeat(60))

console.log(`\n  Exercise detected:  ${attestation.exercise_detected ? '✅ Yes' : '❌ No'}`)
console.log(`  Rep visible:        ${attestation.rep_visible ? 'Yes' : 'No'}`)
console.log(`  Form quality:       ${attestation.form_quality.toUpperCase()}`)
console.log(`  Confidence:         ${(attestation.confidence * 100).toFixed(1)}%`)
console.log(`  Notes:              "${attestation.notes}"`)
console.log(`\n  Inference time:     ${(inferenceMs / 1000).toFixed(1)}s  (on-device, no upload)`)
console.log(`\n  ℹ️   Mobile app captures 3 live frames per rep — requires 2/3 to confirm.`)

console.log('\n' + '━'.repeat(60))
console.log('  PROOF HASH (submitted to Anchor program)')
console.log('━'.repeat(60))
console.log(`\n  ${proofHashHex}`)
console.log(`\n  [u8; 32]: [${Array.from(proofHashBytes).join(', ')}]`)

if (attestation.exercise_detected && attestation.confidence >= 0.6) {
  console.log('\n  ✅  Proof valid — ready for submit_attestation instruction')
  console.log('      → PUSD released from escrow to physiotherapist')
} else {
  console.log('\n  ⚠️   Exercise not verified — no payment released')
  console.log('      Patient must retry with better form or camera angle')
}

console.log('\n' + '━'.repeat(60))
console.log('  ATTESTATION JSON (stored off-chain, hash on-chain)')
console.log('━'.repeat(60))
console.log('\n' + JSON.stringify(attestationPayload, null, 2))

await unloadModel({ modelId, clearStorage: false })
