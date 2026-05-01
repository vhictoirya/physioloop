"use client";

import { Suspense } from "react";
import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import IDL from "../../physioloop_idl.json";
import {
  getCaregiverProfilePDA,
  pusdToDisplay,
} from "@/lib/anchor";
import { RPC_ENDPOINT } from "@/lib/constants";

interface PlanData {
  physio: PublicKey;
  patient: PublicKey;
  patientName: string;
  caregiverName: string;
  sessionsTotal: number;
  sessionsCompleted: number;
  pusdPerSession: number;
  planActive: boolean;
}

interface CaregiverData {
  checkinsTotal: number;
  checkinsStreak: number;
  pusdEarned: number;
}

type Screen = "checkin" | "earnings";
type CheckinPhase = "pending" | "submitting" | "done" | "error";

function signTx(tx: Parameters<AnchorProvider["wallet"]["signTransaction"]>[0], keypair: Keypair) {
  if ("partialSign" in tx && typeof (tx as { partialSign: unknown }).partialSign === "function") {
    (tx as { partialSign: (s: Keypair) => void }).partialSign(keypair);
  } else if ("sign" in tx && typeof tx.sign === "function") {
    (tx as { sign: (s: Keypair[]) => void }).sign([keypair]);
  }
  return tx;
}

function makeProgram(keypair: Keypair) {
  const connection = new Connection(RPC_ENDPOINT, "confirmed");
  const wallet = {
    publicKey: keypair.publicKey,
    signTransaction: async (tx: Parameters<AnchorProvider["wallet"]["signTransaction"]>[0]) => signTx(tx, keypair),
    signAllTransactions: async (txs: Parameters<AnchorProvider["wallet"]["signAllTransactions"]>[0]) => {
      txs.forEach((tx) => signTx(tx, keypair));
      return txs;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provider = new AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { program: new Program(IDL as any, provider), connection, provider };
}

export default function CaregiverPageWrapper() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50 flex items-center justify-center"><div className="w-10 h-10 border-2 border-green-500 border-t-transparent rounded-full animate-spin" /></div>}>
      <CaregiverPage />
    </Suspense>
  );
}

