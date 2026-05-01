"use client";

import { FC, useState } from "react";

export interface TorqueChainStats {
  totalSessions: number;
  totalPlans: number;
  activePlans: number;
  plansCompleted: number;
  caregiverCheckins: number;
}

export interface TorquePatientProgress {
  sessionsCompleted: number;
  sessionsTotal: number;
  planActive: boolean;
  planCompleted: boolean;
  firstRepClaimed: boolean;
  streakClaimed: boolean;
  caregiverStreakCount?: number;
  cgFirstCheckinClaimed?: boolean;
  cgStreak7Claimed?: boolean;
  physioRank?: number | null;
  rafflePotUsd?: number;
  campaignPoolUsd?: number;
}

// ── Shared primitives ────────────────────────────────────────────────────────

function StatusBadge({ status, date }: { status: "claimed" | "progress" | "locked" | "active"; date?: string }) {
  if (status === "claimed") return (
    <span className="flex items-center gap-1 text-[10px] font-semibold text-green-700 bg-green-100 rounded-full px-2 py-0.5 whitespace-nowrap">
      ✅ Claimed{date ? ` · ${date}` : ""}
    </span>
  );
  if (status === "progress") return (
    <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-100 rounded-full px-2 py-0.5 whitespace-nowrap">
      ⏳ In progress
    </span>
  );
  if (status === "active") return (
    <span className="flex items-center gap-1 text-[10px] font-semibold text-blue-700 bg-blue-100 rounded-full px-2 py-0.5 whitespace-nowrap">
      🎯 Active
    </span>
  );
  return (
    <span className="flex items-center gap-1 text-[10px] font-semibold text-gray-500 bg-gray-100 rounded-full px-2 py-0.5 whitespace-nowrap">
      🔒 Locked
    </span>
  );
}

function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = Math.min(100, Math.round((current / total) * 100));
  const remaining = total - current;
  return (
    <div className="mt-2">
      <div className="flex justify-between text-[10px] text-gray-500 mb-1">
        <span>{current} of {total} sessions</span>
        <span>{remaining > 0 ? `${remaining} to go` : "Complete!"}</span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-200 overflow-hidden">
        <div className="h-full rounded-full bg-amber-400 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function DayProgressBar({ current, total }: { current: number; total: number }) {
  const pct = Math.min(100, Math.round((current / total) * 100));
  const remaining = total - current;
  return (
    <div className="mt-2">
      <div className="flex justify-between text-[10px] text-gray-500 mb-1">
        <span>{current} of {total} days</span>
        <span>{remaining > 0 ? `${remaining} to go` : "Complete!"}</span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-200 overflow-hidden">
        <div className="h-full rounded-full bg-blue-400 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function TechDetail({ c, onClose }: {
  c: { torqueEvent: string; trigger: string; delivery: string; examplePayload: object };
  onClose: () => void;
}) {
  return (
    <div className="mt-2 rounded-xl border border-purple-200 bg-white p-3 space-y-2 text-xs">
      <div className="flex items-center justify-between">
        <p className="font-semibold text-purple-900 text-[11px]">Torque Integration</p>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
      </div>
      <div>
        <p className="text-[10px] font-semibold text-purple-500 uppercase tracking-wider mb-1">Event</p>
        <code className="block bg-purple-50 text-purple-800 rounded px-2 py-1 font-mono text-[10px]">{c.torqueEvent}</code>
      </div>
      <div>
        <p className="text-[10px] font-semibold text-purple-500 uppercase tracking-wider mb-1">Trigger</p>
        <p className="text-gray-600 text-[11px] leading-relaxed">{c.trigger}</p>
      </div>
      <div>
        <p className="text-[10px] font-semibold text-purple-500 uppercase tracking-wider mb-1">Delivery</p>
        <p className="text-gray-600 text-[11px] leading-relaxed">{c.delivery}</p>
      </div>
      <div>
        <p className="text-[10px] font-semibold text-purple-500 uppercase tracking-wider mb-1">Example payload</p>
        <pre className="bg-gray-900 text-green-400 rounded px-2 py-1.5 overflow-x-auto text-[10px] font-mono">
          {JSON.stringify(c.examplePayload, null, 2)}
        </pre>
      </div>
    </div>
  );
}

// ── Campaign card ─────────────────────────────────────────────────────────────

interface CampaignCardProps {
  icon: string;
  title: string;
  reward: string;
  description: string;
  timing?: string;
  status?: "claimed" | "progress" | "locked" | "active";
  claimedDate?: string;
  progressBar?: React.ReactNode;
  extra?: React.ReactNode;
  tech: { torqueEvent: string; trigger: string; delivery: string; examplePayload: object };
  techId: string;
  expandedTech: string | null;
  onToggleTech: (id: string) => void;
}

