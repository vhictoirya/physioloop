# PhysioLoop

**Verifiable physiotherapy adherence on Solana.**

🌐 **Live demo:** [physioloop.vercel.app](https://physioloop.vercel.app)

Physioloop is an exercise compliance app, wherevy patients complete their prescribed exercises. A vision model running entirely on their phone confirms each exercises. A proof hash lands on-chain. The physiotherapist gets paid per session — automatically, in PUSD — with no paper forms, no trust required, and no exercise footage ever leaving the patient's device, also the caregiver also get rewarded as well as having a certification.

---

## The problem

65% of physiotherapy patients do not complete their home exercise programs. Physios have no way to verify adherence between clinic visits. Patients have no incentive to keep going. Caregivers — family members or support workers — have no coordination layer or reward for helping.

PhysioLoop puts verifiable proof of exercise on-chain and uses it to trigger automatic PUSD payments, streaks, and caregiver rewards.

---

## Prize tracks

| Track | Integration | Status |
|---|---|---|
| **Tether QVAC** ($10k) | SmolVLM2-500M runs on-device via `@qvac/sdk` + `react-native-bare-kit`. Zero cloud. Proof hash of 3-frame attestation submitted to Anchor program. | Live on devnet |
| **PalmUSD** | Treasury-transfer architecture (no minting). All rewards paid from a pre-funded treasury ATA using `createTransferInstruction`. Mainnet-ready: swap mint address + deposit real PUSD. | Live on devnet |
| **Torque** | 8 recurring incentive campaigns across all three user roles. Custom events emitted after every on-chain action. Physio leaderboard ranked by compliance rate. | Campaigns live |

---

## Architecture

```
Patient phone (React Native + Expo)
  └─ QVAC worklet (Bare JS, isolated runtime)
       └─ SmolVLM2-500M [on-device, Metal/Vulkan GPU]
            └─ Exercise attestation JSON
                 └─ SHA-256 proof hash
                      └─ submit_attestation (Anchor CPI)
                           └─ Escrow → Physio ATA  (70% PUSD)
                           └─ Escrow → Ops ATA     (15% PUSD)
                           └─ Escrow → Campaign ATA (10% PUSD)
                           └─ Escrow → Caregiver reserve (5% PUSD)

Physio dashboard (Next.js)
  └─ register_physio → on-chain PhysioProfile PDA
  └─ create_treatment_plan → TreatmentPlan PDA + escrow vault
  └─ stake_escrow → patient locks PUSD
  └─ complete_plan → returns stake, updates credibility score

Torque
  └─ 8 campaigns (patient + caregiver + physio)
  └─ Custom events after every verifiable action
  └─ Physio leaderboard by compliance rate

PalmUSD treasury
  └─ Treasury funded once (10,000 PUSD on devnet)
  └─ /api/payout → transfer from treasury (no mint)
  └─ /api/admin/fund-treasury → devnet-only seeding
```

---

## On-chain program

**Program ID:** `3vArMkTYa2J95xVYsgdsnDu2pokBjRQGj7ZFUdeDutQi`  
**Cluster:** Solana devnet  
**Framework:** Anchor 0.30  
**Token standard:** Token-2022 (required for PalmUSD)

### Accounts

| Account | PDA seeds | Purpose |
|---|---|---|
| `PhysioProfile` | `["physio", physio_pubkey]` | On-chain credibility score, patient counters |
| `TreatmentPlan` | `["plan", physio_pubkey, patient_pubkey]` | HEP details, escrow balance, session progress |
| `SessionAttestation` | `["attestation", plan_pubkey, session_number]` | QVAC proof hash, timestamp, verified flag |
| `CaregiverProfile` | `["caregiver", caregiver_pubkey]` | Streak, total check-ins, PUSD earned |

### Instructions

| Instruction | Who calls | What it does |
|---|---|---|
| `register_physio` | Physio | Creates PhysioProfile, sets subscription tier |
| `register_caregiver` | Caregiver | Creates CaregiverProfile |
| `create_treatment_plan` | Physio | Initialises TreatmentPlan PDA + escrow vault ATA |
| `stake_escrow` | Patient | Transfers `sessions × pusd_per_session` PUSD into escrow, activates plan |
| `submit_attestation` | Patient | Verifies QVAC proof hash; splits session revenue 70/15/10/5 via PDA-signed CPIs |
| `submit_caregiver_checkin` | Caregiver | Streaks check-in, releases 5% caregiver share from escrow |
| `complete_plan` | Patient | Returns unused escrow, updates physio credibility score, emits completion event |
| `update_credibility_score` | Admin | Manual credibility adjustment (dispute resolution) |

### Revenue split (per session)

```
Patient escrow  ──►  70%  Physiotherapist ATA     (auto-released per session)
                     15%  Ops treasury ATA
                     10%  Torque campaign pool ATA
                      5%  Caregiver reserve         (released via check-in)
```

---

## QVAC integration

PhysioLoop uses **QVAC** (on-device AI attestation) from Tether as the proof-of-exercise layer.

### How it works

1. Patient presses "Verify Rep" in the React Native app
2. `expo-camera` captures **3 frames** with a 3-second countdown between each
3. Each frame is copied to `documentDirectory` and sent over IPC to a **Bare JS worklet**
4. The worklet loads **SmolVLM2-500M-MultiModal-Q8_0** (~500 MB) via `@qvac/sdk`
5. The model runs entirely on-device (Metal on iOS, Vulkan on Android) — no image upload
6. Each frame returns a JSON attestation: `{ exercise_detected, rep_visible, form_quality, confidence, notes }`
7. **2 of 3 frames must pass** (confidence ≥ 0.6, exercise_detected = true) — prevents single-frame gaming
8. A SHA-256 proof hash is computed from the full multi-frame attestation JSON
9. The proof hash is submitted to the Anchor program in `submit_attestation`

### Multi-frame proof structure

```json
{
  "attestations": [
    { "frame": 1, "exercise_detected": true, "confidence": 0.87, "form_quality": "good", ... },
    { "frame": 2, "exercise_detected": true, "confidence": 0.79, "form_quality": "good", ... },
    { "frame": 3, "exercise_detected": false, "confidence": 0.41, "form_quality": "poor", ... }
  ],
  "avg_confidence": 0.69,
  "exercise": "knee_extension",
  "frames_passed": 2,
  "frames_total": 3,
  "model": "SmolVLM2-500M-MultiModal-Q8_0",
  "patient_pubkey": "...",
  "session_number": 1,
  "timestamp": 1714000000000,
  "treatment_plan": "..."
}
```

The 32-byte SHA-256 of this JSON is what goes on-chain. The physio or any auditor can request the full JSON from the patient to verify any session independently.

### Standalone demo (no phone needed)

```bash
cd patient-app/demo
npm install
# place any exercise photo at demo/sample-exercise.jpg (or pass a path)
npx tsx verify-exercise.ts
npx tsx verify-exercise.ts /path/to/photo.jpg
```

SmolVLM2-500M downloads once (~500 MB) and is cached locally. Subsequent runs are instant.

---

## PalmUSD integration

PhysioLoop uses **PalmUSD (PUSD)** — a non-freezable, USD-pegged stablecoin — as its reward token.

### Key design decisions

**No minting.** PalmUSD's mint authority is held exclusively by the PalmUSD team. All PhysioLoop rewards come from a pre-funded treasury ATA. On devnet we use a custom Token-2022 PUSD mint for testing; on mainnet, the PalmUSD team deposits real PUSD into the treasury and we swap the mint address.

**Token-2022.** PalmUSD is a Token-2022 token. `TOKEN_2022_PROGRAM_ID` is used for all ATAs, transfers, and CPI calls throughout the Anchor program and Next.js API routes.

**No freeze authority.** The on-chain program validates `freeze_authority.is_none()` on the PUSD mint before creating escrow accounts.

### Live addresses (devnet)

| Address | Role |
|---|---|
| `D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s` | Devnet test PUSD mint (Token-2022) |
| `CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s` | Mainnet PalmUSD mint |
| `DX3B8ry4m7vBjjfmc9piUimAsnmpucBrJRC97Apgy4wJ` | Platform treasury wallet |
| `8kkTjifHdzYbhxkdTXSRWjeApN1cv2gR2YyrEHjMd4zk` | Treasury ATA (holds 10,000 PUSD) |

### Payout API

```
POST /api/payout
{
  "recipientPublicKey": "...",
  "amountUsd": 0.50,
  "reason": "patient_first_rep_gift"
}
```

Protected by server-side keypairs. Max single payout: $10 PUSD (configurable guard).

---

## Torque integration

PhysioLoop uses **Torque** for on-chain incentive campaigns and analytics.

### Campaigns

| Campaign | Trigger | Reward | Recipient |
|---|---|---|---|
| Onboarding Gift | Session 1 complete | $0.50 PUSD | Patient |
| 7-Session Streak | Sessions 1–7 consecutive | $0.50 PUSD | Patient |
| Plan Raffle | Plan fully completed | $1.00 into raffle pool | Patient |
| Caregiver First Check-in | First daily check-in | $0.25 PUSD | Caregiver |
| Caregiver 7-Day Streak | 7 consecutive check-ins | $1.00 PUSD | Caregiver |
| Rescue Bonus | Check-in after patient missed session | $0.50 PUSD | Caregiver |
| Plan Completion Bonus | Caregiver assigned to completed plan | $2.00 PUSD | Caregiver |
| Physio Leaderboard | Weekly, ranked by compliance rate | $25/$12/$5 PUSD | Top 3 physios |

### Custom events

Six `physioloop_*` events are emitted to Torque ingest after every verified on-chain action:

```
physioloop_session_completed   → every submit_attestation
physioloop_plan_started        → create_treatment_plan + stake_escrow
physioloop_plan_completed      → complete_plan
physioloop_streak_milestone    → session 3 or 7
physioloop_caregiver_checkin   → submit_caregiver_checkin
physioloop_physio_registered   → register_physio
```

Events include `txSignature` so Torque can cross-reference the on-chain record.

---

## Running locally

### Prerequisites

- Node.js 20+
- Anchor CLI 0.30 + Solana CLI 1.18
- Rust (for program builds)
- Expo CLI (for patient app)

### 1. Physio dashboard (Next.js)

```bash
cd app
cp .env.local.example .env.local   # fill in keypair env vars
npm install
npm run dev
```

Open `http://localhost:3000`. Connect a Phantom wallet on devnet.

### 2. Fund the treasury (one-time devnet setup)

With the dashboard running:

```bash
curl --ipv4 -X POST http://localhost:3000/api/admin/fund-treasury \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: <ADMIN_SECRET>" \
  -d '{"amountUsd": 10000}'
```

### 3. Patient app

```bash
cd patient-app

# Build the QVAC worklet (required once — produces assets/qvac-worker.bundle)
cd worklet && npm install && npm run bundle && cd ..

npm install

# Android (physical device required — QVAC native modules don't run in emulators)
npx expo run:android --device

# iOS
npx expo run:ios --device
```

### 4. Anchor program (devnet already deployed)

```bash
anchor build
anchor deploy --provider.cluster devnet
```

The program at `3vArMkTYa2J95xVYsgdsnDu2pokBjRQGj7ZFUdeDutQi` is already live. Rebuild and redeploy only if you change `programs/physioloop/src/lib.rs`.

---

## Repository structure

```
physioloop/
├── programs/physioloop/src/lib.rs   Anchor program (8 instructions, 4 PDAs)
├── tests/physioloop.ts              Anchor integration tests
├── app/                             Next.js physio dashboard
│   ├── app/api/                     API routes (payout, register, torque, admin)
│   ├── components/                  Dashboard UI (CreatePlanModal, PatientTable, ...)
│   └── lib/                         torque.ts, anchor.ts, constants.ts
├── patient-app/                     Expo React Native patient app
│   ├── app/exercise.tsx             Camera + 3-frame QVAC + proof submission
│   ├── lib/bare-bridge.ts           React Native ↔ bare worklet IPC
│   ├── lib/proof.ts                 Multi-frame attestation + SHA-256 hash
│   ├── worklet/index.js             Bare JS: @qvac/sdk loadModel + completion + IPC
│   └── demo/verify-exercise.ts      Standalone QVAC demo (no phone)
└── scripts/                         Fund treasury, create incentives
```

---

## Key addresses (devnet)

| Resource | Address |
|---|---|
| Anchor program | `3vArMkTYa2J95xVYsgdsnDu2pokBjRQGj7ZFUdeDutQi` |
| Devnet PUSD mint | `D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s` |
| Mainnet PalmUSD mint | `CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s` |
| Treasury wallet | `DX3B8ry4m7vBjjfmc9piUimAsnmpucBrJRC97Apgy4wJ` |
| Treasury ATA | `8kkTjifHdzYbhxkdTXSRWjeApN1cv2gR2YyrEHjMd4zk` |
| Mint authority | `Cyd8wW8PJJHSGLfZh8LuF5nC7Y2a6F5Xe9waPjHfSU7n` |

---

## Colosseum Frontier submission

PhysioLoop was built for the **Colosseum Frontier hackathon** (May 2026).

**Track:** Consumer / DeSci / Healthcare  
**Side tracks:** Tether QVAC ($10k), PalmUSD, Torque

The core thesis: on-device AI attestation is the missing link between prescribing physiotherapy and verifying it was done. A proof hash submitted on-chain is cheaper, more private, and more auditable than any paper-based or cloud-based alternative. PUSD makes payments instant and programmable. Torque makes patient and caregiver incentives self-sustaining without a central reward budget.
