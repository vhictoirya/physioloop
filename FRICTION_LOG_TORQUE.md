# PhysioLoop × Torque — Friction Log

Honest notes from integrating Torque recurring incentive campaigns and custom events into PhysioLoop during the Colosseum Frontier hackathon (May 2026). Written for the Torque prize-track submission.

---

## What we built

PhysioLoop emits six custom events to Torque after every verifiable on-chain action, and runs eight recurring incentive campaigns across all three user roles (patient, caregiver, physio):

| Event | Trigger |
|---|---|
| `physioloop_session_completed` | QVAC attestation accepted + PUSD released from escrow |
| `physioloop_plan_started` | Treatment plan created + patient stakes escrow |
| `physioloop_plan_completed` | All sessions done, plan closed |
| `physioloop_streak_milestone` | Patient completes sessions 3 or 7 consecutively |
| `physioloop_caregiver_checkin` | Caregiver submits daily check-in on-chain |
| `physioloop_caregiver_milestone` | First check-in, 7-day streak, rescue, or plan completion |
| `physioloop_physio_registered` | New physiotherapist joins the protocol |

Campaigns:

| Campaign | ID | Reward |
|---|---|---|
| Onboarding Gift | `cmoi6wsja01drjw1he9muhqvk` | $0.50 PUSD on session 1 |
| 7-Session Streak | `cmokk2zmp009fjt1jyseg7g0w` | $0.50 PUSD on session 7 |
| Plan Raffle | `cmokk30vd009qjt1j29afk6hy` | $1.00 into raffle pool |
| Caregiver First Check-in | `cmoi6x0re01e2jw1hcy8cjljw` | $0.25 PUSD |
| Caregiver 7-Day Streak | `cmokk323000a1jt1jlljkrl0w` | $1.00 PUSD |
| Rescue Bonus | `cmokk33jc00acjt1jji3hmflw` | $0.50 PUSD |
| Plan Completion Bonus | `cmokk34xh00anjt1jho5pw217` | $2.00 PUSD (caregiver) |
| Physio Leaderboard | `cmoi6xajg01edjw1hd9tnbkh9` | $25/$12/$5 PUSD weekly top 3 |

---

## Friction encountered

### 1. Event schema requires `tx_signature` field but this is not documented prominently

**What happened:** Initial event emission used a flat metadata payload:
```json
{
  "eventName": "physioloop_session_completed",
  "userPubkey": "...",
  "data": { "exercise": "knee_extension", "confidence": 0.85 }
}
```
The Torque ingest endpoint returned `200` but events did not appear in the dashboard.

**Root cause:** Through experimentation, we discovered that Torque's custom event system requires a `tx_signature` field inside the `data` object to link the event to an on-chain transaction. Without it the event is accepted but not processed for campaign eligibility.

**Fix:**
```ts
body: {
  eventName: payload.event,
  userPubkey: payload.userPublicKey,
  timestamp: new Date().toISOString(),
  data: {
    ...payload.metadata,
    tx_signature: payload.txSignature ?? 'none',  // required
  },
}
```

After adding `tx_signature`, events appeared in the dashboard within seconds.

**Suggestion for Torque team:** Document `tx_signature` as a required field in the custom event schema, not as an optional field that silently determines whether the event is processed. A `4xx` response with a clear error message ("missing required field: tx_signature") would have made this instant to debug rather than a multi-hour investigation.

---

### 2. No clear distinction between "recurring incentive" and "campaign" in the dashboard UI

**What happened:** The Torque dashboard has "Campaigns" and "Recurring Incentives" as separate concepts. We initially created our reward programs under "Campaigns" but the conditional logic (e.g., "reward on session 7", "reward if caregiver assigned to completed plan") required "Recurring Incentives" with custom event triggers.

**Root cause:** The two concepts overlap significantly in the UI. A "Campaign" in Torque appears to be a broader marketing/distribution tool (links, landing pages, social tasks). A "Recurring Incentive" is the right primitive for programmatic, event-triggered rewards.

**Fix:** Deleted the initial Campaigns and recreated all eight programs as Recurring Incentives with `physioloop_*` custom events as triggers. This worked correctly.

**Suggestion for Torque team:** The distinction between Campaign and Recurring Incentive could be clearer in the creation flow. A use-case framing ("Use Recurring Incentives for programmatic, event-triggered rewards; use Campaigns for user-facing distribution links") at the top of each creation form would save integrators time.

---

### 3. Custom event IDs must be created before referencing them in Recurring Incentives

**What happened:** We tried to create a Recurring Incentive with `physioloop_session_completed` as the trigger event before registering the custom event in the Torque project settings. The UI accepted the incentive but it never fired because the event name wasn't registered.

**Fix:** Create all custom events in the project settings first, then create Recurring Incentives that reference them. Order matters; the dashboard doesn't warn you if the event name doesn't exist yet.

**Suggestion for Torque team:** When creating a Recurring Incentive with a custom event trigger, validate that the event name exists in the project. Show a warning or dropdown of registered events rather than a free-text field.

---

### 4. Campaign enrollment API (`/campaigns/:id/enroll`) is undocumented in the public docs

**What happened:** We wanted to programmatically enroll users in campaigns after on-chain events (e.g., enroll in the leaderboard campaign on every physio registration). The Torque docs describe the ingest API for events but don't document a campaign enrollment endpoint.

**Fix:** We found the endpoint by inspecting Torque's own dashboard network requests in the browser DevTools:
```
POST https://server.torque.so/campaigns/:id/enroll
Authorization: Bearer <TORQUE_API_KEY>
{ "userPubkey": "..." }
```

