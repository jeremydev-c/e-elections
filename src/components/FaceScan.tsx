"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Check, CheckCircle2, Loader2, RotateCcw, SwitchCamera } from "lucide-react";
import type { FaceLandmarker, FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import type { LivenessStep } from "@/lib/liveness";
import { useI18n } from "@/lib/i18n/I18n";

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
// The card photo (CardPhotoCapture) must be much straighter: the server takes up to 0.12.
const PORTRAIT_YAW = 0.08;
// Head tipped up or down, in degrees, from MediaPipe's head-pose matrix (generous: the
// server checks pitch exactly from its own landmarks).
const PORTRAIT_PITCH_DEG = 14;
const TURN_YAW = 0.55; // server needs 0.35
const BLINK_SCORE = 0.6; // MediaPipe eyeBlink blendshape (0 open .. 1 shut)
const MIN_FACE = 0.22; // face width as a share of the picture
const FRONT_FRAMES = 3;
const PEAK_WAIT = 6; // frames (~0.2 s) to wait for a move to reach its peak
const MAX_SECONDS = 60;
const CAPTURE_SIDE = 640; // six frames stay well under the 1 MB request limit

/** Dictionary key of each move's prompt (faceScan.prompts.*). */
const PROMPT = (step: LivenessStep) => `faceScan.prompts.${step}`;
const ICONS: Record<LivenessStep, string> = { TURN_LEFT: "◂", TURN_RIGHT: "▸", BLINK: "◉" };

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

/** Start fetching the face tracker early (pages call this on load). */
export function preloadFaceScan() {
  loadLandmarker().catch(() => {});
}

/** Loads MediaPipe once (self-hosted in /mediapipe), on the GPU where the device allows. */
function loadLandmarker() {
  landmarkerPromise ??= (async () => {
    // MediaPipe's WebAssembly prints routine "INFO: ..." lines through console.error,
    // which the Next.js dev overlay then shows as errors. Drop just those lines.
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("INFO:")) return;
      consoleError(...args);
    };
    const { FilesetResolver, FaceLandmarker } = await import("@mediapipe/tasks-vision");
    const files = await FilesetResolver.forVisionTasks("/mediapipe");
    const create = (delegate: "GPU" | "CPU") =>
      FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: "/mediapipe/face_landmarker.task", delegate },
        runningMode: "VIDEO",
        numFaces: 2,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
    return create("GPU").catch(() => create("CPU"));
  })().catch((err) => {
    landmarkerPromise = null;
    throw err;
  });
  return landmarkerPromise;
}

/* ------------------------------------------------------------------ cameras */

const CAMERA_KEY = "ee_camera";
const CAMERA_SIZE = { width: { ideal: 1280 }, height: { ideal: 720 } };

function savedCamera(): string | undefined {
  try {
    return localStorage.getItem(CAMERA_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Opens the camera last chosen on this device (an official may have switched to the back
 * camera to photograph the voter), else the front camera.
 */
async function openCamera(): Promise<MediaStream> {
  const id = savedCamera();
  if (id) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id }, ...CAMERA_SIZE }, audio: false });
    } catch {
      // That camera is unplugged or blocked: fall back to the front camera.
    }
  }
  return navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", ...CAMERA_SIZE }, audio: false });
}

const videoInputs = async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");

/** Remembers the camera after the one in use, so the next openCamera() uses it. */
async function chooseNextCamera(current: MediaStream | null) {
  const cams = await videoInputs();
  if (cams.length < 2) return;
  const now = current?.getVideoTracks()[0]?.getSettings().deviceId;
  const next = cams[(cams.findIndex((c) => c.deviceId === now) + 1) % cams.length];
  try {
    localStorage.setItem(CAMERA_KEY, next.deviceId);
  } catch {
    // Private browsing: the switch still works for this scan.
  }
}

/** A selfie camera is shown mirrored, like a mirror; a back camera pointed at the voter is not. */
const isMirrored = (stream: MediaStream) => stream.getVideoTracks()[0]?.getSettings().facingMode !== "environment";

function SwitchCameraButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-ink/70 px-3 py-1.5 text-xs font-semibold text-paper backdrop-blur hover:bg-ink/90"
    >
      <SwitchCamera className="size-4" aria-hidden /> {t("faceScan.switchCamera")}
    </button>
  );
}

type Point2 = [number, number];
type Reading = {
  yaw: number;
  pitchDeg: number | null;
  blink: number;
  width: number;
  others: number;
  nose: Point2;
  /** Iris centres, image-left first, in raw camera pixels. */
  eyes: [Point2, Point2];
} | null;

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
  // Head pitch from the 4x4 pose matrix (column-major): rotation about the x axis. Folded
  // into -90..90 so either axis convention reads "facing the camera" as about 0.
  const m = res.facialTransformationMatrixes?.[main]?.data;
  let pitchDeg = m && m.length >= 11 ? (Math.atan2(m[6], m[10]) * 180) / Math.PI : null;
  if (pitchDeg !== null && Math.abs(pitchDeg) > 90) pitchDeg = Math.sign(pitchDeg) * (180 - Math.abs(pitchDeg));
  const cats = res.faceBlendshapes[main]?.categories ?? [];
  const score = (name: string) => cats.find((c) => c.categoryName === name)?.score ?? 0;
  return {
    yaw,
    pitchDeg,
    blink: (score("eyeBlinkLeft") + score("eyeBlinkRight")) / 2,
    width: sizes[main],
    others: sizes.filter((s, i) => i !== main && s >= sizes[main] * 0.35).length,
    nose,
    eyes: [le as Point2, re as Point2],
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
  const { t, serverText } = useI18n();
  // A dictionary key, so the hint follows the reader's language.
  const [hint, setHint] = useState("faceScan.lookAtCamera");
  const [frontCount, setFrontCount] = useState(0);
  const [stepIndex, setStepIndex] = useState(-1);
  const [steps, setSteps] = useState<LivenessStep[]>([]);
  const [good, setGood] = useState(false);
  const [mirrored, setMirrored] = useState(true);
  const [cameras, setCameras] = useState(0);

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
      setPhase({ kind: "starting", msg: t("faceScan.opening") });
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(t("faceScan.browserNoCamera")), { name: "NoCamera" });
      const [stream, landmarker, challenge] = await Promise.all([openCamera(), loadLandmarker(), getChallenge()]);
      streamRef.current = stream;
      setMirrored(isMirrored(stream));
      videoInputs().then((c) => setCameras(c.length), () => {});
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
            ? t("faceScan.cameraDenied")
            : e.name === "NotFoundError"
              ? t("faceScan.noCamera")
              : e.name === "NotReadableError"
                ? t("faceScan.cameraBusy")
                : serverText(e.message) || t("faceScan.startFailed"),
      });
    }
  }

  function run(video: HTMLVideoElement, landmarker: FaceLandmarker, challenge: Challenge) {
    const started = performance.now();
    const frames: FaceScanPayload["frames"] = [];
    let stable = 0;
    let lastNose: [number, number] | null = null;
    let lastFront = 0;
    // The best frame of the current move so far (largest turn / most closed eyes), and for how
    // many frames it has not improved: the move's peak is sent, not the first frame past the line.
    let peak: { score: number; image: string; flat: number } | null = null;
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
        setPhase({ kind: "error", msg: serverText((err as Error).message) || t("faceScan.notAccepted") });
      }
    };

    const tick = () => {
      if (!streamRef.current) return;
      const now = performance.now();
      if ((now - started) / 1000 > MAX_SECONDS) {
        stop();
        setPhase({ kind: "error", msg: t("faceScan.tooLong") });
        return;
      }
      if (video.readyState >= 2 && video.currentTime !== lastTs) {
        lastTs = video.currentTime;
        const r = read(landmarker.detectForVideo(video, now), video.videoWidth, video.videoHeight);
        if (!r) {
          setGood(false);
          setHint("faceScan.lookAtCamera");
          stable = 0;
        } else if (r.others) {
          setGood(false);
          setHint("faceScan.onlyYou");
          stable = 0;
        } else if (r.width < MIN_FACE) {
          setGood(false);
          setHint("faceScan.closer");
          stable = 0;
        } else if (step < 0) {
          // Frontal frames: face straight, held still for a moment.
          const still = lastNose ? Math.hypot(r.nose[0] - lastNose[0], r.nose[1] - lastNose[1]) < video.videoWidth * 0.012 : false;
          lastNose = r.nose;
          const front = Math.abs(r.yaw) <= FRONT_YAW && r.blink < 0.4;
          setGood(front);
          if (!front) {
            stable = 0;
            setHint("faceScan.lookStraight");
          } else {
            stable = still ? stable + 1 : 0;
            setHint("faceScan.holdStill");
            if (stable >= 3 && now - lastFront > 90) {
              frames.push({ role: "FRONT", image: capture(video) });
              lastFront = now;
              setFrontCount(frames.length);
              if (frames.length === FRONT_FRAMES) {
                step = 0;
                setStepIndex(0);
                setHint(PROMPT(challenge.steps[0]));
              }
            }
          }
        } else {
          const want = challenge.steps[step];
          const score = want === "BLINK" ? r.blink : r.yaw * (want === "TURN_LEFT" ? 1 : -1);
          const reached = score >= (want === "BLINK" ? BLINK_SCORE : TURN_YAW);
          setGood(reached || !!peak);
          if (reached && (!peak || score > peak.score)) peak = { score, image: capture(video), flat: 0 };
          else if (peak) peak.flat += 1;
          // Done once the move stops growing (2 frames), or after PEAK_WAIT frames at most.
          const done = !!peak && (peak.flat >= 2 || (!reached && peak.flat >= 1) || peak.flat >= PEAK_WAIT);
          if (done && peak) {
            frames.push({ role: want, image: peak.image });
            peak = null;
            step += 1;
            setStepIndex(step);
            if (step >= challenge.steps.length) {
              void finish();
              return;
            }
            setHint(PROMPT(challenge.steps[step]));
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
        <video ref={videoRef} playsInline muted className={`h-full w-full object-cover ${mirrored ? "-scale-x-100" : ""}`} />
        {cameras > 1 && phase.kind !== "checking" && phase.kind !== "starting" && (
          <SwitchCameraButton onClick={() => chooseNextCamera(streamRef.current).then(start)} />
        )}
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
                {t(hint)}
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
                <p className="text-sm">{t("faceScan.checking", { s: phase.seconds })}</p>
                <Loader2 className="size-4 animate-spin" aria-hidden />
              </>
            )}
            {(phase.kind === "idle" || phase.kind === "error") && (
              <>
                {phase.kind === "error" && <p className="text-sm text-red-200">{phase.msg}</p>}
                <p className="text-sm text-paper/80">
                  {t("faceScan.intro")}
                </p>
                <button
                  type="button"
                  onClick={start}
                  className="inline-flex items-center gap-2 rounded-xl bg-forest px-5 py-2.5 text-sm font-semibold text-paper hover:bg-forest-deep"
                >
                  {phase.kind === "error" ? <RotateCcw className="size-4" aria-hidden /> : <Camera className="size-4" aria-hidden />}
                  {phase.kind === "error" ? t("common.tryAgain") : actionLabel}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ card photo */

const PHOTO_SIDE = 800;
const PHOTO_HOLD_MS = 2100; // a 3-2-1 countdown while the voter holds still and straight

/**
 * The voter-card photo, taken on its own before the face scan: the camera waits until the
 * face is straight on (not turned, not tipped, eyes open, alone in the picture) and held still,
 * counts down 3-2-1, then shows the picture to keep or retake. The server checks it again.
 */
export function CardPhotoCapture({ onCapture }: { onCapture: (image: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef(0);
  const { t } = useI18n();
  const [phase, setPhase] = useState<"idle" | "starting" | "live" | "review" | "error">("idle");
  const [error, setError] = useState("");
  const [hint, setHint] = useState("faceScan.lookAtCamera");
  const [count, setCount] = useState<number | null>(null);
  const [shot, setShot] = useState("");
  // The photo cropped the way the card will print it (same framing as the server's crop).
  const [onCard, setOnCard] = useState("");
  const [checks, setChecks] = useState({ alone: false, straight: false, eyes: false, still: false });
  const [mirrored, setMirrored] = useState(true);
  const [cameras, setCameras] = useState(0);

  useEffect(() => {
    loadLandmarker().catch(() => {});
    return () => stop();
  }, []);

  function stop() {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
  }

  async function start() {
    stop();
    setShot("");
    setCount(null);
    setPhase("starting");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(t("faceScan.browserNoCamera")), { name: "NoCamera" });
      const [stream, landmarker] = await Promise.all([openCamera(), loadLandmarker()]);
      streamRef.current = stream;
      setMirrored(isMirrored(stream));
      videoInputs().then((c) => setCameras(c.length), () => {});
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => {});
      setPhase("live");
      watch(video, landmarker);
    } catch (err) {
      stop();
      const e = err as Error;
      setError(
        e.name === "NotAllowedError"
          ? t("faceScan.cameraDenied")
          : e.name === "NotFoundError"
            ? t("faceScan.noCamera")
            : e.name === "NotReadableError"
              ? t("faceScan.cameraBusy")
              : t("faceScan.startFailed")
      );
      setPhase("error");
    }
  }

  function watch(video: HTMLVideoElement, landmarker: FaceLandmarker) {
    let since = 0; // when the face became straight and still
    let lastNose: [number, number] | null = null;
    let lastTs = -1;
    const tick = () => {
      if (!streamRef.current) return;
      const now = performance.now();
      if (video.readyState >= 2 && video.currentTime !== lastTs) {
        lastTs = video.currentTime;
        const r = read(landmarker.detectForVideo(video, now), video.videoWidth, video.videoHeight);
        const still = !!r && !!lastNose && Math.hypot(r.nose[0] - lastNose[0], r.nose[1] - lastNose[1]) < video.videoWidth * 0.01;
        lastNose = r ? r.nose : null;
        const ok = {
          alone: !!r && !r.others,
          straight: !!r && Math.abs(r.yaw) <= PORTRAIT_YAW && (r.pitchDeg === null || Math.abs(r.pitchDeg) <= PORTRAIT_PITCH_DEG),
          eyes: !!r && r.blink <= 0.3,
          still,
        };
        setChecks(ok);
        let why = "";
        if (!r) why = "faceScan.lookAtCamera";
        else if (!ok.alone) why = "faceScan.onlyYou";
        else if (r.width < MIN_FACE) why = "faceScan.closer";
        else if (!ok.straight || !ok.eyes) why = "faceScan.lookStraight";
        else if (!still) why = "faceScan.holdStill";
        if (why) {
          since = 0;
          setCount(null);
          setHint(why);
        } else {
          since ||= now;
          const held = now - since;
          setCount(3 - Math.floor((held / PHOTO_HOLD_MS) * 3));
          if (held >= PHOTO_HOLD_MS) {
            const scale = Math.min(1, PHOTO_SIDE / Math.max(video.videoWidth, video.videoHeight));
            const c = document.createElement("canvas");
            c.width = Math.round(video.videoWidth * scale);
            c.height = Math.round(video.videoHeight * scale);
            c.getContext("2d")!.drawImage(video, 0, 0, c.width, c.height);
            setShot(c.toDataURL("image/jpeg", 0.9));
            setOnCard(cardCrop(video, r!.eyes));
            stop();
            setPhase("review");
            return;
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  return (
    <div className="space-y-3">
      <div className="relative mx-auto aspect-[4/3] w-full max-w-md overflow-hidden rounded-2xl border border-line bg-ink">
        <video
          ref={videoRef}
          playsInline
          muted
          className={`h-full w-full object-cover ${mirrored ? "-scale-x-100" : ""} ${phase === "review" ? "hidden" : ""}`}
        />
        {phase === "review" && shot && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img src={shot} alt="" className={`h-full w-full object-cover ${mirrored ? "-scale-x-100" : ""}`} />
        )}
        {cameras > 1 && (phase === "live" || phase === "idle" || phase === "error") && (
          <SwitchCameraButton onClick={() => chooseNextCamera(streamRef.current).then(start)} />
        )}
        {phase === "live" && (
          <>
            {/* Passport frame: the head fits the oval, eyes on the line. */}
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className={`relative aspect-[4/5] h-[86%] rounded-2xl border-4 transition-colors ${count !== null ? "border-[#8fd19e]" : "border-white/55"}`}>
                <div className="absolute inset-x-[18%] top-[10%] bottom-[18%] rounded-[50%] border-2 border-dashed border-white/40" />
                <div className="absolute inset-x-[12%] top-[47%] border-t border-white/30" />
              </div>
            </div>
            {count !== null && count > 0 && (
              <span className="absolute inset-0 grid place-items-center font-display text-7xl text-white drop-shadow-lg">{count}</span>
            )}
            {/* What the photo still needs, ticked off live */}
            <ul className="absolute left-3 top-3 space-y-1">
              {(["alone", "straight", "eyes", "still"] as const).map((k) => (
                <li
                  key={k}
                  className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${checks[k] ? "bg-[#8fd19e] text-ink" : "bg-ink/60 text-paper/80"}`}
                >
                  {checks[k] ? <Check className="size-3" aria-hidden /> : <span className="size-3 rounded-full border border-paper/60" aria-hidden />}
                  {t(`faceScan.photo.checks.${k}`)}
                </li>
              ))}
            </ul>
            <div className="absolute inset-x-4 bottom-4 text-center">
              <span className="inline-block rounded-full bg-ink/75 px-4 py-2 text-base font-semibold text-paper shadow-lg">
                {count !== null ? t("faceScan.photo.countdown", { n: Math.max(count, 1) }) : t(hint)}
              </span>
            </div>
          </>
        )}
        {(phase === "idle" || phase === "starting" || phase === "error") && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink/80 p-6 text-center text-paper">
            {phase === "starting" ? (
              <p className="flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" aria-hidden /> {t("faceScan.opening")}
              </p>
            ) : (
              <>
                {phase === "error" && <p className="text-sm text-red-200">{error}</p>}
                <p className="text-sm text-paper/80">{t("faceScan.photo.intro")}</p>
                <button
                  type="button"
                  id="reg-card-photo"
                  onClick={start}
                  className="inline-flex items-center gap-2 rounded-xl bg-forest px-5 py-2.5 text-sm font-semibold text-paper hover:bg-forest-deep"
                >
                  {phase === "error" ? <RotateCcw className="size-4" aria-hidden /> : <Camera className="size-4" aria-hidden />}
                  {phase === "error" ? t("common.tryAgain") : t("faceScan.photo.start")}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {phase === "review" && (
        <div className="space-y-3 text-center">
          {onCard && (
            <figure className="mx-auto w-fit">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={onCard} alt="" className="h-[150px] w-[120px] rounded-lg border border-line-strong object-cover shadow-sm" />
              <figcaption className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{t("faceScan.photo.onCard")}</figcaption>
            </figure>
          )}
          <p className="text-sm text-ink-soft">{t("faceScan.photo.review")}</p>
          <div className="flex justify-center gap-3">
            <button type="button" id="reg-photo-retake" className="btn-ghost" onClick={start}>
              <RotateCcw className="size-4" aria-hidden /> {t("faceScan.photo.retake")}
            </button>
            <button type="button" id="reg-photo-use" className="btn-primary" onClick={() => onCapture(shot)}>
              <Check className="size-4" aria-hidden /> {t("faceScan.photo.use")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The card photo the way it will print: eyes level, 24% of the width apart and 47% down, in a
 * 300 x 375 frame, the same framing as the server's portraitCrop (lib/faceEngine.ts).
 */
function cardCrop(video: HTMLVideoElement, [le, re]: [Point2, Point2]): string {
  const W = 300;
  const H = 375;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#e4e0d4";
  g.fillRect(0, 0, W, H);
  const dist = Math.hypot(re[0] - le[0], re[1] - le[1]) || 1;
  g.translate(W / 2, 0.47 * H);
  g.rotate(-Math.atan2(re[1] - le[1], re[0] - le[0]));
  g.scale((0.24 * W) / dist, (0.24 * W) / dist);
  g.translate(-(le[0] + re[0]) / 2, -(le[1] + re[1]) / 2);
  g.drawImage(video, 0, 0);
  return c.toDataURL("image/jpeg", 0.85);
}
