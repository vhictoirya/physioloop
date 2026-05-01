# PhysioLoop × PalmUSD — Friction Log

Honest notes from integrating PalmUSD (PUSD) as the reward token in PhysioLoop during the Colosseum Frontier hackathon (May 2026). Written for the PalmUSD prize-track submission.

---

## What we built

PhysioLoop uses PUSD as the sole payment token across all three user roles:

- **Patients** lock PUSD in an on-chain escrow when starting a treatment plan
- **Physiotherapists** receive 70% of each session's PUSD as verifiable work is done
- **Caregivers** earn micro-PUSD for daily check-ins and streak milestones
- **Platform** takes 15% ops + 10% Torque campaign pool per session

All token flows use a pre-funded treasury ATA. The Anchor program handles escrow splits via PDA-signed CPIs. The Next.js backend handles bonus payouts via `createTransferInstruction` from the treasury.

---

## Friction encountered

### 1. PalmUSD has no devnet deployment

**What happened:** PalmUSD's mainnet mint address (`CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s`) does not exist on Solana devnet. There is no faucet, no airdrop endpoint, and no documentation on how to test with PUSD before mainnet.

**Impact:** We could not use the real PalmUSD mint during development. Every test required a custom devnet PUSD mint that we created and control ourselves.

**Fix:** We created a Token-2022 mint on devnet (`D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s`) with:
- No freeze authority (mirrors PalmUSD's non-freezable guarantee)
- 6 decimal places (matches PalmUSD)
- Token-2022 program (matches PalmUSD)

The Anchor program stores the mint address as a constant. Switching to mainnet PalmUSD requires only changing that constant and redeploying — all transfer logic, ATA derivation, and CPI code is identical.

**Suggestion for PalmUSD team:** A devnet faucet or a documented process for getting test PUSD on devnet would significantly lower the integration barrier. Even a simple form submission that airdropps 100 PUSD to a devnet address would be enough. Without it, every integrating team must create their own test mint and document the swap process, which creates friction in judging and verification.

---

### 2. Discovering that we needed `transfer`, not `mintTo`

**What happened:** Our initial implementation minted fresh PUSD directly to recipients using `createMintToInstruction`. This worked perfectly on devnet with our custom mint (where we hold the mint authority), but is architecturally incompatible with mainnet PalmUSD.

**Root cause:** PalmUSD's design explicitly states that the mint authority is held exclusively by the PalmUSD team. No third-party application can call `mintTo`. This is a core security property of the token — it prevents inflation.

**Discovery:** We read the PalmUSD developer documentation at `palmusd.com/pages/developers` during integration. The freeze authority check is documented but the mint authority restriction required more careful reading of the token's philosophy section.

**Fix:** Changed the entire payout architecture from mint-based to transfer-based:

Before:
```ts
tx.add(createMintToInstruction(
  PUSD_MINT, recipientAta, mintAuthority.publicKey, amountRaw, [], TOKEN_2022_PROGRAM_ID
))
tx.sign(mintAuthority)
```

After:
```ts
tx.add(createTransferInstruction(
  treasuryAta, recipientAta, treasury.publicKey, amountRaw, [], TOKEN_2022_PROGRAM_ID
))
tx.sign(authority, treasury)  // authority pays fees, treasury authorises transfer
```

This required:
- A new `TREASURY_KEYPAIR` environment variable
- A one-time treasury funding step (`/api/admin/fund-treasury`) using our devnet mint authority
- Both `authority` (fee payer) and `treasury` (token authority) signing every payout transaction

**What's unchanged for mainnet:** The payout route, ATA derivation, and Anchor CPI code don't change. The PalmUSD team funds the treasury with real PUSD once; all subsequent payouts draw from that balance.

**Suggestion for PalmUSD team:** The developer docs clearly state the token cannot be minted by third parties, but leading with a "treasury pattern" code example (showing `transfer` instead of `mintTo`) in the docs would save teams the architectural pivot. Many Solana developers default to thinking in terms of minting because that's the common pattern for reward tokens.

---

### 3. Token-2022 requirement was not immediately obvious

**What happened:** Initial SPL token setup used the standard `TOKEN_PROGRAM_ID`. All ATA derivations, transfer instructions, and Anchor account constraints compiled and ran without error on devnet — but produced the wrong ATA addresses when we switched to the PalmUSD mint address for testing.

**Root cause:** PalmUSD is a Token-2022 token (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`). Token-2022 ATAs are derived using a different program ID than standard SPL Token ATAs. Mixing program IDs produces different addresses — transactions fail with "account not owned by token program" rather than a clear mismatch error.

**Fix:** Updated every occurrence in the codebase:

```ts
// Wrong — standard SPL Token
import { TOKEN_PROGRAM_ID } from "@solana/spl-token"

// Correct for PalmUSD
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token"
```

And in the Anchor program:
```rust
// Account constraint must specify token_interface, not token
#[account(
    associated_token::mint = pusd_mint,
    associated_token::authority = physio,
    associated_token::token_program = token_program,
)]
pub physio_pusd_ata: InterfaceAccount<'info, TokenAccount>,
pub token_program: Interface<'info, TokenInterface>,
```

**Suggestion for PalmUSD team:** Make the Token-2022 requirement the first sentence in the developer docs — "PalmUSD is a Token-2022 token. Use `TOKEN_2022_PROGRAM_ID` everywhere." This is a silent footgun that produces confusing errors about account ownership rather than a clear "wrong program ID" message.

---

### 4. Standalone Node.js scripts can't reach devnet from WSL2 (IPv6 routing issue)

**What happened:** We wrote a `scripts/fund-treasury.mjs` script to seed the treasury on devnet. Running it via `node scripts/fund-treasury.mjs` produced:

```
TypeError: fetch failed
  cause: Error: connect ENETUNREACH 2600:3c01::f03c:92ff:fe6d:5c57:8899
