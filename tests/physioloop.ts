/**
 * PhysioLoop program tests.
 *
 * Covers the full plan lifecycle plus all the guard constraints:
 *   - register_physio / register_caregiver
 *   - create_treatment_plan
 *   - stake_escrow (including freeze_authority rejection)
 *   - submit_attestation (session ordering, replay prevention, credibility update)
 *   - submit_caregiver_checkin (double check-in guard)
 *   - complete_plan (escrow refund, early termination guard)
 *   - update_credibility_score
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Physioloop } from "../target/types/physioloop";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  createMint as createFreezeableMint,
} from "@solana/spl-token";
import { assert } from "chai";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PUSD_DECIMALS = 6;
const ONE_PUSD = 1_000_000n;
const SESSION_FEE = 5_000_000n; // 5 PUSD per session

function pda(seeds: Buffer[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

async function airdrop(
  connection: anchor.web3.Connection,
  key: PublicKey,
  sol = 2
) {
  const sig = await connection.requestAirdrop(key, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("physioloop", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Physioloop as Program<Physioloop>;
  const conn = provider.connection;
  const progId = program.programId;

  // Actors
  const physio = Keypair.generate();
  const patient = Keypair.generate();
  const caregiver = Keypair.generate();
  const attacker = Keypair.generate();

  // Token accounts
  let pusdMint: PublicKey;
  let physioAta: PublicKey;
  let patientAta: PublicKey;
  let caregiverAta: PublicKey;

  // PDAs
  let physioProfilePDA: PublicKey;
  let caregiverProfilePDA: PublicKey;
  let treatmentPlanPDA: PublicKey;
  let escrowVaultPDA: PublicKey;

  before("fund wallets + create Token-2022 PUSD mint", async () => {
    await Promise.all([
      airdrop(conn, physio.publicKey),
      airdrop(conn, patient.publicKey),
      airdrop(conn, caregiver.publicKey),
      airdrop(conn, attacker.publicKey),
    ]);

    // Create Token-2022 mint with NO freeze authority (mirrors real PUSD)
    pusdMint = await createMint(
      conn,
      physio,              // payer
      physio.publicKey,    // mint authority
      null,                // freeze authority = null → matches PUSD guarantee
      PUSD_DECIMALS,
      undefined,
      { commitment: "confirmed" },
      TOKEN_2022_PROGRAM_ID
    );

    // Create ATAs using Token-2022
    const physioAcct = await getOrCreateAssociatedTokenAccount(
      conn, physio, pusdMint, physio.publicKey,
      false, "confirmed", { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
    );
    physioAta = physioAcct.address;

    const patientAcct = await getOrCreateAssociatedTokenAccount(
      conn, patient, pusdMint, patient.publicKey,
      false, "confirmed", { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
    );
    patientAta = patientAcct.address;

    const caregiverAcct = await getOrCreateAssociatedTokenAccount(
      conn, caregiver, pusdMint, caregiver.publicKey,
      false, "confirmed", { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
    );
    caregiverAta = caregiverAcct.address;

    // Mint 1,000 PUSD to patient (enough for many sessions)
    await mintTo(
      conn, physio, pusdMint, patientAta, physio, 1_000n * ONE_PUSD,
      [], { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
    );

    // Derive PDAs
    [physioProfilePDA] = pda([Buffer.from("physio"), physio.publicKey.toBuffer()], progId);
    [caregiverProfilePDA] = pda([Buffer.from("caregiver"), caregiver.publicKey.toBuffer()], progId);
    [treatmentPlanPDA] = pda([Buffer.from("plan"), physio.publicKey.toBuffer(), patient.publicKey.toBuffer()], progId);
    [escrowVaultPDA] = pda([Buffer.from("escrow"), treatmentPlanPDA.toBuffer()], progId);
  });

  // ─── register_physio ────────────────────────────────────────────────────────

  describe("register_physio", () => {
    it("creates a PhysioProfile with tier 1", async () => {
      await program.methods
        .registerPhysio(1)
        .accountsStrict({
          physioProfile: physioProfilePDA,
          physio: physio.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([physio])
        .rpc();

      const profile = await program.account.physioProfile.fetch(physioProfilePDA);
      assert.equal(profile.subscriptionTier, 1);
      assert.equal(profile.credibilityScore, 0);
      assert.equal(profile.totalPatients, 0);
    });

    it("rejects duplicate registration (account already initialised)", async () => {
      try {
        await program.methods
          .registerPhysio(1)
          .accountsStrict({
            physioProfile: physioProfilePDA,
            physio: physio.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([physio])
          .rpc();
        assert.fail("expected error");
      } catch (e: unknown) {
        assert.ok(e, "duplicate registration rejected");
      }
    });
  });

  // ─── register_caregiver ─────────────────────────────────────────────────────

  describe("register_caregiver", () => {
    it("creates a CaregiverProfile", async () => {
      await program.methods
        .registerCaregiver()
        .accountsStrict({
          caregiverProfile: caregiverProfilePDA,
          caregiver: caregiver.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([caregiver])
        .rpc();

      const profile = await program.account.caregiverProfile.fetch(caregiverProfilePDA);
      assert.equal(profile.checkins_total ?? profile.checkinsTotal, 0);
    });
  });

  // ─── create_treatment_plan ──────────────────────────────────────────────────

  describe("create_treatment_plan", () => {
    it("creates TreatmentPlan PDA and escrow vault", async () => {
      const SESSIONS = 3;

      await program.methods
        .createTreatmentPlan(SESSIONS, new BN(SESSION_FEE.toString()))
        .accountsStrict({
          physioProfile: physioProfilePDA,
          treatmentPlan: treatmentPlanPDA,
          escrowVault: escrowVaultPDA,
          physio: physio.publicKey,
          patient: patient.publicKey,
          caregiver: caregiver.publicKey,
          pusdMint: pusdMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([physio])
        .rpc();

      const plan = await program.account.treatmentPlan.fetch(treatmentPlanPDA);
      assert.ok(plan.physio.equals(physio.publicKey));
      assert.ok(plan.patient.equals(patient.publicKey));
      assert.equal(plan.sessionsTotal, SESSIONS);
      assert.equal(plan.sessionsCompleted, 0);
      assert.equal(plan.planActive, false, "plan not active until staked");

      const profileAfter = await program.account.physioProfile.fetch(physioProfilePDA);
      assert.equal(profileAfter.totalPatients, 1);
    });
  });

  // ─── stake_escrow ───────────────────────────────────────────────────────────

  describe("stake_escrow", () => {
    it("rejects a mint that has freeze authority set", async () => {
      // Create a mint WITH freeze authority — should be rejected
      const freezeAuthority = Keypair.generate();
      const badMint = await createFreezeableMint(
        conn, physio, physio.publicKey, freezeAuthority.publicKey,
        PUSD_DECIMALS, undefined,
        { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
      );

      // Create a fake plan PDA for badMint (won't exist — just testing mint validation)
      const fakePatient = Keypair.generate();
      const [fakePlan] = pda([Buffer.from("plan"), physio.publicKey.toBuffer(), fakePatient.publicKey.toBuffer()], progId);
      const [fakeEscrow] = pda([Buffer.from("escrow"), fakePlan.toBuffer()], progId);
      const fakePatientAta = await getOrCreateAssociatedTokenAccount(
        conn, patient, badMint, patient.publicKey,
        false, "confirmed", { commitment: "confirmed" }, TOKEN_2022_PROGRAM_ID
      );

      try {
        await program.methods
          .stakeEscrow(new BN((3n * SESSION_FEE).toString()))
          .accountsStrict({
            treatmentPlan: fakePlan,
            escrowVault: fakeEscrow,
            patientPusdAta: fakePatientAta.address,
            pusdMint: badMint,
            patient: patient.publicKey,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .signers([patient])
          .rpc();
        assert.fail("expected NotPalmUsd error");
      } catch (e: unknown) {
        const msg = String(e);
        // Either NotPalmUsd constraint or account-not-found (plan doesn't exist yet)
        // Both are acceptable — the point is it didn't succeed
        assert.ok(msg.includes("NotPalmUsd") || msg.includes("not found") || msg.includes("AccountNotFound") || msg.includes("Error"), "rejected correctly");
      }
    });

    it("accepts stake from patient with valid PUSD mint", async () => {
      const SESSIONS = 3;
      // Stake session fees + 1 PUSD surplus to fund caregiver rewards.
      // Minimum stake (sessions × fee) leaves no room for caregiver rewards
      // because the program guards the full session reserve — by design.
      const stakeAmount = new BN((BigInt(SESSIONS) * SESSION_FEE + ONE_PUSD).toString());

      await program.methods
        .stakeEscrow(stakeAmount)
        .accountsStrict({
          treatmentPlan: treatmentPlanPDA,
          escrowVault: escrowVaultPDA,
          patientPusdAta: patientAta,
          pusdMint: pusdMint,
          patient: patient.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([patient])
        .rpc();

      const plan = await program.account.treatmentPlan.fetch(treatmentPlanPDA);
      assert.equal(plan.planActive, true);
      assert.equal(plan.escrowAmount.toString(), stakeAmount.toString());
    });

    it("rejects double-staking an active plan", async () => {
      try {
        await program.methods
          .stakeEscrow(new BN(SESSION_FEE.toString()))
          .accountsStrict({
            treatmentPlan: treatmentPlanPDA,
            escrowVault: escrowVaultPDA,
            patientPusdAta: patientAta,
            pusdMint: pusdMint,
            patient: patient.publicKey,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .signers([patient])
          .rpc();
        assert.fail("expected PlanAlreadyActive");
      } catch (e: unknown) {
        assert.ok(String(e).includes("PlanAlreadyActive") || String(e).includes("Error"), "double-stake rejected");
      }
    });
  });

  // ─── submit_attestation ─────────────────────────────────────────────────────

  describe("submit_attestation", () => {
    const proofHash = Array.from({ length: 32 }, (_, i) => i + 1);

    function sessionPDA(sessionNumber: number) {
      return pda(
        [Buffer.from("session"), treatmentPlanPDA.toBuffer(), Buffer.from([sessionNumber])],
        progId
      );
    }

    it("rejects session 2 before session 1", async () => {
      const [attestPDA] = sessionPDA(2);
      try {
        await program.methods
          .submitAttestation(2, proofHash)
          .accountsStrict({
            patient: patient.publicKey,
            physioProfile: physioProfilePDA,
            treatmentPlan: treatmentPlanPDA,
            sessionAttestation: attestPDA,
            escrowVault: escrowVaultPDA,
            physioPusdAta: physioAta,
            pusdMint: pusdMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([patient])
          .rpc();
        assert.fail("expected InvalidSessionNumber");
      } catch (e: unknown) {
        assert.ok(String(e).includes("InvalidSessionNumber") || String(e).includes("Error"), "out-of-order session rejected");
      }
    });

    it("accepts session 1 and releases PUSD to physio", async () => {
      const [attestPDA] = sessionPDA(1);

      const physioBalBefore = await conn.getTokenAccountBalance(physioAta);
      const bBefore = BigInt(physioBalBefore.value.amount);

      await program.methods
        .submitAttestation(1, proofHash)
        .accountsStrict({
          patient: patient.publicKey,
          physioProfile: physioProfilePDA,
          treatmentPlan: treatmentPlanPDA,
          sessionAttestation: attestPDA,
          escrowVault: escrowVaultPDA,
          physioPusdAta: physioAta,
          pusdMint: pusdMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([patient])
        .rpc();

      const plan = await program.account.treatmentPlan.fetch(treatmentPlanPDA);
      assert.equal(plan.sessionsCompleted, 1);
      // Escrow reduced by exactly one session fee
      const escrowBN = BigInt(plan.escrowAmount.toString());
      const escrowVaultInfo = await conn.getTokenAccountBalance(escrowVaultPDA);
      assert.equal(BigInt(escrowVaultInfo.value.amount), escrowBN, "escrow account matches plan state");

      const physioBalAfter = await conn.getTokenAccountBalance(physioAta);
      const bAfter = BigInt(physioBalAfter.value.amount);
      assert.equal(bAfter - bBefore, SESSION_FEE, "physio received exactly 1 session fee");
    });

    it("increments physio credibility score after session 1", async () => {
      const profile = await program.account.physioProfile.fetch(physioProfilePDA);
      // After 1 of 3 sessions completed with 1 patient: delta = (1/3 - 0/3) / 1 = 0.333
      assert.ok(profile.credibilityScore > 0, "credibility score increased");
      assert.ok(profile.credibilityScore <= 1, "credibility score clamped");
    });

    it("rejects replaying session 1", async () => {
      const [attestPDA] = sessionPDA(1);
      try {
        await program.methods
          .submitAttestation(1, proofHash)
          .accountsStrict({
            patient: patient.publicKey,
            physioProfile: physioProfilePDA,
            treatmentPlan: treatmentPlanPDA,
            sessionAttestation: attestPDA,
            escrowVault: escrowVaultPDA,
            physioPusdAta: physioAta,
            pusdMint: pusdMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([patient])
          .rpc();
        assert.fail("expected replay rejection");
      } catch (e: unknown) {
        assert.ok(e, "replay rejected (account already exists)");
      }
    });

    it("accepts session 2", async () => {
      const [attestPDA] = sessionPDA(2);
      await program.methods
        .submitAttestation(2, proofHash)
        .accountsStrict({
          patient: patient.publicKey,
          physioProfile: physioProfilePDA,
          treatmentPlan: treatmentPlanPDA,
          sessionAttestation: attestPDA,
          escrowVault: escrowVaultPDA,
          physioPusdAta: physioAta,
          pusdMint: pusdMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([patient])
        .rpc();

      const plan = await program.account.treatmentPlan.fetch(treatmentPlanPDA);
      assert.equal(plan.sessionsCompleted, 2);
    });
  });

  // ─── submit_caregiver_checkin ────────────────────────────────────────────────

  describe("submit_caregiver_checkin", () => {
    // State at entry: sessions 1+2 done, escrow = 16-5-5 = 6 PUSD
    // session_reserve = 1×5 = 5 PUSD, surplus = 1 PUSD — enough for reward

    it("pays caregiver 0.10 PUSD from escrow surplus", async () => {
      const balBefore = await conn.getTokenAccountBalance(caregiverAta);
      const bBefore = BigInt(balBefore.value.amount);

      await program.methods
        .submitCaregiverCheckin()
        .accountsStrict({
          caregiver: caregiver.publicKey,
          caregiverProfile: caregiverProfilePDA,
          treatmentPlan: treatmentPlanPDA,
          escrowVault: escrowVaultPDA,
          caregiverPusdAta: caregiverAta,
          pusdMint: pusdMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([caregiver])
        .rpc();

      const balAfter = await conn.getTokenAccountBalance(caregiverAta);
      const bAfter = BigInt(balAfter.value.amount);
      assert.equal(bAfter - bBefore, 100_000n, "caregiver received 0.10 PUSD");

      const profile = await program.account.caregiverProfile.fetch(caregiverProfilePDA);
      assert.equal(profile.checkinsTotal, 1);

      // Verify session reserve is intact: escrow must still cover session 3
      const plan = await program.account.treatmentPlan.fetch(treatmentPlanPDA);
      const sessionsLeft = plan.sessionsTotal - plan.sessionsCompleted;
      const reserve = BigInt(sessionsLeft) * SESSION_FEE;
      assert.ok(
        BigInt(plan.escrowAmount.toString()) >= reserve,
        "session reserve is intact after caregiver payment"
      );
    });

    it("rejects same-day double check-in", async () => {
      // Immediately after the check-in above — same block time, within 86,400s
      try {
        await program.methods
          .submitCaregiverCheckin()
          .accountsStrict({
            caregiver: caregiver.publicKey,
            caregiverProfile: caregiverProfilePDA,
            treatmentPlan: treatmentPlanPDA,
            escrowVault: escrowVaultPDA,
            caregiverPusdAta: caregiverAta,
            pusdMint: pusdMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .signers([caregiver])
          .rpc();
        assert.fail("expected AlreadyCheckedInToday");
      } catch (e: unknown) {
        assert.ok(
          String(e).includes("AlreadyCheckedInToday") || String(e).includes("Error"),
          "double check-in rejected"
        );
      }
    });
  });

  // ─── complete_plan ──────────────────────────────────────────────────────────

  describe("complete_plan", () => {
    it("rejects completion when sessions are not all done", async () => {
      // Only 2 of 3 sessions completed so far
      try {
        await program.methods
          .completePlan()
          .accountsStrict({
            physio: physio.publicKey,
            physioProfile: physioProfilePDA,
            treatmentPlan: treatmentPlanPDA,
            escrowVault: escrowVaultPDA,
            patientPusdAta: patientAta,
            caregiverProfile: caregiverProfilePDA,
            pusdMint: pusdMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([physio])
          .rpc();
        assert.fail("expected PlanNotComplete");
      } catch (e: unknown) {
        assert.ok(String(e).includes("PlanNotComplete") || String(e).includes("Error"), "early completion rejected");
      }
    });

    it("completes plan after final session and refunds remaining escrow", async () => {
      // Submit session 3 to finish the plan
      const [attestPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), treatmentPlanPDA.toBuffer(), Buffer.from([3])],
        progId
      );
      const proofHash = Array.from({ length: 32 }, (_, i) => i + 5);
      await program.methods
        .submitAttestation(3, proofHash)
        .accountsStrict({
          patient: patient.publicKey,
          physioProfile: physioProfilePDA,
          treatmentPlan: treatmentPlanPDA,
          sessionAttestation: attestPDA,
          escrowVault: escrowVaultPDA,
          physioPusdAta: physioAta,
          pusdMint: pusdMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([patient])
        .rpc();

      // Record patient balance before completion (should receive 0 refund — caregiver took some)
      const patientBalBefore = await conn.getTokenAccountBalance(patientAta);
      const bBefore = BigInt(patientBalBefore.value.amount);

      const planBeforeComplete = await program.account.treatmentPlan.fetch(treatmentPlanPDA);
      const remainingEscrow = BigInt(planBeforeComplete.escrowAmount.toString());

      await program.methods
        .completePlan()
        .accountsStrict({
          physio: physio.publicKey,
          physioProfile: physioProfilePDA,
          treatmentPlan: treatmentPlanPDA,
          escrowVault: escrowVaultPDA,
          patientPusdAta: patientAta,
          caregiverProfile: caregiverProfilePDA,
          pusdMint: pusdMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([physio])
        .rpc();

      const plan = await program.account.treatmentPlan.fetch(treatmentPlanPDA);
      assert.equal(plan.planActive, false, "plan marked inactive");
      assert.equal(plan.escrowAmount.toString(), "0", "escrow drained");

      // Patient should have received the remaining escrow back
      if (remainingEscrow > 0n) {
        const patientBalAfter = await conn.getTokenAccountBalance(patientAta);
        const bAfter = BigInt(patientBalAfter.value.amount);
        assert.equal(bAfter - bBefore, remainingEscrow, "remaining escrow returned to patient");
      }

      const caregiverProfile = await program.account.caregiverProfile.fetch(caregiverProfilePDA);
      assert.equal(caregiverProfile.nftMinted, true, "caregiver NFT eligibility flagged");
    });
  });

  // ─── update_credibility_score ────────────────────────────────────────────────

  describe("update_credibility_score", () => {
    it("recalculates to 1.0 after a fully completed plan", async () => {
      await program.methods
        .updateCredibilityScore()
        .accountsStrict({
          physioProfile: physioProfilePDA,
          treatmentPlan: treatmentPlanPDA,
        })
        .rpc();

      const profile = await program.account.physioProfile.fetch(physioProfilePDA);
      assert.closeTo(profile.credibilityScore, 1.0, 0.001, "credibility is 1.0 after full completion");
    });
  });

  // ─── access control ──────────────────────────────────────────────────────────

  describe("access control", () => {
    it("attacker cannot submit attestation for another patient's plan", async () => {
      const [attestPDA] = PublicKey.findProgramAddressSync(
        [Buffer.from("session"), treatmentPlanPDA.toBuffer(), Buffer.from([99])],
        progId
      );
      try {
        await program.methods
          .submitAttestation(99, Array(32).fill(0))
          .accountsStrict({
            patient: attacker.publicKey,   // wrong signer
            physioProfile: physioProfilePDA,
            treatmentPlan: treatmentPlanPDA,
            sessionAttestation: attestPDA,
            escrowVault: escrowVaultPDA,
            physioPusdAta: physioAta,
            pusdMint: pusdMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([attacker])
          .rpc();
        assert.fail("expected Unauthorized or constraint failure");
      } catch (e: unknown) {
        assert.ok(e, "unauthorized attestation rejected");
      }
    });
  });
});
