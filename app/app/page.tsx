"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, SendTransactionError, Transaction } from "@solana/web3.js";
import {
  usePhysioloopProgram,
  getPhysioProfilePDA,
  pusdToDisplay,
  shortenAddress,
} from "@/lib/anchor";
import { PhysioStats } from "@/components/PhysioStats";
import { PatientTable, PatientRow } from "@/components/PatientTable";
import { CreatePlanModal } from "@/components/CreatePlanModal";
import { TorqueCampaignBanner, type TorqueChainStats } from "@/components/TorqueCampaignBanner";

interface PhysioProfileData {
  subscriptionTier: number;
  credibilityScore: number;
  totalPatients: number;
  activePatients: number;
  completionRate: number;
}

const TIERS = [
  { id: 1, name: "Starter", price: 5, patients: "Up to 20 active patients", color: "green" },
  { id: 2, name: "Professional", price: 15, patients: "Up to 100 active patients", color: "blue" },
  { id: 3, name: "Elite", price: 50, patients: "Unlimited patients", color: "purple" },
] as const;

type TierId = 1 | 2 | 3;

export default function PhysioDashboard() {
  const { publicKey, connected, signTransaction } = useWallet();
  const { program, connection } = usePhysioloopProgram();

  const [profile, setProfile] = useState<PhysioProfileData | null>(null);
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [totalEarnings, setTotalEarnings] = useState(0);
  const [loading, setLoading] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [selectedTier, setSelectedTier] = useState<TierId>(1);
  const [renewing, setRenewing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [leaderboardPoolUsd, setLeaderboardPoolUsd] = useState<number | undefined>(undefined);
  const [leaderboardRank, setLeaderboardRank] = useState<number | null>(null);
  const [campaignPoolUsd, setCampaignPoolUsd] = useState<number>(0);

  const fetchDashboard = useCallback(async () => {
    if (!publicKey || !program) return;
    setLoading(true);

    try {
      // Fetch physio profile
      const [profilePDA] = getPhysioProfilePDA(publicKey);
      let physioData: PhysioProfileData | null = null;

      try {
        const rawProfile = await (
          program.account as Record<string, { fetch: (key: PublicKey) => Promise<Record<string, unknown>> }>
        ).physioProfile.fetch(profilePDA);
        physioData = {
          subscriptionTier: rawProfile.subscriptionTier as number,
          credibilityScore: rawProfile.credibilityScore as number,
          totalPatients: rawProfile.totalPatients as number,
          activePatients: rawProfile.activePatients as number,
          completionRate: rawProfile.completionRate as number,
        };
        setProfile(physioData);
      } catch {
        // Profile not yet registered
        setProfile(null);
      }

      // Use Anchor client to fetch and deserialize all TreatmentPlan accounts for this physio.
      // memcmp filter: physio pubkey starts at byte offset 8 (after discriminator).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plans = await (program.account as any).treatmentPlan.all([
        { memcmp: { offset: 8, bytes: publicKey.toBase58() } },
      ]) as Array<{ publicKey: PublicKey; account: Record<string, unknown> }>;

      let earnings = 0;
      const rows: PatientRow[] = plans.map((p) => {
        const acct = p.account;
        const sessionsCompleted = acct.sessionsCompleted as number;
        const pusdPerSession = (acct.pusdPerSession as { toNumber: () => number }).toNumber();
        // Physio earns 70% of each session fee
        earnings += Math.round(sessionsCompleted * pusdPerSession * 0.7);

        // Parse condition from exercises JSON: new format {"cond":"...","ex":[...]}
        // or legacy array format [...]. Silently fall back to empty string.
        let condition = "";
        try {
          const parsed = JSON.parse(acct.exercises as string);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            condition = (parsed.cond as string) ?? "";
          }
        } catch { /* ignore */ }

        return {
          planAddress: p.publicKey.toBase58(),
          patientAddress: (acct.patient as PublicKey).toBase58(),
          patientName: (acct.patientName as string) ?? "",
          condition,
          sessionsCompleted,
          sessionsTotal: acct.sessionsTotal as number,
          pusdPerSession,
          planActive: acct.planActive as boolean,
          createdAt: (acct.createdAt as { toNumber: () => number }).toNumber(),
        };
      });

      setPatients(rows);
      setTotalEarnings(earnings);
    } finally {
      setLoading(false);
    }

    // Leaderboard pool + ranking (non-blocking)
    fetch(`/api/leaderboard?physio=${publicKey.toBase58()}`)
      .then(r => r.json())
      .then((d: { poolUsd?: number; campaignPoolUsd?: number; physioRank?: number | null }) => {
        if (d.poolUsd !== undefined) setLeaderboardPoolUsd(d.poolUsd);
        if (d.campaignPoolUsd !== undefined) setCampaignPoolUsd(d.campaignPoolUsd);
        if (d.physioRank !== undefined) setLeaderboardRank(d.physioRank ?? null);
      })
      .catch(() => {});
  }, [publicKey, program]);

  useEffect(() => {
    if (connected && publicKey) {
      fetchDashboard();
    } else {
      setProfile(null);
      setPatients([]);
    }
  }, [connected, publicKey, fetchDashboard]);

  const registerPhysio = async () => {
    if (!publicKey || !program || !signTransaction) return;
    setRegistering(true);
    setRegisterError(null);
    try {
      // Server builds partially-signed tx: mint PUSD to physio → transfer to treasury → register_physio
      const res = await fetch("/api/register-physio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ physioPublicKey: publicKey.toBase58(), tier: selectedTier }),
      });
      const json = await res.json() as { transaction?: string; error?: string };
      if (!res.ok || !json.transaction) throw new Error(json.error ?? "Registration failed");

      // Physio signs the transfer + register_physio instructions
      const tx = Transaction.from(Buffer.from(json.transaction, "base64"));
      const signedTx = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signedTx.serialize());
      await connection.confirmTransaction(sig, "confirmed");

      // Torque: enroll physio in leaderboard campaign
      fetch("/api/torque/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "physioloop_physio_registered",
          userPublicKey: publicKey.toBase58(),
          txSignature: sig,
        }),
      }).catch(() => { /* non-fatal */ });

      await fetchDashboard();
    } catch (err) {
      if (err instanceof Error && err.message.includes("already been processed")) {
        await fetchDashboard();
        return;
      }
      const detail = err instanceof SendTransactionError
        ? (await err.getLogs(connection).catch(() => null))?.join("\n") ?? err.message
        : err instanceof Error ? err.message : String(err);
      console.error("Register physio failed:", detail);
      setRegisterError(detail.split("\n")[0]);
    } finally {
      setRegistering(false);
    }
  };

  const renewSubscription = async () => {
    if (!publicKey || !profile || !signTransaction) return;
    setRenewing(true);
    try {
      const res = await fetch("/api/register-physio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Reuse the same endpoint; it's idempotent for the ATA creation steps,
        // and mints + transfers the subscription cost regardless
        body: JSON.stringify({ physioPublicKey: publicKey.toBase58(), tier: profile.subscriptionTier }),
      });
      const json = await res.json() as { transaction?: string; error?: string };
      if (!res.ok || !json.transaction) throw new Error(json.error ?? "Renewal failed");
      const tx = Transaction.from(Buffer.from(json.transaction, "base64"));
      const signedTx = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signedTx.serialize());
      await connection.confirmTransaction(sig, "confirmed");
      console.log("Subscription renewed:", sig);
    } catch (err) {
      console.error("Renewal failed:", err instanceof Error ? err.message : err);
    } finally {
      setRenewing(false);
    }
  };

  // ─── Not connected ────────────────────────────────────────────────────────

  if (!connected) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
        <div className="text-center max-w-sm">
          <div className="w-16 h-16 rounded-2xl bg-green-100 flex items-center justify-center mx-auto mb-4">
            <span className="text-3xl">🩺</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">PhysioLoop</h1>
          <p className="text-gray-500 mt-2">
            Clinical compliance marketplace on Solana. Connect your wallet to access your physio dashboard.
          </p>
        </div>
        <WalletMultiButton />
      </main>
    );
  }

  // ─── Connected but no profile ─────────────────────────────────────────────

  if (!loading && profile === null) {
    const tierColors: Record<TierId, { border: string; bg: string; badge: string; btn: string }> = {
      1: { border: "border-green-400", bg: "bg-green-50", badge: "bg-green-100 text-green-700", btn: "bg-green-600 hover:bg-green-700" },
      2: { border: "border-blue-400",  bg: "bg-blue-50",  badge: "bg-blue-100 text-blue-700",  btn: "bg-blue-600 hover:bg-blue-700"   },
      3: { border: "border-purple-400",bg: "bg-purple-50",badge: "bg-purple-100 text-purple-700",btn:"bg-purple-600 hover:bg-purple-700"},
    };
    const chosen = tierColors[selectedTier];

    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-8">
        <div className="text-center max-w-lg">
          <div className="w-16 h-16 rounded-2xl bg-green-100 flex items-center justify-center mx-auto mb-4">
            <span className="text-3xl">🩺</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Join PhysioLoop</h1>
          <p className="text-gray-500 mt-2 text-sm">
            Choose your plan and pay your first month in PUSD to activate your on-chain PhysioProfile.
          </p>
          <p className="text-xs text-gray-400 mt-1 font-mono">
            {shortenAddress(publicKey!.toBase58(), 8)}
          </p>
        </div>

        {/* Tier cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-2xl">
          {TIERS.map((tier) => {
            const active = selectedTier === tier.id;
            const c = tierColors[tier.id];
            return (
              <button
                key={tier.id}
                onClick={() => setSelectedTier(tier.id)}
                className={`rounded-2xl border-2 p-5 text-left transition-all ${
                  active ? `${c.border} ${c.bg}` : "border-gray-200 bg-white hover:border-gray-300"
                }`}
              >
                <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold mb-3 ${
                  active ? c.badge : "bg-gray-100 text-gray-500"
                }`}>
                  {tier.name}
                </span>
                <p className="text-2xl font-bold text-gray-900">
                  ${tier.price}
                  <span className="text-sm font-normal text-gray-400">/mo</span>
                </p>
                <p className="text-xs text-gray-500 mt-1">{tier.patients}</p>
                {active && (
                  <p className="text-xs font-medium mt-2" style={{ color: "inherit" }}>
                    ✓ Selected
                  </p>
                )}
              </button>
            );
          })}
        </div>

        {/* Payment summary */}
        <div className="rounded-xl bg-gray-50 border border-gray-200 px-6 py-4 text-sm text-gray-600 max-w-sm w-full text-center">
          First month: <span className="font-semibold text-gray-900">
            ${TIERS.find(t => t.id === selectedTier)!.price} PUSD
          </span>
          <span className="text-gray-400 text-xs block mt-0.5">
            Funded by PhysioLoop on devnet — sign to confirm
          </span>
        </div>

        {registerError && (
          <p className="text-sm text-red-600 max-w-sm text-center">{registerError}</p>
        )}

        <button
          onClick={registerPhysio}
          disabled={registering}
          className={`rounded-xl px-8 py-3 text-sm font-semibold text-white transition-colors disabled:opacity-50 ${chosen.btn}`}
        >
          {registering ? "Registering…" : `Activate ${TIERS.find(t => t.id === selectedTier)!.name} Plan`}
        </button>

        <WalletMultiButton />
      </main>
    );
  }

  // ─── Main dashboard ───────────────────────────────────────────────────────

  return (
    <main className="min-h-screen">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xl">🩺</span>
          <span className="font-bold text-gray-900">PhysioLoop</span>
          <span className="rounded-full bg-green-100 text-green-700 text-xs px-2 py-0.5 font-medium">
            Devnet
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400 font-mono hidden md:block">
            {publicKey && shortenAddress(publicKey.toBase58(), 6)}
          </span>
          <WalletMultiButton />
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {/* Page title */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Physio Dashboard</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Manage treatment plans and track patient compliance
            </p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 rounded-xl bg-green-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-green-700 transition-colors"
          >
            <span>+</span>
            New Treatment Plan
          </button>
        </div>

        {/* Stats */}
        {profile && (
          <PhysioStats
            credibilityScore={profile.credibilityScore}
            subscriptionTier={profile.subscriptionTier}
            totalPatients={profile.totalPatients}
            activePatients={profile.activePatients}
            completionRate={profile.completionRate}
            totalEarnings={totalEarnings}
            onRenew={renewSubscription}
            renewing={renewing}
            leaderboardPoolUsd={leaderboardPoolUsd}
            leaderboardRank={leaderboardRank}
          />
        )}

        {/* Torque growth campaigns */}
        {(() => {
          const totalSessions  = patients.reduce((s, p) => s + p.sessionsCompleted, 0);
          const plansCompleted = patients.filter(p => p.sessionsCompleted >= p.sessionsTotal && p.sessionsTotal > 0).length;
          const chainStats: TorqueChainStats | undefined = patients.length > 0 ? {
            totalSessions,
            totalPlans:        patients.length,
            activePlans:       patients.filter(p => p.planActive).length,
            plansCompleted,
            caregiverCheckins: totalSessions,
          } : undefined;
          return (
            <TorqueCampaignBanner
              className="mb-6"
              chainStats={chainStats}
              progress={{
                sessionsCompleted: totalSessions,
                sessionsTotal:     patients.reduce((s, p) => s + p.sessionsTotal, 0),
                planActive:        patients.some(p => p.planActive),
                planCompleted:     plansCompleted > 0,
                firstRepClaimed:   totalSessions >= 1,
                streakClaimed:     totalSessions >= 7,
                physioRank:        leaderboardRank,
                campaignPoolUsd,
              }}
            />
          );
        })()}

        {/* Patient list */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
              Treatment Plans
            </h2>
            <button
              onClick={fetchDashboard}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              Refresh
            </button>
          </div>
          <PatientTable patients={patients} loading={loading} />
        </div>
      </div>

      {/* Create plan modal */}
      {showCreateModal && (
        <CreatePlanModal
          onClose={() => setShowCreateModal(false)}
          onSuccess={() => {
            setShowCreateModal(false);
            fetchDashboard();
          }}
        />
      )}
    </main>
  );
}