function CaregiverPage() {
  const params = useSearchParams();
  const planParam = params.get("plan");
  const keyParam = params.get("key");
  const nameParam = params.get("name") ?? "there";
  const patientName = params.get("patient") ?? "your patient";

  const [keypair, setKeypair] = useState<Keypair | null>(null);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [caregiverData, setCaregiverData] = useState<CaregiverData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>("checkin");
  const [phase, setPhase] = useState<CheckinPhase>("pending");
  const [checkinError, setCheckinError] = useState<string | null>(null);

  useEffect(() => {
    if (!keyParam) { setLoadError("Missing access key."); setLoading(false); return; }
    try {
      setKeypair(Keypair.fromSecretKey(bs58.decode(keyParam)));
    } catch {
      setLoadError("Invalid access key.");
      setLoading(false);
    }
  }, [keyParam]);

  const fetchData = useCallback(async () => {
    if (!keypair || !planParam) return;
    setLoading(true);
    try {
      const { program } = makeProgram(keypair);
      const planPDA = new PublicKey(planParam);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await (program.account as any).treatmentPlan.fetch(planPDA) as Record<string, unknown>;
      setPlan({
        physio: raw.physio as PublicKey,
        patient: raw.patient as PublicKey,
        patientName: raw.patientName as string,
        caregiverName: raw.caregiverName as string,
        sessionsTotal: raw.sessionsTotal as number,
        sessionsCompleted: raw.sessionsCompleted as number,
        pusdPerSession: (raw.pusdPerSession as BN).toNumber(),
        planActive: raw.planActive as boolean,
      });

      // Try to fetch caregiver profile
      const [caregiverProfilePDA] = getCaregiverProfilePDA(keypair.publicKey);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cg = await (program.account as any).caregiverProfile.fetch(caregiverProfilePDA) as Record<string, unknown>;
        setCaregiverData({
          checkinsTotal: cg.checkinsTotal as number,
          checkinsStreak: cg.checkinsStreak as number,
          pusdEarned: (cg.pusdEarned as BN).toNumber(),
        });
      } catch {
        // Not yet registered — will register on first check-in
        setCaregiverData(null);
      }
    } catch (err) {
      setLoadError("Could not load the treatment plan. Check your link.");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [keypair, planParam]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleCheckin = useCallback(async () => {
    if (!keypair || !plan || !planParam || phase !== "pending") return;
    setPhase("submitting");

    try {
      const res = await fetch("/api/caregiver-checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caregiverSecretKey: bs58.encode(keypair.secretKey),
          planAddress:        planParam,
          physioPublicKey:    plan.physio.toBase58(),
          patientPublicKey:   plan.patient.toBase58(),
        }),
      });

      const json = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !json.success) throw new Error(json.error ?? "Check-in failed");

      setPhase("done");
      await fetchData();

      fetch("/api/torque/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "physioloop_caregiver_checkin",
          userPublicKey: keypair.publicKey.toBase58(),
          metadata: {
            patient:      plan.patient.toBase58(),
            streak_count: (caregiverData?.checkinsTotal ?? 0) + 1,
          },
        }),
      }).catch(() => {});
    } catch (err) {
      console.error("[caregiver] checkin error:", err);
      setCheckinError(err instanceof Error ? err.message : "Check-in failed");
      setPhase("error");
    }
  }, [keypair, plan, planParam, phase, caregiverData, fetchData]);

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center text-gray-400">
          <div className="w-10 h-10 border-2 border-green-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm">Loading…</p>
        </div>
      </main>
    );
  }

  if (loadError || !plan) {
    return (
      <main className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="text-center max-w-sm">
          <p className="text-4xl mb-4">⚠️</p>
          <p className="text-gray-700 font-medium">{loadError ?? "Something went wrong."}</p>
          <p className="text-sm text-gray-400 mt-2">Contact the physiotherapist for a new link.</p>
        </div>
      </main>
    );
  }

  const totalEarned = caregiverData?.pusdEarned ?? 0;
  const streak = caregiverData?.checkinsStreak ?? 0;
  const checksTotal = caregiverData?.checkinsTotal ?? 0;
  const consistencyPct = plan.sessionsTotal > 0 ? Math.round((checksTotal / Math.max(plan.sessionsCompleted, 1)) * 100) : 0;
  const certPct = Math.min(Math.round((checksTotal / plan.sessionsTotal) * 100), 100);

  return (
    <main className="min-h-screen bg-gray-50 flex flex-col max-w-sm mx-auto">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">🩺</span>
          <span className="font-bold text-gray-900 text-sm">PhysioLoop</span>
        </div>
        <span className="text-xs text-green-600 font-medium">Care supporter</span>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {screen === "checkin" ? (
          <>
            <h1 className="text-xl font-bold text-gray-900">Hi {nameParam} 👋</h1>

            <div className="rounded-2xl bg-white border border-gray-200 p-5 shadow-sm text-center space-y-4">
              <p className="text-base font-semibold text-gray-800">
                {patientName}&apos;s check-in for today
              </p>
              <p className="text-sm text-gray-600">
                Has {patientName} done their exercises today?
              </p>

              {phase === "pending" && (
                <div className="flex gap-3">
                  <button
                    onClick={handleCheckin}
                    className="flex-1 rounded-2xl bg-green-500 py-4 text-lg font-bold text-white hover:bg-green-600 transition-colors"
                  >
                    ✅ YES
                  </button>
                  <a
                    href={`https://wa.me/?text=${encodeURIComponent(`Hi ${patientName}, just a reminder to do your exercises today! 💪`)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 rounded-2xl bg-gray-100 py-4 text-base font-bold text-gray-600 hover:bg-gray-200 transition-colors flex items-center justify-center"
                  >
                    ❌ NOT YET
                  </a>
                </div>
              )}

              {phase === "submitting" && (
                <div className="py-4">
                  <div className="w-8 h-8 border-2 border-green-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                  <p className="text-sm text-gray-500">Recording check-in…</p>
                </div>
              )}

              {phase === "done" && (
                <div className="space-y-2">
                  <p className="text-green-600 font-bold text-lg">✅ Check-in recorded</p>
                  <p className="text-sm text-gray-600">You earned $0.25 PUSD today</p>
                  {streak > 0 && <p className="text-sm font-medium text-orange-500">{streak}-day streak 🔥</p>}
                </div>
              )}

              {phase === "error" && (
                <div className="space-y-2">
                  <p className="text-red-600 font-medium">Check-in failed</p>
                  {checkinError && (
                    <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2 text-left leading-relaxed">
                      {checkinError.includes("AlreadyCheckedInToday")
                        ? "Already checked in — please wait 5 minutes before checking in again."
                        : checkinError.slice(0, 200)}
                    </p>
                  )}
                  <button onClick={() => { setPhase("pending"); setCheckinError(null); }} className="text-sm text-green-600 underline">
                    Retry
                  </button>
                </div>
              )}
            </div>

            {/* NOT YET — reminder note */}
            {phase === "pending" && (
              <p className="text-xs text-gray-400 text-center">
                Tap ❌ NOT YET to send {patientName} a WhatsApp reminder
              </p>
            )}

            <div className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm space-y-2">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Your earnings</p>
              <p className="text-2xl font-bold text-gray-900">${pusdToDisplay(totalEarned)}</p>
              <p className="text-xs text-gray-400">Total earned · {checksTotal} check-ins</p>
            </div>

          </>
        ) : (
          <>
            <h2 className="text-xl font-bold text-gray-900">Your Care Record</h2>

            <div className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-600">Total earned</span>
                <span className="text-xl font-bold text-gray-900">${pusdToDisplay(totalEarned)}</span>
              </div>
              <button className="w-full rounded-xl border-2 border-dashed border-gray-200 py-2.5 text-sm font-medium text-gray-500 hover:border-green-300 hover:text-green-600 transition-colors">
                Withdraw to bank / M-Pesa
              </button>
            </div>

            <div className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Check-in streak</span>
                <span className="font-semibold">{streak} days 🔥</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Consistency score</span>
                <span className="font-semibold text-green-700">{consistencyPct}%</span>
              </div>
            </div>

            <div className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm space-y-3">
              <p className="text-sm font-semibold text-gray-800">Care Certificate Progress</p>
              <div className="w-full bg-gray-100 rounded-full h-3 overflow-hidden">
                <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${certPct}%` }} />
              </div>
              <p className="text-xs text-gray-400">{certPct}% complete</p>
              <p className="text-xs text-gray-600">
                Complete {patientName}&apos;s full programme to earn your verified Care Certificate —
                usable on job applications.
              </p>
              <button className="w-full rounded-xl bg-gray-50 border border-gray-200 py-2 text-xs font-medium text-gray-600 hover:bg-gray-100 transition-colors">
                See what the certificate looks like
              </button>
            </div>
          </>
        )}
      </div>

      {/* Bottom nav */}
      <nav className="bg-white border-t border-gray-200 flex">
        {(["checkin", "earnings"] as Screen[]).map((s) => {
          const icons = { checkin: "✅", earnings: "💰" };
          const labels = { checkin: "Check-in", earnings: "My Record" };
          return (
            <button
              key={s}
              onClick={() => setScreen(s)}
              className={`flex-1 py-3 flex flex-col items-center gap-0.5 text-xs font-medium transition-colors ${
                screen === s ? "text-green-600" : "text-gray-400"
              }`}
            >
              <span className="text-lg">{icons[s]}</span>
              {labels[s]}
            </button>
          );
        })}
      </nav>
    </main>
  );
}
