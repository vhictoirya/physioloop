# PhysioLoop × Torque — Friction Log

Required submission artifact. Honest notes on what broke, what was confusing, and improvement suggestions.

---

## What we integrated

PhysioLoop emits five `custom_events` to Torque after every on-chain action:

| Event | Trigger | Campaigns affected |
|-------|---------|-------------------|
| `physioloop:session_completed` | QVAC attestation accepted + PUSD released | Onboarding gift, streak rebate, plan raffle |
| `physioloop:plan_started` | Treatment plan created + escrow staked | Physio leaderboard |
| `physioloop:plan_completed` | All sessions done, NFT minted | Plan raffle entry |
| `physioloop:streak_milestone` | 3 or 7 consecutive sessions | Streak rebate enroll |
| `physioloop:caregiver_checkin` | Daily caregiver check-in on-chain | — (analytics) |
| `physioloop:physio_registered` | New physio registers on protocol | Physio leaderboard |

Campaigns running:
1. **Onboarding Gift** — PUSD gift on first verified session
2. **7-Session Streak Rebate** — 10% rebate on next session cost
3. **Plan Completion Raffle** — raffle entry when full plan is done
4. **Physio Leaderboard** — weekly PUSD prize for top compliance rate

Architecture: Patient app (React Native) → POST `/api/torque/event` (Next.js proxy) → Torque API with server-side key. This keeps the API key off the device while the patient app can still fire events.

---

## What broke

### 1. MCP server discovery
**Problem:** The MCP quickstart guide referenced in the hackathon description requires joining a Telegram group first. There's no public URL for the Torque MCP server — you need to get it from the TG chat. This added friction for builders working outside business hours.  
**Suggestion:** Publish the MCP server URL publicly in the Torque docs. The API key protects the endpoint anyway; the URL itself doesn't need to be gated.

### 2. Campaign ID format unclear
**Problem:** When creating campaigns via the Torque dashboard, the ID format wasn't obvious — is it a UUID, a slug, or a numeric ID? The API docs didn't show an example of what a campaign ID looks like in the enroll endpoint.  
**Suggestion:** Show an example campaign ID in the API reference (e.g. `camp_abc123`) so builders know what to paste into `.env`.

### 3. `custom_event` schema not documented
**Problem:** The `POST /v1/events/custom` body shape isn't fully documented. We inferred it from context. Fields like whether `metadata` values must be strings vs. any JSON type, and whether `txSignature` is indexed for on-chain verification, weren't specified.  
**Suggestion:** Publish a JSON Schema or OpenAPI spec for the custom_events endpoint. Include whether `txSignature` is cross-validated against the RPC.

### 4. No local emulator / test mode
**Problem:** During development it's hard to know if events are being received correctly without triggering live campaigns. We ended up logging Torque API responses manually.  
**Suggestion:** A `?dry_run=true` query param or a sandbox environment (like Stripe's test mode) would make event integration much faster to validate.

### 5. Sybil resistance interaction model
**Problem:** We built QVAC attestations as proof of real exercise (on-device AI verification with on-chain proof hash). We expected Torque's Sybil resistance layer to be able to cross-reference the on-chain proof hash. It's not clear if Torque reads the `txSignature` we pass and does any validation, or treats it purely as a string label.  
**Suggestion:** Document what Torque does with `txSignature`. If Torque can verify on-chain state from it, that's a major selling point for clinical/compliance use cases where event legitimacy is critical.

---

## What worked well

- The event API pattern (`POST /v1/events/custom`) is dead simple — no SDK needed, plain fetch works.
- The campaign enrollment endpoint (`/v1/campaigns/:id/enroll`) is intuitive.
- The concept of "custom_events + campaign enrollment" as separate concerns is the right abstraction — it means our growth logic stays decoupled from our clinical logic.
- PUSD + Torque rewards in the same token feels natural: PUSD flows into escrow from patients, gets released to physios per session, and Torque rebates/gifts return PUSD to patients who adhere. It's a closed loop.

---

## Improvement wishlist (prioritized)

1. **Webhook support** — Torque calling our backend when a campaign triggers (e.g., when a raffle winner is drawn) instead of us polling
2. **On-chain event listener** — Torque directly watching a Solana program's event log, removing the need for a client-side event proxy entirely
3. **Test mode / sandbox** — isolated environment for development without touching live campaigns
4. **MCP public URL** — remove TG gating for the hackathon quickstart
5. **OpenAPI spec** — machine-readable API contract
