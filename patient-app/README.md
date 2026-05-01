# PhysioLoop — Patient App

React Native (Expo) patient-facing app. Core feature: **on-device exercise verification via QVAC** — no exercise video or image ever leaves the patient's phone.

---

## How QVAC is integrated

```
Patient presses "Verify Rep"
  │
  ▼
expo-camera captures a single frame
  │
  ▼  (file path over IPC)
react-native-bare-kit worklet  ←── SmolVLM2-500M loaded here, stays in memory
  │
  ▼  (local GPU inference, ~5–15s on modern phones)
JSON attestation:
  { exercise_detected, rep_visible, form_quality, confidence, notes }
  │
  ▼  (no network, no API key)
SHA-256 proof hash of (attestation + session context)
  │
  ▼  (Solana tx)
submit_attestation instruction → escrow releases PUSD to physiotherapist
```

**Models used:**
| Module | Model | Size | Purpose |
|--------|-------|------|---------|
| `@qvac/sdk` (llm-llamacpp) | SmolVLM2-500M-MultiModal-Q8_0 | ~500 MB | Exercise form analysis from camera frame |
| `@qvac/sdk` (llm-llamacpp) | MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0 | ~100 MB | Projection model for vision input |

Both models run on the patient's device via Metal (iOS) or Vulkan (Android). No GPU cloud is used.

---

## Quick demo (no phone needed)

```bash
cd demo
npm install
# Place any exercise photo at demo/sample-exercise.jpg
npx tsx verify-exercise.ts
# Or pass your own image:
npx tsx verify-exercise.ts /path/to/exercise-photo.jpg
```

This runs the full QVAC pipeline locally and outputs:
- The model's JSON attestation
- The 32-byte proof hash that would be submitted on-chain
- Inference time (purely on-device)

---

## Mobile setup

### Prerequisites
- Node.js 20+
- Expo CLI: `npm install -g expo`
- Android Studio (for Android) or Xcode 15+ (for iOS)
- A physical device (QVAC native modules don't run in emulators)

### 1. Install patient app dependencies
```bash
npm install
```

### 2. Build the QVAC bare worklet
```bash
cd worklet
npm install
npm run bundle          # produces ../assets/qvac-worker.bundle
cd ..
```

### 3. Create a development build
```bash
# Android
npx expo run:android --device

# iOS
npx expo run:ios --device
```

> **Why not Expo Go?** QVAC uses native C++ modules via `react-native-bare-kit`.
> These require a custom dev build. Expo Go only runs pure JS apps.

### 4. First launch
On first launch the app downloads SmolVLM2-500M (~600 MB total with projection model).
This is cached in the app's local storage — subsequent launches load from cache instantly.

---

## Proof hash design

The proof hash is a SHA-256 digest of a deterministic JSON payload:

```json
{
  "confidence": 0.85,
  "exercise": "knee_extension",
  "exercise_detected": true,
  "form_quality": "good",
  "model": "SmolVLM2-500M-MultiModal-Q8_0",
  "notes": "Patient demonstrates correct knee angle",
  "patient_pubkey": "...",
  "rep_visible": true,
  "session_number": 1,
  "timestamp": 1714000000000,
  "treatment_plan": "..."
}
```

The on-chain `SessionAttestation` account stores only the 32-byte hash. Anyone holding the JSON can verify it independently. The physio or a third-party auditor can request the attestation JSON from the patient to verify any session.

---

## Why this can't be done with cloud AI

- Patients will not consent to uploading exercise videos to a server — clinical & GDPR risk
- Network latency during exercise breaks the real-time feedback loop  
- Cloud inference requires API keys → subscription cost on every session → UX friction
- QVAC runs offline: useful in low-connectivity settings (rural clinics, hospital wards)
- The privacy guarantee ("your exercise data never leaves your phone") is a core product promise that only on-device AI can make truthfully

---

## File structure

```
patient-app/
├── app/
│   ├── _layout.tsx       starts qvacBridge worklet on app boot
│   ├── index.tsx         home screen (plan overview + model status)
│   └── exercise.tsx      camera + QVAC + on-chain proof submission
├── lib/
│   ├── bare-bridge.ts    React Native ↔ bare worklet IPC bridge
│   ├── proof.ts          SHA-256 proof hash generation (expo-crypto)
│   ├── solana.ts         Anchor program client + submit_attestation
│   ├── wallet.ts         keypair management (expo-secure-store)
│   └── constants.ts      program ID, mint, RPC endpoint
├── worklet/
│   ├── package.json      QVAC SDK dependency
│   └── index.js          bare runtime: loadModel + completion + IPC
└── demo/
    └── verify-exercise.ts  runnable Node.js proof-of-concept (no phone needed)
```
