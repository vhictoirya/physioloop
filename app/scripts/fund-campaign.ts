/**
 * fund-campaign.ts
 *
 * Mints PUSD from the mint authority into a Torque campaign distributor vault.
 *
 * Usage (after epoch closes and Torque gives you the distributor vault address):
 *   npx tsx scripts/fund-campaign.ts <vault-address> <amount-usd>
 *
 * Example:
 *   npx tsx scripts/fund-campaign.ts AbcDef...XYZ 50
 *
 * When to run:
 *   1. An epoch closes (Torque evaluates qualifying users)
 *   2. Torque creates an on-chain distributor with a vault address
 *   3. Run this script with that vault address and the epoch reward budget
 *   4. Torque releases rewards to qualifying users during the claim window
 *
 * How to find the vault address:
 *   - Check platform.torque.so → incentives → epoch details
 *   - Or call GET https://server.torque.so/offers/<offerId> to get pubkey
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const PUSD_MINT = new PublicKey("D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s");
const RPC = "https://api.devnet.solana.com";

function loadAuthority(): Keypair {
  const b64 = process.env.MINT_AUTHORITY_KEYPAIR;
  if (!b64) throw new Error("MINT_AUTHORITY_KEYPAIR not set in .env.local");
  return Keypair.fromSecretKey(Buffer.from(b64, "base64"));
}

async function fundCampaignVault(vaultAddress: string, amountUsd: number) {
  const authority = loadAuthority();
  const connection = new Connection(RPC, "confirmed");
  const recipient = new PublicKey(vaultAddress);
  const amountRaw = Math.round(amountUsd * 1_000_000);

  console.log(`\nFunding campaign vault: ${vaultAddress}`);
  console.log(`Amount: $${amountUsd} PUSD (${amountRaw} raw)`);
  console.log(`Authority: ${authority.publicKey.toBase58()}`);

  // Derive the ATA for the vault address (Torque may use a regular wallet or PDA)
  const vaultAta = getAssociatedTokenAddressSync(
    PUSD_MINT, recipient, true, TOKEN_2022_PROGRAM_ID,
  );
  console.log(`Vault ATA: ${vaultAta.toBase58()}`);

  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, vaultAta, recipient, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
    ),
    createMintToInstruction(
      PUSD_MINT, vaultAta, authority.publicKey, amountRaw, [], TOKEN_2022_PROGRAM_ID,
    ),
  );

  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = authority.publicKey;
  tx.sign(authority);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, "confirmed");

  console.log(`\n✅ Funded! Signature: ${sig}`);
  console.log(`   https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

// ── Campaign vault addresses (fill in after each epoch closes) ───────────────
const CAMPAIGN_VAULTS: Record<string, { name: string; budgetUsd: number }> = {
  // Add vault addresses here once Torque creates each epoch's distributor
  // Example:
  // "AbcDef...XYZ": { name: "Patient Session Gift — Epoch 1", budgetUsd: 50 },
};

async function main() {
  const [, , vaultArg, amountArg] = process.argv;

  if (vaultArg && amountArg) {
    // Direct invocation: fund a specific address
    await fundCampaignVault(vaultArg, parseFloat(amountArg));
    return;
  }

  // No args: show known campaign vaults and their budgets
  if (Object.keys(CAMPAIGN_VAULTS).length === 0) {
    console.log(`
No campaign vaults configured yet.

After the first epoch closes (2026-04-29), Torque will create on-chain
distributor accounts. Get their addresses from:
  - platform.torque.so → Incentives
  - Torque API: GET https://server.torque.so/offers/<offerId>

Then run:
  npx tsx scripts/fund-campaign.ts <vault-address> <amount-usd>

Campaign budgets to fund per epoch:
  Patient Session Gift:        $50 PUSD  (covers 100 patients @ $0.50 each)
  Caregiver Daily Check-in:    $25 PUSD  (covers 100 caregivers @ $0.25 each)
  Physio Weekly Leaderboard:   $42 PUSD  ($25 + $12 + $5 for top 3)
`);
    return;
  }

  // Fund all known vaults
  for (const [address, { name, budgetUsd }] of Object.entries(CAMPAIGN_VAULTS)) {
    console.log(`\n── ${name} ──`);
    await fundCampaignVault(address, budgetUsd);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
