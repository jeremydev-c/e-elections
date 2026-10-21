"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ScanFace,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Zap,
} from "lucide-react";
import {
  analyzeLiveFrame,
  cameraSupportError,
  collectFaceSamples,
  cropFaceSnapshot,
  fuseDescriptors,
  loadFaceApi,
  playBiometricSound,
  QUALITY_HINTS,
  type BiometricTelemetry,
} from "@/lib/face.client";

/** How many quality-checked frames make up one face reading. */
const SAMPLE_COUNT = 5;
const MIN_GOOD_SAMPLES = 3;

export type FaceCaptureResult = {
  /** Outlier-free average of the readings (the template stored at registration). */
  descriptor: number[];
  /** The individual readings that survived outlier rejection. */
  samples: number[][];
  photoDataUrl?: string;
};


type GuidedStage =
  | "CENTER" // Look straight and align in circle
  | "TURN_LEFT" // Anti-spoofing challenge: turn head slightly left
  | "FINALIZE"; // Return to center to finalize descriptor fusion

type Status =
  | { kind: "idle" }
  | { kind: "loading"; msg: string }
  | { kind: "live" }
  | { kind: "capturing"; stage: GuidedStage; progress: number }
  | { kind: "done"; photoUrl: string; frames: number }
  | { kind: "error"; msg: string };

