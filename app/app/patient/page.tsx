"use client";

import { Suspense } from "react";
import { useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import IDL from "../../physioloop_idl.json";
import {
  getTreatmentPlanPDA,
  getPhysioProfilePDA,
  getEscrowVaultPDA,
  getSessionAttestationPDA,
  pusdToDisplay,
  completionPct,
} from "@/lib/anchor";
import { PROGRAM_ID, RPC_ENDPOINT, PUSD_MINT_ADDRESS } from "@/lib/constants";

interface Exercise { name: string; sets: number; reps: number }

interface PlanData {
  physio: PublicKey;
  patient: PublicKey;
  caregiver: PublicKey;
  patientName: string;
  caregiverName: string;
  condition: string;
  exercises: Exercise[];
  sessionsTotal: number;
  sessionsCompleted: number;
  pusdPerSession: number;
  escrowAmount: number;
  planActive: boolean;
}

type Phase = "idle" | "capturing" | "analyzing" | "submitting" | "success" | "error";
type Tab = "home" | "session" | "progress";

function signTx(tx: Parameters<AnchorProvider["wallet"]["signTransaction"]>[0], keypair: Keypair) {
  if ("partialSign" in tx && typeof (tx as { partialSign: unknown }).partialSign === "function") {
    (tx as { partialSign: (signer: Keypair) => void }).partialSign(keypair);
  } else if ("sign" in tx && typeof tx.sign === "function") {
    (tx as { sign: (signers: Keypair[]) => void }).sign([keypair]);
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

function getHour() { return new Date().getHours(); }
function greeting(name: string) {
  const h = getHour();
  const time = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  return `Good ${time}, ${name} 👋`;
}

// Suppress unused import warnings for PDAs not used directly in this file
void getTreatmentPlanPDA;

export default function PatientPageWrapper() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50 flex items-center justify-center"><div className="w-10 h-10 border-2 border-green-500 border-t-transparent rounded-full animate-spin" /></div>}>
      <PatientPage />
    </Suspense>
  );
}

function PatientPage() {
  const params = useSearchParams();
  const planParam = params.get("plan");
  const keyParam = params.get("key");
  const nameParam = params.get("name") ?? "there";

  const [keypair, setKeypair] = useState<Keypair | null>(null);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [phase, setPhase] = useState<Phase>("idle");
  const [sessionMsg, setSessionMsg] = useState<string | null>(null);
  const [activeExercise, setActiveExercise] = useState(0);
  const [depositing, setDepositing] = useState(false);
  const [depositError, setDepositError] = useState<string | null>(null);

  // Video recording state
  const [recording, setRecording]     = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const [videoBlob, setVideoBlob]     = useState<Blob | null>(null);
  const [videoUrl, setVideoUrl]       = useState<string | null>(null);

  const videoRef         = useRef<HTMLVideoElement>(null);   // live camera
  const previewRef       = useRef<HTMLVideoElement>(null);   // recorded playback
  const streamRef        = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef        = useRef<Blob[]>([]);
  const recTimerRef      = useRef<ReturnType<typeof setInterval> | null>(null);

  const currentEx = plan?.exercises[activeExercise];
  const canVerify = videoBlob !== null;

  // Restore keypair from URL
  useEffect(() => {
    if (!keyParam) { setLoadError("Missing access key in link."); setLoading(false); return; }
    try {
      const secret = bs58.decode(keyParam);
      setKeypair(Keypair.fromSecretKey(secret));
    } catch {
      setLoadError("Invalid access key.");
      setLoading(false);
    }
  }, [keyParam]);

  // Fetch plan from chain
  const fetchPlan = useCallback(async () => {
    if (!keypair || !planParam) return;
    setLoading(true);
    try {
      const { program } = makeProgram(keypair);
      const planPDA = new PublicKey(planParam);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await (program.account as any).treatmentPlan.fetch(planPDA) as Record<string, unknown>;
      let exercises: Exercise[] = [];
      let condition = "";
      try {
        const parsed = JSON.parse(raw.exercises as string);
        if (Array.isArray(parsed)) {
          exercises = parsed;
        } else {
          exercises = (parsed.ex as Exercise[]) ?? [];
          condition = (parsed.cond as string) ?? "";
        }
      } catch { /* ignore */ }
      setPlan({
        physio: raw.physio as PublicKey,
        patient: raw.patient as PublicKey,
        caregiver: raw.caregiver as PublicKey,
        patientName: raw.patientName as string,
        caregiverName: raw.caregiverName as string,
        condition,
        exercises,
        sessionsTotal: raw.sessionsTotal as number,
        sessionsCompleted: raw.sessionsCompleted as number,
        pusdPerSession: (raw.pusdPerSession as BN).toNumber(),
        escrowAmount: (raw.escrowAmount as BN).toNumber(),
        planActive: raw.planActive as boolean,
      });
    } catch (err) {
      setLoadError("Could not load your treatment plan. Check your link.");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [keypair, planParam]);

  useEffect(() => { fetchPlan(); }, [fetchPlan]);

  const handleDeposit = useCallback(async () => {
    if (!keypair || !plan || !planParam) return;
    setDepositing(true);
    setDepositError(null);
    try {
      const depositAmount = plan.sessionsTotal * plan.pusdPerSession;
      const amountUsd = depositAmount / 1_000_000;

      const res = await fetch("/api/activate-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planAddress: planParam,
          patientSecretKey: bs58.encode(keypair.secretKey),
          amountUsd,
          physioPublicKey: plan.physio.toBase58(),
        }),
      });

      const json = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Payment failed");
      }

      await fetchPlan();
    } catch (err) {
      setDepositError(err instanceof Error ? err.message : "Payment failed. Please try again.");
    } finally {
      setDepositing(false);
    }
  }, [keypair, plan, planParam, fetchPlan]);

  // Camera management
  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch {
      setSessionMsg("Camera access denied.");
    }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (tab === "session") startCamera();
    else stopCamera();
    return () => { if (tab !== "session") stopCamera(); };
  }, [tab, startCamera, stopCamera]);

  // Re-attach stream — SessionTab is a nested component so React remounts <video> on parent re-render
  useEffect(() => {
    if (tab === "session" && videoRef.current && streamRef.current && !videoRef.current.srcObject) {
      videoRef.current.srcObject = streamRef.current;
    }
  });

  // Revoke object URL when video is replaced or component unmounts
  useEffect(() => {
    return () => { if (videoUrl) URL.revokeObjectURL(videoUrl); };
  }, [videoUrl]);

  // ── handleVerify ────────────────────────────────────────────────────────────
  const handleVerify = useCallback(async () => {
    if (!keypair || !plan || !planParam || phase !== "idle") return;
    if (!canVerify || !videoBlob) return;

    setPhase("submitting");
    setSessionMsg(null);

    try {
      const sessionNumber = plan.sessionsCompleted + 1;
      const exerciseName  = currentEx?.name ?? "";

      // Hash the recorded video — binds the on-chain proof to real captured footage
      const videoArrayBuf = await videoBlob.arrayBuffer();
      const videoHashBuf  = await crypto.subtle.digest("SHA-256", videoArrayBuf);
      const videoHash     = Array.from(new Uint8Array(videoHashBuf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const encoded = new TextEncoder().encode(
        JSON.stringify({
          plan:              planParam,
          session:           sessionNumber,
          patient:           keypair.publicKey.toBase58(),
          exercise:          exerciseName,
          video_hash:        videoHash,
          video_duration_ms: recordingMs,
          ts:                Date.now(),
        }),
      );
      const hashBuf   = await crypto.subtle.digest("SHA-256", encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer);
      const proofHash = Array.from(new Uint8Array(hashBuf));

      // Ensure all ATAs that submit_attestation writes to exist on-chain (idempotent)
      await fetch("/api/ensure-atas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ physioPublicKey: plan.physio.toBase58() }),
      });

      // Submit attestation to Solana
      const { program } = makeProgram(keypair);
      const planPDA     = new PublicKey(planParam);
      const pusdMint    = new PublicKey(PUSD_MINT_ADDRESS);
      const TOKEN_2022  = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

      const [physioProfile]      = getPhysioProfilePDA(plan.physio);
      const [escrowVault]        = getEscrowVaultPDA(planPDA);
      const [sessionAttestation] = getSessionAttestationPDA(planPDA, sessionNumber);
      const physioAta            = getAssociatedTokenAddressSync(pusdMint, plan.physio, false, TOKEN_2022_PROGRAM_ID);
      const opsTreasuryAta       = new PublicKey("D6TtHc7jrtF3APDcXjTn6hvPnfAyxsw4ndauxvRnM1D3");
      const campaignPoolAta      = new PublicKey("Dt7o6GQxq187EjFjXJLqJUjoCSrT3r7mdBzYNHWLP7Bf");

      await program.methods
        .submitAttestation(sessionNumber, proofHash)
        .accountsStrict({
          patient:          keypair.publicKey,
          physioProfile,
          treatmentPlan:    planPDA,
          sessionAttestation,
          escrowVault,
          physioPusdAta:    physioAta,
          opsTreasuryAta,
          campaignPoolAta,
          pusdMint,
          tokenProgram:     TOKEN_2022,
          systemProgram:    SystemProgram.programId,
        })
        .rpc();

      setPhase("success");
      const physioEarned = Math.round(plan.pusdPerSession * 0.7);
      setSessionMsg(
        `Session ${sessionNumber} verified! ${(recordingMs / 1000).toFixed(0)}s video · $${pusdToDisplay(physioEarned)} released to your physio.`,
      );

      fetch("/api/torque/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event:           "physioloop_session_completed",
          userPublicKey:   keypair.publicKey.toBase58(),
          metadata: {
            exercise:          exerciseName,
            session_number:    sessionNumber,
            sessions_total:    plan.sessionsTotal,
            video_duration_ms: recordingMs,
            physio:            plan.physio.toBase58(),
          },
        }),
      }).catch(() => {});

      await fetchPlan();
    } catch (err) {
      setPhase("error");
      const msg = err instanceof Error ? err.message : String(err);
      const anchorMsg = msg.match(/Error Message: (.+?)(?:\.|$)/)?.[1]
        ?? msg.match(/"message":"(.+?)"/)?.[1]
        ?? msg;
      console.error("[PhysioLoop] submit error:", err);
      setSessionMsg(`Submission failed: ${anchorMsg.slice(0, 120)}`);
    }
  }, [keypair, plan, planParam, phase, canVerify, videoBlob, recordingMs, currentEx, fetchPlan]);

  // ── Video recording ───────────────────────────────────────────────────────
  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || recording) return;

    chunksRef.current = [];
    setVideoBlob(null);
    setVideoUrl(null);
    setRecordingMs(0);

    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : MediaRecorder.isTypeSupported("video/webm")
        ? "video/webm"
        : "video/mp4";

    const mr = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 800_000 });
    mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      setVideoBlob(blob);
      setVideoUrl(URL.createObjectURL(blob));
    };
    mr.start(500);
    mediaRecorderRef.current = mr;
    setRecording(true);

    const t0 = Date.now();
    recTimerRef.current = setInterval(() => setRecordingMs(Date.now() - t0), 500);
  }, [recording]);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    setRecording(false);
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
  }, []);

  const resetVideo = useCallback(() => {
    setVideoBlob(null);
    setVideoUrl(null);
    setRecordingMs(0);
  }, []);

  // ── Loading / error states ─────────────────────────────────────────────────
  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center text-gray-400">
          <div className="w-10 h-10 border-2 border-green-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm">Loading your programme…</p>
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
          <p className="text-sm text-gray-400 mt-2">Contact your physiotherapist for a new link.</p>
        </div>
      </main>
    );
  }

  const pct = completionPct(plan.sessionsCompleted, plan.sessionsTotal);
  const sessionsLeft = plan.sessionsTotal - plan.sessionsCompleted;
  const totalDeposit = plan.sessionsTotal * plan.pusdPerSession;
  const remaining = plan.escrowAmount;
  const released  = totalDeposit - remaining;

  const physioShare    = Math.round(plan.sessionsCompleted * plan.pusdPerSession * 0.70);
  const opsShare       = Math.round(plan.sessionsCompleted * plan.pusdPerSession * 0.15);
  const campaignShare  = Math.round(plan.sessionsCompleted * plan.pusdPerSession * 0.10);
  const caregiverShare = Math.round(plan.sessionsCompleted * plan.pusdPerSession * 0.05);

  const NGN_RATE = 1600;
  const totalNgn = (totalDeposit / 1_000_000) * NGN_RATE;

  // ── Payment gate ─────────────────────────────────────────────────────────
  if (!plan.planActive) {
    return (
      <main className="min-h-screen bg-gray-50 flex flex-col max-w-sm mx-auto">
        <div className="bg-white border-b border-gray-200 px-5 py-3 flex items-center gap-2">
          <span className="text-lg">🩺</span>
          <span className="font-bold text-gray-900 text-sm">PhysioLoop</span>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <div className="text-center pt-4">
            <p className="text-2xl font-bold text-gray-900">Secure your treatment</p>
            <p className="text-sm text-gray-500 mt-1">Hi {nameParam} — your physio has set up a plan for you</p>
          </div>

          <div className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm space-y-2">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Your treatment plan</p>
            {plan.exercises.slice(0, 3).map((ex, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span className="text-gray-700">{ex.name}</span>
                <span className="text-gray-400">{ex.sets} × {ex.reps}</span>
              </div>
            ))}
            {plan.exercises.length > 3 && (
              <p className="text-xs text-gray-400">+{plan.exercises.length - 3} more exercises</p>
            )}
            <div className="border-t border-gray-100 pt-2 mt-2 flex justify-between text-sm">
              <span className="text-gray-500">{plan.sessionsTotal} sessions</span>
              <span className="font-medium">${pusdToDisplay(plan.pusdPerSession)} / session</span>
            </div>
          </div>

          <div className="rounded-2xl bg-green-600 text-white p-5 shadow-sm space-y-4">
            <div>
              <p className="text-xs font-semibold text-green-200 uppercase tracking-wide">Treatment deposit</p>
              <p className="text-4xl font-bold mt-1">₦{totalNgn.toLocaleString("en-NG", { maximumFractionDigits: 0 })}</p>
              <p className="text-sm text-green-200 mt-0.5">
                ${pusdToDisplay(totalDeposit)} PUSD · held in secure escrow
              </p>
            </div>
            <p className="text-xs text-green-100 leading-relaxed">
              Your deposit is locked on Solana. As you complete each verified session, your physio earns their fee.
              Complete your full programme and unused funds are returned to you.
            </p>
            {depositError && (
              <p className="text-xs bg-red-500/20 rounded-lg p-2 text-white">{depositError}</p>
            )}
            <button
              onClick={handleDeposit}
              disabled={depositing}
              className="w-full rounded-xl bg-white text-green-700 px-4 py-3.5 text-sm font-bold hover:bg-green-50 disabled:opacity-60 transition-colors"
            >
              {depositing ? "Processing payment…" : "Pay now"}
            </button>
          </div>

          <div>
            <p className="text-xs text-gray-400 text-center mb-3">Pay with</p>
            <div className="grid grid-cols-4 gap-2">
              {["💳 Card", "🏦 Bank", "📱 Opay", "📱 Palmpay"].map((m) => (
                <button
                  key={m}
                  onClick={handleDeposit}
                  disabled={depositing}
                  className="rounded-xl border border-gray-200 bg-white p-2.5 text-xs text-gray-600 hover:border-green-400 hover:bg-green-50 transition-colors disabled:opacity-50"
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <p className="text-[11px] text-gray-400 text-center pb-4">
            Powered by Solana · Secured by cryptographic escrow
          </p>
        </div>
      </main>
    );
  }

  // ── Home tab ───────────────────────────────────────────────────────────────
  const HomeTab = () => (
    <div className="p-5 space-y-4">
      <h1 className="text-xl font-bold text-gray-900">{greeting(nameParam)}</h1>

      <div className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Today&apos;s exercises</p>
          {plan.condition && (
            <span className="rounded-full bg-blue-50 text-blue-700 text-xs px-2 py-0.5 font-medium">
              {plan.condition}
            </span>
          )}
        </div>
        {plan.exercises.map((ex, i) => (
          <div key={i} className="flex items-center justify-between py-2.5 border-b border-gray-100 last:border-0">
            <div>
              <p className="text-sm font-medium text-gray-900">{i + 1}. {ex.name}</p>
              <p className="text-xs text-gray-400">{ex.sets} sets × {ex.reps} reps</p>
            </div>
            <button
              onClick={() => { setActiveExercise(i); setTab("session"); setPhase("idle"); setSessionMsg(null); resetVideo(); }}
              className="rounded-xl bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 transition-colors"
            >
              Start
            </button>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-white border border-gray-200 p-3 shadow-sm">
          <p className="text-2xl">🔥 {plan.sessionsCompleted}</p>
          <p className="text-xs text-gray-500 mt-1">Sessions done</p>
        </div>
        <div className="rounded-xl bg-white border border-gray-200 p-3 shadow-sm">
          <p className="text-sm font-bold text-gray-900">{plan.sessionsCompleted}/{plan.sessionsTotal}</p>
          <div className="w-full bg-gray-100 rounded-full h-1.5 mt-1">
            <div className="h-full bg-green-500 rounded-full" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-gray-500 mt-1">Programme progress</p>
        </div>
      </div>

      <div className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm space-y-2">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Treatment deposit</p>
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Total deposited</span>
          <span className="font-semibold">${pusdToDisplay(totalDeposit)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Released from escrow</span>
          <span className="text-gray-700">${pusdToDisplay(released)}</span>
        </div>
        {plan.sessionsCompleted > 0 && (
          <div className="ml-3 space-y-1 border-l-2 border-gray-100 pl-3">
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">↳ Physiotherapist (70%)</span>
              <span className="text-gray-600">${pusdToDisplay(physioShare)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">↳ Ops &amp; infrastructure (15%)</span>
              <span className="text-gray-600">${pusdToDisplay(opsShare)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">↳ Torque campaign pool (10%)</span>
              <span className="text-gray-600">${pusdToDisplay(campaignShare)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-gray-400">↳ Caregiver reserve (5%)</span>
              <span className="text-gray-600">${pusdToDisplay(caregiverShare)}</span>
            </div>
          </div>
        )}
        <div className="flex justify-between text-sm pt-1 border-t border-gray-100">
          <span className="text-gray-500">Remaining in escrow</span>
          <span className="font-semibold text-green-700">${pusdToDisplay(remaining)}</span>
        </div>
        <p className="text-xs text-gray-400">
          {sessionsLeft} session{sessionsLeft !== 1 ? "s" : ""} remaining. Unused deposit returned on completion.
        </p>
      </div>
    </div>
  );

  // ── Session tab ────────────────────────────────────────────────────────────
  const SessionTab = () => {
    const ex = plan.exercises[activeExercise] ?? plan.exercises[0];
    const elapsedSec = Math.floor(recordingMs / 1000);
    const elapsedFmt = `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, "0")}`;
    const showLiveCamera = !videoBlob || recording;

    return (
      <div className="flex flex-col h-full">
        {/* Camera / video area */}
        <div className="relative bg-black overflow-hidden" style={{ height: "55vw", maxHeight: 320 }}>

          {/* Live camera feed — shown while recording or before first recording */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-200 ${showLiveCamera ? "opacity-100" : "opacity-0 pointer-events-none"}`}
          />

          {/* Recorded video playback — shown after recording stops */}
          {videoUrl && !recording && (
            <video
              ref={previewRef}
              src={videoUrl}
              controls
              playsInline
              className="absolute inset-0 w-full h-full object-cover"
            />
          )}

          {/* Exercise label overlay — only during live camera */}
          {showLiveCamera && !recording && (
            <div className="absolute top-3 left-3 bg-black/60 backdrop-blur-sm rounded-lg px-3 py-1.5">
              <p className="text-white text-xs font-bold">{ex?.name?.toUpperCase()}</p>
              <p className="text-green-300 text-xs">{ex?.sets} sets × {ex?.reps} reps</p>
            </div>
          )}

          {/* Recording indicator — red dot + elapsed time */}
          {recording && (
            <div className="absolute top-3 right-3 flex items-center gap-2 bg-black/70 backdrop-blur-sm rounded-lg px-3 py-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-white text-xs font-mono font-bold">{elapsedFmt}</span>
            </div>
          )}

          {/* Start Recording button — shown before any recording */}
          {phase === "idle" && !recording && !videoBlob && (
            <button
              onClick={startRecording}
              className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-red-600 hover:bg-red-700 active:scale-95 shadow-lg px-6 py-3 text-sm font-bold text-white transition-all"
            >
              ● Start Recording
            </button>
          )}

          {/* Stop button — shown while recording */}
          {recording && (
            <button
              onClick={stopRecording}
              className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/90 hover:bg-white active:scale-95 shadow-lg px-6 py-3 text-sm font-bold text-gray-900 transition-all"
            >
              ⏹ Stop
            </button>
          )}

          {/* Submitting overlay */}
          {phase === "submitting" && (
            <div className="absolute inset-0 bg-black/70 flex items-center justify-center">
              <div className="text-center text-white">
                <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                <p className="text-sm font-medium">Recording on Solana…</p>
              </div>
            </div>
          )}
        </div>

        {/* Panel */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">

          {/* Success / error banners */}
          {phase === "success" && sessionMsg && (
            <div className="rounded-xl bg-green-50 border border-green-200 p-3">
              <p className="text-sm font-semibold text-green-800">✅ Session verified on-chain</p>
              <p className="text-xs text-green-700 mt-0.5">{sessionMsg}</p>
            </div>
          )}
          {phase === "error" && sessionMsg && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3">
              <p className="text-sm font-semibold text-red-800">⚠️ {sessionMsg}</p>
            </div>
          )}

          {/* Pre-recording instructions */}
          {phase === "idle" && !recording && !videoBlob && (
            <div className="rounded-xl bg-blue-50 border border-blue-100 p-3">
              <p className="text-xs font-semibold text-blue-800 mb-0.5">{ex?.name}</p>
              <p className="text-xs text-blue-600">{ex?.sets} sets × {ex?.reps} reps</p>
              <p className="text-xs text-gray-500 mt-2 leading-relaxed">
                Press <strong>Start Recording</strong>, perform your exercises in front of the camera, then press <strong>Stop</strong>. The video is your proof of adherence.
              </p>
            </div>
          )}

          {/* Recording in progress hint */}
          {recording && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3 flex items-center gap-3">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse shrink-0" />
              <div>
                <p className="text-sm font-semibold text-red-800">Recording {elapsedFmt}</p>
                <p className="text-xs text-red-600">Perform your exercises · press Stop when done</p>
              </div>
            </div>
          )}

          {/* Video ready indicator */}
          {videoBlob && !recording && phase === "idle" && (
            <div className="rounded-xl bg-green-50 border border-green-200 p-3 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-green-800">Video ready</p>
                <p className="text-xs text-green-600">{(recordingMs / 1000).toFixed(0)}s · SHA-256 hash will be secured on Solana</p>
              </div>
              <button
                onClick={() => { resetVideo(); }}
                className="text-xs text-gray-400 hover:text-gray-600 underline shrink-0 ml-3"
              >
                Re-record
              </button>
            </div>
          )}

          {/* Exercise selector */}
          <div className="flex gap-2 overflow-x-auto pb-1">
            {plan.exercises.map((e, i) => (
              <button
                key={i}
                onClick={() => {
                  if (recording) stopRecording();
                  setActiveExercise(i);
                  resetVideo();
                  setPhase("idle");
                  setSessionMsg(null);
                }}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeExercise === i ? "bg-green-600 text-white" : "bg-gray-100 text-gray-600"
                }`}
              >
                {e.name}
              </button>
            ))}
          </div>

          {/* Primary action button */}
          <button
            onClick={
              phase === "success"
                ? () => { setPhase("idle"); setSessionMsg(null); resetVideo(); }
                : handleVerify
            }
            disabled={phase === "submitting" || recording || (phase === "idle" && !canVerify)}
            className={`w-full rounded-2xl py-4 text-base font-bold text-white transition-all ${
              phase === "success"
                ? "bg-blue-600 hover:bg-blue-700"
                : phase === "submitting"
                  ? "bg-green-300 cursor-not-allowed"
                  : canVerify && !recording
                    ? "bg-green-600 hover:bg-green-700 shadow-lg shadow-green-600/30"
                    : "bg-gray-300 cursor-not-allowed text-gray-500"
            }`}
          >
            {phase === "submitting"
              ? "Recording on Solana…"
              : phase === "success"
                ? "Next session →"
                : recording
                  ? "Stop recording first"
                  : canVerify
                    ? "Submit video → Record on Solana"
                    : "Record your session to submit"}
          </button>

          <p className="text-xs text-gray-400 text-center">
            Video proof · SHA-256 hash secured on Solana
          </p>
        </div>
      </div>
    );
  };

  // ── Progress tab ───────────────────────────────────────────────────────────
  const ProgressTab = () => {
    const weeks: boolean[][] = [];
    for (let w = 0; w < Math.ceil(plan.sessionsTotal / 7); w++) {
      const week: boolean[] = [];
      for (let d = 0; d < 7; d++) {
        const idx = w * 7 + d;
        week.push(idx < plan.sessionsCompleted);
      }
      weeks.push(week);
    }

    return (
      <div className="p-5 space-y-4">
        <h2 className="text-lg font-bold text-gray-900">Your Progress</h2>

        <div className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm space-y-3">
          {weeks.map((week, wi) => (
            <div key={wi} className="flex items-center gap-2">
              <span className="text-xs text-gray-400 w-12">Week {wi + 1}</span>
              <div className="flex gap-1">
                {week.map((done, di) => (
                  <span key={di} className={`text-base ${done ? "" : "opacity-20"}`}>
                    {done ? "✅" : "□"}
                  </span>
                ))}
              </div>
            </div>
          ))}
          <div className="pt-2 border-t border-gray-100">
            <p className="text-sm text-gray-600">
              Compliance rate: <span className="font-semibold text-green-700">{pct}%</span>
            </p>
          </div>
        </div>

        <div className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm space-y-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Treatment deposit</p>
          <div className="flex justify-between text-sm"><span className="text-gray-500">Total deposited</span><span className="font-semibold">${pusdToDisplay(totalDeposit)}</span></div>
          <div className="flex justify-between text-sm"><span className="text-gray-500">Released from escrow</span><span>${pusdToDisplay(released)}</span></div>
          {plan.sessionsCompleted > 0 && (
            <div className="ml-3 space-y-1 border-l-2 border-gray-100 pl-3">
              <div className="flex justify-between text-xs"><span className="text-gray-400">↳ Physiotherapist (70%)</span><span className="text-gray-600">${pusdToDisplay(physioShare)}</span></div>
              <div className="flex justify-between text-xs"><span className="text-gray-400">↳ Ops &amp; infrastructure (15%)</span><span className="text-gray-600">${pusdToDisplay(opsShare)}</span></div>
              <div className="flex justify-between text-xs"><span className="text-gray-400">↳ Torque campaign pool (10%)</span><span className="text-gray-600">${pusdToDisplay(campaignShare)}</span></div>
              <div className="flex justify-between text-xs"><span className="text-gray-400">↳ Caregiver reserve (5%)</span><span className="text-gray-600">${pusdToDisplay(caregiverShare)}</span></div>
            </div>
          )}
          <div className="flex justify-between text-sm pt-1 border-t border-gray-100"><span className="text-gray-500">Remaining in escrow</span><span className="font-semibold text-green-700">${pusdToDisplay(remaining)}</span></div>
        </div>

        {plan.caregiverName && (
          <div className="rounded-2xl bg-white border border-gray-200 p-4 shadow-sm">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Caregiver</p>
            <p className="text-sm font-medium text-gray-800">{plan.caregiverName}</p>
            <p className="text-xs text-gray-400 mt-0.5">Checking in on your progress daily</p>
          </div>
        )}
      </div>
    );
  };

  // ── Layout ─────────────────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-gray-50 flex flex-col max-w-sm mx-auto">
      <div className="bg-white border-b border-gray-200 px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">🩺</span>
          <span className="font-bold text-gray-900 text-sm">PhysioLoop</span>
        </div>
        <span className="text-xs text-gray-400">{plan.sessionsCompleted}/{plan.sessionsTotal} sessions</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === "home" && <HomeTab />}
        {tab === "session" && <SessionTab />}
        {tab === "progress" && <ProgressTab />}
      </div>

      <nav className="bg-white border-t border-gray-200 flex">
        {(["home", "session", "progress"] as Tab[]).map((t) => {
          const icons  = { home: "🏠", session: "📹", progress: "📊" };
          const labels = { home: "Home", session: "Session", progress: "Progress" };
          return (
            <button
              key={t}
              onClick={() => {
                if (t !== "session" && recording) stopRecording();
                setTab(t);
                if (t !== "session") { setPhase("idle"); setSessionMsg(null); }
              }}
              className={`flex-1 py-3 flex flex-col items-center gap-0.5 text-xs font-medium transition-colors ${
                tab === t ? "text-green-600" : "text-gray-400 hover:text-gray-600"
              }`}
            >
              <span className="text-lg">{icons[t]}</span>
              {labels[t]}
            </button>
          );
        })}
      </nav>
    </main>
  );
}
