"use client";

import { FC, FormEvent, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, SystemProgram, SendTransactionError } from "@solana/web3.js";
import bs58 from "bs58";
import {
  usePhysioloopProgram,
  getPhysioProfilePDA,
  getTreatmentPlanPDA,
  getEscrowVaultPDA,
  displayToPusd,
  pusdToDisplay,
} from "@/lib/anchor";
import { PUSD_MINT_ADDRESS } from "@/lib/constants";

const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

interface Exercise {
  name: string;
  sets: number;
  reps: number;
}

interface InviteLinks {
  patientUrl: string;
  caregiverUrl: string;
  patientName: string;
  caregiverName: string;
}

interface CreatePlanModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

const DEFAULT_EXERCISES: Exercise[] = [{ name: "", sets: 3, reps: 10 }];

export const CreatePlanModal: FC<CreatePlanModalProps> = ({ onClose, onSuccess }) => {
  const { publicKey } = useWallet();
  const { program } = usePhysioloopProgram();

  const [patientName, setPatientName] = useState("");
  const [caregiverName, setCaregiverName] = useState("");
  const [condition, setCondition] = useState("");
  const [exercises, setExercises] = useState<Exercise[]>(DEFAULT_EXERCISES);
  const [sessions, setSessions] = useState("12");
  const [pusdPerSession, setPusdPerSession] = useState("5.00");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteLinks, setInviteLinks] = useState<InviteLinks | null>(null);
  const [copied, setCopied] = useState<"patient" | "caregiver" | null>(null);

  const addExercise = () => {
    if (exercises.length >= 6) return;
    setExercises((ex) => [...ex, { name: "", sets: 3, reps: 10 }]);
  };

  const removeExercise = (i: number) => {
    setExercises((ex) => ex.filter((_, idx) => idx !== i));
  };

  const updateExercise = (i: number, field: keyof Exercise, value: string | number) => {
    setExercises((ex) => ex.map((e, idx) => idx === i ? { ...e, [field]: value } : e));
  };

  const totalCost = parseInt(sessions || "0") * parseFloat(pusdPerSession || "0");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!publicKey) return;

    const validExercises = exercises.filter((ex) => ex.name.trim());
    if (validExercises.length === 0) {
      setError("Add at least one exercise.");
      return;
    }

    // Pack condition + exercises into a single JSON object stored in the exercises field.
    // Use short keys ("cond", "ex") to stay within the 256-byte on-chain limit.
    const exercisesJson = JSON.stringify({ cond: condition.trim(), ex: validExercises });
    if (exercisesJson.length > 256) {
      setError("Exercise list too long — shorten exercise names or condition.");
      return;
    }

    setError(null);
    setSubmitting(true);

    // Generate keypairs and build invite links BEFORE the RPC call.
    // Plan PDA is deterministic so we can compute it immediately.
    // This means even if Anchor retries and throws "already processed",
    // we still have the links to show the physio.
    const patientKeypair = Keypair.generate();
    const caregiverKeypair = Keypair.generate();
    const patient = patientKeypair.publicKey;
    const caregiver = caregiverKeypair.publicKey;
    const sessionCount = parseInt(sessions, 10);
    const pusdPerSessionBN = displayToPusd(pusdPerSession);
    const pusdMint = new PublicKey(PUSD_MINT_ADDRESS);

    const [physioProfile] = getPhysioProfilePDA(publicKey);
    const [treatmentPlan] = getTreatmentPlanPDA(publicKey, patient);
    const [escrowVault] = getEscrowVaultPDA(treatmentPlan);

    const base = window.location.origin;
    const patientKey = bs58.encode(patientKeypair.secretKey);
    const caregiverKey = bs58.encode(caregiverKeypair.secretKey);
    const planPDA = treatmentPlan.toBase58();
    const links: InviteLinks = {
      patientUrl: `${base}/patient?plan=${planPDA}&key=${patientKey}&name=${encodeURIComponent(patientName.trim())}`,
      caregiverUrl: `${base}/caregiver?plan=${planPDA}&key=${caregiverKey}&name=${encodeURIComponent(caregiverName.trim())}&patient=${encodeURIComponent(patientName.trim())}`,
      patientName: patientName.trim(),
      caregiverName: caregiverName.trim(),
    };

    try {
      const tx = await program.methods
        .createTreatmentPlan(
          sessionCount,
          pusdPerSessionBN,
          patientName.trim(),
          caregiverName.trim(),
          exercisesJson,
        )
        .accountsStrict({
          physioProfile,
          treatmentPlan,
          escrowVault,
          physio: publicKey,
          patient,
          caregiver,
          pusdMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("Treatment plan created:", tx);

      fetch("/api/torque/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "physioloop_plan_started",
          userPublicKey: publicKey.toBase58(),
          txSignature: tx,
          metadata: {
            patient: patient.toBase58(),
            exercise: validExercises[0]?.name ?? "",
            sessions_total: sessionCount,
            pusd_per_session: pusdPerSessionBN.toNumber(),
          },
        }),
      }).catch(() => {});

      setInviteLinks(links);
    } catch (err: unknown) {
      // "Already processed" = tx landed but Anchor's retry fired. Plan IS on-chain.
      // Show the invite links — they're still valid.
      if (err instanceof Error && err.message.includes("This transaction has already been processed")) {
        setInviteLinks(links);
        return;
      }
      if (err instanceof SendTransactionError) {
        const logs = await err.getLogs(program.provider.connection).catch(() => null);
        const logMsg = logs?.find((l) => l.includes("Error") || l.includes("error"));
        setError(logMsg ?? err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const copyLink = (type: "patient" | "caregiver") => {
    const url = type === "patient" ? inviteLinks?.patientUrl : inviteLinks?.caregiverUrl;
    if (!url) return;
    navigator.clipboard.writeText(url);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  };

  const whatsappLink = (url: string, name: string, role: string) => {
    const msg = `Hi ${name}, you've been added to PhysioLoop as a ${role}. Tap this link to get started: ${url}`;
    return `https://wa.me/?text=${encodeURIComponent(msg)}`;
  };

  // ── Success screen: invite links ────────────────────────────────────────────
  if (inviteLinks) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-semibold text-gray-900">Plan Created — Send Invites</h2>
            <button onClick={() => { onSuccess(); onClose(); }} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
          </div>

          <div className="rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800 mb-4">
            Treatment plan is live on Solana. Share these links via WhatsApp or SMS.
          </div>

          {/* Patient link */}
          <div className="mb-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Patient link — {inviteLinks.patientName}
            </p>
            <div className="flex gap-2">
              <input
                readOnly
                value={inviteLinks.patientUrl}
                className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-xs font-mono text-gray-600 bg-gray-50 truncate"
              />
              <button
                onClick={() => copyLink("patient")}
                className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 whitespace-nowrap"
              >
                {copied === "patient" ? "Copied!" : "Copy"}
              </button>
            </div>
            <a
              href={whatsappLink(inviteLinks.patientUrl, inviteLinks.patientName, "patient")}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 flex items-center justify-center gap-2 w-full rounded-lg bg-[#25D366] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#1ebe57] transition-colors"
            >
              <span>📱</span> Send to {inviteLinks.patientName} via WhatsApp
            </a>
          </div>

          {/* Caregiver link */}
          {inviteLinks.caregiverName && (
            <div className="mb-4">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Caregiver link — {inviteLinks.caregiverName}
              </p>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={inviteLinks.caregiverUrl}
                  className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-xs font-mono text-gray-600 bg-gray-50 truncate"
                />
                <button
                  onClick={() => copyLink("caregiver")}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 whitespace-nowrap"
                >
                  {copied === "caregiver" ? "Copied!" : "Copy"}
                </button>
              </div>
              <a
                href={whatsappLink(inviteLinks.caregiverUrl, inviteLinks.caregiverName, "care supporter")}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 flex items-center justify-center gap-2 w-full rounded-lg bg-[#25D366] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#1ebe57] transition-colors"
              >
                <span>📱</span> Send to {inviteLinks.caregiverName} via WhatsApp
              </a>
            </div>
          )}

          <p className="text-[10px] text-gray-400 text-center mt-2">
            Links contain embedded access credentials — share only with the intended recipient.
          </p>
        </div>
      </div>
    );
  }

  // ── Form ─────────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-900">Issue HEP Prescription</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Patient + Caregiver names */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Patient name</label>
              <input
                type="text"
                value={patientName}
                onChange={(e) => setPatientName(e.target.value)}
                placeholder="e.g. Chidi"
                required
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Caregiver name</label>
              <input
                type="text"
                value={caregiverName}
                onChange={(e) => setCaregiverName(e.target.value)}
                placeholder="e.g. Mrs. Ngozi"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
              />
            </div>
          </div>

          {/* Condition */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Condition being managed</label>
            <input
              type="text"
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
              placeholder="e.g. Lower back pain, Post-op knee replacement"
              required
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
            />
          </div>

          {/* Exercise list */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-gray-700">Exercises</label>
              {exercises.length < 6 && (
                <button
                  type="button"
                  onClick={addExercise}
                  className="text-xs text-green-600 font-medium hover:text-green-700"
                >
                  + Add exercise
                </button>
              )}
            </div>
            <div className="space-y-2">
              {exercises.map((ex, i) => (
                <div key={i} className="flex gap-2 items-center rounded-lg border border-gray-200 p-2">
                  <input
                    type="text"
                    value={ex.name}
                    onChange={(e) => updateExercise(i, "name", e.target.value)}
                    placeholder="Exercise name"
                    className="flex-1 rounded border border-gray-200 px-2 py-1.5 text-sm focus:border-green-500 focus:outline-none"
                    required
                  />
                  <div className="flex items-center gap-1 shrink-0">
                    <input
                      type="number"
                      value={ex.sets}
                      onChange={(e) => updateExercise(i, "sets", parseInt(e.target.value) || 1)}
                      min={1} max={5}
                      className="w-12 rounded border border-gray-200 px-1.5 py-1.5 text-sm text-center focus:border-green-500 focus:outline-none"
                    />
                    <span className="text-xs text-gray-400">sets</span>
                    <input
                      type="number"
                      value={ex.reps}
                      onChange={(e) => updateExercise(i, "reps", parseInt(e.target.value) || 1)}
                      min={1} max={50}
                      className="w-12 rounded border border-gray-200 px-1.5 py-1.5 text-sm text-center focus:border-green-500 focus:outline-none"
                    />
                    <span className="text-xs text-gray-400">reps</span>
                  </div>
                  {exercises.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeExercise(i)}
                      className="text-gray-300 hover:text-red-400 text-lg leading-none ml-1"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Sessions + fee */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Sessions (1–60)</label>
              <input
                type="number"
                value={sessions}
                onChange={(e) => setSessions(e.target.value)}
                min={1} max={60} required
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Fee / Session (PUSD $)</label>
              <input
                type="number"
                value={pusdPerSession}
                onChange={(e) => setPusdPerSession(e.target.value)}
                min="0.01" step="0.01" required
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-green-500 focus:outline-none focus:ring-1 focus:ring-green-500"
              />
            </div>
          </div>

          {/* Cost summary */}
          {sessions && pusdPerSession && (
            <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
              <div className="flex justify-between">
                <span>Patient treatment deposit</span>
                <span className="font-semibold">${totalCost.toFixed(2)} PUSD</span>
              </div>
              <p className="text-xs text-green-600 mt-1">
                ${pusdToDisplay(displayToPusd(pusdPerSession).toNumber())} released per verified session.
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{error}</div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? "Creating…" : "Create Plan & Generate Links"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
