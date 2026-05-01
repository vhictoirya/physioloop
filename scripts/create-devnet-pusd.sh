#!/usr/bin/env bash
# Creates a devnet test mint that matches PUSD properties:
#   - Token-2022 program
#   - 6 decimals
#   - No freeze authority (matches on-chain constraint)
#   - Mints some test tokens to your wallet
#
# Usage: bash scripts/create-devnet-pusd.sh
# Requires: solana-cli, spl-token cli, wallet configured for devnet

set -euo pipefail

echo "==> Switching to devnet"
solana config set --url devnet

echo "==> Requesting airdrop (2 SOL for rent)"
solana airdrop 2 || true

echo "==> Creating Token-2022 mint (6 decimals, no freeze authority)"
MINT=$(spl-token create-token \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --decimals 6 \
  2>&1 | grep "Creating token" | awk '{print $3}')

echo "Devnet PUSD mint: $MINT"

echo "==> Creating associated token account"
spl-token create-account "$MINT" \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb

echo "==> Minting 10,000 test PUSD"
spl-token mint "$MINT" 10000 \
  --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb

echo ""
echo "========================================"
echo "  Devnet PUSD mint:  $MINT"
echo "========================================"
echo ""
echo "Update these files with the mint address:"
echo "  app/lib/constants.ts    -> PUSD_MINT_ADDRESS (devnet only)"
echo "  patient-app/lib/constants.ts -> PUSD_MINT_ADDRESS (devnet only)"
echo ""
echo "DO NOT update programs/physioloop/src/lib.rs — that holds the mainnet address."
echo "The freeze_authority.is_none() constraint will still pass for this mint."
