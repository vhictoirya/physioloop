/**
 * One-time setup: create the treasury ATA and mint 10,000 PUSD into it.
 *
 * On devnet we use our own mint authority to seed the treasury.
 * On mainnet this step is replaced by PalmUSD team depositing real PUSD
 * into the treasury wallet — the payout code is identical either way.
 *
 * Run: node scripts/fund-treasury.mjs
 */

import {
  Connection, Keypair, PublicKey, Transaction, clusterApiUrl,
} from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'

const PUSD_MINT        = new PublicKey('D63PopAKdPvRhHvbrDR8jseC9hFCHesELCSQQpDadz8s')
const FUND_AMOUNT_PUSD = 10_000          // PUSD to mint into the treasury
const PUSD_DECIMALS    = 6

function loadKeypair(b64) {
  return Keypair.fromSecretKey(Buffer.from(b64, 'base64'))
}

const authority = loadKeypair('2IMj7Wa2ZICrjHQxManh86Qi5H8c0JSScOWtC1X6lIWx8fENb/xDLnD1da8fr6bsg4GgTJBpA8lIJATWoq2PHQ==')
const treasury  = loadKeypair('5EaKM12L6h5zALC7XajcdYzmHFsYr4+zstFpXF3+jGa5/iBa5bPFmwM8QPg6uKsbviz1OjMWZmHbXdWlQ1DXiQ==')

console.log('Mint authority:', authority.publicKey.toBase58())
console.log('Treasury:      ', treasury.publicKey.toBase58())

const connection = new Connection(clusterApiUrl('devnet'), 'confirmed')

// Airdrop SOL to treasury for rent if needed
const treasuryBalance = await connection.getBalance(treasury.publicKey)
console.log(`Treasury SOL balance: ${treasuryBalance / 1e9}`)
if (treasuryBalance < 0.01 * 1e9) {
  console.log('Airdropping 1 SOL to treasury for rent...')
  const sig = await connection.requestAirdrop(treasury.publicKey, 1e9)
  await connection.confirmTransaction(sig, 'confirmed')
  console.log('Airdrop confirmed:', sig)
}

const treasuryAta = getAssociatedTokenAddressSync(
  PUSD_MINT, treasury.publicKey, false, TOKEN_2022_PROGRAM_ID,
)
console.log('Treasury ATA:', treasuryAta.toBase58())

const tx = new Transaction()

// Create treasury ATA if needed
tx.add(createAssociatedTokenAccountIdempotentInstruction(
  authority.publicKey, treasuryAta, treasury.publicKey, PUSD_MINT, TOKEN_2022_PROGRAM_ID,
))

// Mint PUSD into treasury (devnet only — mainnet: PalmUSD team deposits real PUSD)
const amountRaw = BigInt(FUND_AMOUNT_PUSD * 10 ** PUSD_DECIMALS)
tx.add(createMintToInstruction(
  PUSD_MINT, treasuryAta, authority.publicKey, amountRaw, [], TOKEN_2022_PROGRAM_ID,
))

const { blockhash } = await connection.getLatestBlockhash()
tx.recentBlockhash = blockhash
tx.feePayer = authority.publicKey
tx.sign(authority)

const fundSig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false })
await connection.confirmTransaction(fundSig, 'confirmed')

console.log(`\n✅ Treasury funded: ${FUND_AMOUNT_PUSD} PUSD`)
console.log(`   ATA:       ${treasuryAta.toBase58()}`)
console.log(`   Signature: ${fundSig}`)
console.log('\nNote: on mainnet, replace this script with a PalmUSD deposit into the treasury ATA.')
