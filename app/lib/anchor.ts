"use client";

import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useMemo } from "react";
import IDL from "../physioloop_idl.json";
import { PROGRAM_ID, PUSD_DECIMALS } from "./constants";

export type PhysioloopIDL = typeof IDL;

const PROGRAM_PUBLIC_KEY = new PublicKey(PROGRAM_ID);

export function usePhysioloopProgram() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const provider = useMemo(
    () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new AnchorProvider(connection, wallet as any, {
        commitment: "confirmed",
        preflightCommitment: "confirmed",
      }),
    [connection, wallet]
  );

  const program = useMemo(
    () => new Program(IDL as PhysioloopIDL, provider),
    [provider]
  );

  return { program, provider, connection };
}

// ─── PDA helpers ─────────────────────────────────────────────────────────────

export function getPhysioProfilePDA(physio: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("physio"), physio.toBuffer()],
    PROGRAM_PUBLIC_KEY
  );
}

export function getTreatmentPlanPDA(physio: PublicKey, patient: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("plan"), physio.toBuffer(), patient.toBuffer()],
    PROGRAM_PUBLIC_KEY
  );
}

export function getEscrowVaultPDA(treatmentPlan: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), treatmentPlan.toBuffer()],
    PROGRAM_PUBLIC_KEY
  );
}

export function getSessionAttestationPDA(
  treatmentPlan: PublicKey,
  sessionNumber: number
) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("session"), treatmentPlan.toBuffer(), Buffer.from([sessionNumber])],
    PROGRAM_PUBLIC_KEY
  );
}

export function getCaregiverProfilePDA(caregiver: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("caregiver"), caregiver.toBuffer()],
    PROGRAM_PUBLIC_KEY
  );
}

// ─── Display helpers ─────────────────────────────────────────────────────────

export function pusdToDisplay(amount: number | BN): string {
  const n = typeof amount === "number" ? amount : amount.toNumber();
  return (n / PUSD_DECIMALS).toFixed(2);
}

export function displayToPusd(dollars: string): BN {
  return new BN(Math.round(parseFloat(dollars) * PUSD_DECIMALS));
}

export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

export function completionPct(completed: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((completed / total) * 100);
}

// Tier labels — sync with PhysioProfile.subscription_tier on-chain values
export const TIER_LABELS: Record<number, string> = {
  0: "Free",
  1: "Starter",
  2: "Professional",
  3: "Elite",
};
