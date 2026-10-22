"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import type { FaceLandmarker, FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import type { LivenessStep } from "@/lib/liveness";

/**
 * The camera side of a face scan. MediaPipe Face Landmarker (478 points, blink scores)
 * runs in the browser only to GUIDE the voter and pick good frames: three frontal
 * frames, then one frame at the peak of each liveness move the server asked for.
 * The frames go to the server, which re-checks every move and does all the matching
 * (lib/faceScan.ts). Nothing the browser measures is trusted.
 */

export type Challenge = { token: string; steps: LivenessStep[] };
export type FaceScanPayload = {
  liveness: { token: string };
  frames: { role: "FRONT" | LivenessStep; image: string }[];
  seconds: number;
};

type Props = {
  getChallenge: () => Promise<Challenge>;
  onScan: (scan: FaceScanPayload) => Promise<void> | void;
  actionLabel: string;
};

// Same measure as the server (lib/faceEngine.ts yawOf), with a safety margin each way.
const FRONT_YAW = 0.2; // server accepts up to 0.35
const TURN_YAW = 0.55; // server needs 0.45
const BLINK_SCORE = 0.6; // MediaPipe eyeBlink blendshape (0 open .. 1 shut)
const MIN_FACE = 0.22; // face width as a share of the picture
const FRONT_FRAMES = 3;
const MAX_SECONDS = 60;
const CAPTURE_SIDE = 640; // six frames stay well under the 1 MB request limit

const PROMPTS: Record<LivenessStep, string> = {
  TURN_LEFT: "Turn your head to your left",
  TURN_RIGHT: "Turn your head to your right",
  BLINK: "Close your eyes for a second",
};
const ICONS: Record<LivenessStep, string> = { TURN_LEFT: "◂", TURN_RIGHT: "▸", BLINK: "◉" };

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

/** Start fetching the face tracker early (pages call this on load). */
export function preloadFaceScan() {
  loadLandmarker().catch(() => {});
}

/** Loads MediaPipe once (self-hosted in /mediapipe), on the GPU where the device allows. */
function loadLandmarker() {
  landmarkerPromise ??= (async () => {
    const { FilesetResolver, FaceLandmarker } = await import("@mediapipe/tasks-vision");
    const files = await FilesetResolver.forVisionTasks("/mediapipe");
    const create = (delegate: "GPU" | "CPU") =>
      FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: "/mediapipe/face_landmarker.task", delegate },
        runningMode: "VIDEO",
        numFaces: 2,
        outputFaceBlendshapes: true,
      });
    return create("GPU").catch(() => create("CPU"));
  })().catch((err) => {
    landmarkerPromise = null;
    throw err;
  });
  return landmarkerPromise;
}

type Reading = { yaw: number; blink: number; width: number; others: number; nose: [number, number] } | null;

function read(res: FaceLandmarkerResult, vw: number, vh: number): Reading {
  const faces = res.faceLandmarks;
  if (!faces.length) return null;
  const box = (lm: { x: number }[]) => Math.max(...lm.map((p) => p.x)) - Math.min(...lm.map((p) => p.x));
  const sizes = faces.map(box);
  const main = sizes.indexOf(Math.max(...sizes));
  const lm = faces[main];
  // Iris centres (468, 473) and nose tip (1), in raw (un-mirrored) camera pixels.
  const a = [lm[468].x * vw, lm[468].y * vh];
  const b = [lm[473].x * vw, lm[473].y * vh];
  const [le, re] = a[0] < b[0] ? [a, b] : [b, a];
  const nose: [number, number] = [lm[1].x * vw, lm[1].y * vh];
  const yaw = (nose[0] - (le[0] + re[0]) / 2) / Math.max(1, (re[0] - le[0]) / 2);
  const cats = res.faceBlendshapes[main]?.categories ?? [];
  const score = (name: string) => cats.find((c) => c.categoryName === name)?.score ?? 0;
  return {
    yaw,
    blink: (score("eyeBlinkLeft") + score("eyeBlinkRight")) / 2,
    width: sizes[main],
    others: sizes.filter((s, i) => i !== main && s >= sizes[main] * 0.35).length,
    nose,
  };
}