This works but feels fragile — an undocumented internal endpoint could change without notice.

**Suggestion for Torque team:** Publish the campaign enrollment endpoint in the public API docs. For programmatic integrations (our use case), explicitly enrolling users in campaigns after on-chain events is a core workflow, not an edge case.

---

### 5. MCP server provides good context but `ask_torque` tool occasionally returns stale schema examples

**What happened:** We used the Torque MCP server (`mcp__torque__*` tools) extensively during integration. The `get_ai_context` and `ask_torque` tools were genuinely useful for understanding campaign structure and event schema.

However, a few times the `ask_torque` tool returned example payloads that didn't match the actual accepted format — specifically, it showed `userId` instead of `userPubkey` in one example, and showed a flat payload without the nested `data` object in another.

**Impact:** Stale examples in AI responses are hard to distinguish from correct ones. We cross-referenced every schema field against the live API before trusting it.

**Suggestion for Torque team:** Pin the MCP server's example payloads to the current API version and include a "last-updated" field in the schema documentation. Outdated field names in AI-assisted development cause disproportionate confusion because developers may not immediately question an AI's answer.

---

### 6. API key scoping — single key for both ingest and server endpoints

**What happened:** Torque provides two keys: `TORQUE_INGEST_KEY` (for the `/events` ingest endpoint) and `TORQUE_API_KEY` (for the `/campaigns/*` server endpoints). We initially used `TORQUE_API_KEY` for ingest calls, which returned `401`.

**Root cause:** The two keys are scoped differently but both look like opaque strings. The naming (`INGEST_KEY` vs `API_KEY`) is the only signal. If you swap them, the error message is just `401 Unauthorized` with no indication that you're using the wrong key type.

**Fix:** Keep the keys separate in `.env.local` and use them in the right contexts:
```
TORQUE_INGEST_KEY → used in emitTorqueEvent (POST /events)
TORQUE_API_KEY    → used in enrollInCampaign (POST /campaigns/:id/enroll)
```

**Suggestion for Torque team:** Return a more descriptive 401 body such as `{ "error": "ingest key used on server endpoint" }` to make key confusion diagnosable without trial and error.

---

### 7. No way to test events locally without hitting the live Torque API

**What happened:** Every event emission during development hit the live `ingest.torque.so` endpoint. There is no local mock, sandbox environment, or test mode. This meant we were generating real events (with real wallet addresses) in the production Torque dashboard during development.

**Impact:** The production dashboard is now populated with test events from our development cycles. These are distinguishable (we used predictable test wallet addresses) but clutter the analytics view.

**Suggestion for Torque team:** A sandbox environment or a `x-torque-test: true` header that accepts events but doesn't process them for campaign eligibility or analytics would make development much cleaner.

---

### 8. Raffle draw requires a manual API call — no built-in scheduling

**What happened:** The Plan Raffle campaign accumulates PUSD into a raffle pool ATA. Drawing a winner requires calling our `/api/admin/raffle/draw` endpoint manually. Torque does not provide built-in scheduled draws or winner selection.

**Impact:** We implemented our own raffle draw logic (select a random enrolled wallet, transfer the pool balance to it). This works but is a significant amount of code that feels like it belongs in the Torque layer.

**Suggestion for Torque team:** A native raffle campaign type with configurable draw cadence (weekly, monthly, per-N-entries) would remove a large class of custom backend logic from integrating apps. This is a natural extension of the Recurring Incentive primitive.

---

## What worked well

- **Custom event creation via MCP is fast.** Creating the six `physioloop_*` events via `mcp__torque__create_custom_event` in the Claude conversation was genuinely the fastest part of the integration. No dashboard navigation needed.

- **Recurring Incentive campaigns fire reliably.** Once the schema was correct and `tx_signature` was included, events processed and campaign conditions evaluated within seconds. Zero missed events across hundreds of test sessions.

- **Project/API key isolation works well.** Having a separate Torque project per app means our analytics are clean and don't mix with other teams' data.

- **The leaderboard primitive is a natural fit for physio rankings.** Torque's epoch-based leaderboard (rank by custom metric, top-N wins) maps cleanly onto "physio with highest patient compliance rate this week wins." We didn't need to build any leaderboard logic ourselves.

- **`emitTorqueEvent` never blocking the main flow.** We fire events with `.catch(() => {})` so a Torque outage never disrupts a patient's session submission. The `Promise.allSettled` pattern in `onSessionCompleted` means all events are attempted but failures are silent to the user.

- **The ingest endpoint is fast.** Response times of 50–150ms from the ingest endpoint were consistently within our acceptable range for a fire-and-forget analytics call.

---

## Summary of suggested improvements

| Issue | Priority | Suggested fix |
|---|---|---|
| `tx_signature` undocumented as required | High | Document as required field with 4xx if missing |
| Campaign vs Recurring Incentive confusion | High | Use-case framing in creation UI |
| Event must exist before incentive | Medium | Validate event name in incentive creation flow |
| Campaign enrollment endpoint undocumented | Medium | Add to public API docs |
| MCP tool returns stale schema examples | Medium | Version-pin MCP examples |
| API key type confusion gives generic 401 | Medium | Descriptive 401 body explaining key scope |
| No sandbox / test mode | Low | Sandbox env or `x-torque-test` header |
| No native raffle campaign type | Low | Scheduled draw as first-class campaign feature |
