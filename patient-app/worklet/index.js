/**
 * PhysioLoop QVAC Worklet — Bare runtime
 *
 * Runs entirely on-device. No data leaves the patient's phone.
 * Bundle for mobile: npm run bundle  (uses bare-pack)
 *
 * Models used:
 *   Vision: SmolVLM2-500M-MultiModal-Q8_0 (~500 MB)  — exercise form analysis
 *   TTS:    loaded on-demand from @qvac/sdk            — audio coaching
 */

import IPC from 'bare-ipc'
import b4a from 'b4a'
import {
  loadModel,
  completion,
  unloadModel,
  SMOLVLM2_500M_MULTIMODAL_Q8_0,
  MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
} from '@qvac/sdk'

// ─── State ────────────────────────────────────────────────────────────────────

let visionModelId = null

// ─── IPC helpers ─────────────────────────────────────────────────────────────

function send(msg) {
  IPC.write(b4a.from(JSON.stringify(msg)))
}

// ─── Boot: load vision model ──────────────────────────────────────────────────

async function init() {
  try {
    send({ type: 'status', phase: 'loading_vision', percentage: 0 })

    visionModelId = await loadModel({
      modelSrc: SMOLVLM2_500M_MULTIMODAL_Q8_0,
      modelType: 'llm',
      modelConfig: {
        ctx_size: 2048,
        projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
        device: 'gpu',         // Metal on iOS, Vulkan on Android
        gpu_layers: 99,        // offload all layers to GPU
        temp: 0.1,             // low temperature for deterministic JSON output
        predict: 256,          // proof JSON is short
      },
      onProgress: (p) =>
        send({ type: 'status', phase: 'loading_vision', percentage: p.percentage }),
    })

    send({ type: 'ready', model: 'SmolVLM2-500M-MultiModal-Q8_0' })
  } catch (err) {
    send({ type: 'error', message: String(err.message || err) })
  }
}

// ─── Exercise verification prompt ────────────────────────────────────────────

function buildPrompt(exerciseName) {
  return `You are a physical therapy compliance AI running entirely on the patient's device.
No image or personal data is uploaded to any server.

Analyze this image and determine whether the patient is performing: "${exerciseName}"

Reply ONLY with this exact JSON object and nothing else:
{
  "exercise_detected": true,
  "rep_visible": true,
  "form_quality": "good",
  "confidence": 0.85,
  "notes": "Patient demonstrates correct knee angle at 90 degrees"
}

Rules:
- exercise_detected: true if the exercise movement is visible, false otherwise
- rep_visible: true if a complete rep or partial rep is captured
- form_quality: "good" | "fair" | "poor"
- confidence: 0.0–1.0, your certainty
- notes: one short sentence describing what you observe`
}

// ─── Incoming messages ────────────────────────────────────────────────────────

IPC.on('data', async (data) => {
  let msg
  try {
    msg = JSON.parse(b4a.toString(data))
  } catch {
    send({ type: 'error', message: 'Malformed IPC message' })
    return
  }

  switch (msg.type) {
    // ── Vision: analyze a captured frame ───────────────────────────────────
    case 'analyze_exercise': {
      if (!visionModelId) {
        send({ type: 'error', message: 'Vision model not loaded yet' })
        return
      }

      const { imagePath, exerciseName } = msg

      try {
        send({ type: 'status', phase: 'inferring' })

        let rawResponse = ''
        const result = completion({
          modelId: visionModelId,
          history: [
            {
              role: 'user',
              content: buildPrompt(exerciseName),
              attachments: [{ path: imagePath }],
            },
          ],
          stream: true,
        })

        for await (const token of result.tokenStream) {
          rawResponse += token
        }

        // Extract JSON from model output (model may prepend/append prose)
        const jsonMatch = rawResponse.match(/\{[\s\S]*?\}/)
        let attestation = null
        if (jsonMatch) {
          try {
            attestation = JSON.parse(jsonMatch[0])
          } catch {
            // JSON parse failed — treat as not detected
          }
        }

        send({
          type: 'analysis_result',
          attestation,
          rawResponse,
          model: 'SmolVLM2-500M-MultiModal-Q8_0',
        })
      } catch (err) {
        send({ type: 'error', message: String(err.message || err) })
      }
      break
    }

    // ── Cleanup ─────────────────────────────────────────────────────────────
    case 'unload': {
      if (visionModelId) {
        await unloadModel({ modelId: visionModelId, clearStorage: false })
        visionModelId = null
      }
      send({ type: 'unloaded' })
      break
    }

    default:
      send({ type: 'error', message: `Unknown message type: ${msg.type}` })
  }
})

// Start loading models immediately on worklet boot
init()