function CampaignCard({
  icon, title, reward, description, timing, status, claimedDate,
  progressBar, extra, tech, techId, expandedTech, onToggleTech,
}: CampaignCardProps) {
  const isExpanded = expandedTech === techId;
  return (
    <div className={`rounded-xl border px-4 py-3 transition-all ${
      status === "claimed" ? "bg-green-50 border-green-200" :
      status === "progress" ? "bg-amber-50 border-amber-200" :
      status === "locked" ? "bg-gray-50 border-gray-200 opacity-75" :
      "bg-white border-purple-100 hover:border-purple-300"
    }`}>
      <div className="flex items-start gap-3">
        <span className="text-xl flex-shrink-0 mt-0.5">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xs font-semibold text-gray-900">{title}</p>
            <span className="text-[10px] font-medium bg-purple-100 text-purple-700 rounded-full px-2 py-0.5">{reward}</span>
            {status && <StatusBadge status={status} date={claimedDate} />}
          </div>
          <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{description}</p>
          {timing && <p className="text-[10px] text-purple-400 mt-1">{timing}</p>}
          {progressBar}
          {extra}
        </div>
        <button
          onClick={() => onToggleTech(techId)}
          className="text-[10px] text-purple-400 hover:text-purple-600 flex-shrink-0 mt-0.5"
        >
          {isExpanded ? "▲" : "▼"}
        </button>
      </div>
      {isExpanded && <TechDetail c={tech} onClose={() => onToggleTech(techId)} />}
    </div>
  );
}

// ── Stat pill ─────────────────────────────────────────────────────────────────

