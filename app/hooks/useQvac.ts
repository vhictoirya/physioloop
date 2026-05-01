"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export interface QvacProof {
  repsCompleted: number;
  avgConfidence: number;
  peakAngleRange: number;
  exerciseName: string;
}

const LOWER_CONNECTIONS = [[23,25],[25,27],[24,26],[26,28],[23,24],[11,23],[12,24]];
const UPPER_CONNECTIONS = [[11,13],[13,15],[12,14],[14,16],[11,12]];

function calcAngle(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): number {
  const r = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
  let d  = Math.abs((r * 180) / Math.PI);
  if (d > 180) d = 360 - d;
  return d;
}

function isLowerBody(name: string) {
  return /knee|squat|lunge|leg|hip|ankle|calf|glute|hamstring|quad|step|sit.to.stand/i.test(name);
}

type Lmk = { x: number; y: number; z: number; visibility?: number };
interface PLResult { landmarks: Lmk[][] }
interface PLInstance { detectForVideo(v: HTMLVideoElement, ts: number): PLResult }

export function useQvac(
  videoRef: React.RefObject<HTMLVideoElement>,
  exerciseName: string,
  targetReps: number,
  active: boolean,
) {
  const canvasRef           = useRef<HTMLCanvasElement>(null);
  const lmRef               = useRef<PLInstance | null>(null);
  const rafRef              = useRef<number>(0);
  const anglesRef           = useRef<number[]>([]);
  const stateRef            = useRef<"extended" | "flexed">("extended");
  const repCountRef         = useRef(0);
  const confSumRef          = useRef(0);
  const confFramesRef       = useRef(0);
  const lastTsRef           = useRef(0);

  // Adaptive baseline: learns the patient's "rest" (extended) angle in the first 10 frames,
  // then updates slowly so thresholds track any starting position or exercise range.
  const restAngleRef        = useRef(170);
  const calibCountRef       = useRef(0);
  const calibSumRef         = useRef(0);

  const [isReady,       setIsReady]       = useState(false);
  const [isLoading,     setIsLoading]     = useState(false);
  const [loadError,     setLoadError]     = useState<string | null>(null);
  const [repCount,      setRepCount]      = useState(0);
  const [confidence,    setConfidence]    = useState(0);
  const [jointAngle,    setJointAngle]    = useState(180);
  const [poseDetected,  setPoseDetected]  = useState(false);
  const [isCalibrating, setIsCalibrating] = useState(false);

  const lower = isLowerBody(exerciseName);

  // ── Initialise MediaPipe (WASM served locally, model from Google CDN) ──────
  useEffect(() => {
    if (lmRef.current) return;
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);

    (async () => {
      try {
        const { PoseLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");

        // Serve WASM from /mediapipe-wasm (copied from node_modules to public/)
        const vision = await FilesetResolver.forVisionTasks("/mediapipe-wasm");

        const lm = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
            delegate: "CPU",
          },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.3,
          minPosePresenceConfidence:  0.3,
          minTrackingConfidence:      0.3,
        });

        if (!cancelled) {
          lmRef.current = lm as unknown as PLInstance;
          setIsReady(true);
          setIsLoading(false);
          console.log("[QVAC] ready");
        }
      } catch (err) {
        console.error("[QVAC] init failed:", err);
        if (!cancelled) {
          setIsLoading(false);
          setLoadError(err instanceof Error ? err.message : "MediaPipe failed to load");
        }
      }
    })();

    return () => { cancelled = true; };
  }, []);

  // ── Reset when exercise changes ────────────────────────────────────────────
  useEffect(() => {
    repCountRef.current   = 0;
    confSumRef.current    = 0;
    confFramesRef.current = 0;
    stateRef.current      = "extended";
    anglesRef.current     = [];
    lastTsRef.current     = 0;
    restAngleRef.current  = 170;
    calibCountRef.current = 0;
    calibSumRef.current   = 0;
    setRepCount(0);
    setJointAngle(180);
    setConfidence(0);
    setPoseDetected(false);
    setIsCalibrating(false);
  }, [exerciseName]);

  // ── Detection loop ─────────────────────────────────────────────────────────
  const detect = useCallback(() => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    const lm     = lmRef.current;

    if (!video || !canvas || !lm || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(detect);
      return;
    }

    // Strictly increasing timestamp required by MediaPipe VIDEO mode
    const now = performance.now();
    if (now <= lastTsRef.current) {
      rafRef.current = requestAnimationFrame(detect);
      return;
    }
    lastTsRef.current = now;

    // Size canvas to container
    const box = canvas.parentElement?.getBoundingClientRect();
    if (box && (canvas.width !== Math.round(box.width) || canvas.height !== Math.round(box.height))) {
      canvas.width  = Math.round(box.width);
      canvas.height = Math.round(box.height);
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) { rafRef.current = requestAnimationFrame(detect); return; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let result: PLResult;
    try {
      result = lm.detectForVideo(video, now);
    } catch (e) {
      console.warn("[QVAC] detect err:", e);
      rafRef.current = requestAnimationFrame(detect);
      return;
    }

    const w = canvas.width;
    const h = canvas.height;

    if (!result.landmarks?.length) {
      setPoseDetected(false);
      ctx.fillStyle = "rgba(250,200,80,0.85)";
      ctx.font      = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Step back so your full body is visible", w / 2, h - 12);
      ctx.textAlign = "left";
      rafRef.current = requestAnimationFrame(detect);
      return;
    }

    setPoseDetected(true);
    const lmks = result.landmarks[0];
    const w_ = w, h_ = h;

    // Draw skeleton
    ctx.strokeStyle = "#00ff88";
    ctx.lineWidth   = 2.5;
    for (const [i, j] of (lower ? LOWER_CONNECTIONS : UPPER_CONNECTIONS)) {
      if (!lmks[i] || !lmks[j]) continue;
      ctx.beginPath();
      ctx.moveTo(lmks[i].x * w_, lmks[i].y * h_);
      ctx.lineTo(lmks[j].x * w_, lmks[j].y * h_);
      ctx.stroke();
    }
    for (const l of lmks) {
      if ((l.visibility ?? 0) < 0.2) continue;
      ctx.beginPath();
      ctx.arc(l.x * w_, l.y * h_, 5, 0, 2 * Math.PI);
      ctx.fillStyle   = "#fff";
      ctx.fill();
      ctx.strokeStyle = "#00ff88";
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }

    // Best-visibility side
    let la: Lmk, lb: Lmk, lc: Lmk;
    if (lower) {
      const lv = (lmks[23]?.visibility??0)+(lmks[25]?.visibility??0)+(lmks[27]?.visibility??0);
      const rv = (lmks[24]?.visibility??0)+(lmks[26]?.visibility??0)+(lmks[28]?.visibility??0);
      [la,lb,lc] = lv>=rv ? [lmks[23],lmks[25],lmks[27]] : [lmks[24],lmks[26],lmks[28]];
    } else {
      const lv = (lmks[11]?.visibility??0)+(lmks[13]?.visibility??0)+(lmks[15]?.visibility??0);
      const rv = (lmks[12]?.visibility??0)+(lmks[14]?.visibility??0)+(lmks[16]?.visibility??0);
      [la,lb,lc] = lv>=rv ? [lmks[11],lmks[13],lmks[15]] : [lmks[12],lmks[14],lmks[16]];
    }

    if (la! && lb! && lc!) {
      const angle = calcAngle(la, lb, lc);
      const conf  = ((la.visibility??0)+(lb.visibility??0)+(lc.visibility??0))/3;

      anglesRef.current.push(angle);
      confSumRef.current    += conf;
      confFramesRef.current += 1;
      setJointAngle(Math.round(angle));
      setConfidence(Math.round((confSumRef.current/confFramesRef.current)*100)/100);

      // ── Adaptive calibration ──────────────────────────────────────────────
      // Collect the first 10 frames to learn the patient's resting (extended) angle.
      // After calibration, update the rest angle slowly via EMA when in "extended" state
      // so it tracks gradual posture drift without being fooled by mid-rep positions.
      if (calibCountRef.current < 10) {
        calibCountRef.current += 1;
        calibSumRef.current   += angle;
        setIsCalibrating(true);
        if (calibCountRef.current === 10) {
          restAngleRef.current = calibSumRef.current / 10;
          setIsCalibrating(false);
          console.log(`[QVAC] calibrated rest=${Math.round(restAngleRef.current)}°`);
        }
        // Don't count reps until we have a baseline
        rafRef.current = requestAnimationFrame(detect);
        return;
      }

      if (stateRef.current === "extended") {
        // Slow EMA keeps rest angle in sync if patient's range drifts
        restAngleRef.current = 0.97 * restAngleRef.current + 0.03 * angle;
      }

      // Flex = patient moves 30° below rest; Extend = returns to within 12° of rest.
      // These deltas work for any exercise/starting position without manual tuning.
      const FLEX   = restAngleRef.current - 30;
      const EXTEND = restAngleRef.current - 12;

      if (angle < FLEX && stateRef.current === "extended") {
        stateRef.current = "flexed";
        console.log(`[QVAC] ↓ flexed ${Math.round(angle)}° (rest=${Math.round(restAngleRef.current)}°, thresh=${Math.round(FLEX)}°)`);
      } else if (angle > EXTEND && stateRef.current === "flexed") {
        stateRef.current    = "extended";
        repCountRef.current += 1;
        setRepCount(repCountRef.current);
        console.log(`[QVAC] ✓ rep ${repCountRef.current}`);
      }

      // Highlight tracked joint + angle label
      const jx = lb.x * w_;
      const jy = lb.y * h_;
      ctx.beginPath();
      ctx.arc(jx, jy, 10, 0, 2*Math.PI);
      ctx.fillStyle = repCountRef.current >= targetReps ? "#00ff88" : "#facc15";
      ctx.fill();
      ctx.font      = "bold 14px sans-serif";
      ctx.fillStyle = "#fff";
      ctx.textAlign = "left";
      ctx.fillText(`${Math.round(angle)}°`, jx+14, jy+5);

      // Progress arc
      const prog = Math.min(repCountRef.current/Math.max(targetReps,1),1);
      ctx.beginPath();
      ctx.arc(jx, jy, 20, -Math.PI/2, -Math.PI/2+prog*2*Math.PI);
      ctx.strokeStyle = repCountRef.current>=targetReps ? "#00ff88" : "#facc15";
      ctx.lineWidth   = 3;
      ctx.stroke();
    }

    rafRef.current = requestAnimationFrame(detect);
  }, [videoRef, lower, targetReps]);

  useEffect(() => {
    if (!isReady || !active) {
      cancelAnimationFrame(rafRef.current);
      return;
    }
    console.log("[QVAC] loop start — lower:", lower, "target:", targetReps, "exercise:", exerciseName);
    rafRef.current = requestAnimationFrame(detect);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isReady, active, detect, lower, targetReps, exerciseName]);

  // ── Manual tap fallback ────────────────────────────────────────────────────
  const manualAddRep = useCallback(() => {
    repCountRef.current += 1;
    setRepCount(repCountRef.current);
  }, []);

  const getProofData = useCallback((): QvacProof => {
    const a = anglesRef.current;
    return {
      repsCompleted:  repCountRef.current,
      avgConfidence:  confFramesRef.current>0 ? Math.round((confSumRef.current/confFramesRef.current)*100)/100 : 0,
      peakAngleRange: a.length>0 ? Math.round(Math.max(...a)-Math.min(...a)) : 0,
      exerciseName,
    };
  }, [exerciseName]);

  return {
    canvasRef,
    isReady,
    isLoading,
    loadError,
    repCount,
    targetReps,
    confidence,
    jointAngle,
    poseDetected,
    isCalibrating,
    canVerify: repCount >= targetReps && targetReps > 0,
    manualAddRep,
    getProofData,
  };
}