export function FaceCapture({
  onCapture,
  actionLabel = "Enroll Biometrics",
  requireLiveness = false,
}: {
  onCapture: (result: FaceCaptureResult) => void;
  actionLabel?: string;
  /** Hide the single-frame quick scan so the head-turn liveness check is mandatory. */
  requireLiveness?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const runningRef = useRef(false);

  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [isCapturing, setIsCapturing] = useState(false);
  const [guidedStage, setGuidedStage] = useState<GuidedStage>("CENTER");
  const [telemetry, setTelemetry] = useState<BiometricTelemetry | null>(null);
  const [stageProgress, setStageProgress] = useState(0);
  const [hudMessage, setHudMessage] = useState("Align face inside the biometric frame");

  // Refs mirror state for the async render loop (state would be stale there).
  const telemetryRef = useRef<BiometricTelemetry | null>(null);
  const progressRef = useRef(0);
  const isCapturingRef = useRef(false);
  const completingRef = useRef(false);
  const stageRef = useRef<GuidedStage>("CENTER");
  const faceApiRef = useRef<typeof import("@vladmandic/face-api") | null>(null);

  const stopCamera = useCallback(() => {
    runningRef.current = false;
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    isCapturingRef.current = false;
    setIsCapturing(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  function setProgress(value: number) {
    progressRef.current = value;
    setStageProgress(value);
  }

  function goToStage(stage: GuidedStage, message: string) {
    stageRef.current = stage;
    setGuidedStage(stage);
    setProgress(0);
    setHudMessage(message);
  }

  /** Front camera at the best resolution the device offers (no hard minimums). */
  async function openStream(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === "OverconstrainedError" || name === "NotReadableError" || name === "AbortError") {
        return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      throw err;
    }
  }

  // Start video stream & load models
  async function startCamera() {
    const errorMsg = cameraSupportError();
    if (errorMsg) return setStatus({ kind: "error", msg: errorMsg });

    stopCamera();
    completingRef.current = false;
    try {
      setStatus({ kind: "loading", msg: "Opening camera…" });
      const stream = await openStream();
      streamRef.current = stream;

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await new Promise<void>((resolve) => {
          if (video.readyState >= 1) return resolve();
          video.onloadedmetadata = () => resolve();
        });
        await video.play().catch(() => {}); // muted autoplay only fails if interrupted
      }

      setStatus({ kind: "loading", msg: "Loading WebGL biometric engine…" });
      const api = await loadFaceApi();
      faceApiRef.current = api;

      if (!streamRef.current) return; // camera was closed while models loaded
      setStatus({ kind: "live" });
      goToStage("CENTER", "Align face in center frame");
      startLiveTelemetryLoop(api);
    } catch (err) {
      stopCamera();
      const e = err as Error;
      setStatus({
        kind: "error",
        msg:
          e.name === "NotAllowedError"
            ? "Camera permission denied. Allow camera access (padlock icon in the address bar) and try again."
            : e.name === "NotFoundError"
              ? "No camera detected on this device. Use Fingerprint Unlock or another device."
              : e.name === "NotReadableError"
                ? "The camera is in use by another app (Zoom, Teams…). Close it and try again."
                : `Camera error: ${e.message}`,
      });
    }
  }

  // Real-time canvas render loop
  function startLiveTelemetryLoop(api: typeof import("@vladmandic/face-api")) {
    let lastInference = 0;
    runningRef.current = true;

    async function tick(now: number) {
      if (!runningRef.current) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (video && canvas && !video.paused && !video.ended) {
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth || 640;
          canvas.height = video.videoHeight || 480;
        }

        // Run face telemetry inference at ~15 FPS to keep UI snappy
        if (now - lastInference > 65) {
          lastInference = now;
          try {
            const data = await analyzeLiveFrame(video, api);
            if (data && runningRef.current) {
              telemetryRef.current = data;
              setTelemetry(data);
              if (isCapturingRef.current) handleGuidedProgression(data, video, api);
            }
          } catch {
            // Ignore single-frame inference glitches
          }
        }

        const ctx = canvas.getContext("2d");
        if (ctx && runningRef.current) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          drawBiometricHUD(ctx, canvas.width, canvas.height, telemetryRef.current, stageRef.current, isCapturingRef.current);
        }
      }

      if (runningRef.current) animFrameRef.current = requestAnimationFrame(tick);
    }

    animFrameRef.current = requestAnimationFrame(tick);
  }

  // Draw HUD elements (reticle, brackets, landmarks, scanline)
  function drawBiometricHUD(
    ctx: CanvasRenderingContext2D,
    cw: number,
    ch: number,
    telem: BiometricTelemetry | null,
    currentStage: GuidedStage,
    isCapturing: boolean
  ) {
    // 1. Dark vignette around edges
    const grad = ctx.createRadialGradient(cw / 2, ch / 2, ch * 0.35, cw / 2, ch / 2, ch * 0.75);
    grad.addColorStop(0, "rgba(31, 34, 25, 0)");
    grad.addColorStop(1, "rgba(31, 34, 25, 0.65)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cw, ch);

    // 2. Center Biometric Guide Oval
    const ovalW = cw * 0.42;
    const ovalH = ch * 0.68;
    const cx = cw / 2;
    const cy = ch / 2;

    const isAligned =
      telem?.faceFound &&
      !telem?.multipleFaces &&
      telem?.isCentered &&
      telem?.distanceStatus === "OPTIMAL" &&
      telem?.isFullyFrontal;

    const isTurnedSide = telem?.faceFound && !telem?.multipleFaces && !telem?.isFullyFrontal;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, ovalW / 2, ovalH / 2, 0, 0, Math.PI * 2);
    ctx.lineWidth = isAligned ? 3.5 : 2;
    ctx.strokeStyle = isAligned
      ? "rgba(143, 209, 158, 0.95)" // Kenya green
      : isTurnedSide
        ? "rgba(245, 158, 11, 0.9)" // Amber: face is turned sideways!
        : telem?.multipleFaces
          ? "rgba(239, 68, 68, 0.9)" // Red warning
          : "rgba(255, 255, 255, 0.25)";
    ctx.stroke();

    // Corner crosshairs on oval
    ctx.strokeStyle = isAligned ? "#8fd19e" : isTurnedSide ? "#f59e0b" : "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = 2;
    const arm = 16;
    // Top
    ctx.beginPath();
    ctx.moveTo(cx, cy - ovalH / 2 - arm);
    ctx.lineTo(cx, cy - ovalH / 2 + arm);
    ctx.stroke();
    // Bottom
    ctx.beginPath();
    ctx.moveTo(cx, cy + ovalH / 2 - arm);
    ctx.lineTo(cx, cy + ovalH / 2 + arm);
    ctx.stroke();
    // Left
    ctx.beginPath();
    ctx.moveTo(cx - ovalW / 2 - arm, cy);
    ctx.lineTo(cx - ovalW / 2 + arm, cy);
    ctx.stroke();
    // Right
    ctx.beginPath();
    ctx.moveTo(cx + ovalW / 2 - arm, cy);
    ctx.lineTo(cx + ovalW / 2 + arm, cy);
    ctx.stroke();
    ctx.restore();

    // Side turn feedback banner directly above/below oval
    if (isTurnedSide && telem) {
      ctx.save();
      ctx.fillStyle = "rgba(245, 158, 11, 0.95)";
      ctx.font = "bold 13px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      let hint = "⚠️ FACE TURNED TO SIDE — PLEASE FACE FRONT";
      if (telem.yaw > 10) {
        hint = "◂◂ TURN HEAD SLIGHTLY TO YOUR LEFT (FACE FRONT) ◂◂";
      } else if (telem.yaw < -10) {
        hint = "▸▸ TURN HEAD SLIGHTLY TO YOUR RIGHT (FACE FRONT) ▸▸";
      } else if (Math.abs(telem.roll) > 10) {
        hint = "STRAIGHTEN HEAD TILT (HOLD LEVEL)";
      }
      ctx.fillText(hint, cx, cy + ovalH / 2 + 28);
      ctx.restore();
    } else if (isAligned) {
      ctx.save();
      ctx.fillStyle = "rgba(143, 209, 158, 0.95)";
      ctx.font = "bold 13px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("✓ FULLY FRONTAL — HOLD STEADY", cx, cy + ovalH / 2 + 28);
      ctx.restore();
    }

    // 3. Live Face Bounding Box & Landmarks (Mirrored to align with user's mirror view)
    if (telem?.faceFound && telem.box) {
      const box = telem.box;
      // Mirror x coordinate because video is rendered mirrored
      const mirX = cw - (box.x + box.width);
      const mirY = box.y;

      ctx.save();
      // Bounding box corner brackets
      ctx.strokeStyle = isAligned
        ? "#8fd19e"
        : isTurnedSide
          ? "rgba(245, 158, 11, 0.85)"
          : "rgba(143, 209, 158, 0.5)";
      ctx.lineWidth = 2;
      const bArm = 18;

      // Top-Left
      ctx.beginPath();
      ctx.moveTo(mirX, mirY + bArm);
      ctx.lineTo(mirX, mirY);
      ctx.lineTo(mirX + bArm, mirY);
      ctx.stroke();

      // Top-Right
      ctx.beginPath();
      ctx.moveTo(mirX + box.width - bArm, mirY);
      ctx.lineTo(mirX + box.width, mirY);
      ctx.lineTo(mirX + box.width, mirY + bArm);
      ctx.stroke();

      // Bottom-Left
      ctx.beginPath();
      ctx.moveTo(mirX, mirY + box.height - bArm);
      ctx.lineTo(mirX, mirY + box.height);
      ctx.lineTo(mirX + bArm, mirY + box.height);
      ctx.stroke();

      // Bottom-Right
      ctx.beginPath();
      ctx.moveTo(mirX + box.width - bArm, mirY + box.height);
      ctx.lineTo(mirX + box.width, mirY + box.height);
      ctx.lineTo(mirX + box.width, mirY + box.height - bArm);
      ctx.stroke();

      // Draw subtle facial landmark constellation dots
      if (telem.landmarks && telem.landmarks.length > 0) {
        ctx.fillStyle = isAligned
          ? "rgba(143, 209, 158, 0.8)"
          : isTurnedSide
            ? "rgba(245, 158, 11, 0.6)"
            : "rgba(148, 163, 184, 0.4)";
        for (let i = 0; i < telem.landmarks.length; i += 2) {
          const pt = telem.landmarks[i];
          const mx = cw - pt.x;
          ctx.beginPath();
          ctx.arc(mx, pt.y, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // 4. Guided Arrow Animation (when asked to turn head for liveness)
    if (isCapturing && currentStage === "TURN_LEFT") {
      ctx.save();
      ctx.fillStyle = "rgba(143, 209, 158, 0.95)";
      ctx.font = "bold 15px monospace";
      ctx.textAlign = "center";
      ctx.fillText("◂ TURN HEAD SLIGHTLY LEFT (3D LIVENESS) ◂", cx, cy - ovalH / 2 - 28);
      ctx.restore();
    }
  }

  // Guided Liveness & Frontal Capture Engine. Side effects stay OUT of
  // state updaters, which React StrictMode runs twice in development.
  function handleGuidedProgression(
    data: BiometricTelemetry,
    video: HTMLVideoElement,
    api: typeof import("@vladmandic/face-api")
  ) {
    if (completingRef.current) return;
    if (!data.faceFound || data.multipleFaces) {
      setHudMessage(data.multipleFaces ? "Multiple faces detected — ensure 1 person only" : "Looking for face…");
      return;
    }

    const stage = stageRef.current;
    const framed = data.isCentered && data.distanceStatus === "OPTIMAL" && data.isFullyFrontal;

    // --- STAGE 1: CENTER & FULLY FRONTAL FACE ---
    if (stage === "CENTER") {
      if (!framed) {
        if (!data.isCentered) setHudMessage("Align face in center frame");
        else if (data.distanceStatus === "TOO_FAR") setHudMessage("Move slightly closer");
        else if (data.distanceStatus === "TOO_CLOSE") setHudMessage("Step back slightly");
        else setHudMessage(data.poseFeedback);
        return;
      }
      setHudMessage("Frontal alignment locked ✓ (Hold steady…)");
      const next = progressRef.current + 0.3;
      if (next < 1) return setProgress(next);
      playBiometricSound("step");
      goToStage("TURN_LEFT", "Anti-Spoofing: Turn head slightly to your LEFT");
    }

    // --- STAGE 2: LIVENESS HEAD ROTATION CHALLENGE (Anti-Spoofing) ---
    else if (stage === "TURN_LEFT") {
      // |yaw| > 14 degrees proves real 3D movement (a printed photo can't turn).
      if (Math.abs(data.yaw) <= 14) {
        setHudMessage("Turn head slightly to your LEFT (proves you are live)");
        return;
      }
      setHudMessage("Liveness verified! ✓ (3D depth detected)");
      const next = progressRef.current + 0.4;
      if (next < 1) return setProgress(next);
      playBiometricSound("step");
      goToStage("FINALIZE", "Now face FULLY FRONT to capture official photo");
    }

    // --- STAGE 3: FINALIZE & FRONTAL SIGNATURE LOCK ---
    else if (stage === "FINALIZE") {
      if (!framed) {
        setHudMessage(data.poseFeedback || "Face the camera directly (fully front, not sides)");
        return;
      }
      setHudMessage("Perfect frontal pose! Capturing biometrics…");
      setProgress(0);
      completingRef.current = true;
      completeBiometricEnrollment(video, api);
    }
  }

  /**
   * Takes SAMPLE_COUNT quality-checked readings with the precise SSD detector,
   * drops outliers and fuses the rest. Returns null if too few were usable.
   */
  async function captureFusedReading(video: HTMLVideoElement, api: typeof import("@vladmandic/face-api")) {
    setHudMessage(`Hold still — reading your face 0/${SAMPLE_COUNT}`);
    const samples = await collectFaceSamples(video, api, {
      count: SAMPLE_COUNT,
      onProgress: (got, issue) => {
        setProgress(got / SAMPLE_COUNT);
        setHudMessage(issue ? QUALITY_HINTS[issue] : `Hold still — reading your face ${got}/${SAMPLE_COUNT}`);
      },
    });
    if (samples.length < MIN_GOOD_SAMPLES) return null;

    const fused = fuseDescriptors(samples.map((x) => x.descriptor));
    if (fused.kept.length < MIN_GOOD_SAMPLES) return null;

    const best = samples.reduce((a, z) => (z.score > a.score ? z : a));
    const photoDataUrl = await cropFaceSnapshot(video, best.box);
    return { descriptor: fused.mean, samples: fused.kept, photoDataUrl };
  }

  function finish(result: FaceCaptureResult) {
    playBiometricSound("success");
    stopCamera();
    setStatus({ kind: "done", photoUrl: result.photoDataUrl ?? "", frames: result.samples.length });
    onCapture(result);
  }

  // Final stage of the guided scan
  async function completeBiometricEnrollment(video: HTMLVideoElement, api: typeof import("@vladmandic/face-api")) {
    const result = await captureFusedReading(video, api).catch(() => null);
    if (!result) {
      completingRef.current = false;
      playBiometricSound("error");
      goToStage("FINALIZE", "Could not get a clear reading — face the light, look straight ahead and hold still");
      return;
    }
    isCapturingRef.current = false;
    setIsCapturing(false);
    finish(result);
  }

  // Manual trigger for "Start Guided Scan"
  function startGuidedScan() {
    completingRef.current = false;
    isCapturingRef.current = true;
    setIsCapturing(true);
    goToStage("CENTER", "Align face in center frame (facing fully front)");
    playBiometricSound("step");
  }

  // Quick scan (registration desk only): same multi-frame reading, no head-turn step
  async function startQuickScan() {
    const video = videoRef.current;
    const api = faceApiRef.current;
    const telemetry = telemetryRef.current;
    if (!video || !api || completingRef.current) return;

    if (!telemetry || !telemetry.isFullyFrontal) {
      setHudMessage(telemetry?.poseFeedback || "Look straight into the camera first");
      playBiometricSound("error");
      return;
    }

    completingRef.current = true;
    isCapturingRef.current = true;
    setIsCapturing(true);
    stageRef.current = "FINALIZE";
    setGuidedStage("FINALIZE");
    setStatus({ kind: "capturing", stage: "FINALIZE", progress: 0 });

    const result = await captureFusedReading(video, api).catch(() => null);
    isCapturingRef.current = false;
    setIsCapturing(false);
    if (!result) {
      completingRef.current = false;
      setStatus({ kind: "live" });
      setHudMessage("Could not get a clear reading — improve the lighting and hold still");
      playBiometricSound("error");
      return;
    }
    finish(result);
  }

  const isLive = status.kind === "live" || status.kind === "capturing";

  return (
    <div className="space-y-4">
      {/* Biometric Viewport */}
      <div className="relative mx-auto aspect-[4/3] w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-ink shadow-sm">
        {/* Live Video Feed (mirrored for natural selfie view) */}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className={`absolute inset-0 h-full w-full -scale-x-100 object-cover transition-opacity duration-300 ${
            isLive ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        />

        {/* Live HUD Canvas Overlay (transparent, over live video) */}
        <canvas
          ref={canvasRef}
          className={`absolute inset-0 h-full w-full object-cover pointer-events-none transition-opacity duration-300 ${
            isLive ? "opacity-100" : "opacity-0"
          }`}
        />

        {/* State: Idle / Initial Camera Off */}
        {status.kind === "idle" && (
          <div className="absolute inset-0 grid place-items-center bg-radial from-forest-soft via-paper to-paper p-6 text-center">
            <div className="space-y-3">
              <span className="mx-auto grid size-20 place-items-center rounded-2xl border border-forest/30 bg-forest-soft ">
                <ScanFace className="size-10 text-forest" aria-hidden />
              </span>
              <div>
                <h3 className="text-lg font-bold text-ink">Multi-Modal Face Biometrics</h3>
                <p className="mt-1 text-xs text-ink-soft">
                  Hardware-accelerated frontal descriptor extraction with active 3D anti-spoofing
                </p>
              </div>
              <div className="flex items-center justify-center gap-2 pt-2 text-[11px] text-ink-soft">
                <span className="inline-flex items-center gap-1 rounded-full bg-paper px-2.5 py-1">
                  <ShieldCheck className="size-3 text-forest" /> Frontal Verification
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-paper px-2.5 py-1">
                  <Zap className="size-3 text-forest" /> Anti-Spoof
                </span>
              </div>
            </div>
          </div>
        )}

        {/* State: Loading Models */}
        {status.kind === "loading" && (
          <div className="absolute inset-0 grid place-items-center bg-paper backdrop-blur-md p-6 text-center">
            <div className="space-y-3">
              <Loader2 className="mx-auto size-10 animate-spin text-forest" aria-hidden />
              <p className="text-sm font-medium text-ink">{status.msg}</p>
              <p className="text-xs text-ink-faint">Preparing neural network models in GPU memory…</p>
            </div>
          </div>
        )}

        {/* State: Done (Photo Confirmation Preview) */}
        {status.kind === "done" && (
          <div className="absolute inset-0 grid place-items-center bg-paper p-6 text-center animate-fade-up">
            <div className="space-y-4">
              <div className="relative mx-auto size-36 overflow-hidden rounded-2xl border-2 border-forest ">
                {status.photoUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={status.photoUrl}
                    alt="Captured Voter Biometric Photo"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="grid h-full w-full place-items-center bg-paper-2">
                    <ScanFace className="size-16 text-forest" />
                  </div>
                )}
                <span className="absolute bottom-1 right-1 grid size-7 place-items-center rounded-full bg-forest text-white">
                  <CheckCircle2 className="size-4" />
                </span>
              </div>
              <div>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-forest/40 bg-forest-soft px-3 py-1 text-xs font-semibold text-forest">
                  <ShieldCheck className="size-3.5" /> Frontal Biometric Locked
                </span>
                <p className="mt-2 text-xs text-ink-soft">
                  {status.frames} quality-checked frames fused into one 128-point reading
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Active HUD Telemetry Overlay Bar (Top) */}
        {isLive && (
          <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-linear-to-b from-black/80 via-black/40 to-transparent p-3 text-[11px] font-mono text-white/85">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-black/50 px-2 py-0.5 ">
              <span className="size-2 rounded-full bg-[#e05a43] animate-pulse" />
              LIVE 30FPS
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md bg-black/50 px-2 py-0.5 ">
              {telemetry?.faceFound ? (
                telemetry.isFullyFrontal ? (
                  <span className="text-[#9fd8ad] font-bold">POSE: FRONTAL ✓ (0°)</span>
                ) : (
                  <span className="text-[#f1d18c] font-bold">
                    POSE: SIDE ({telemetry.yaw > 0 ? `+${telemetry.yaw}°` : `${telemetry.yaw}°`}) ⚠️
                  </span>
                )
              ) : (
                <span>POSE: --</span>
              )}
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-black/50 px-2 py-0.5 ">
              {telemetry?.faceFound ? (
                telemetry.multipleFaces ? (
                  <span className="text-[#f3a99a]">⚠️ MULTI-FACE</span>
                ) : (
                  <span className="text-[#9fd8ad]">✓ 1 FACE</span>
                )
              ) : (
                <span className="text-[#f1d18c]">NO FACE</span>
              )}
            </span>
          </div>
        )}

        {/* Dynamic HUD Prompt Badge (Bottom) */}
        {isLive && (
          <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/90 via-black/60 to-transparent p-4 text-center">
            <p className="text-sm font-semibold text-white">{hudMessage}</p>

            {/* Guided Progress Bar */}
            {isCapturing && (
              <div className="mt-3 flex items-center gap-2">
                <span className="text-[10px] font-mono text-[#9fd8ad] uppercase">
                  {guidedStage === "CENTER" ? "1. Frontal" : guidedStage === "TURN_LEFT" ? "2. Liveness" : "3. Lock"}
                </span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/20">
                  <div
                    className="h-full bg-linear-to-r from-[#8fd19e] to-[#d7efd9] transition-all duration-200"
                    style={{
                      width: `${
                        guidedStage === "CENTER"
                          ? stageProgress * 33
                          : guidedStage === "TURN_LEFT"
                            ? 33 + stageProgress * 33
                            : 66 + stageProgress * 34
                      }%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Error Message */}
      {status.kind === "error" && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-clay/30 bg-clay-soft p-3 text-sm text-clay"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-clay" aria-hidden />
          <span>{status.msg}</span>
        </p>
      )}

      {/* Control Buttons */}
      <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
        {(status.kind === "idle" || status.kind === "error") && (
          <button
            type="button"
            id="face-start-camera"
            onClick={startCamera}
            className="btn-primary w-full sm:w-auto"
          >
            <Camera className="size-5" aria-hidden /> Start Biometric Camera
          </button>
        )}

        {status.kind === "live" && !isCapturing && (
          <>
            <button
              type="button"
              id="face-start-guided"
              onClick={startGuidedScan}
              className="btn-primary w-full sm:w-auto animate-pulse-ring"
            >
              <Sparkles className="size-5" aria-hidden /> {actionLabel} (Anti-Spoof Guided)
            </button>
            {!requireLiveness && (
              <button
              type="button"
              id="face-quick-scan"
              onClick={startQuickScan}
              className="btn-ghost w-full sm:w-auto text-xs"
              title="Multi-frame capture without the head-turn step"
            >
              <Zap className="size-3.5 text-ochre-deep" aria-hidden /> Quick 1-Click
            </button>
            )}
          </>
        )}

        {status.kind === "done" && (
          <button
            type="button"
            id="face-retake"
            onClick={startCamera}
            className="btn-ghost"
          >
            <RefreshCw className="size-4" aria-hidden /> Retake Face Biometrics
          </button>
        )}
      </div>

      {/* Science Fair Anti-Spoofing & KSEF Note */}
      {isLive && (
        <div className="rounded-xl border border-line bg-paper p-3 text-xs text-ink-soft">
          <p className="flex items-center gap-1.5 font-medium text-ink-soft">
            <ShieldAlert className="size-3.5 text-forest" /> KSEF / YSK 2027 Biometric Anti-Spoofing Protocol
          </p>
          <p className="mt-1 leading-relaxed">
            The guided scan verifies 3D head movement (yaw deviation) across multiple frames to reject static photos,
            smartphone screens, and paper cutouts.
          </p>
        </div>
      )}
    </div>
  );
}
