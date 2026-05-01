// Mirrors physio dashboard constants — keep in sync
export const PROGRAM_ID = '3vArMkTYa2J95xVYsgdsnDu2pokBjRQGj7ZFUdeDutQi'
// Devnet test mint (Token-2022, no freeze auth); mainnet: CZzgUBvxaMLwMhVSLgqJn3npmxoTo6nzMNQPAnwtHF3s
export const PUSD_MINT_ADDRESS = 'D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s'
export const RPC_ENDPOINT = 'https://api.devnet.solana.com'
// PUSD uses Token-2022
export const TOKEN_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

// Exercise names must match what the physio prescribes
export const SUPPORTED_EXERCISES = [
  'knee_extension',
  'straight_leg_raise',
  'hamstring_curl',
  'calf_raise',
  'hip_abduction',
  'wall_squat',
  'ankle_dorsiflexion',
] as const

export type ExerciseName = typeof SUPPORTED_EXERCISES[number]

// Minimum confidence from QVAC model to accept the proof
export const MIN_CONFIDENCE_THRESHOLD = 0.6

// PUSD base units per dollar (6 decimals, like USDC)
export const PUSD_DECIMALS = 1_000_000
