"use client";

import { FC } from "react";
import { pusdToDisplay, TIER_LABELS } from "@/lib/anchor";

const TIER_PRICES: Record<number, number> = { 1: 5, 2: 15, 3: 50 };

interface PhysioStatsProps {
  credibilityScore: number;
  subscriptionTier: number;
  totalPatients: number;
  activePatients: number;
  completionRate: number;
  totalEarnings: number;
  onRenew?: () => void;
  renewing?: boolean;
  leaderboardPoolUsd?: number;
  leaderboardRank?: number | null;
}

export const PhysioStats: FC<PhysioStatsProps> = ({
  credibilityScore,
  subscriptionTier,
  totalPatients,
  activePatients,
  completionRate,
  totalEarnings,
  onRenew,
  renewing,
  leaderboardPoolUsd,
  leaderboardRank,
}) => {
  const scorePct = Math.round(credibilityScore * 100);
  const ratePct = Math.round(completionRate * 100);
  const tierPrice = TIER_PRICES[subscriptionTier];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
      <StatCard
        label="Credibility Score"
        value={`${scorePct} / 100`}
        sub={TIER_LABELS[subscriptionTier] ?? "Unknown"}
        accent={scorePct >= 80 ? "green" : scorePct >= 50 ? "yellow" : "red"}
      />
      <StatCard
        label="Completion Rate"
        value={`${ratePct}%`}
        sub="across all plans"
        accent="blue"
      />
      <StatCard
        label="Patients"
        value={`${activePatients} active`}
        sub={`${totalPatients} total`}
        accent="purple"
      />
      <StatCard
        label="PUSD Earned"
        value={`$${pusdToDisplay(totalEarnings)}`}
        sub="from session releases"
        accent="green"
      />
      {/* Subscription card with renew button */}
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 flex flex-col justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide opacity-70 text-gray-700">Subscription</p>
          <p className="text-2xl font-bold mt-1 text-gray-900">
            {TIER_LABELS[subscriptionTier] ?? "Unknown"}
          </p>
          <p className="text-xs mt-1 opacity-60 text-gray-700">
            {tierPrice ? `$${tierPrice} PUSD / month` : "—"}
          </p>
        </div>
        {onRenew && (
          <button
            onClick={onRenew}
            disabled={renewing}
            className="mt-3 rounded-lg bg-white border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50 transition-colors"
          >
            {renewing ? "Renewing…" : "Renew →"}
          </button>
        )}
      </div>

      {/* Leaderboard prize pool card */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex flex-col justify-between col-span-2 md:col-span-1">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide opacity-70 text-amber-700">
            📊 Leaderboard Prize Pool
          </p>
          <p className="text-2xl font-bold mt-1 text-amber-900">
            {leaderboardPoolUsd !== undefined
              ? `$${leaderboardPoolUsd.toFixed(2)} PUSD`
              : "—"}
          </p>
          <p className="text-xs mt-1 opacity-60 text-amber-700">
            {leaderboardRank != null
              ? `Your rank: #${leaderboardRank} · Top 3 win weekly`
              : "Weekly prizes: $25 / $12 / $5"}
          </p>
        </div>
        <p className="text-[10px] text-amber-600 mt-2">
          10% of subscriptions → prize pool · Powered by Torque
        </p>
      </div>
    </div>
  );
};

const ACCENT_CLASSES: Record<string, string> = {
  green: "bg-green-50 border-green-200 text-green-700",
  blue: "bg-blue-50 border-blue-200 text-blue-700",
  yellow: "bg-yellow-50 border-yellow-200 text-yellow-700",
  red: "bg-red-50 border-red-200 text-red-700",
  purple: "bg-purple-50 border-purple-200 text-purple-700",
  gray: "bg-gray-50 border-gray-200 text-gray-700",
};

const StatCard: FC<{
  label: string;
  value: string;
  sub: string;
  accent: string;
}> = ({ label, value, sub, accent }) => (
  <div className={`rounded-xl border p-4 ${ACCENT_CLASSES[accent]}`}>
    <p className="text-xs font-medium uppercase tracking-wide opacity-70">{label}</p>
    <p className="text-2xl font-bold mt-1">{value}</p>
    <p className="text-xs mt-1 opacity-60">{sub}</p>
  </div>
);
