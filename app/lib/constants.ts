import { clusterApiUrl } from "@solana/web3.js";

export const PROGRAM_ID = "3vArMkTYa2J95xVYsgdsnDu2pokBjRQGj7ZFUdeDutQi";

// palmUSD (PUSD) SPL token mint
// Mainnet: CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s
// Devnet test mint (Token-2022, no freeze auth): D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s
export const PUSD_MINT_ADDRESS = "D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s";

export const CLUSTER = "devnet";
export const RPC_ENDPOINT = clusterApiUrl("devnet");

// $0.25 PUSD per caregiver check-in — 5% of $5 session fee
export const CAREGIVER_REWARD_PUSD = 250_000;
export const PUSD_DECIMALS = 1_000_000;

// Per-session split (mirrors on-chain constants — BPS out of 10_000)
export const PHYSIO_SHARE_PCT   = 70;  // 70% → physio wallet
export const OPS_SHARE_PCT      = 15;  // 15% → ops treasury
export const CAMPAIGN_SHARE_PCT = 10;  // 10% → Torque campaign pool
export const CAREGIVER_SHARE_PCT = 5;  //  5% → caregiver (via check-in)

// Subscription split
export const SUB_OPS_PCT         = 90; // 90% → ops treasury
export const SUB_LEADERBOARD_PCT = 10; // 10% → leaderboard prize pool

// Treasury ATAs (all Token-2022, PUSD mint)
export const OPS_TREASURY_ATA      = "D6TtHc7jrtF3APDcXjTn6hvPnfAyxsw4ndauxvRnM1D3"; // authority wallet
export const CAMPAIGN_POOL_ATA     = "Dt7o6GQxq187EjFjXJLqJUjoCSrT3r7mdBzYNHWLP7Bf"; // PDA "campaign_pool"
export const LEADERBOARD_POOL_ATA  = "zVwDKwwALnDee3JquRmoBzUUzpCFDTg7GiZzsW5CcHg";  // PDA "leaderboard_pool"
export const RAFFLE_POOL_ATA       = "796puzSZryzLA865sPKko74Zj76bspGCsGnJ3tJ1cwyc";  // PDA "raffle_pool"
export const RAFFLE_POOL_OWNER     = "2QPBHKJL7m8RPkayZVktSvEDvP3sQyV2u2S4xGuPmBu5"; // PDA "raffle_pool"

// PUSD is a Token-2022 token — use this program ID everywhere
export const TOKEN_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