function StatPill({ label, value, color = "purple" }: { label: string; value: number | string; color?: "purple" | "green" | "blue" | "orange" }) {
  const colors = {
    purple: "bg-purple-100 text-purple-800",
    green: "bg-green-100 text-green-800",
    blue: "bg-blue-100 text-blue-800",
    orange: "bg-orange-100 text-orange-800",
  };
  return (
    <div className={`rounded-lg px-3 py-2 text-center ${colors[color]}`}>
      <p className="text-lg font-bold leading-none">{value}</p>
      <p className="text-[10px] font-medium mt-0.5 opacity-80">{label}</p>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface TorqueCampaignBannerProps {
  className?: string;
  chainStats?: TorqueChainStats;
  progress?: TorquePatientProgress;
}

export const TorqueCampaignBanner: FC<TorqueCampaignBannerProps> = ({ className = "", chainStats, progress }) => {
  const [expandedTech, setExpandedTech] = useState<string | null>(null);
  const toggleTech = (id: string) => setExpandedTech(prev => prev === id ? null : id);

  const hasData = !!chainStats;
  const sessions          = chainStats?.totalSessions ?? 0;
  const caregiverCheckins = chainStats?.caregiverCheckins ?? 0;
  const activePlans       = chainStats?.activePlans ?? 0;
  const plansCompleted    = chainStats?.plansCompleted ?? 0;

  const sc          = progress?.sessionsCompleted ?? 0;
  const cgStreak    = progress?.caregiverStreakCount ?? 0;
  const campaignPool = progress?.campaignPoolUsd ?? 0;

  const now = new Date();
  const nextDraw = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const nextDrawStr = nextDraw.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  return (
    <section className={`rounded-2xl border border-purple-200 bg-gradient-to-br from-purple-50 to-violet-50 p-5 ${className}`}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <div className="w-7 h-7 rounded-lg bg-purple-600 flex items-center justify-center">
          <span className="text-white text-xs font-bold">T</span>
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-purple-900">Growth Campaigns · Powered by Torque</h3>
          <p className="text-xs text-purple-600">Every reward fires on a verified on-chain event. Click ▼ to see the integration.</p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${hasData ? "bg-green-500 animate-pulse" : "bg-gray-300"}`} />
          <span className="text-[10px] text-purple-500 font-medium">LIVE</span>
        </div>
      </div>

      {/* Live stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <StatPill label="Sessions verified"    value={hasData ? sessions          : "…"} color="green"  />
        <StatPill label="Caregiver check-ins"  value={hasData ? caregiverCheckins : "…"} color="blue"   />
        <StatPill label="Plans active"         value={hasData ? activePlans       : "…"} color="orange" />
        <StatPill label="Plans completed"      value={hasData ? plansCompleted    : "…"} color="purple" />
      </div>

      <div className="space-y-4">

        {/* ── Patient Rewards ────────────────────────────────────────────── */}
        <div>
          <p className="text-[10px] font-semibold text-purple-500 uppercase tracking-wider mb-2">Patient Rewards</p>
          <div className="space-y-2">

            <CampaignCard
              icon="🎁" title="First Rep Gift" reward="$0.50 PUSD"
              description="Automatically minted after the first verified session confirms on-chain."
              timing="One-time · fires once permanently"
              status={progress ? (progress.firstRepClaimed ? "claimed" : "locked") : undefined}
              claimedDate={progress?.firstRepClaimed ? "Apr 28" : undefined}
              tech={{
                torqueEvent: "physioloop_session_completed",
                trigger: "submit_attestation ix confirms → session_number === 1",
                delivery: "Direct PUSD mint · /api/payout · reason: patient_first_rep_gift",
                examplePayload: { eventName: "physioloop_session_completed", userPubkey: "patient_wallet", data: { session_number: 1, sessions_total: 12, tx_signature: "5xK3…" } },
              }}
              techId="first_rep" expandedTech={expandedTech} onToggleTech={toggleTech}
            />

            <CampaignCard
              icon="🔥" title="7-Session Streak" reward="$0.50 PUSD"
              description="Complete 7 consecutive verified sessions and receive $0.50 PUSD directly to your wallet."
              timing="Rolling · 7 days from first session"
              status={progress
                ? (progress.streakClaimed ? "claimed" : sc > 0 ? "progress" : "locked")
                : undefined}
              progressBar={progress && sc > 0 && !progress.streakClaimed
                ? <ProgressBar current={Math.min(sc, 7)} total={7} />
                : undefined}
              tech={{
                torqueEvent: "physioloop_streak_milestone",
                trigger: "submit_attestation confirms → session_number === 7",
                delivery: "Direct PUSD mint · /api/payout · reason: patient_streak_7_rebate",
                examplePayload: { eventName: "physioloop_streak_milestone", userPubkey: "patient_wallet", data: { streak_length: 7, tx_signature: "8mL9…" } },
              }}
              techId="streak" expandedTech={expandedTech} onToggleTech={toggleTech}
            />

            <CampaignCard
              icon="🏆" title="Plan Completion Raffle" reward="Monthly draw"
              description="$1.00 PUSD enters the raffle pot when you finish your plan. One winner takes the full pot monthly."
              timing={`Monthly · Next draw: ${nextDrawStr}`}
              status={progress
                ? (progress.planCompleted ? "active" : progress.planActive ? "locked" : "locked")
                : undefined}
              extra={
                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-semibold text-amber-700">Current pot</p>
                    <p className="text-sm font-bold text-amber-900">${campaignPool.toFixed(2)} PUSD</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-semibold text-amber-700">Next draw</p>
                    <p className="text-xs font-medium text-amber-800">{nextDrawStr}</p>
                  </div>
                </div>
              }
              tech={{
                torqueEvent: "physioloop_plan_completed",
                trigger: "complete_plan ix confirms → all sessions_completed === sessions_total",
                delivery: "$1.00 minted → Campaign Pool ATA · Monthly draw via /api/admin/raffle/draw",
                examplePayload: { eventName: "physioloop_plan_completed", userPubkey: "patient_wallet", data: { sessions_total: 12, tx_signature: "3nR2…" } },
              }}
              techId="raffle" expandedTech={expandedTech} onToggleTech={toggleTech}
            />
          </div>
        </div>

        {/* ── Caregiver Rewards ─────────────────────────────────────────── */}
        <div>
          <p className="text-[10px] font-semibold text-purple-500 uppercase tracking-wider mb-2">Caregiver Rewards</p>
          <div className="space-y-2">

            <CampaignCard
              icon="👋" title="First Check-In Gift" reward="$0.25 PUSD"
              description="Receive $0.25 PUSD on your first daily check-in for any patient."
              timing="One-time · fires once permanently"
              status={progress ? (progress.cgFirstCheckinClaimed ? "claimed" : cgStreak > 0 ? "active" : "locked") : undefined}
              tech={{
                torqueEvent: "physioloop_caregiver_checkin",
                trigger: "submit_caregiver_checkin ix confirms → streak_count === 1",
                delivery: "Direct PUSD mint · /api/payout · reason: caregiver_first_checkin_gift",
                examplePayload: { eventName: "physioloop_caregiver_checkin", userPubkey: "caregiver_wallet", data: { streak_count: 1, patient_missed_session: false, tx_signature: "9pQ7…" } },
              }}
              techId="cg_first" expandedTech={expandedTech} onToggleTech={toggleTech}
            />

            <CampaignCard
              icon="📅" title="7-Day Streak Bonus" reward="$1.00 PUSD"
              description="Check in every day for 7 days straight and earn $1.00 PUSD."
              timing="Rolling · 7 days from first check-in"
              status={progress
                ? (progress.cgStreak7Claimed ? "claimed" : cgStreak > 0 ? "progress" : "locked")
                : undefined}
              progressBar={progress && cgStreak > 0 && !progress.cgStreak7Claimed
                ? <DayProgressBar current={Math.min(cgStreak, 7)} total={7} />
                : undefined}
              tech={{
                torqueEvent: "physioloop_caregiver_milestone",
                trigger: "submit_caregiver_checkin confirms → streak_count === 7",
                delivery: "Direct PUSD mint · /api/payout · reason: caregiver_streak_7_bonus",
                examplePayload: { eventName: "physioloop_caregiver_milestone", userPubkey: "caregiver_wallet", data: { milestone: "streak_7", streak_count: 7, tx_signature: "2kM4…" } },
              }}
              techId="cg_streak" expandedTech={expandedTech} onToggleTech={toggleTech}
            />

            <CampaignCard
              icon="🚨" title="Rescue Bonus" reward="$0.50 PUSD"
              description="Patient misses a session → caregiver submits check-in → patient completes the missed session within 24 hours → $0.50 PUSD fires to caregiver wallet for the recovery outcome."
              timing="Situational · fires on patient recovery"
              tech={{
                torqueEvent: "physioloop_caregiver_milestone",
                trigger: "submit_caregiver_checkin with patient_missed_session: true + patient recovers within 24h",
                delivery: "Direct PUSD mint · /api/payout · reason: caregiver_rescue_bonus",
                examplePayload: { eventName: "physioloop_caregiver_milestone", userPubkey: "caregiver_wallet", data: { milestone: "rescue", patient_missed_session: true, tx_signature: "7tX1…" } },
              }}
              techId="cg_rescue" expandedTech={expandedTech} onToggleTech={toggleTech}
            />

            <CampaignCard
              icon="✅" title="Plan Completion Bonus" reward="$2.00 PUSD"
              description="Earn $2.00 PUSD when a patient you've been supporting completes their full treatment plan."
              timing="Per plan · fires on plan completion"
              status={progress
                ? (progress.planCompleted ? "active" : progress.planActive ? "locked" : "locked")
                : undefined}
              tech={{
                torqueEvent: "physioloop_caregiver_milestone",
                trigger: "physioloop_plan_completed fires with caregiver assigned",
                delivery: "Direct PUSD mint · /api/payout · reason: caregiver_completion_bonus",
                examplePayload: { eventName: "physioloop_caregiver_milestone", userPubkey: "caregiver_wallet", data: { milestone: "plan_completion", sessions_completed: 12, tx_signature: "6nB8…" } },
              }}
              techId="cg_completion" expandedTech={expandedTech} onToggleTech={toggleTech}
            />
          </div>
        </div>

        {/* ── Physio Rewards ────────────────────────────────────────────── */}
        <div>
          <p className="text-[10px] font-semibold text-purple-500 uppercase tracking-wider mb-2">Physio Rewards</p>
          <div className="space-y-2">
            <CampaignCard
              icon="📊" title="Weekly Leaderboard" reward="$25 / $12 / $5"
              description="Ranked by patient compliance rate. Top 3 physios earn PUSD prizes every week from the subscription prize pool."
              timing={`Weekly · Resets Sunday${progress?.physioRank != null ? ` · Your rank: #${progress.physioRank}` : ""}`}
              extra={
                <div className="mt-2 rounded-lg border border-purple-200 bg-purple-50 px-3 py-2 flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-semibold text-purple-700">Prize pool</p>
                    <p className="text-sm font-bold text-purple-900">${campaignPool.toFixed(2)} PUSD</p>
                  </div>
                  <div className="text-right space-y-0.5">
                    <div className="flex items-center gap-1.5 justify-end">
                      <span className="text-[10px] text-gray-500">#1</span>
                      <span className="text-[10px] font-semibold text-amber-600">$25</span>
                    </div>
                    <div className="flex items-center gap-1.5 justify-end">
                      <span className="text-[10px] text-gray-500">#2</span>
                      <span className="text-[10px] font-semibold text-gray-500">$12</span>
                    </div>
                    <div className="flex items-center gap-1.5 justify-end">
                      <span className="text-[10px] text-gray-500">#3</span>
                      <span className="text-[10px] font-semibold text-gray-500">$5</span>
                    </div>
                  </div>
                </div>
              }
              tech={{
                torqueEvent: "physioloop_session_completed",
                trigger: "Every submit_attestation confirmation — physio enrolled in leaderboard on each session",
                delivery: "Weekly Torque recurring incentive · leaderboard campaign",
                examplePayload: { campaign: "PHYSIO_LEADERBOARD", action: "enroll", userPubkey: "physio_wallet", data: { compliance_rate: 0.91, active_patients: 8 } },
              }}
              techId="leaderboard" expandedTech={expandedTech} onToggleTech={toggleTech}
            />
          </div>
        </div>
      </div>

      <p className="text-[10px] text-purple-400 text-center mt-4">
        Rewards fire on every on-chain QVAC attestation · Sybil-resistant · Powered by Torque
      </p>
    </section>
  );
};
