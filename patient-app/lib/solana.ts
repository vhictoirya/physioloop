/**
 * Solana helpers — submit the QVAC proof to the PhysioLoop Anchor program.
 */

import { Connection, PublicKey, SystemProgram } from '@solana/web3.js'
import { AnchorProvider, Program, BN } from '@coral-xyz/anchor'
import { RPC_ENDPOINT, PROGRAM_ID, TOKEN_PROGRAM_ID } from './constants'
import IDL from '../physioloop_idl.json'

export function getConnection() {
  return new Connection(RPC_ENDPOINT, 'confirmed')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getProgram(wallet: any) {
  const connection = getConnection()
  const provider = new AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  })
  return new Program(IDL as never, provider)
}

// ─── PDA derivations (mirrors lib/anchor.ts in the physio dashboard) ─────────

const PROG = new PublicKey(PROGRAM_ID)

export const pdas = {
  treatmentPlan: (physio: PublicKey, patient: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('plan'), physio.toBuffer(), patient.toBuffer()],
      PROG
    ),

  escrowVault: (treatmentPlan: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('escrow'), treatmentPlan.toBuffer()],
      PROG
    ),

  sessionAttestation: (treatmentPlan: PublicKey, sessionNumber: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('session'), treatmentPlan.toBuffer(), Buffer.from([sessionNumber])],
      PROG
    ),

  physioProfile: (physio: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from('physio'), physio.toBuffer()],
      PROG
    ),
}

// ─── Instructions ─────────────────────────────────────────────────────────────

interface SubmitAttestationArgs {
  wallet: ReturnType<typeof import('./wallet').makeWalletAdapter>
  patientPublicKey: PublicKey
  physioPubkey: PublicKey
  physioAtaPublicKey: PublicKey     // physio's PUSD associated token account
  pusdMintPublicKey: PublicKey
  sessionNumber: number
  proofHash: number[]               // [u8; 32] from generateProofHash()
}

export async function submitAttestation(args: SubmitAttestationArgs): Promise<string> {
  const {
    wallet,
    patientPublicKey,
    physioPubkey,
    physioAtaPublicKey,
    pusdMintPublicKey,
    sessionNumber,
    proofHash,
  } = args

  const program = getProgram(wallet)

  const [physioProfile] = pdas.physioProfile(physioPubkey)
  const [treatmentPlan] = pdas.treatmentPlan(physioPubkey, patientPublicKey)
  const [escrowVault] = pdas.escrowVault(treatmentPlan)
  const [sessionAttestation] = pdas.sessionAttestation(treatmentPlan, sessionNumber)

  const txSig = await program.methods
    .submitAttestation(sessionNumber, proofHash)
    .accountsStrict({
      patient: patientPublicKey,
      physioProfile,
      treatmentPlan,
      sessionAttestation,
      escrowVault,
      physioPusdAta: physioAtaPublicKey,
      pusdMint: pusdMintPublicKey,
      tokenProgram: new PublicKey(TOKEN_PROGRAM_ID),
      systemProgram: SystemProgram.programId,
    })
    .rpc()

  return txSig
}

/** Fetch the TreatmentPlan account for this patient + physio pair. */
export async function fetchTreatmentPlan(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: any,
  physioPubkey: PublicKey,
  patientPublicKey: PublicKey
) {
  const program = getProgram(wallet)
  const [planPDA] = pdas.treatmentPlan(physioPubkey, patientPublicKey)
  return program.account.treatmentPlan.fetch(planPDA) as Promise<{
    physio: PublicKey
    patient: PublicKey
    caregiver: PublicKey
    escrowAmount: BN
    sessionsTotal: number
    sessionsCompleted: number
    pusdPerSession: BN
    planActive: boolean
    createdAt: BN
  }>
}
