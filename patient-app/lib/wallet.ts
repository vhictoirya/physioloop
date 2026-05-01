/**
 * Patient wallet management.
 *
 * For hackathon: stores a generated Ed25519 keypair in expo-secure-store.
 * Production: replace with @solana-mobile/mobile-wallet-adapter-protocol (Android)
 *             or WalletConnect v2 (iOS).
 */

import * as SecureStore from 'expo-secure-store'
import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'

const KEYPAIR_KEY = 'physioloop_patient_keypair'

/** Load keypair from secure storage, or generate a new one on first launch. */
export async function getOrCreateKeypair(): Promise<Keypair> {
  const stored = await SecureStore.getItemAsync(KEYPAIR_KEY)
  if (stored) {
    return Keypair.fromSecretKey(bs58.decode(stored))
  }

  const keypair = Keypair.generate()
  await SecureStore.setItemAsync(KEYPAIR_KEY, bs58.encode(keypair.secretKey))
  return keypair
}

/** Create a minimal wallet adapter compatible with @coral-xyz/anchor. */
export function makeWalletAdapter(keypair: Keypair) {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
      if (tx instanceof Transaction) {
        tx.sign(keypair)
      } else {
        // VersionedTransaction
        tx.sign([keypair])
      }
      return tx
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(
      txs: T[]
    ): Promise<T[]> => {
      for (const tx of txs) {
        if (tx instanceof Transaction) tx.sign(keypair)
        else tx.sign([keypair])
      }
      return txs
    },
  }
}
