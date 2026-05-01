/**
 * React Native ↔ Bare worklet bridge.
 *
 * The QVAC worklet runs in an isolated Bare JS environment via react-native-bare-kit.
 * This module owns the Worklet lifecycle and exposes a typed async API to the RN layer.
 *
 * Setup: run `npm run build:worklet` in patient-app root to produce
 *        assets/qvac-worker.bundle, then rebuild the Expo dev build.
 */

import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'

// Loaded as a static asset via Metro — the bundle is produced by bare-pack
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WORKLET_BUNDLE: string = require('../assets/qvac-worker.bundle')

export interface ExerciseAttestation {
  exercise_detected: boolean
  rep_visible: boolean
  form_quality: 'good' | 'fair' | 'poor'
  confidence: number
  notes: string
}

type WorkletMessage =
  | { type: 'status'; phase: string; percentage?: number }
  | { type: 'ready'; model: string }
  | { type: 'analysis_result'; attestation: ExerciseAttestation | null; rawResponse: string; model: string }
  | { type: 'error'; message: string }
  | { type: 'unloaded' }

type MessageListener = (msg: WorkletMessage) => void

class QvacBridgeClass {
  private worklet: InstanceType<typeof Worklet> | null = null
  private listeners = new Set<MessageListener>()
  private _ready = false
  private _readyPromise: Promise<void>
  private _readyResolve!: () => void

  constructor() {
    this._readyPromise = new Promise((res) => { this._readyResolve = res })
  }

  /** Boot the bare worklet. Call once, early in app lifecycle. */
  start() {
    if (this.worklet) return
    this.worklet = new Worklet()
    this.worklet.IPC.on('data', (raw: Uint8Array) => {
      const msg: WorkletMessage = JSON.parse(b4a.toString(raw))
      if (msg.type === 'ready') {
        this._ready = true
        this._readyResolve()
      }
      this.listeners.forEach((cb) => cb(msg))
    })
    this.worklet.start('/qvac-worker.bundle', WORKLET_BUNDLE)
  }

  /** Subscribe to all worklet messages. Returns unsubscribe fn. */
  onMessage(cb: MessageListener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Wait until the vision model is fully loaded. */
  waitUntilReady(): Promise<void> {
    return this._readyPromise
  }

  get isReady() { return this._ready }

  /**
   * Send an image file path to QVAC for exercise verification.
   * imagePath must be an absolute path accessible to the Bare runtime
   * (use expo-file-system to copy camera output to documentDirectory first).
   */
  analyzeExercise(imagePath: string, exerciseName: string): void {
    this.send({ type: 'analyze_exercise', imagePath, exerciseName })
  }

  /** One-shot helper: analyze and await the result. */
  analyzeExerciseAsync(
    imagePath: string,
    exerciseName: string
  ): Promise<{ attestation: ExerciseAttestation | null; rawResponse: string }> {
    return new Promise((resolve, reject) => {
      const unsub = this.onMessage((msg) => {
        if (msg.type === 'analysis_result') {
          unsub()
          resolve({ attestation: msg.attestation, rawResponse: msg.rawResponse })
        } else if (msg.type === 'error') {
          unsub()
          reject(new Error(msg.message))
        }
      })
      this.analyzeExercise(imagePath, exerciseName)
    })
  }

  unload() {
    this.send({ type: 'unload' })
    this.worklet = null
    this._ready = false
  }

  private send(msg: object) {
    if (!this.worklet) throw new Error('Worklet not started')
    this.worklet.IPC.write(b4a.from(JSON.stringify(msg)))
  }
}

export const qvacBridge = new QvacBridgeClass()