type Phase =
  | { kind: "idle" }
  | { kind: "starting"; msg: string }
  | { kind: "scanning" }
  | { kind: "checking"; seconds: number }
  | { kind: "error"; msg: string };

export function FaceScan({ getChallenge, onScan, actionLabel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef(0);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [hint, setHint] = useState("Look at the camera");
  const [frontCount, setFrontCount] = useState(0);
  const [stepIndex, setStepIndex] = useState(-1);
  const [steps, setSteps] = useState<LivenessStep[]>([]);
  const [good, setGood] = useState(false);

  // Start downloading MediaPipe as soon as the scanner is on screen.
  useEffect(() => {
    loadLandmarker().catch(() => {});
    return () => stop();
  }, []);

  function stop() {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  function capture(video: HTMLVideoElement) {
    const scale = Math.min(1, CAPTURE_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(video.videoWidth * scale);
    c.height = Math.round(video.videoHeight * scale);
    c.getContext("2d")!.drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85);
  }

  async function start() {
    stop();
    setFrontCount(0);
    setStepIndex(-1);
    setGood(false);
    try {
      setPhase({ kind: "starting", msg: "Opening the camera…" });
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("This browser cannot use the camera."), { name: "NoCamera" });
      const [stream, landmarker, challenge] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }),
        loadLandmarker(),
        getChallenge(),
      ]);
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => {});
      setSteps(challenge.steps);
      setPhase({ kind: "scanning" });
      run(video, landmarker, challenge);
    } catch (err) {
      stop();
      const e = err as Error;
      setPhase({
        kind: "error",
        msg:
          e.name === "NotAllowedError"
            ? "Camera permission denied. Allow camera access (padlock icon in the address bar) and try again."
            : e.name === "NotFoundError"
              ? "No camera found on this device. Use Fingerprint instead."
              : e.name === "NotReadableError"
                ? "The camera is in use by another app. Close it and try again."
                : e.message || "Could not start the face scan.",
      });
    }
  }

  function run(video: HTMLVideoElement, landmarker: FaceLandmarker, challenge: Challenge) {
    const started = performance.now();
    const frames: FaceScanPayload["frames"] = [];
    let stable = 0;
    let lastNose: [number, number] | null = null;
    let lastFront = 0;
    let turnHold = 0;
    let step = -1; // -1 = frontal frames
    let lastTs = -1;

    const finish = async () => {
      stop();
      const seconds = Math.round((performance.now() - started) / 100) / 10;
      setPhase({ kind: "checking", seconds });
      try {
        await onScan({ liveness: { token: challenge.token }, frames, seconds });
        setPhase({ kind: "idle" });
      } catch (err) {
        setPhase({ kind: "error", msg: (err as Error).message || "The face scan was not accepted." });
      }
    };

    const tick = () => {
      if (!streamRef.current) return;
      const now = performance.now();
      if ((now - started) / 1000 > MAX_SECONDS) {
        stop();
        setPhase({ kind: "error", msg: "The scan took too long. Try again in good light." });
        return;
      }
      if (video.readyState >= 2 && video.currentTime !== lastTs) {
        lastTs = video.currentTime;
        const r = read(landmarker.detectForVideo(video, now), video.videoWidth, video.videoHeight);
        if (!r) {
          setGood(false);
          setHint("Look at the camera");
          stable = 0;
        } else if (r.others) {
          setGood(false);
          setHint("Only you should be in the picture");
          stable = 0;
        } else if (r.width < MIN_FACE) {
          setGood(false);
          setHint("Come a little closer");
          stable = 0;
        } else if (step < 0) {
          // Frontal frames: face straight, held still for a moment.
          const still = lastNose ? Math.hypot(r.nose[0] - lastNose[0], r.nose[1] - lastNose[1]) < video.videoWidth * 0.012 : false;
          lastNose = r.nose;
          const front = Math.abs(r.yaw) <= FRONT_YAW && r.blink < 0.4;
          setGood(front);
          if (!front) {
            stable = 0;
            setHint("Look straight at the camera");
          } else {
            stable = still ? stable + 1 : 0;
            setHint("Hold still…");
            if (stable >= 3 && now - lastFront > 90) {
              frames.push({ role: "FRONT", image: capture(video) });
              lastFront = now;
              setFrontCount(frames.length);
              if (frames.length === FRONT_FRAMES) {
                step = 0;
                setStepIndex(0);
                setHint(PROMPTS[challenge.steps[0]]);
              }
            }
          }
        } else {
          const want = challenge.steps[step];
          let done = false;
          if (want === "BLINK") {
            setGood(r.blink >= BLINK_SCORE);
            done = r.blink >= BLINK_SCORE;
          } else {
            const sign = want === "TURN_LEFT" ? 1 : -1;
            const turned = r.yaw * sign >= TURN_YAW;
            setGood(turned);
            turnHold = turned ? turnHold + 1 : 0;
            done = turnHold >= 2;
          }
          if (done) {
            frames.push({ role: want, image: capture(video) });
            turnHold = 0;
            step += 1;
            setStepIndex(step);
            if (step >= challenge.steps.length) {
              void finish();
              return;
            }
            setHint(PROMPTS[challenge.steps[step]]);
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  const scanning = phase.kind === "scanning";
  const prompt = stepIndex >= 0 && stepIndex < steps.length ? steps[stepIndex] : null;
  const accent = good ? "#8fd19e" : "rgba(255,255,255,0.55)";

  return (
    <div className="space-y-3">
      <div className="relative mx-auto aspect-[4/3] w-full max-w-md overflow-hidden rounded-2xl border border-line bg-ink">
        <video ref={videoRef} playsInline muted className="h-full w-full -scale-x-100 object-cover" />
        {scanning && (
          <>
            {/* The whole picture is the target: corner brackets at its edges. */}
            {[
              "left-3 top-3 border-l-4 border-t-4 rounded-tl-xl",
              "right-3 top-3 border-r-4 border-t-4 rounded-tr-xl",
              "left-3 bottom-3 border-l-4 border-b-4 rounded-bl-xl",
              "right-3 bottom-3 border-r-4 border-b-4 rounded-br-xl",
            ].map((c) => (
              <span key={c} className={`absolute size-14 transition-colors ${c}`} style={{ borderColor: accent }} />
            ))}
            <div className="absolute inset-x-0 top-4 flex justify-center gap-2">
              {Array.from({ length: FRONT_FRAMES }, (_, i) => (
                <span key={`f${i}`} className="size-2.5 rounded-full" style={{ background: i < frontCount ? "#8fd19e" : "rgba(255,255,255,0.35)" }} />
              ))}
              {steps.map((s, i) => (
                <span key={s} className="rounded-full px-2 text-xs font-semibold leading-5" style={{ background: i < stepIndex ? "#8fd19e" : i === stepIndex ? "#f0b35a" : "rgba(255,255,255,0.25)", color: "#1f2219" }}>
                  {ICONS[s]}
                </span>
              ))}
            </div>
            <div className="absolute inset-x-4 bottom-5 text-center">
              <span className="inline-block rounded-full bg-ink/75 px-4 py-2 text-base font-semibold text-paper shadow-lg">
                {prompt && <span className="mr-1.5 text-amber-300">{ICONS[prompt]}</span>}
                {hint}
              </span>
            </div>
          </>
        )}
        {phase.kind !== "scanning" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink/80 p-6 text-center text-paper">
            {phase.kind === "starting" && (
              <p className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" aria-hidden /> {phase.msg}</p>
            )}
            {phase.kind === "checking" && (
              <>
                <CheckCircle2 className="size-8 text-[#8fd19e]" aria-hidden />
                <p className="text-sm">Scanned in {phase.seconds} s. Checking with the register…</p>
                <Loader2 className="size-4 animate-spin" aria-hidden />
              </>
            )}
            {(phase.kind === "idle" || phase.kind === "error") && (
              <>
                {phase.kind === "error" && <p className="text-sm text-red-200">{phase.msg}</p>}
                <p className="text-sm text-paper/80">
                  Look at the camera, then do three quick moves. Takes about 5 seconds.
                </p>
                <button
                  type="button"
                  onClick={start}
                  className="inline-flex items-center gap-2 rounded-xl bg-forest px-5 py-2.5 text-sm font-semibold text-paper hover:bg-forest-deep"
                >
                  {phase.kind === "error" ? <RotateCcw className="size-4" aria-hidden /> : <Camera className="size-4" aria-hidden />}
                  {phase.kind === "error" ? "Try again" : actionLabel}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