```

The devnet DNS (`api.devnet.solana.com`) resolved to an IPv6 address. WSL2's IPv6 routing is broken by default — packets to IPv6 addresses are dropped.

**What didn't work:**
- `NODE_OPTIONS="--dns-result-order=ipv4first"` — had no effect on `@solana/web3.js` fetch internals
- `node --dns-result-order=ipv4first` — same
- Hardcoding `https://api.devnet.solana.com` — resolves to IPv6

**Fix:** Created a Next.js API route (`/api/admin/fund-treasury`) that performs the same mint operation. The Next.js server handles IPv6 correctly (or routes through a different network stack in WSL2). Calling the route via `curl --ipv4` works reliably:

```bash
curl --ipv4 -X POST http://localhost:3000/api/admin/fund-treasury \
  -H "x-admin-secret: physioloop-admin-2026" \
  -d '{"amountUsd": 10000}'
```

**Result:** `{ "success": true, "signature": "27NCf5ciW5SMH...", "amountUsd": 10000 }`

**This is not a PalmUSD issue** — it's a WSL2/Node.js networking edge case. Documenting it here because it blocked treasury setup for several hours and other Windows developers on WSL2 will hit it.

---

### 5. Verifying freeze authority on-chain in Anchor

**What happened:** We wanted the Anchor program to validate that the PUSD mint is genuinely non-freezable (i.e., `freeze_authority.is_none()`) before creating escrow accounts. The standard Anchor `#[account(mint::freeze_authority = ...)]` constraint only accepts a known pubkey — it cannot assert `None`.

**Fix:** Added a custom constraint using `constraint =`:
```rust
#[account(
    constraint = pusd_mint.freeze_authority.is_none() @ PhysioloopError::MintHasFreezeAuthority,
)]
pub pusd_mint: InterfaceAccount<'info, Mint>,
```

This gates `create_treatment_plan` on the mint being non-freezable — if someone tried to use a different Token-2022 mint that has a freeze authority (and therefore could freeze patient funds), the transaction fails with a clear error.

**Suggestion for Anchor team (not PalmUSD):** The `mint::freeze_authority` constraint should support `None` as a value to express "this mint must not have a freeze authority." Currently this requires a verbose custom constraint.

---

### 6. No confirmed devnet contact / response from PalmUSD team

**What happened:** We emailed `hello@palmusd.com` to ask about devnet testing options and mainnet treasury setup. No response was received during the hackathon window.

**Impact:** We proceeded with the devnet custom mint approach, which is architecturally correct but means judges can't verify the flow with real PUSD without running the full local setup.

**What we'd need from PalmUSD team for mainnet:**
1. Confirm the mainnet mint address (`CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s`)
2. Fund the platform treasury (`DX3B8ry4m7vBjjfmc9piUimAsnmpucBrJRC97Apgy4wJ`) with an initial PUSD deposit
3. Confirm the token has no freeze authority (visible on-chain; we've verified this)

**Suggestion for PalmUSD team:** A hackathon-specific point of contact or a Telegram/Discord channel for builder questions would help significantly. The documentation is clear on the token's properties but silent on the process for getting test tokens or coordinating treasury funding.

---

## What worked well

- **Token-2022 `transfer_checked` in Anchor is straightforward.** Once `TokenInterface` / `InterfaceAccount` account types were in place, the CPI for `transfer_checked` worked on the first attempt with no surprises.
- **The treasury-transfer pattern is cleaner than minting.** Having a single treasury account as the source of all rewards makes auditing trivial — one account, one balance, all outflows visible in one place.
- **PUSD's no-freeze-authority guarantee is a real differentiator.** For a healthcare application where patients lock funds in escrow, "the platform cannot freeze your tokens" is a meaningful trust property. We surface this in the UI.
- **6 decimal places matches USDC.** Our `amountUsd * 1_000_000` conversion logic works identically for both tokens, which simplifies any future multi-stablecoin support.

---

## Summary of suggested improvements

| Issue | Priority | Suggested fix |
|---|---|---|
| No devnet deployment / faucet | High | Devnet PUSD faucet or documented test token process |
| Treasury-pattern not shown in docs | High | Lead with `transfer` example, not `mintTo` |
| Token-2022 requirement buried | Medium | First sentence of developer docs |
| No hackathon contact channel | Medium | Discord or Telegram for builder support |
| Freeze authority constraint in Anchor | Low | Anchor-side improvement (not PalmUSD) |
